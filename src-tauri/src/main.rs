// flymd 桌面端：Tauri 2
// 职责：对话框、文件系统、存储、窗口状态、外链打开等插件初始化

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter, State};
// 全局共享：保存通过“打开方式/默认程序”传入且可能早于前端监听的文件路径
#[derive(Default)]
struct PendingOpenPath(std::sync::Mutex<Option<String>>);
use serde::{Deserialize, Serialize};
use sha2::Digest;
use chrono::{DateTime, Utc};
use std::time::Duration;
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
fn init_linux_render_env() {
  // Linux 默认禁用 WebKitGTK 的 DMABUF 渲染，降低白屏概率；若用户显式设置则尊重用户配置
  use std::env;
  if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }
}

// 启动诊断日志：发布版也能落盘，便于定位“黑屏/卡初始化”等问题
static STARTUP_LOG_PATH: OnceLock<std::path::PathBuf> = OnceLock::new();
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

fn now_epoch_ms() -> u128 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0)
}

fn try_write_log_line(path: &std::path::Path, line: &str) -> std::io::Result<()> {
  use std::io::Write;
  let mut f = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)?;
  writeln!(f, "{line}")?;
  Ok(())
}

fn write_startup_log(line: &str) {
  let Some(path) = STARTUP_LOG_PATH.get() else { return; };
  let _ = try_write_log_line(path, line);
}

fn install_panic_hook_once() {
  if PANIC_HOOK_INSTALLED.set(()).is_err() {
    return;
  }

  std::panic::set_hook(Box::new(|info| {
    // 注意：release 里 panic=abort，但 hook 仍有机会写入关键信息
    let ts = now_epoch_ms();
    write_startup_log(&format!("[panic] t={ts}ms {info}"));
  }));
}

fn init_startup_log<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
  // 优先写入 app_log_dir；失败则退回 app_data_dir；再失败就放弃（不能为了日志把应用搞崩）
  let dir = app
    .path()
    .app_log_dir()
    .or_else(|_| app.path().app_data_dir());
  let Ok(mut dir) = dir else { return; };
  let _ = std::fs::create_dir_all(&dir);
  dir.push("flymd-startup.log");

  // 覆盖写：保留“最近一次启动”的信息，避免无限增长
  if let Ok(mut f) = std::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .truncate(true)
    .open(&dir)
  {
    use std::io::Write;
    let _ = writeln!(f, "flymd 启动诊断日志（仅保留最近一次）");
  }

  let _ = STARTUP_LOG_PATH.set(dir);
  install_panic_hook_once();

  let ts = now_epoch_ms();
  write_startup_log(&format!("[boot] t={ts}ms pid={}", std::process::id()));

  if let Ok(exe) = std::env::current_exe() {
    let exe_s = exe.to_string_lossy();
    write_startup_log(&format!("[boot] exe={exe_s}"));
    if exe_s.contains("AppTranslocation") {
      write_startup_log("[boot] 检测到 AppTranslocation（quarantine/未签名常见触发点）");
    }
  }
  if let Ok(cwd) = std::env::current_dir() {
    write_startup_log(&format!("[boot] cwd={}", cwd.to_string_lossy()));
  }

  let args: Vec<String> = std::env::args().collect();
  if !args.is_empty() {
    write_startup_log(&format!("[boot] args={}", args.join(" ")));
  }

  // 只记录少量关键变量：GUI 启动与终端启动差异最大的就是这些
  for k in ["PATH", "HOME", "SHELL", "LANG", "LC_ALL"] {
    if let Ok(v) = std::env::var(k) {
      write_startup_log(&format!("[env] {k}={v}"));
    }
  }

  if let Ok(p) = app.path().app_log_dir() {
    write_startup_log(&format!("[path] app_log_dir={}", p.to_string_lossy()));
  }
  if let Ok(p) = app.path().app_config_dir() {
    write_startup_log(&format!("[path] app_config_dir={}", p.to_string_lossy()));
  }
  if let Ok(p) = app.path().app_data_dir() {
    write_startup_log(&format!("[path] app_data_dir={}", p.to_string_lossy()));
  }
}

// 判定是否为受支持的文档扩展名（md/markdown/txt/pdf），并确保路径存在
fn is_supported_doc_path(path: &std::path::Path) -> bool {
  use std::path::Path;
  let p: &Path = path;
  if !p.exists() {
    return false;
  }
  match p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()) {
    Some(ext) => ext == "md" || ext == "markdown" || ext == "txt" || ext == "pdf",
    None => false,
  }
}

// 判定是否为 Markdown 类文本（供插件扫描使用，不包含 PDF）
fn is_markdown_like_path(path: &std::path::Path) -> bool {
  use std::path::Path;
  let p: &Path = path;
  if !p.exists() {
    return false;
  }
  match p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()) {
    Some(ext) => ext == "md" || ext == "markdown" || ext == "txt",
    None => false,
  }
}

// 统一的“打开方式/默认程序”事件分发：写入 PendingOpenPath，并向前端发送 open-file 事件
fn dispatch_open_file_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: &std::path::Path) {
  if !is_supported_doc_path(path) {
    return;
  }
  let path_str = path.to_string_lossy().to_string();
  write_startup_log(&format!("[open] {}", path_str));
  // 先写入共享状态：即便当前窗口尚未创建，前端仍可在启动后通过 get_pending_open_path 主动拉取
  if let Some(state) = app.try_state::<PendingOpenPath>() {
    if let Ok(mut slot) = state.0.lock() {
      *slot = Some(path_str.clone());
    }
  }
  // 若主窗口已存在，则主动发送 open-file 事件；否则仅依赖前端兜底拉取
  if let Some(win) = app.get_webview_window("main") {
    let win_clone = win.clone();
    let path_clone = path_str.clone();
    std::thread::spawn(move || {
      std::thread::sleep(std::time::Duration::from_millis(500));
      let _ = win_clone.emit("open-file", path_clone);
      let _ = win_clone.set_focus();
    });
  }
}

// macOS：通过 RunEvent::Opened 捕获 Finder/Launch Services 传入的文件 URL，并复用统一分发逻辑
#[cfg(target_os = "macos")]
fn init_macos_open_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
  use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
  use tauri::RunEvent;

  PluginBuilder::new("macos-open-handler")
    .on_event(|app, event| {
      if let RunEvent::Opened { urls } = event {
        write_startup_log(&format!("[run] Opened urls={}", urls.len()));
        for url in urls {
          // 仅处理 file:// URL，其它协议（如自定义 URL Scheme）暂不介入
          if url.scheme() != "file" {
            continue;
          }
          if let Ok(path) = url.to_file_path() {
            dispatch_open_file_event(app, &path);
          }
        }
      }
    })
    .build()
}


#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadReq {
  access_key_id: String,
  secret_access_key: String,
  bucket: String,
  #[serde(default)]
  region: Option<String>,
  #[serde(default)]
  endpoint: Option<String>,
  #[serde(default = "UploadReq::default_true")]
  force_path_style: bool,
  #[serde(default = "UploadReq::default_true")]
  acl_public_read: bool,
  #[serde(default)]
  custom_domain: Option<String>,
  key: String,
  #[serde(default)]
  content_type: Option<String>,
  // 前端可传 Uint8Array -> Vec<u8>
  bytes: Vec<u8>,
}

impl UploadReq {
  fn default_true() -> bool { true }
}

#[derive(Debug, Serialize)]
struct UploadResp {
  key: String,
  public_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UploadedImageRecord {
  id: String,
  bucket: String,
  key: String,
  public_url: String,
  uploaded_at: String,
  #[serde(default)]
  file_name: Option<String>,
  #[serde(default)]
  content_type: Option<String>,
  #[serde(default)]
  size: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploaderDeleteReq {
  access_key_id: String,
  secret_access_key: String,
  bucket: String,
  #[serde(default)]
  region: Option<String>,
  #[serde(default)]
  endpoint: Option<String>,
  #[serde(default)]
  force_path_style: Option<bool>,
  key: String,
}

fn uploader_history_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let mut dir = app
    .path()
    .app_config_dir()
    .map_err(|e| format!("app_config_dir error: {e}"))?;
  dir.push("uploader-history.json");
  Ok(dir)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignReq {
  access_key_id: String,
  secret_access_key: String,
  bucket: String,
  #[serde(default)]
  region: Option<String>,
  #[serde(default)]
  endpoint: Option<String>,
  #[serde(default)]
  force_path_style: bool,
  #[serde(default)]
  custom_domain: Option<String>,
  key: String,
  #[serde(default)]
  expires: Option<u32>,
}

#[derive(Debug, Serialize)]
struct PresignResp {
  put_url: String,
  public_url: String,
}

#[tauri::command]
async fn upload_to_s3(req: UploadReq) -> Result<UploadResp, String> {
  // 使用 AWS SDK for Rust 直传，行为与 PicList（SDK）一致；仅构建机需工具链，用户零依赖。
  use aws_sdk_s3 as s3;
  use aws_config::meta::region::RegionProviderChain;
  use s3::config::Region;
  use s3::types::ObjectCannedAcl;
  use s3::primitives::ByteStream;

  let region_str = req.region.clone().unwrap_or_else(|| "us-east-1".to_string());
  let region = Region::new(region_str.clone());
  let region_provider = RegionProviderChain::first_try(region.clone());
  let base_conf = aws_config::defaults(aws_config::BehaviorVersion::latest())
    .region(region_provider)
    .load()
    .await;

  let creds = s3::config::Credentials::new(
    req.access_key_id.clone(),
    req.secret_access_key.clone(),
    None,
    None,
    "flymd",
  );
  let mut conf_builder = s3::config::Builder::from(&base_conf)
    .credentials_provider(creds)
    .force_path_style(req.force_path_style);
  if let Some(ep) = &req.endpoint { if !ep.trim().is_empty() { conf_builder = conf_builder.endpoint_url(ep.trim()); } }
  let conf = conf_builder.build();
  let client = s3::Client::from_conf(conf);

  let mut put = client
    .put_object()
    .bucket(req.bucket.clone())
    .key(req.key.clone())
    .body(ByteStream::from(req.bytes.clone()));
  if let Some(ct) = &req.content_type { if !ct.is_empty() { put = put.content_type(ct); } }
  if req.acl_public_read { put = put.acl(ObjectCannedAcl::PublicRead); }
  put.send().await.map_err(|e| format!("put_object error: {e}"))?;

  // 生成外链
  let key_enc = percent_encoding::utf8_percent_encode(&req.key, percent_encoding::NON_ALPHANUMERIC).to_string();
  let public_url = if let Some(custom) = &req.custom_domain {
    let base = custom.trim_end_matches('/');
    format!("{}/{}", base, key_enc)
  } else if let Some(ep) = &req.endpoint {
    let ep = ep.trim_end_matches('/');
    if req.force_path_style {
      // path-style: <endpoint>/<bucket>/<key>
      format!("{}/{}/{}", ep, req.bucket, key_enc)
    } else {
      // virtual-host: https://<bucket>.<host>/<key>
      match ep.parse::<url::Url>() {
        Ok(u) => format!("{}://{}.{}{}{}{}{}", u.scheme(), req.bucket, u.host_str().unwrap_or(""), if u.port().is_some() { ":" } else { "" }, u.port().map(|p| p.to_string()).unwrap_or_default(), if u.path() == "/" { "" } else { u.path() }, format!("/{}", key_enc)),
        Err(_) => format!("{}/{}/{}", ep, req.bucket, key_enc),
      }
    }
  } else {
    // 默认 S3 公域名
    if req.force_path_style { format!("https://s3.amazonaws.com/{}/{}", req.bucket, key_enc) } else { format!("https://{}.s3.amazonaws.com/{}", req.bucket, key_enc) }
  };

  Ok(UploadResp { key: req.key, public_url })
}

#[tauri::command]
async fn presign_put(req: PresignReq) -> Result<PresignResp, String> {
  use hmac::{Hmac, Mac};
  use sha2::Sha256;
  use std::time::SystemTime;

  let region_str = req.region.clone().unwrap_or_else(|| "us-east-1".to_string());
  let service = "s3";
  let expires = req.expires.unwrap_or(600);

  // 构建基础 URL 与 CanonicalURI
  let ep = req.endpoint.clone().unwrap_or_else(|| "https://s3.amazonaws.com".to_string());
  let ep_url = ep.parse::<url::Url>().map_err(|e| format!("invalid endpoint: {e}"))?;

  fn aws_uri_encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for &b in seg.as_bytes() {
      let c = b as char;
      let is_unreserved = (b'A'..=b'Z').contains(&b)
        || (b'a'..=b'z').contains(&b)
        || (b'0'..=b'9').contains(&b)
        || c == '-' || c == '_' || c == '.' || c == '~';
      if is_unreserved { out.push(c) } else { out.push('%'); out.push_str(&format!("{:02X}", b)); }
    }
    out
  }
  let key_enc = req.key.split('/').map(aws_uri_encode_segment).collect::<Vec<_>>().join("/");

  let (mut base_url, host_for_sig, canonical_uri) = if req.force_path_style {
    // <endpoint>/<bucket>/<key>
    let mut u = ep_url.clone();
    let mut new_path = u.path().trim_end_matches('/').to_string();
    new_path.push('/'); new_path.push_str(&req.bucket);
    new_path.push('/'); new_path.push_str(&key_enc);
    u.set_path(&new_path);
    let host_sig = u.host_str().unwrap_or("").to_string();
    (u, host_sig, new_path)
  } else {
    // https://<bucket>.<host>/<key>
    let host = format!("{}.{}", req.bucket, ep_url.host_str().unwrap_or(""));
    let u = url::Url::parse(&format!("{}://{}/{}", ep_url.scheme(), host, key_enc))
      .map_err(|e| format!("build url error: {e}"))?;
    (u, host, format!("/{}", key_enc))
  };

  // 构建 X-Amz-* 查询参数（不包含 Signature）
  let sys_now = SystemTime::now();
  let datetime: DateTime<Utc> = sys_now.into();
  let amz_date = datetime.format("%Y%m%dT%H%M%SZ").to_string();
  let date_stamp = datetime.format("%Y%m%d").to_string();
  let scope = format!("{}/{}/{}/aws4_request", date_stamp, region_str, service);

  // Query 编码（RFC3986，空格用 %20）
  fn enc_q(v: &str) -> String {
    let mut out = String::new();
    for &b in v.as_bytes() {
      let c = b as char;
      let unreserved = (b'A'..=b'Z').contains(&b)
        || (b'a'..=b'z').contains(&b)
        || (b'0'..=b'9').contains(&b)
        || c == '-' || c == '_' || c == '.' || c == '~';
      if unreserved { out.push(c) } else { out.push('%'); out.push_str(&format!("{:02X}", b)); }
    }
    out
  }

  let mut query: Vec<(String, String)> = vec![
    ("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()),
    ("X-Amz-Credential".into(), format!("{}/{}", req.access_key_id, scope)),
    ("X-Amz-Date".into(), amz_date.clone()),
    ("X-Amz-Expires".into(), expires.to_string()),
    ("X-Amz-SignedHeaders".into(), "host".into()),
  ];
  query.sort_by(|a,b| a.0.cmp(&b.0));
  let canonical_query = query.iter().map(|(k,v)| format!("{}={}", enc_q(k), enc_q(v))).collect::<Vec<_>>().join("&");

  // CanonicalHeaders / SignedHeaders / HashedPayload
  let canonical_headers = format!("host:{}\n", host_for_sig);
  let signed_headers = "host";
  let hashed_payload = "UNSIGNED-PAYLOAD";

  // CanonicalRequest
  let canonical_request = format!(
    "PUT\n{}\n{}\n{}\n{}\n{}",
    canonical_uri, canonical_query, canonical_headers, signed_headers, hashed_payload
  );

  // StringToSign
  let string_to_sign = format!(
    "AWS4-HMAC-SHA256\n{}\n{}\n{}",
    amz_date,
    scope,
    hex::encode(sha2::Sha256::digest(canonical_request.as_bytes()))
  );

  // 派生签名密钥
  type HmacSha256 = Hmac<Sha256>;
  fn hmac(key: &[u8], data: &str) -> Vec<u8> { let mut mac = HmacSha256::new_from_slice(key).unwrap(); mac.update(data.as_bytes()); mac.finalize().into_bytes().to_vec() }
  let k_date = hmac(format!("AWS4{}", req.secret_access_key).as_bytes(), &date_stamp);
  let k_region = hmac(&k_date, &region_str);
  let k_service = hmac(&k_region, service);
  let k_signing = hmac(&k_service, "aws4_request");
  let signature = hex::encode(hmac(&k_signing, &string_to_sign));

  // 构造最终 URL（附加 Signature）
  let mut final_q = canonical_query.clone();
  final_q.push_str(&format!("&X-Amz-Signature={}", signature));
  base_url.set_query(Some(&final_q));

  // 生成外链
  let public_url = if let Some(custom) = &req.custom_domain {
    let base = custom.trim_end_matches('/');
    format!("{}/{}", base, key_enc)
  } else if req.force_path_style {
    format!("{}/{}/{}", ep.trim_end_matches('/'), req.bucket, key_enc)
  } else {
    format!("{}://{}.{}{}{}{}{}",
      ep_url.scheme(), req.bucket, ep_url.host_str().unwrap_or(""),
      if ep_url.port().is_some() { ":" } else { "" }, ep_url.port().map(|p| p.to_string()).unwrap_or_default(),
      if ep_url.path() == "/" { "" } else { ep_url.path() },
      format!("/{}", key_enc)
    )
  };

  Ok(PresignResp { put_url: base_url.to_string(), public_url })
}

// S3/R2 上传历史管理：仅记录非敏感元数据，便于前端插件查看与删除
#[tauri::command]
async fn flymd_record_uploaded_image(app: tauri::AppHandle, record: UploadedImageRecord) -> Result<(), String> {
  use std::fs;

  let path = uploader_history_path(&app)?;
  tauri::async_runtime::spawn_blocking(move || {
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("create_dir_all error: {e}"))?;
    }
    let mut list: Vec<UploadedImageRecord> = match fs::read_to_string(&path) {
      Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
      Err(_) => Vec::new(),
    };
    // 去重：同 bucket/key/public_url 仅保留最新一条
    if let Some(pos) = list
      .iter()
      .position(|x| x.bucket == record.bucket && x.key == record.key && x.public_url == record.public_url)
    {
      list.remove(pos);
    }
    list.push(record);
    const MAX_ITEMS: usize = 2000;
    if list.len() > MAX_ITEMS {
      let drop_n = list.len() - MAX_ITEMS;
      list.drain(0..drop_n);
    }
    let json = serde_json::to_string_pretty(&list).map_err(|e| format!("serialize error: {e}"))?;
    fs::write(&path, json.as_bytes()).map_err(|e| format!("write error: {e}"))?;
    Ok::<(), String>(())
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;

  Ok(())
}

#[tauri::command]
async fn flymd_list_uploaded_images(app: tauri::AppHandle) -> Result<Vec<UploadedImageRecord>, String> {
  use std::fs;

  let path = uploader_history_path(&app)?;
  let list = tauri::async_runtime::spawn_blocking(move || {
    if !path.exists() {
      return Ok::<Vec<UploadedImageRecord>, String>(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read error: {e}"))?;
    let mut list: Vec<UploadedImageRecord> = serde_json::from_str(&text).unwrap_or_default();
    // 按时间倒序返回（新上传在前）
    list.sort_by(|a, b| b.uploaded_at.cmp(&a.uploaded_at));
    Ok(list)
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;

  Ok(list)
}

#[tauri::command]
async fn flymd_delete_uploaded_image(app: tauri::AppHandle, req: UploaderDeleteReq) -> Result<(), String> {
  // 1) 使用当前配置删除远端对象
  use aws_config::meta::region::RegionProviderChain;
  use aws_sdk_s3 as s3;
  use s3::config::Region;

  let region_str = req.region.clone().unwrap_or_else(|| "us-east-1".to_string());
  let region = Region::new(region_str.clone());
  let region_provider = RegionProviderChain::first_try(region.clone());
  let base_conf = aws_config::defaults(aws_config::BehaviorVersion::latest())
    .region(region_provider)
    .load()
    .await;

  let creds = s3::config::Credentials::new(
    req.access_key_id.clone(),
    req.secret_access_key.clone(),
    None,
    None,
    "flymd",
  );
  let mut conf_builder = s3::config::Builder::from(&base_conf)
    .credentials_provider(creds)
    .force_path_style(req.force_path_style.unwrap_or(true));
  if let Some(ep) = &req.endpoint {
    if !ep.trim().is_empty() {
      conf_builder = conf_builder.endpoint_url(ep.trim());
    }
  }
  let conf = conf_builder.build();
  let client = s3::Client::from_conf(conf);

  client
    .delete_object()
    .bucket(req.bucket.clone())
    .key(req.key.clone())
    .send()
    .await
    .map_err(|e| format!("delete_object error: {e}"))?;

  // 2) 本地历史中移除对应记录（按 bucket+key 匹配）
  use std::fs;

  let path = uploader_history_path(&app)?;
  let bucket = req.bucket.clone();
  let key = req.key.clone();
  tauri::async_runtime::spawn_blocking(move || {
    if !path.exists() {
      return Ok::<(), String>(());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read error: {e}"))?;
    let mut list: Vec<UploadedImageRecord> = serde_json::from_str(&text).unwrap_or_default();
    let before = list.len();
    list.retain(|r| !(r.bucket == bucket && r.key == key));
    if list.len() != before {
      let json = serde_json::to_string_pretty(&list).map_err(|e| format!("serialize error: {e}"))?;
      fs::write(&path, json.as_bytes()).map_err(|e| format!("write error: {e}"))?;
    }
    Ok(())
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;

  Ok(())
}


#[derive(Debug, Deserialize)]
struct XmlHttpReq {
  url: String,
  xml: String,
}

#[tauri::command]
async fn http_xmlrpc_post(req: XmlHttpReq) -> Result<String, String> {
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(20))
    .build()
    .map_err(|e| format!("client error: {e}"))?;
  let res = client
    .post(&req.url)
    .header("Content-Type", "text/xml; charset=UTF-8")
    .header("Accept", "text/xml, */*;q=0.1")
    .header("User-Agent", "flymd-typecho-publisher/0.1")
    .body(req.xml)
    .send()
    .await
    .map_err(|e| format!("send error: {e}"))?;
  let status = res.status();
  let text = res.text().await.map_err(|e| format!("read error: {e}"))?;
  if !status.is_success() {
    return Err(format!("HTTP {}: {}", status.as_u16(), text));
  }
  Ok(text)
}

// PicList HTTP 代理：在后端通过 reqwest 调用本地 PicList 内置服务器，避免前端 HTTP scope 限制
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PicListUploadReq {
  host: String,
  #[serde(default)]
  key: String,
  #[serde(default)]
  picbed: String,
  #[serde(default)]
  config_name: String,
  path: String,
}

#[tauri::command]
async fn flymd_piclist_upload(req: PicListUploadReq) -> Result<String, String> {
  use serde_json::Value;
  use url::form_urlencoded;

  fn enc_q(s: &str) -> String {
    form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>()
  }

  let mut host = req.host.trim().to_string();
  if host.is_empty() {
    return Err("PicList host 为空".into());
  }
  if !host.starts_with("http://") && !host.starts_with("https://") {
    host = format!("http://{}", host);
  }
  let mut url = format!("{}/upload", host.trim_end_matches('/'));

  let mut qs: Vec<String> = Vec::new();
  if !req.key.trim().is_empty() {
    qs.push(format!("key={}", enc_q(req.key.trim())));
  }
  if !req.picbed.trim().is_empty() {
    qs.push(format!("picbed={}", enc_q(req.picbed.trim())));
  }
  if !req.config_name.trim().is_empty() {
    qs.push(format!("configName={}", enc_q(req.config_name.trim())));
  }
  if !qs.is_empty() {
    url.push('?');
    url.push_str(&qs.join("&"));
  }

  let payload = serde_json::json!({
    "list": [req.path]
  });

  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| format!("build client error: {e}"))?;

  let res = client
    .post(&url)
    .json(&payload)
    .send()
    .await
    .map_err(|e| format!("send error: {e}"))?;

  let status = res.status();
  let v: Value = res.json().await.map_err(|e| format!("json error: {e}"))?;

  if !status.is_success() {
    return Err(format!("HTTP {}: {}", status.as_u16(), v));
  }

  let ok = v
    .get("success")
    .and_then(|x| x.as_bool())
    .unwrap_or(false);
  if !ok {
    return Err(format!("PicList 返回失败: {}", v));
  }

  let url_field = v
    .get("result")
    .and_then(|r| {
      if r.is_array() {
        r.get(0)
      } else {
        Some(r)
      }
    })
    .and_then(|x| x.as_str())
    .ok_or_else(|| format!("PicList 响应缺少 result 字段: {}", v))?;

  Ok(url_field.to_string())
}

// 为插件提供的“全库 Markdown 扫描”命令：在给定根目录下递归枚举所有 md/markdown/txt 文件
#[tauri::command]
async fn flymd_list_markdown_files(root: String) -> Result<Vec<String>, String> {
  use std::fs;
  use std::path::{Path, PathBuf};

  let root_path = PathBuf::from(root.clone());
  if !root_path.is_dir() {
    return Err(format!("root 不是有效目录: {}", root));
  }

  // 在后台线程递归遍历，避免阻塞 async runtime
  let result = tauri::async_runtime::spawn_blocking(move || {
    fn walk_dir(dir: &Path, acc: &mut Vec<String>) -> Result<(), String> {
      let entries = fs::read_dir(dir)
        .map_err(|e| format!("read_dir error ({}): {}", dir.display(), e))?;
      for entry in entries {
        let entry = entry.map_err(|e| format!("read_dir entry error: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
          walk_dir(&path, acc)?;
        } else if crate::is_markdown_like_path(&path) {
          if let Some(s) = path.to_str() {
            acc.push(s.to_string());
          }
        }
      }
      Ok(())
    }

    let mut acc = Vec::<String>::new();
    walk_dir(&root_path, &mut acc)?;
    Ok::<Vec<String>, String>(acc)
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;

  Ok(result)
}

fn main() {
  #[cfg(target_os = "linux")]
  init_linux_render_env();

  let builder = tauri::Builder::default()
    .manage(PendingOpenPath::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_window_state::Builder::default().build());

  #[cfg(target_os = "macos")]
  let builder = builder.plugin(init_macos_open_plugin());

  let builder = builder
    .invoke_handler(tauri::generate_handler![
        upload_to_s3,
        presign_put,
        flymd_record_uploaded_image,
        flymd_list_uploaded_images,
        flymd_delete_uploaded_image,
        move_to_trash,
        force_remove_path,
        read_text_file_any,
        write_text_file_any,
        get_pending_open_path,
      http_xmlrpc_post,
      flymd_piclist_upload,
      flymd_list_markdown_files,
      check_update,
      download_file,
      git_status_summary,
      git_file_history,
      git_file_diff,
      git_init_repo,
      git_commit_snapshot,
      git_restore_file_version,
      run_installer,
      // Android SAF 命令
      android_pick_document,
      android_create_document,
      android_read_uri,
      android_write_uri,
      android_persist_uri_permission,
      get_cli_args,
      get_platform,
      get_virtual_screen_size,
      open_as_sticky_note
    ])
    .setup(|app| {
      init_startup_log(&app.handle());
      write_startup_log("[setup] begin");

      // Windows "打开方式/默认程序" 传入的文件参数处理
      #[cfg(target_os = "windows")]
      {
        use std::env;
        use std::path::PathBuf;
        let args: Vec<PathBuf> = env::args_os().skip(1).map(PathBuf::from).collect();
        if let Some(p) = args.into_iter().find(|p| crate::is_supported_doc_path(p)) {
          let app_handle = app.handle();
          dispatch_open_file_event(&app_handle, &p);
        }
      }
      // macOS：Finder 通过“打开方式/双击”传入的文件参数处理
      #[cfg(target_os = "macos")]
      {
        use std::env;
        use std::path::PathBuf;
        let args: Vec<PathBuf> = env::args_os().skip(1).map(PathBuf::from).collect();
        if let Some(p) = args.into_iter().find(|p| crate::is_supported_doc_path(p)) {
          let app_handle = app.handle();
          dispatch_open_file_event(&app_handle, &p);
        }
      }
      // 其它初始化逻辑
      if let Some(win) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        {
          // Windows：仅负责延迟显示和聚焦，窗口装饰交由 Tauri 管理
          let win_clone = win.clone();
          std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let _ = win_clone.show();
            let _ = win_clone.set_focus();
          });
        }
        #[cfg(not(target_os = "windows"))]
        {
          let _ = win.show();
          let _ = win.set_focus();
        }
      }

      write_startup_log("[setup] end");
      Ok(())
    });

  builder
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[derive(Debug, Serialize)]
struct VirtualScreenSize {
  width: u32,
  height: u32,
  monitors: usize,
}

#[tauri::command]
async fn get_virtual_screen_size(app: tauri::AppHandle) -> Result<VirtualScreenSize, String> {
  // Android 暂不支持多屏信息：直接返回错误，前端回退到仅下限保护逻辑
  #[cfg(target_os = "android")]
  {
    let _ = app;
    return Err("virtual screen size not supported on android".into());
  }

  #[cfg(not(target_os = "android"))]
  {
    let monitors = app
      .available_monitors()
      .map_err(|e| format!("获取显示器信息失败: {e}"))?;
    if monitors.is_empty() {
      return Err("no monitors".into());
    }

    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;

    for m in &monitors {
      let pos = m.position();
      let size = m.size();
      if pos.x < min_x { min_x = pos.x; }
      if pos.y < min_y { min_y = pos.y; }
      let right = pos.x.saturating_add(size.width as i32);
      let bottom = pos.y.saturating_add(size.height as i32);
      if right > max_x { max_x = right; }
      if bottom > max_y { max_y = bottom; }
    }

    let width = max_x.saturating_sub(min_x).max(0) as u32;
    let height = max_y.saturating_sub(min_y).max(0) as u32;

    Ok(VirtualScreenSize {
      width,
      height,
      monitors: monitors.len(),
    })
  }
}

#[tauri::command]
async fn get_cli_args() -> Result<Vec<String>, String> {
  // 返回启动参数（去除可执行文件本身），用于 macOS 兜底打开文件
  use std::env;
  let args: Vec<String> = env::args_os()
    .skip(1)
    .map(|s| s.to_string_lossy().to_string())
    .collect();
  Ok(args)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAssetInfo {
  name: String,
  size: u64,
  direct_url: String,
  proxy_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckUpdateResp {
  has_update: bool,
  current: String,
  latest: String,
  release_name: String,
  notes: String,
  html_url: String,
  // Windows 推荐资产
  asset_win: Option<UpdateAssetInfo>,
  // Linux 双资产
  asset_linux_appimage: Option<UpdateAssetInfo>,
  asset_linux_deb: Option<UpdateAssetInfo>,
  // macOS 双资产（Intel / Apple Silicon）
  asset_macos_x64: Option<UpdateAssetInfo>,
  asset_macos_arm: Option<UpdateAssetInfo>,
}

fn norm_ver(v: &str) -> (i64, i64, i64, i64) {
  // 版本比较：major.minor.patch + 权重（fix>无后缀>预发行）
  let s = v.trim().trim_start_matches('v');
  let mut parts = s.splitn(2, '-');
  let core = parts.next().unwrap_or("");
  let suffix = parts.next().unwrap_or("").to_ascii_lowercase();
  let mut nums = core.split('.').take(3).map(|x| x.parse::<i64>().unwrap_or(0)).collect::<Vec<_>>();
  while nums.len() < 3 { nums.push(0); }
  let weight = if suffix.starts_with("fix") { 2 } else if suffix.is_empty() { 1 } else { 0 };
  (nums[0], nums[1], nums[2], weight)
}

fn is_better(a: &(i64,i64,i64,i64), b: &(i64,i64,i64,i64)) -> bool {
  // a > b ?
  a.0 > b.0 || (a.0==b.0 && (a.1 > b.1 || (a.1==b.1 && (a.2 > b.2 || (a.2==b.2 && a.3 > b.3)))))
}

#[derive(Debug, Deserialize)]
struct GhAsset {
  name: String,
  browser_download_url: String,
  size: Option<u64>,
  #[allow(dead_code)]
  content_type: Option<String>,
}
#[derive(Debug, Deserialize)]
struct GhRelease {
  tag_name: String,
  name: Option<String>,
  body: Option<String>,
  draft: bool,
  prerelease: bool,
  html_url: String,
  assets: Vec<GhAsset>,
}

fn gh_proxy_url(raw: &str) -> String {
  // 代理前缀：按“https://gh-proxy.comb/原始URL”拼接
  let prefix = "https://gh-proxy.com/";
  if raw.starts_with(prefix) { raw.to_string() } else { format!("{}{}", prefix, raw) }
}

fn os_arch_tag() -> (&'static str, &'static str) {
  let os = {
    #[cfg(target_os = "windows")] { "windows" }
    #[cfg(target_os = "linux")] { "linux" }
    #[cfg(target_os = "macos")] { "macos" }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))] { "other" }
  };
  let arch = {
    #[cfg(target_arch = "x86_64")] { "x86_64" }
    #[cfg(target_arch = "aarch64")] { "aarch64" }
    #[cfg(target_arch = "x86")] { "x86" }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "x86")))] { "other" }
  };
  (os, arch)
}

fn match_linux_assets(assets: &[GhAsset]) -> (Option<&GhAsset>, Option<&GhAsset>) {
  // 返回 (AppImage, Deb)
  let mut appimage: Option<&GhAsset> = None;
  let mut deb: Option<&GhAsset> = None;
  for a in assets {
    let n = a.name.to_ascii_lowercase();
    // 排除 ARM 相关
    let is_arm = n.contains("arm64") || n.contains("aarch64") || n.contains("armv7");
    if is_arm { continue; }
    if n.ends_with(".appimage") && (n.contains("x86_64") || n.contains("amd64")) {
      if appimage.is_none() { appimage = Some(a); }
    } else if n.ends_with(".deb") && (n.contains("x86_64") || n.contains("amd64")) {
      if deb.is_none() { deb = Some(a); }
    }
  }
  (appimage, deb)
}

fn match_windows_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
  for a in assets {
    let n = a.name.to_ascii_lowercase();
    let is_arm = n.contains("arm64") || n.contains("aarch64") || n.contains("armv7");
    if is_arm { continue; }
    if (n.ends_with(".exe") || n.ends_with(".msi")) && (n.contains("x64") || n.contains("x86_64") || n.contains("amd64")) {
      return Some(a);
    }
  }
  None
}

#[tauri::command]
async fn check_update(_force: Option<bool>, include_prerelease: Option<bool>) -> Result<CheckUpdateResp, String> {
  // 当前版本：与 tauri.conf.json 一致（构建时可由环境注入，这里直接读取 Cargo.toml 同步版本）
  let current = env!("CARGO_PKG_VERSION").to_string();
  let (os_tag, _arch_tag) = os_arch_tag();

  // 节流留空：简单实现始终请求（前端可决定调用频率）

  let url = "https://api.github.com/repos/flyhunterl/flymd/releases";
  let client = reqwest::Client::builder()
    .user_agent("flymd-updater")
    .build()
    .map_err(|e| format!("build client error: {e}"))?;
  let resp = client
    .get(url)
    .header("Accept", "application/vnd.github+json")
    .send().await.map_err(|e| format!("request error: {e}"))?;
  if !resp.status().is_success() { return Err(format!("http status {}", resp.status())); }
  let releases: Vec<GhRelease> = resp.json().await.map_err(|e| format!("json error: {e}"))?;
  let include_pre = include_prerelease.unwrap_or(false);
  let latest = releases.into_iter().find(|r| !r.draft && (include_pre || !r.prerelease))
    .ok_or_else(|| "no release found".to_string())?;

  // 统一版本号语义：从 tag_name 中剥离前缀 v，仅保留纯版本号（例如 v0.5.0 -> 0.5.0）
  let latest_tag = latest.tag_name.trim().trim_start_matches('v').to_string();
  let n_cur = norm_ver(&current);
  let n_new = norm_ver(&latest_tag);
  let has_update = is_better(&n_new, &n_cur);

  // 组装资产信息
  let mut asset_win = None;
  let mut asset_linux_appimage = None;
  let mut asset_linux_deb = None;
  let mut asset_macos_x64 = None;
  let mut asset_macos_arm = None;
  if os_tag == "windows" {
    if let Some(a) = match_windows_asset(&latest.assets) {
      asset_win = Some(UpdateAssetInfo{
        name: a.name.clone(),
        size: a.size.unwrap_or(0),
        direct_url: a.browser_download_url.clone(),
        proxy_url: gh_proxy_url(&a.browser_download_url),
      });
    }
  } else if os_tag == "linux" {
    let (ai, deb) = match_linux_assets(&latest.assets);
    if let Some(a) = ai {
      asset_linux_appimage = Some(UpdateAssetInfo{
        name: a.name.clone(),
        size: a.size.unwrap_or(0),
        direct_url: a.browser_download_url.clone(),
        proxy_url: gh_proxy_url(&a.browser_download_url),
      });
    }
    if let Some(a) = deb {
      asset_linux_deb = Some(UpdateAssetInfo{
        name: a.name.clone(),
        size: a.size.unwrap_or(0),
        direct_url: a.browser_download_url.clone(),
        proxy_url: gh_proxy_url(&a.browser_download_url),
      });
    }
  } else if os_tag == "macos" {
    let (x64, arm) = match_macos_assets(&latest.assets);
    if let Some(a) = x64 {
      asset_macos_x64 = Some(UpdateAssetInfo{
        name: a.name.clone(),
        size: a.size.unwrap_or(0),
        direct_url: a.browser_download_url.clone(),
        proxy_url: gh_proxy_url(&a.browser_download_url),
      });
    }
    if let Some(a) = arm {
      asset_macos_arm = Some(UpdateAssetInfo{
        name: a.name.clone(),
        size: a.size.unwrap_or(0),
        direct_url: a.browser_download_url.clone(),
        proxy_url: gh_proxy_url(&a.browser_download_url),
      });
    }
  }

  let notes = latest.body.unwrap_or_default();
  let name = latest.name.unwrap_or_else(|| latest_tag.clone());

  Ok(CheckUpdateResp{
    has_update,
    current,
    latest: latest_tag,
    release_name: name,
    notes,
    html_url: latest.html_url,
    asset_win,
    asset_linux_appimage,
    asset_linux_deb,
    asset_macos_x64,
    asset_macos_arm,
  })
}

#[tauri::command]
#[allow(unused_assignments)]
async fn download_file(url: String, use_proxy: Option<bool>) -> Result<String, String> {
  let client = reqwest::Client::builder()
    .user_agent("flymd-updater")
    .build()
    .map_err(|e| format!("build client error: {e}"))?;

  // 解析文件名
  let (direct, proxy) = {
    let u = url::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let fname = u
      .path_segments()
      .and_then(|mut s| s.next_back())
      .unwrap_or("download.bin")
      .to_string();
        // 保存到用户下载目录（不可用时回退到临时目录）
    #[cfg(target_os = "windows")]
    let base_download = std::env::var("USERPROFILE")
      .map(|p| std::path::PathBuf::from(p).join("Downloads"))
      .unwrap_or_else(|_| std::env::temp_dir());
    #[cfg(not(target_os = "windows"))]
    let base_download = std::env::var("HOME")
      .map(|p| std::path::PathBuf::from(p).join("Downloads"))
      .unwrap_or_else(|_| std::env::temp_dir());
    let mut path = base_download.clone();
    path.push(&fname);
    let direct = (u, path);
    let proxy = (
      url::Url::parse(&gh_proxy_url(&url)).map_err(|e| format!("invalid proxy url: {e}"))?,
      base_download.join(&fname)
    );
    (direct, proxy)
  };

  // 下载函数
  async fn do_fetch(client: &reqwest::Client, url: &url::Url, save: &std::path::Path) -> Result<(), String> {
    let resp = client.get(url.clone()).send().await.map_err(|e| format!("request error: {e}"))?;
    if !resp.status().is_success() { return Err(format!("http status {}", resp.status())); }
    let mut f = std::fs::File::create(save).map_err(|e| format!("create file error: {e}"))?;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
      let bytes = chunk.map_err(|e| format!("read chunk error: {e}"))?;
      std::io::Write::write_all(&mut f, &bytes).map_err(|e| format!("write error: {e}"))?;
    }
    Ok(())
  }

  let want_proxy = use_proxy.unwrap_or(false);
  let mut last_err: Option<String> = None;
  if want_proxy {
    if let Err(e) = do_fetch(&client, &proxy.0, &proxy.1).await { last_err = Some(e); } else { return Ok(proxy.1.to_string_lossy().to_string()); }
    // 代理失败 -> 尝试直连
    if let Err(e) = do_fetch(&client, &direct.0, &direct.1).await { last_err = Some(e); } else { return Ok(direct.1.to_string_lossy().to_string()); }
  } else {
    if let Err(e) = do_fetch(&client, &direct.0, &direct.1).await { last_err = Some(e); } else { return Ok(direct.1.to_string_lossy().to_string()); }
    // 直连失败 -> 尝试代理
    if let Err(e) = do_fetch(&client, &proxy.0, &proxy.1).await { last_err = Some(e); } else { return Ok(proxy.1.to_string_lossy().to_string()); }
  }
  Err(last_err.unwrap_or_else(|| "download failed".into()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusSummary {
  is_repo: bool,
  repo_root: Option<String>,
  branch: Option<String>,
  head: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitEntry {
  hash: String,
  summary: String,
  author: String,
  author_email: Option<String>,
  date: String,
}

#[tauri::command]
async fn git_status_summary(repo_path: String) -> Result<GitStatusSummary, String> {
  let res = tauri::async_runtime::spawn_blocking(move || {
    use std::path::Path;
    use std::process::Command;

    let path = Path::new(&repo_path);
    if !path.exists() {
      return Ok::<GitStatusSummary, String>(GitStatusSummary {
        is_repo: false,
        repo_root: None,
        branch: None,
        head: None,
      });
    }

    let output = Command::new("git")
      .args(["rev-parse", "--show-toplevel"])
      .current_dir(path)
      .output()
      .map_err(|e| format!("git rev-parse error: {e}"))?;

    if !output.status.success() {
      return Ok(GitStatusSummary {
        is_repo: false,
        repo_root: None,
        branch: None,
        head: None,
      });
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
      return Ok(GitStatusSummary {
        is_repo: false,
        repo_root: None,
        branch: None,
        head: None,
      });
    }

    let mut branch: Option<String> = None;
    let mut head: Option<String> = None;

    let out_branch = Command::new("git")
      .args(["rev-parse", "--abbrev-ref", "HEAD"])
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git rev-parse --abbrev-ref error: {e}"))?;
    if out_branch.status.success() {
      let s = String::from_utf8_lossy(&out_branch.stdout).trim().to_string();
      if !s.is_empty() {
        branch = Some(s);
      }
    }

    let out_head = Command::new("git")
      .args(["rev-parse", "HEAD"])
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git rev-parse HEAD error: {e}"))?;
    if out_head.status.success() {
      let s = String::from_utf8_lossy(&out_head.stdout).trim().to_string();
      if !s.is_empty() {
        head = Some(s);
      }
    }

    Ok(GitStatusSummary {
      is_repo: true,
      repo_root: Some(root),
      branch,
      head,
    })
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn git_restore_file_version(
  repo_path: String,
  file_path: String,
  commit: String,
) -> Result<(), String> {
  let res = tauri::async_runtime::spawn_blocking(move || {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(&repo_path);
    if !root.exists() {
      return Err("路径不存在".into());
    }

    let file = PathBuf::from(&file_path);
    if !file.exists() {
      return Err("目标文件不存在".into());
    }

    let rel = file.strip_prefix(&root).unwrap_or(&file);
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    let output = Command::new("git")
      .arg("show")
      .arg(format!("{commit}:{rel_str}"))
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git show error: {e}"))?;
    if !output.status.success() {
      let msg = String::from_utf8_lossy(&output.stderr).to_string();
      return Err(if msg.is_empty() { "git show failed".into() } else { msg });
    }

    fs::write(&file, &output.stdout).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn git_file_history(
  repo_path: String,
  file_path: String,
  max_count: Option<u32>,
) -> Result<Vec<GitCommitEntry>, String> {
  let res = tauri::async_runtime::spawn_blocking(move || {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(&repo_path);
    if !root.exists() {
      return Ok::<Vec<GitCommitEntry>, String>(Vec::new());
    }
    let file = PathBuf::from(&file_path);
    let rel = file.strip_prefix(&root).unwrap_or(&file);

    let max = max_count.unwrap_or(50).max(1);

    let mut cmd = Command::new("git");
    cmd.arg("log");
    cmd.arg(format!("--max-count={}", max));
    cmd.args([
      "--date=iso-strict",
      "--pretty=format:%H%x09%an%x09%ae%x09%ad%x09%s",
      "--",
    ]);
    cmd.arg(rel);

    let output = cmd
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git log error: {e}"))?;
    if !output.status.success() {
      return Ok(Vec::new());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut items: Vec<GitCommitEntry> = Vec::new();
    for line in text.lines() {
      let t = line.trim();
      if t.is_empty() {
        continue;
      }
      let parts: Vec<&str> = t.split('\t').collect();
      if parts.len() < 5 {
        continue;
      }
      let hash = parts[0].trim().to_string();
      let author = parts[1].trim().to_string();
      let email_str = parts[2].trim();
      let date = parts[3].trim().to_string();
      let summary = parts[4].trim().to_string();
      let author_email = if email_str.is_empty() {
        None
      } else {
        Some(email_str.to_string())
      };
      items.push(GitCommitEntry {
        hash,
        summary,
        author,
        author_email,
        date,
      });
    }
    Ok(items)
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn git_file_diff(
  repo_path: String,
  file_path: String,
  commit: Option<String>,
  context_lines: Option<u32>,
) -> Result<String, String> {
  let ctx = context_lines.unwrap_or(3);
  let commit_arg = commit.clone();

  let res = tauri::async_runtime::spawn_blocking(move || {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(&repo_path);
    if !root.exists() {
      return Ok::<String, String>(String::new());
    }
    let file = PathBuf::from(&file_path);
    let rel = file.strip_prefix(&root).unwrap_or(&file);

    let ctx_lines = if ctx == 0 { 1 } else { ctx };

    let mut cmd = Command::new("git");
    if let Some(cmt) = commit_arg {
      cmd.arg("show");
      cmd.arg(format!("--unified={}", ctx_lines));
      cmd.arg(cmt);
      cmd.arg("--");
      cmd.arg(rel);
    } else {
      cmd.arg("diff");
      cmd.arg(format!("--unified={}", ctx_lines));
      cmd.arg("HEAD");
      cmd.arg("--");
      cmd.arg(rel);
    }

    let output = cmd
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git diff error: {e}"))?;
    if !output.status.success() {
      return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn git_init_repo(repo_path: String) -> Result<(), String> {
  let res = tauri::async_runtime::spawn_blocking(move || {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(&repo_path);
    if !root.exists() {
      return Err("路径不存在".into());
    }

    let output = Command::new("git")
      .arg("init")
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git init error: {e}"))?;
    if !output.status.success() {
      let msg = String::from_utf8_lossy(&output.stderr).to_string();
      return Err(if msg.is_empty() { "git init failed".into() } else { msg });
    }
    Ok(())
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn git_commit_snapshot(
  repo_path: String,
  file_path: Option<String>,
  message: String,
  all: Option<bool>,
) -> Result<(), String> {
  let res = tauri::async_runtime::spawn_blocking(move || {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(&repo_path);
    if !root.exists() {
      return Err("路径不存在".into());
    }

    let scope_all = all.unwrap_or(false) || file_path.is_none();

    let mut add_cmd = Command::new("git");
    add_cmd.arg("add");
    if scope_all {
      add_cmd.arg("--all");
    } else if let Some(fp) = &file_path {
      let file = PathBuf::from(fp);
      let rel = file.strip_prefix(&root).unwrap_or(&file);
      add_cmd.arg(rel);
    }
    let add_out = add_cmd
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git add error: {e}"))?;
    if !add_out.status.success() {
      let msg = String::from_utf8_lossy(&add_out.stderr).to_string();
      return Err(if msg.is_empty() { "git add failed".into() } else { msg });
    }

    let mut commit_cmd = Command::new("git");
    commit_cmd.arg("commit").arg("-m").arg(message);
    let commit_out = commit_cmd
      .current_dir(&root)
      .output()
      .map_err(|e| format!("git commit error: {e}"))?;
    if !commit_out.status.success() {
      let msg = String::from_utf8_lossy(&commit_out.stderr).to_string();
      if msg.contains("nothing to commit") {
        return Ok(());
      }
      return Err(if msg.is_empty() { "git commit failed".into() } else { msg });
    }

    Ok(())
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn read_text_file_any(path: String) -> Result<String, String> {
  use std::fs::File;
  use std::io::Read;
  use std::path::PathBuf;

  let pathbuf = PathBuf::from(path);
  if !pathbuf.exists() {
    return Err("path not found".into());
  }

  // 后台线程读取，避免阻塞异步运行时
  let res = tauri::async_runtime::spawn_blocking(move || {
    let mut f = File::open(&pathbuf).map_err(|e| format!("open error: {e}"))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| format!("read error: {e}"))?;
    let s = String::from_utf8_lossy(&buf).to_string();
    Ok::<String, String>(s)
  })
  .await
  .map_err(|e| format!("join error: {e}"))?;

  res
}

#[tauri::command]
async fn write_text_file_any(path: String, content: String) -> Result<(), String> {
  use std::fs;
  use std::path::PathBuf;

  let pathbuf = PathBuf::from(path);
  // 后台线程写入，避免阻塞异步执行器
  tauri::async_runtime::spawn_blocking(move || {
    if let Some(parent) = pathbuf.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("create_dir_all error: {e}"))?;
    }
    fs::write(&pathbuf, content.as_bytes()).map_err(|e| format!("write error: {e}"))?;
    Ok::<(), String>(())
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;

  Ok(())
}

// 前端兜底查询：获取并清空待打开路径，避免事件竞态丢失
#[tauri::command]
async fn get_pending_open_path(state: State<'_, PendingOpenPath>) -> Result<Option<String>, ()> {
  if let Ok(mut slot) = state.0.lock() {
    Ok(slot.take())
  } else {
    Ok(None)
  }
}

#[tauri::command]
async fn move_to_trash(path: String) -> Result<(), String> {
  // 使用 trash crate 跨平台移动到回收站
  tauri::async_runtime::spawn_blocking(move || {
    trash::delete(path).map_err(|e| format!("move_to_trash error: {e}"))
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;
  Ok(())
}

#[tauri::command]
async fn force_remove_path(path: String) -> Result<(), String> {
  use std::fs;
  use std::path::PathBuf;
  let pathbuf = PathBuf::from(path);
  tauri::async_runtime::spawn_blocking(move || {
    if pathbuf.is_dir() {
      fs::remove_dir_all(&pathbuf).map_err(|e| format!("remove_dir_all error: {e}"))
    } else {
      fs::remove_file(&pathbuf).map_err(|e| format!("remove_file error: {e}"))
    }
  })
  .await
  .map_err(|e| format!("join error: {e}"))??;
  Ok(())
}

#[tauri::command]
async fn run_installer(path: String) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    use std::process::Command;
    // 使用 PowerShell 以管理员权限启动安装程序
    let status = Command::new("powershell")
      .args([
        "-NoProfile",
        "-Command",
        "Start-Process",
        "-FilePath",
        &path,
        "-Verb",
        "runas",
      ])
      .status()
      .map_err(|e| format!("spawn error: {e}"))?;
    let _ = status; // 忽略返回码，由安装器自行处理
    Ok(())
  }
  #[cfg(not(target_os = "windows"))]
  {
    Err("run_installer only supports Windows".into())
  }
}

// ============ Android SAF 文件操作命令（移动端专用） ============
// 这些命令在 Android 上通过 JNI 调用原生 SAF API
// 桌面版返回错误提示

#[tauri::command]
async fn android_pick_document() -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    // TODO: 实现 JNI 调用 Intent ACTION_OPEN_DOCUMENT
    // 返回 content:// URI
    Err("android_pick_document: JNI implementation pending".into())
  }
  #[cfg(not(target_os = "android"))]
  {
    Err("android_pick_document only available on Android".into())
  }
}

#[tauri::command]
async fn android_create_document(_filename: String, _mime_type: String) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    // TODO: 实现 JNI 调用 Intent ACTION_CREATE_DOCUMENT
    // 返回 content:// URI
    let _ = filename;
    let _ = mime_type;
    Err("android_create_document: JNI implementation pending".into())
  }
  #[cfg(not(target_os = "android"))]
  {
    Err("android_create_document only available on Android".into())
  }
}

#[tauri::command]
async fn android_read_uri(_uri: String) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    // TODO: 实现 JNI 调用 ContentResolver.openInputStream
    // 读取 URI 内容并返回文本
    let _ = uri;
    Err("android_read_uri: JNI implementation pending".into())
  }
  #[cfg(not(target_os = "android"))]
  {
    Err("android_read_uri only available on Android".into())
  }
}

#[tauri::command]
async fn android_write_uri(_uri: String, _content: String) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    // TODO: 实现 JNI 调用 ContentResolver.openOutputStream
    // 写入内容到 URI
    let _ = uri;
    let _ = content;
    Err("android_write_uri: JNI implementation pending".into())
  }
  #[cfg(not(target_os = "android"))]
  {
    Err("android_write_uri only available on Android".into())
  }
}

#[tauri::command]
async fn android_persist_uri_permission(_uri: String) -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    // TODO: 实现 JNI 调用 takePersistableUriPermission
    // 持久化 URI 访问权限
    let _ = uri;
    Err("android_persist_uri_permission: JNI implementation pending".into())
  }
  #[cfg(not(target_os = "android"))]
  {
    Err("android_persist_uri_permission only available on Android".into())
  }
}

// 便签模式：以新实例打开文件并自动进入便签模式
#[tauri::command]
async fn open_as_sticky_note(path: String) -> Result<(), String> {
  use std::process::Command;
  use std::env;

  let exe = env::current_exe().map_err(|e| format!("获取可执行文件路径失败: {e}"))?;

  Command::new(exe)
    .arg("--sticky-note")
    .arg(&path)
    .spawn()
    .map_err(|e| format!("启动便签实例失败: {e}"))?;

  Ok(())
}

#[tauri::command]
async fn get_platform() -> Result<String, String> {
  // 返回当前平台标识，前端用于条件分支
  #[cfg(target_os = "android")]
  {
    Ok("android".into())
  }
  #[cfg(target_os = "windows")]
  {
    Ok("windows".into())
  }
  #[cfg(target_os = "linux")]
  {
    Ok("linux".into())
  }
  #[cfg(target_os = "macos")]
  {
    Ok("macos".into())
  }
  #[cfg(not(any(target_os = "android", target_os = "windows", target_os = "linux", target_os = "macos")))]
  {
    Ok("unknown".into())
  }
}

fn match_macos_assets(assets: &[GhAsset]) -> (Option<&GhAsset>, Option<&GhAsset>) {
  // 返回 (x64, arm64)；优先使用 macOS 专用包，避免误选 Windows 便携 ZIP
  let mut x64: Option<&GhAsset> = None;
  let mut arm: Option<&GhAsset> = None;
  for a in assets {
    let n = a.name.to_ascii_lowercase();
    // 仅考虑 macOS 常见包后缀：
    // - .dmg / .pkg：安装包
    // - .app.zip：打包后的 .app（避免把 Windows 便携版 zip 当成 mac 包）
    let is_macos_pkg = n.ends_with(".dmg") || n.ends_with(".pkg") || n.ends_with(".app.zip");
    if !is_macos_pkg { continue; }

    // 通用（universal）包：同时填充 x64 / arm，前端统一走“立即更新”
    let is_universal = n.contains("universal");
    if is_universal {
      if x64.is_none() { x64 = Some(a); }
      if arm.is_none() { arm = Some(a); }
      continue;
    }

    if (n.contains("arm64") || n.contains("aarch64")) && arm.is_none() {
      arm = Some(a);
      continue;
    }
    if (n.contains("x86_64") || n.contains("x64") || n.contains("amd64")) && x64.is_none() {
      x64 = Some(a);
      continue;
    }
  }
  (x64, arm)
}

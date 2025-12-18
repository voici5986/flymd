// AI 小说引擎（强制后端）
// 原则：
// 1) 计费与质量保证在后端，插件只是 UI
// 2) 默认不自动写回文档（用户确认后再写）
// 3) 只调用后端：/auth/* /billing/* /ai/proxy/*

const CFG_KEY = 'aiNovel.config'
const DRAFT_KEY = 'aiNovel.lastDraft'
const AI_LOCALE_LS_KEY = 'flymd.locale'

// fetch 的硬超时：避免网络/CORS 卡死导致 UI 永久无响应（给足时间，不影响正常长请求）
const API_FETCH_TIMEOUT_MS = 200000

const DEFAULT_CFG = {
  // 后端地址：强制内置，不在设置里展示
  backendBaseUrl: 'https://flymd.llingfei.com/xiaoshuo',
  token: '',
  novelRootDir: '小说/', // 相对库根目录，用户可改
  currentProjectRel: '', // 当前小说项目（相对库根目录），为空则从当前文件路径推断
  upstream: {
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-chat'
  },
  embedding: {
    baseUrl: '',
    apiKey: '',
    model: 'voyage-3'
  },
  ctx: {
    // 上游模型的上下文窗口（字符，不是 token；会有误差，但足够实用）
    modelContextChars: 32000,
    maxPrevChars: 8000,
    maxProgressChars: 10000,
    maxBibleChars: 10000,
    // “更新进度脉络”用于生成提议的源文本上限（字符）
    maxUpdateSourceChars: 20000
  },
  rag: {
    enabled: true,
    autoBuildIndex: true,
    topK: 6,
    maxChars: 2400,
    chunkSize: 900,
    chunkOverlap: 160,
    // 自动更新进度脉络：仅在“用户确认追加正文到文档/创建项目写入章节”后触发（避免生成但未采用也写进度）
    autoUpdateProgress: true
  },
  constraints: {
    // 全局硬约束：每次请求都会作为 input.constraints 传给后端，进入 system
    global: ''
  },
  agent: {
    // Agent（Plan/TODO）模式：把一次写作拆成多轮执行，提高上限与一致性（代价：更耗字符/更慢）
    enabled: false,
    // 写作字数目标（总字数）：为了审阅成本，最大只允许到 4000
    targetChars: 3000,
    // 自动审计默认关闭（让用户自己决定要不要花预算）
    audit: false
  }
}

let __CTX__ = null
let __DIALOG__ = null
let __MINIBAR__ = null
let __MINI__ = null

function detectLocale() {
  try {
    const v = localStorage.getItem(AI_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  try {
    const lang = (navigator && (navigator.language || navigator.userLanguage)) || 'en'
    if (String(lang).toLowerCase().startsWith('zh')) return 'zh'
  } catch {}
  return 'zh'
}

function t(zh, en) {
  return detectLocale() === 'en' ? en : zh
}

async function loadCfg(ctx) {
  try {
    const raw = await ctx.storage.get(CFG_KEY)
    if (raw && typeof raw === 'object') {
      const out = { ...DEFAULT_CFG, ...raw }
      // 后端地址强制内置（不在 UI 暴露）
      out.backendBaseUrl = DEFAULT_CFG.backendBaseUrl
      // 清理历史默认值：不要把旧的 flymd 代理地址塞回 UI
      try {
        const legacy = 'https://flymd.llingfei.com/ai/ai_proxy.php'
        if (out.upstream && out.upstream.baseUrl === legacy) out.upstream.baseUrl = ''
        if (out.embedding && out.embedding.baseUrl === legacy) out.embedding.baseUrl = ''
      } catch {}
      return out
    }
  } catch {}
  return { ...DEFAULT_CFG }
}

async function saveCfg(ctx, patch) {
  const cur = await loadCfg(ctx)
  const out = { ...cur, ...(patch || {}) }
  // 后端地址强制内置（不允许被保存覆盖）
  out.backendBaseUrl = DEFAULT_CFG.backendBaseUrl
  await ctx.storage.set(CFG_KEY, out)
  return out
}

function normBase(u) {
  const s = String(u || '').trim().replace(/\/+$/, '')
  return s
}

function joinUrl(base, path) {
  const b = normBase(base)
  const p = String(path || '').replace(/^\/+/, '')
  return b + '/' + p
}

function fetchWithTimeout(url, init, timeoutMs) {
  const ms = Math.max(1000, Number(timeoutMs) || 0)
  // 极少数环境没 AbortController：只能退回原生 fetch（仍可能卡死，但至少不破坏功能）
  if (typeof AbortController === 'undefined') return fetch(url, init)
  const ctl = new AbortController()
  const timer = setTimeout(() => {
    try { ctl.abort() } catch {}
  }, ms)
  const init2 = { ...(init || {}), signal: ctl.signal }
  return fetch(url, init2).finally(() => {
    try { clearTimeout(timer) } catch {}
  })
}

function getOrCreateDeviceId() {
  const k = 'aiNovel.deviceId'
  try {
    const old = localStorage.getItem(k)
    if (old && String(old).length >= 16) return String(old)
  } catch {}
  let id = ''
  try {
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    id = Array.from(buf).map((x) => x.toString(16).padStart(2, '0')).join('')
  } catch {
    id = String(Date.now()) + '-' + Math.random().toString(16).slice(2)
  }
  try { localStorage.setItem(k, id) } catch {}
  return id
}

async function apiFetch(ctx, cfg, path, body) {
  const base = normBase(cfg.backendBaseUrl)
  if (!base) throw new Error(t('后端未配置', 'Backend is not configured'))
  const url = joinUrl(base, path)

  // 桌面版（Tauri）下 fetch 会被 CORS/OPTIONS 预检卡死：优先走宿主侧 reqwest 代理
  if (ctx && typeof ctx.invoke === 'function') {
    try {
      return await ctx.invoke('ai_novel_api', {
        req: {
          path: String(path || ''),
          method: 'POST',
          token: cfg.token ? String(cfg.token) : '',
          body: body || {}
        }
      })
    } catch (e) {
      // 宿主未实现命令时，降级到 fetch（可能仍会因为跨域失败）
      const msg = e && e.message ? String(e.message) : String(e)
      if (!/ai_novel_api|unknown command|not found/i.test(msg)) throw e
    }
  }

  const headers = { 'Content-Type': 'application/json' }
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token
  let res
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    }, API_FETCH_TIMEOUT_MS)
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    throw new Error(t('网络请求失败：', 'Network request failed: ') + msg + t('（常见原因：后端未处理 CORS/OPTIONS 预检，或网络不可达）', ' (common: backend missing CORS/OPTIONS preflight, or network unreachable)') + ' ' + url)
  }
  const txt = await res.text()
  let json = null
  try { json = txt ? JSON.parse(txt) : null } catch {}
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) ? (json.error || json.message) : (txt || String(res.status))
    throw new Error(msg)
  }
  if (!json || typeof json !== 'object') throw new Error(t('后端返回非 JSON', 'Backend returned non-JSON'))
  if (json.ok === false) throw new Error(String(json.error || 'error'))
  return json
}

async function apiGet(ctx, cfg, path) {
  const base = normBase(cfg.backendBaseUrl)
  if (!base) throw new Error(t('后端未配置', 'Backend is not configured'))
  // GET 一律加时间戳防缓存（CDN/中间层不讲武德时很常见）
  const url = joinUrl(base, path) + (String(path || '').includes('?') ? '&' : '?') + '_ts=' + Date.now()

  // 桌面版（Tauri）下 fetch 会被 CORS/OPTIONS 预检卡死：优先走宿主侧 reqwest 代理
  if (ctx && typeof ctx.invoke === 'function') {
    try {
      return await ctx.invoke('ai_novel_api', {
        req: {
          path: String(path || '') + (String(path || '').includes('?') ? '&' : '?') + '_ts=' + Date.now(),
          method: 'GET',
          token: cfg.token ? String(cfg.token) : ''
        }
      })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      if (!/ai_novel_api|unknown command|not found/i.test(msg)) throw e
    }
  }

  const headers = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token
  let res
  try {
    res = await fetchWithTimeout(url, { method: 'GET', headers, cache: 'no-store' }, API_FETCH_TIMEOUT_MS)
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    throw new Error(t('网络请求失败：', 'Network request failed: ') + msg + t('（常见原因：后端未处理 CORS/OPTIONS 预检，或网络不可达）', ' (common: backend missing CORS/OPTIONS preflight, or network unreachable)') + ' ' + url)
  }
  const txt = await res.text()
  let json = null
  try { json = txt ? JSON.parse(txt) : null } catch {}
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) ? (json.error || json.message) : (txt || String(res.status))
    throw new Error(msg)
  }
  if (!json || typeof json !== 'object') throw new Error(t('后端返回非 JSON', 'Backend returned non-JSON'))
  if (json.ok === false) throw new Error(String(json.error || 'error'))
  return json
}

function sleep(ms) {
  const n = Math.max(0, ms | 0)
  return new Promise((r) => setTimeout(r, n))
}

async function apiFetchConsultWithJob(ctx, cfg, body, opt) {
  const onTick = opt && typeof opt.onTick === 'function' ? opt.onTick : null
  const timeoutMs = opt && opt.timeoutMs ? Number(opt.timeoutMs) : 190000

  const b = body && typeof body === 'object' ? body : {}
  const input = (b.input && typeof b.input === 'object') ? b.input : {}
  const body2 = { ...b, input: { ...input, async: true, mode: 'job' } }

  const first = await apiFetch(ctx, cfg, 'ai/proxy/consult/', body2)
  const jobId = first && (first.job_id || first.jobId)
  if (!jobId) return first

  const start = Date.now()
  let waitMs = 0
  for (;;) {
    waitMs = Date.now() - start
    if (waitMs > timeoutMs) {
      throw new Error(t('咨询超时：任务仍未完成，请稍后重试或换模型', 'Consult timeout: job still pending, please retry or switch model'))
    }

    if (onTick) {
      try { onTick({ jobId, waitMs }) } catch {}
    }

    await sleep(1000)
    const st = await apiGet(ctx, cfg, 'ai/proxy/consult/status/?id=' + encodeURIComponent(String(jobId)))
    const s = st && st.status ? String(st.status) : ''
    if (s === 'pending') continue
    if (s === 'error') throw new Error(String(st.error || '任务失败'))
    if (s === 'ok' && st.result && typeof st.result === 'object') return st.result
    throw new Error(t('任务状态异常', 'Invalid job status'))
  }
}

async function apiFetchChatWithJob(ctx, cfg, body, opt) {
  const onTick = opt && typeof opt.onTick === 'function' ? opt.onTick : null
  const timeoutMs = opt && opt.timeoutMs ? Number(opt.timeoutMs) : 190000

  const b = body && typeof body === 'object' ? body : {}
  const input = (b.input && typeof b.input === 'object') ? b.input : {}
  const body2 = { ...b, input: { ...input, async: true, mode: 'job' } }

  const first = await apiFetch(ctx, cfg, 'ai/proxy/chat/', body2)
  const jobId = first && (first.job_id || first.jobId)
  // 兼容旧后端：不支持 job 时会直接返回 {text,...}
  if (!jobId) return first

  const start = Date.now()
  let waitMs = 0
  for (;;) {
    waitMs = Date.now() - start
    if (waitMs > timeoutMs) {
      throw new Error(t('审计超时：任务仍未完成，请稍后重试或换模型', 'Audit timeout: job still pending, please retry or switch model'))
    }

    if (onTick) {
      try { onTick({ jobId, waitMs }) } catch {}
    }

    await sleep(1000)
    const st = await apiGet(ctx, cfg, 'ai/proxy/chat/status/?id=' + encodeURIComponent(String(jobId)))
    const s = st && st.status ? String(st.status) : ''
    if (s === 'pending') continue
    if (s === 'error') throw new Error(String(st.error || '任务失败'))
    if (s === 'ok' && st.result && typeof st.result === 'object') return st.result
    throw new Error(t('任务状态异常', 'Invalid job status'))
  }
}

function sliceTail(s, maxChars) {
  const str = String(s || '')
  const m = Math.max(0, maxChars | 0)
  if (!m || str.length <= m) return str
  return str.slice(str.length - m)
}

function sliceHeadTail(s, maxChars, headRatio) {
  const str = String(s || '')
  const m = Math.max(0, maxChars | 0)
  if (!m || str.length <= m) return str
  const r = Math.min(0.8, Math.max(0.2, Number(headRatio || 0.45) || 0.45))
  const sep = '\n\n……（中间省略）……\n\n'
  const headLen = Math.max(1, Math.floor((m - sep.length) * r))
  const tailLen = Math.max(1, (m - sep.length) - headLen)
  const head = str.slice(0, headLen)
  const tail = str.slice(Math.max(0, str.length - tailLen))
  return head + sep + tail
}

function _ainEscapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function _ainDiffNormEol(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function _ainDiffIsBreakChar(ch) {
  // 粗粒度分块：避免 3000 字全文逐字符 diff 把浏览器搞到卡死
  return ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';' || ch === '…'
}

function _ainDiffTokenize(text, maxChunkLen) {
  const s = _ainDiffNormEol(text)
  const maxLen = Math.max(20, (maxChunkLen | 0) || 80)
  const out = []
  let buf = ''
  let lastBreak = -1
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    buf += ch
    if (ch === '\n') {
      out.push(buf)
      buf = ''
      lastBreak = -1
      continue
    }
    if (_ainDiffIsBreakChar(ch)) lastBreak = buf.length
    if (buf.length >= maxLen) {
      if (lastBreak > 0 && lastBreak < buf.length) {
        out.push(buf.slice(0, lastBreak))
        buf = buf.slice(lastBreak)
      } else {
        out.push(buf)
        buf = ''
      }
      lastBreak = -1
    }
  }
  if (buf) out.push(buf)
  return out
}

function _ainDiffLcsOps(aTokens, bTokens) {
  const a = Array.isArray(aTokens) ? aTokens : []
  const b = Array.isArray(bTokens) ? bTokens : []
  const n = a.length
  const m = b.length
  const cols = m + 1
  const dp = new Uint16Array((n + 1) * (m + 1))

  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    for (let j = 1; j <= m; j++) {
      const idx = i * cols + j
      if (ai === b[j - 1]) {
        dp[idx] = (dp[(i - 1) * cols + (j - 1)] + 1) | 0
      } else {
        const up = dp[(i - 1) * cols + j]
        const left = dp[i * cols + (j - 1)]
        dp[idx] = up >= left ? up : left
      }
    }
  }

  const ops = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ t: 'eq', s: a[i - 1] })
      i--
      j--
      continue
    }
    const up = dp[(i - 1) * cols + j]
    const left = dp[i * cols + (j - 1)]
    if (up >= left) {
      ops.push({ t: 'del', s: a[i - 1] })
      i--
    } else {
      ops.push({ t: 'ins', s: b[j - 1] })
      j--
    }
  }
  while (i > 0) {
    ops.push({ t: 'del', s: a[i - 1] })
    i--
  }
  while (j > 0) {
    ops.push({ t: 'ins', s: b[j - 1] })
    j--
  }
  ops.reverse()
  return ops
}

function _ainDiffStats(ops) {
  const arr = Array.isArray(ops) ? ops : []
  let insChars = 0
  let delChars = 0
  let insSegs = 0
  let delSegs = 0
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i]
    const t0 = it && it.t ? String(it.t) : ''
    const s0 = safeText(it && it.s)
    if (t0 === 'ins') {
      insSegs++
      insChars += s0.length
    } else if (t0 === 'del') {
      delSegs++
      delChars += s0.length
    }
  }
  return { insChars, delChars, insSegs, delSegs }
}

function _ainDiffRenderHtml(ops, mode) {
  const arr = Array.isArray(ops) ? ops : []
  const m = String(mode || 'new')
  let html = ''
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {}
    const t0 = String(it.t || '')
    const s0 = _ainEscapeHtml(it.s)
    if (t0 === 'eq') html += s0
    else if (t0 === 'ins') html += `<mark>${s0}</mark>`
    else if (t0 === 'del' && m === 'combined') html += `<del>${s0}</del>`
  }
  return html
}

function normFsPath(p) {
  return String(p || '').replace(/\\/g, '/')
}

function joinFsPath(a, b) {
  const x = normFsPath(a).replace(/\/+$/, '')
  const y = normFsPath(b).replace(/^\/+/, '')
  if (!x) return y
  if (!y) return x
  return x + '/' + y
}

function safeFileName(name, fallback) {
  const raw = String(name || '').trim()
  const s = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const out = s || String(fallback || '未命名')
  // Windows 保留名（粗暴处理）
  const upper = out.toUpperCase()
  const reserved = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'])
  if (reserved.has(upper)) return '_' + out
  return out
}

function fsBaseName(p) {
  const s = normFsPath(p).replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

async function listMarkdownFilesAny(ctx, rootAbs) {
  // 依赖宿主命令递归枚举目录下 md/markdown/txt
  if (ctx && typeof ctx.invoke === 'function') {
    try {
      const arr = await ctx.invoke('flymd_list_markdown_files', { root: rootAbs })
      return Array.isArray(arr) ? arr.map((x) => normFsPath(x)) : []
    } catch {
      return []
    }
  }
  return []
}

function zhNumber(n) {
  // 只服务“章节号”，够用就行：1~999
  const x = n | 0
  if (x <= 0) return String(x)
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (x < 10) return d[x]
  if (x < 20) return x === 10 ? '十' : ('十' + d[x % 10])
  if (x < 100) {
    const a = (x / 10) | 0
    const b = x % 10
    return d[a] + '十' + (b ? d[b] : '')
  }
  if (x < 1000) {
    const a = (x / 100) | 0
    const rest = x % 100
    if (!rest) return d[a] + '百'
    if (rest < 10) return d[a] + '百零' + d[rest]
    return d[a] + '百' + zhNumber(rest)
  }
  return String(x)
}

async function fileExists(ctx, absPath) {
  try {
    // 优先走宿主侧读取：避免插件宿主 readTextFile 在“目录不存在”时刷屏报错
    if (ctx && typeof ctx.invoke === 'function') {
      await ctx.invoke('read_text_file_any', { path: absPath })
      return true
    }
  } catch {}
  try {
    if (!ctx || typeof ctx.readTextFile !== 'function') return false
    await ctx.readTextFile(absPath)
    return true
  } catch {
    return false
  }
}

async function readTextAny(ctx, absPath) {
  if (ctx && typeof ctx.invoke === 'function') {
    return await ctx.invoke('read_text_file_any', { path: absPath })
  }
  if (ctx && typeof ctx.readTextFile === 'function') {
    return await ctx.readTextFile(absPath)
  }
  throw new Error(t('当前环境不支持读文件', 'File read is not supported in this environment'))
}

async function computeNextChapterPath(ctx, cfg) {
  const inf = await inferProjectDir(ctx, cfg)
  if (!inf) return null

  const chapDir = joinFsPath(inf.projectAbs, '03_章节')
  const files = await listMarkdownFilesAny(ctx, chapDir)

  let maxNo = 0
  for (let i = 0; i < files.length; i++) {
    const bn = fsBaseName(files[i] || '')
    const m = /^(\d{3,})_/.exec(bn)
    if (!m || !m[1]) continue
    const k = parseInt(m[1], 10)
    if (Number.isFinite(k) && k > maxNo) maxNo = k
  }

  let nextNo = (maxNo | 0) + 1
  if (nextNo <= 0) nextNo = 1

  // 冲突就递增（极端情况：用户手工建了很多同名）
  for (let tries = 0; tries < 1000; tries++) {
    const pad = String(nextNo).padStart(3, '0')
    const z = zhNumber(nextNo)
    const chapPath = joinFsPath(chapDir, `${pad}_第${z}章.md`)
    const exists = await fileExists(ctx, chapPath)
    if (!exists) {
      return { ...inf, chapDir, chapPath, chapNo: nextNo, chapZh: z }
    }
    nextNo++
  }
  return null
}

async function getPrevChapterTailText(ctx, cfg, maxChars) {
  try {
    if (!ctx || !cfg) return ''
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return ''

    const chapDir = joinFsPath(inf.projectAbs, '03_章节')
    const files = await listMarkdownFilesAny(ctx, chapDir)
    if (!files.length) return ''

    let curPath = ''
    try {
      if (ctx.getCurrentFilePath) curPath = String(await ctx.getCurrentFilePath() || '')
    } catch {}
    const curBase = curPath ? fsBaseName(curPath) : ''
    let curNo = 0
    const m0 = /^(\d{3,})_/.exec(curBase)
    if (m0 && m0[1]) {
      const x = parseInt(m0[1], 10)
      if (Number.isFinite(x)) curNo = x
    }

    // 优先取“当前章节号 - 1”；否则取目录里最大章节号（排除当前文件），作为上一章。
    let targetNo = 0
    if (curNo > 1) {
      targetNo = curNo - 1
    } else {
      for (let i = 0; i < files.length; i++) {
        const bn = fsBaseName(files[i] || '')
        if (!bn) continue
        const mm = /^(\d{3,})_/.exec(bn)
        if (!mm || !mm[1]) continue
        const n = parseInt(mm[1], 10)
        if (!Number.isFinite(n) || n <= 0) continue
        if (curBase && bn === curBase) continue
        if (n > targetNo) targetNo = n
      }
    }

    if (targetNo <= 0) return ''
    const pad = String(targetNo).padStart(3, '0')
    let targetPath = ''
    for (let i = 0; i < files.length; i++) {
      const bn = fsBaseName(files[i] || '')
      if (bn && bn.startsWith(pad + '_')) {
        targetPath = files[i]
        break
      }
    }
    if (!targetPath) return ''

    const raw = await readTextAny(ctx, targetPath)
    const t0 = sliceTail(String(raw || ''), maxChars)
    return t0
  } catch {
    return ''
  }
}

async function getPrevTextForRequest(ctx, cfg) {
  const lim = cfg && cfg.ctx && cfg.ctx.maxPrevChars ? (cfg.ctx.maxPrevChars | 0) : 8000
  const doc = String(ctx && ctx.getEditorValue ? (ctx.getEditorValue() || '') : '')
  const tail = sliceTail(doc, lim)
  // 当前文档已经有足够正文，就直接用它（避免反复读文件）
  if (safeText(tail).trim().length >= 200) return tail

  const prevChap = await getPrevChapterTailText(ctx, cfg, lim)
  if (safeText(prevChap).trim()) return prevChap
  return tail
}

async function getPrevTextForRevise(ctx, cfg, baseText) {
  // 修订草稿时，“前文尾部”更应该优先取上一章；
  // 否则当前文档尾部往往就是草稿本身，会把待修订文本重复塞两遍，既浪费预算也容易让模型复读。
  try {
    const lim = cfg && cfg.ctx && cfg.ctx.maxPrevChars ? (cfg.ctx.maxPrevChars | 0) : 8000
    const prevChap = await getPrevChapterTailText(ctx, cfg, lim)
    if (safeText(prevChap).trim()) return prevChap

    const doc = String(ctx && ctx.getEditorValue ? (ctx.getEditorValue() || '') : '')
    const tail = sliceTail(doc, lim)
    const keyLen = Math.min(800, Math.max(200, ((lim / 10) | 0)))
    const key = sliceTail(String(baseText || ''), keyLen).trim()
    if (key && tail.includes(key)) return ''
    return tail
  } catch {
    return ''
  }
}

async function inferProjectDir(ctx, cfg) {
  // 从“当前文档路径”推断项目目录：.../<小说根>/<项目名>/...
  try {
    if (!ctx.getCurrentFilePath || !ctx.getLibraryRoot) return null
    const curPath = await ctx.getCurrentFilePath()
    const libRoot = await ctx.getLibraryRoot()
    if (!curPath || !libRoot) return null

    const root = normFsPath(libRoot).replace(/\/+$/, '')
    const rootPrefix = normFsPath(cfg.novelRootDir || '小说/')
    const rootParts = rootPrefix.split('/').filter(Boolean)

    // 如果用户显式选择了项目，优先用它
    const fixed = String(cfg.currentProjectRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (fixed) {
      const parts = fixed.split('/').filter(Boolean)
      const projectName = parts[parts.length - 1] || ''
      if (projectName) {
        const projectAbs = joinFsPath(root, fixed)
        return { projectName, projectAbs, libRoot: root, projectRel: fixed }
      }
    }

    const cur = normFsPath(curPath)
    const rel = cur.replace(root + '/', '')
    const parts = rel.split('/')

    let idx = -1
    for (let i = 0; i <= parts.length - rootParts.length; i++) {
      let ok = true
      for (let j = 0; j < rootParts.length; j++) {
        if (parts[i + j] !== rootParts[j]) { ok = false; break }
      }
      if (ok) { idx = i + rootParts.length; break }
    }
    if (idx < 0) return null

    const projectName = parts[idx] || ''
    if (!projectName) return null

    const projectRel = rootParts.concat([projectName]).join('/')
    const projectAbs = joinFsPath(root, projectRel)
    return { projectName, projectAbs, libRoot: root, projectRel }
  } catch {
    return null
  }
}

async function getProgressDocText(ctx, cfg) {
  // 约定：当前章节文件同项目目录下存在 01_进度脉络.md
  // 找不到就返回空（降级）
  try {
    if (!ctx) return ''
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return ''
    const abs = joinFsPath(inf.projectAbs, '01_进度脉络.md')
    const text = await readTextAny(ctx, abs)
    return sliceTail(text, cfg.ctx && cfg.ctx.maxProgressChars ? cfg.ctx.maxProgressChars : 10000)
  } catch {
    return ''
  }
}

async function getBibleDocText(ctx, cfg) {
  // 约定：同项目目录下存在“故事资料”文件（可选）
  try {
    if (!ctx) return ''
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return ''

    // 注意：limit 是“总预算”，不是每个文件都给一份预算；否则 5 个文件会膨胀成 5*limit，角色设定很容易被挤掉/被上游截断。
    const limit = (cfg && cfg.ctx && cfg.ctx.maxBibleChars) ? Math.max(0, cfg.ctx.maxBibleChars | 0) : 10000
    if (limit <= 0) return ''

    const sections = [
      // 兼容旧项目/手动改名：同一分节允许多个候选文件名，按顺序取第一个存在且非空的。
      { key: 'bible', w: 0.35, head: 0.55, title: t('【故事圣经】', '[Bible]'), files: ['02_故事圣经.md', '02_故事资料.md', '02_圣经.md'] },
      { key: 'world', w: 0.20, head: 0.70, title: t('【世界设定】', '[World]'), files: ['02_世界设定.md', '02_设定.md', '02_世界观.md'] },
      { key: 'chars', w: 0.25, head: 0.85, title: t('【主要角色】', '[Characters]'), files: ['03_主要角色.md', '03_主要人物.md', '03_角色设定.md', '03_人物设定.md'] },
      { key: 'rels', w: 0.10, head: 0.80, title: t('【人物关系】', '[Relations]'), files: ['04_人物关系.md', '04_关系.md', '04_角色关系.md'] },
      { key: 'outline', w: 0.10, head: 0.80, title: t('【章节大纲】', '[Outline]'), files: ['05_章节大纲.md', '05_大纲.md', '05_剧情大纲.md'] },
    ]

    async function readFirstNonEmpty(fileList) {
      for (let i = 0; i < fileList.length; i++) {
        const abs = joinFsPath(inf.projectAbs, fileList[i])
        try {
          const text = await readTextAny(ctx, abs)
          const s = safeText(text).trim()
          if (s) return s
        } catch {}
      }
      return ''
    }

    const present = []
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]
      const raw = await readFirstNonEmpty(sec.files)
      if (!raw) continue
      present.push({ ...sec, raw })
    }
    if (!present.length) return ''

    const totalW = present.reduce((a, s) => a + (Number.isFinite(s.w) ? s.w : 0), 0) || 1
    const parts = []
    for (let i = 0; i < present.length; i++) {
      const sec = present[i]
      const cap = Math.max(200, Math.floor(limit * (sec.w / totalW)))
      const v = sliceHeadTail(sec.raw, cap, sec.head).trim()
      if (v) parts.push(sec.title + '\n' + v)
    }

    // 最终再兜底一次总长度，避免拼接误差/多语言标题导致超预算
    const all = parts.join('\n\n')
    return sliceHeadTail(all, limit, 0.6).trim()
  } catch {
    return ''
  }
}

function _fallbackHash32(s) {
  // 兜底：没有 crypto.subtle 时用一个简单 hash，避免功能完全不可用（不是安全用途）
  let h = 2166136261
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8)
}

async function sha256Hex(text) {
  try {
    if (crypto && crypto.subtle && crypto.subtle.digest) {
      const enc = new TextEncoder()
      const buf = enc.encode(String(text || ''))
      const dig = await crypto.subtle.digest('SHA-256', buf)
      const arr = Array.from(new Uint8Array(dig))
      return arr.map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {}
  return _fallbackHash32(text)
}

function rag_split_chunks(text, chunkSize, overlap) {
  const s = safeText(text)
  const maxLen = Math.max(200, (chunkSize | 0) || 900)
  const ov = Math.max(0, (overlap | 0) || 160)
  const out = []

  // 优先按段落切，再在段内做滑窗
  const paras = s.split(/\n{2,}/)
  for (let p = 0; p < paras.length; p++) {
    const para = safeText(paras[p]).trim()
    if (!para) continue
    if (para.length <= maxLen) {
      out.push(para)
      continue
    }
    let i = 0
    while (i < para.length) {
      const j = Math.min(para.length, i + maxLen)
      const seg = para.slice(i, j).trim()
      if (seg) out.push(seg)
      if (j >= para.length) break
      i = Math.max(0, j - ov)
    }
  }
  return out
}

async function rag_list_project_files(ctx, projectAbs) {
  // 依赖宿主命令递归枚举项目目录下 md/markdown/txt
  if (ctx && typeof ctx.invoke === 'function') {
    try {
      const arr = await ctx.invoke('flymd_list_markdown_files', { root: projectAbs })
      const files = Array.isArray(arr) ? arr.map((x) => normFsPath(x)) : []
      return files
    } catch {
      return []
    }
  }
  return []
}

function rag_should_index_path(projectAbs, absPath) {
  const p = normFsPath(absPath)
  const root = normFsPath(projectAbs).replace(/\/+$/, '')
  if (!p.startsWith(root)) return false
  const rel = p.slice(root.length).replace(/^\/+/, '')
  if (!rel) return false
  if (rel.startsWith('.ainovel/')) return false
  if (rel.startsWith('.git/')) return false
  return true
}

const AIN_RAG_SCHEMA_VERSION = 1
const AIN_RAG_META_FILE = '.ainovel/rag_meta.json'
const AIN_RAG_VEC_FILE = '.ainovel/rag_vectors.f32'

function fsDirName(p) {
  const s = normFsPath(p).replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (i < 0) return ''
  return s.slice(0, i)
}

async function readFileBinaryAny(ctx, absPath) {
  if (ctx && typeof ctx.readFileBinary === 'function') {
    return await ctx.readFileBinary(absPath)
  }
  throw new Error(t('当前环境不支持二进制读文件', 'Binary read is not supported in this environment'))
}

async function writeFileBinaryAny(ctx, absPath, bytes) {
  if (ctx && typeof ctx.writeFileBinary === 'function') {
    return await ctx.writeFileBinary(absPath, bytes)
  }
  throw new Error(t('当前环境不支持二进制写文件', 'Binary write is not supported in this environment'))
}

async function rag_load_index(ctx, projectAbs) {
  // 索引落盘：meta.json（文本）+ vectors.f32（二进制）。避免 JSON 存向量导致索引膨胀/解析卡死。
  const metaPath = joinFsPath(projectAbs, AIN_RAG_META_FILE)
  const vecPath = joinFsPath(projectAbs, AIN_RAG_VEC_FILE)
  const legacyPath = joinFsPath(projectAbs, '.ainovel/rag_index.json')

  async function tryMigrateLegacy() {
    // 兼容旧版：.ainovel/rag_index.json（内含 embedding 数组）。迁移为 meta+f32。
    try {
      const raw = await readTextAny(ctx, legacyPath)
      const legacy = JSON.parse(String(raw || '{}'))
      if (!legacy || typeof legacy !== 'object') return false
      if ((legacy.version | 0) !== 1) return false
      const chunks = Array.isArray(legacy.chunks) ? legacy.chunks : []
      if (!chunks.length) return false

      let dims = 0
      for (let i = 0; i < chunks.length; i++) {
        const e = chunks[i] && chunks[i].embedding
        if (!Array.isArray(e) || !e.length) continue
        dims = e.length | 0
        break
      }
      if (!dims) return false

      const flat = new Float32Array(chunks.length * dims)
      const outChunks = []
      for (let i = 0; i < chunks.length; i++) {
        const it = chunks[i] || {}
        const id = String(it.id || '').trim()
        const e = it.embedding
        if (!id || !Array.isArray(e) || (e.length | 0) !== dims) continue
        flat.set(e, i * dims)
        outChunks.push({
          id,
          hash: it.hash ? String(it.hash) : id,
          source: it.source ? String(it.source) : '',
          text: it.text ? String(it.text) : '',
          vector_offset: i * dims
        })
      }
      if (!outChunks.length) return false

      const now = Date.now()
      const meta = {
        schema_version: AIN_RAG_SCHEMA_VERSION,
        embed_key: legacy.embed_key ? String(legacy.embed_key) : '',
        dims,
        created_at: legacy.created_at ? legacy.created_at : now,
        updated_at: now,
        files: (legacy.files && typeof legacy.files === 'object') ? legacy.files : {},
        chunks: outChunks
      }
      await rag_save_index(ctx, projectAbs, meta, flat)
      return { meta, vectors: flat }
    } catch {
      return false
    }
  }

  try {
    const raw = await readTextAny(ctx, metaPath)
    const meta = JSON.parse(String(raw || '{}'))
    if (!meta || typeof meta !== 'object') return null
    if ((meta.schema_version | 0) !== AIN_RAG_SCHEMA_VERSION) return null

    const dims = meta.dims | 0
    if (dims < 0) return null

    const bytes = await readFileBinaryAny(ctx, vecPath)
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    if (ab.byteLength % 4 !== 0) return null
    const vectors = new Float32Array(ab)

    if (dims === 0) return { meta, vectors: new Float32Array() }
    if (!vectors.length || vectors.length % dims !== 0) return null

    return { meta, vectors }
  } catch {
    // 如果新索引不存在，尝试从旧 JSON 索引迁移一次
    try {
      const migrated = await tryMigrateLegacy()
      if (!migrated) return null
      return migrated
    } catch {
      return null
    }
  }
}

async function rag_save_index(ctx, projectAbs, meta, vectors) {
  const metaPath = joinFsPath(projectAbs, AIN_RAG_META_FILE)
  const vecPath = joinFsPath(projectAbs, AIN_RAG_VEC_FILE)

  // 先写 meta，确保父目录存在（write_text_file_any 会 create_dir_all）
  await writeTextAny(ctx, metaPath, JSON.stringify(meta || {}, null, 2))

  const v = vectors instanceof Float32Array ? vectors : new Float32Array()
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  await writeFileBinaryAny(ctx, vecPath, bytes)
}

function rag_extract_embeddings(resp) {
  // 兼容 OpenAI embedding 响应：{ data: [{ embedding: [...] }, ...] }
  // 也兼容后端包装：{ ok: true, data: <上游响应> }
  if (!resp) return null

  // unwrap: { ok: true, data: ... }
  if (!Array.isArray(resp) && typeof resp === 'object' && resp.ok === true && resp.data != null) {
    return rag_extract_embeddings(resp.data)
  }

  // 直接就是数组：[[...], [...]] 或 [{embedding:[...]}, ...]
  if (Array.isArray(resp)) {
    if (!resp.length) return null
    if (Array.isArray(resp[0])) return resp
    const vecs = resp
      .map((it) => (it && Array.isArray(it.embedding) ? it.embedding : null))
      .filter((v) => Array.isArray(v) && v.length)
    return vecs.length ? vecs : null
  }

  if (typeof resp !== 'object') return null

  // OpenAI: { data: [...] }
  if (Array.isArray(resp.data)) {
    const vecs = resp.data
      .map((it) => (it && Array.isArray(it.embedding) ? it.embedding : null))
      .filter((v) => Array.isArray(v) && v.length)
    return vecs.length ? vecs : null
  }

  // 部分第三方：{ embeddings: [...] } 或 { data: { embeddings: [...] } }
  if (Array.isArray(resp.embeddings)) {
    const vecs = resp.embeddings
      .map((it) => (Array.isArray(it) ? it : (it && Array.isArray(it.embedding) ? it.embedding : null)))
      .filter((v) => Array.isArray(v) && v.length)
    return vecs.length ? vecs : null
  }

  // 再深入一层尝试（常见：resp.data 是对象）
  if (resp.data && typeof resp.data === 'object') {
    const inner = rag_extract_embeddings(resp.data)
    if (inner && inner.length) return inner
  }

  return null
}

function rag_is_voyage_base_url(baseUrl) {
  return /voyageai\.com/i.test(String(baseUrl || ''))
}

async function rag_embed_texts(ctx, cfg, texts, inputType) {
  const emb = cfg && cfg.embedding ? cfg.embedding : null
  if (!emb || !emb.baseUrl || !emb.model) {
    throw new Error(t('请先在设置里填写 embedding BaseURL 和模型', 'Please set embedding BaseURL and model in Settings first'))
  }
  const payload = {
    upstream: { baseUrl: emb.baseUrl, apiKey: emb.apiKey, model: emb.model },
    input: texts
  }
  // Voyage 支持 input_type（query/document）；其他上游未必支持，乱传会 400
  const it = String(inputType || '').trim()
  if (it && rag_is_voyage_base_url(emb.baseUrl) && (it === 'query' || it === 'document')) {
    payload.input_type = it
  }
  const json = await apiFetch(ctx, cfg, 'ai/proxy/embeddings/', payload)
  const vecs = rag_extract_embeddings(json)
  if (!vecs || !vecs.length) throw new Error(t('embedding 返回为空或格式不兼容', 'Empty/invalid embedding response'))
  return vecs
}

function rag_cosine_sim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i] || 0)
    const y = Number(b[i] || 0)
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na <= 0 || nb <= 0) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function rag_build_or_update_index(ctx, cfg, opts) {
  const o = opts || {}
  const inf = await inferProjectDir(ctx, cfg)
  if (!inf) return null
  const projectAbs = inf.projectAbs

  const ragCfg = cfg && cfg.rag ? cfg.rag : {}
  const chunkSize = ragCfg.chunkSize || 900
  const chunkOverlap = ragCfg.chunkOverlap || 160

  const emb = cfg && cfg.embedding ? cfg.embedding : null
  if (!emb || !emb.baseUrl || !emb.model) return null

  const now = Date.now()
  const hostKey = (String(emb.baseUrl || '').trim() + '|' + String(emb.model || '').trim()).toLowerCase()
  const isVoyage = rag_is_voyage_base_url(emb.baseUrl)

  // 读取旧索引（F32），尽量复用未变化文件的向量，减少 embedding 请求。
  let oldLoaded = null
  try { oldLoaded = await rag_load_index(ctx, projectAbs) } catch { oldLoaded = null }
  let oldMeta = oldLoaded && oldLoaded.meta && typeof oldLoaded.meta === 'object' ? oldLoaded.meta : null
  let oldVectors = oldLoaded && oldLoaded.vectors instanceof Float32Array ? oldLoaded.vectors : null

  if (!oldMeta || (oldMeta.schema_version | 0) !== AIN_RAG_SCHEMA_VERSION || String(oldMeta.embed_key || '').toLowerCase() !== hostKey) {
    oldMeta = null
    oldVectors = null
  }

  let dims = oldMeta && (oldMeta.dims | 0) > 0 ? (oldMeta.dims | 0) : 0
  const oldFiles = oldMeta && oldMeta.files && typeof oldMeta.files === 'object' ? oldMeta.files : {}
  const oldChunkArr = oldMeta && Array.isArray(oldMeta.chunks) ? oldMeta.chunks : []
  const oldChunkById = new Map()
  for (let i = 0; i < oldChunkArr.length; i++) {
    const it = oldChunkArr[i]
    if (it && it.id) oldChunkById.set(String(it.id), it)
  }
  if (dims > 0 && oldVectors && oldVectors.length % dims !== 0) {
    // 索引损坏：降级为全量重建
    oldMeta = null
    oldVectors = null
    dims = 0
    oldChunkById.clear()
  }

  // 扫描项目目录下所有 md/markdown/txt，按文件 sha256 做增量
  const absList0 = await rag_list_project_files(ctx, projectAbs)
  const usableAbs = (Array.isArray(absList0) ? absList0 : [])
    .filter((p) => rag_should_index_path(projectAbs, p))
    .map((p) => normFsPath(p))
    .sort((a, b) => a.localeCompare(b))

  const nextFiles = {}
  const newChunkById = new Map() // id -> {id,hash,source,text}

  for (let i = 0; i < usableAbs.length; i++) {
    const abs = usableAbs[i]
    const rel = normFsPath(abs).slice(normFsPath(projectAbs).replace(/\/+$/, '').length).replace(/^\/+/, '')
    let text = ''
    try { text = await readTextAny(ctx, abs) } catch { text = '' }
    const fhash = await sha256Hex(text)

    const prev = oldFiles && oldFiles[rel]
    if (prev && prev.sha256 === fhash && Array.isArray(prev.chunk_ids) && prev.chunk_ids.length) {
      nextFiles[rel] = prev
      continue
    }

    const chunks = rag_split_chunks(text, chunkSize, chunkOverlap)
    const ids = []
    const local = new Set()
    for (let k = 0; k < chunks.length; k++) {
      const ctext = chunks[k]
      let id = await sha256Hex(rel + '\n' + ctext)
      if (local.has(id)) {
        let n = 2
        while (local.has(id + ':dup' + n)) n++
        id = id + ':dup' + n
      }
      local.add(id)
      ids.push(id)
      newChunkById.set(id, { id, hash: id, source: rel, text: ctext })
    }
    nextFiles[rel] = { sha256: fhash, chunk_ids: ids, updated_at: now }
  }

  // 生成最终 chunks 顺序：按 rel 排序 + 文件内 chunk_ids 顺序（稳定，利于增量复用）
  const rels = Object.keys(nextFiles).sort((a, b) => a.localeCompare(b))
  const finalChunks = []
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i]
    const ids = nextFiles[rel] && Array.isArray(nextFiles[rel].chunk_ids) ? nextFiles[rel].chunk_ids : []
    for (let j = 0; j < ids.length; j++) {
      const id = String(ids[j] || '').trim()
      if (!id) continue
      const ni = newChunkById.get(id)
      if (ni) {
        finalChunks.push({ id, hash: ni.hash || id, source: ni.source || rel, text: ni.text || '' })
        continue
      }
      const oi = oldChunkById.get(id)
      if (oi) {
        finalChunks.push({
          id,
          hash: oi.hash ? String(oi.hash) : id,
          source: oi.source ? String(oi.source) : rel,
          text: oi.text ? String(oi.text) : ''
        })
        continue
      }
      // 理论不该发生：降级为“空块”（不参与 embedding）
      finalChunks.push({ id, hash: id, source: rel, text: '' })
    }
  }

  if (!finalChunks.length) {
    const meta0 = {
      schema_version: AIN_RAG_SCHEMA_VERSION,
      embed_key: hostKey,
      dims: 0,
      created_at: (oldMeta && oldMeta.created_at) ? oldMeta.created_at : now,
      updated_at: now,
      files: nextFiles,
      chunks: []
    }
    await rag_save_index(ctx, projectAbs, meta0, new Float32Array())
    return { projectAbs, index: meta0, vectors: new Float32Array() }
  }

  const needIdx = []
  for (let i = 0; i < finalChunks.length; i++) {
    const id = String(finalChunks[i].id || '').trim()
    const oi = id ? oldChunkById.get(id) : null
    const off = oi && oi.vector_offset != null ? (oi.vector_offset | 0) : -1
    const canReuse = !!(oi && oldVectors && dims > 0 && off >= 0 && off + dims <= oldVectors.length)
    if (!canReuse) needIdx.push(i)
  }

  const batchSize = 16
  const totalNeed = needIdx.length
  let flat = null

  // dims 未知：先做一批 embedding 拿维度
  let pos = 0
  if (dims <= 0) {
    const first = needIdx.slice(0, Math.min(batchSize, totalNeed))
    if (!first.length) {
      // 没有任何可 embedding 的块：写空索引
      const meta0 = {
        schema_version: AIN_RAG_SCHEMA_VERSION,
        embed_key: hostKey,
        dims: 0,
        created_at: (oldMeta && oldMeta.created_at) ? oldMeta.created_at : now,
        updated_at: now,
        files: nextFiles,
        chunks: []
      }
      await rag_save_index(ctx, projectAbs, meta0, new Float32Array())
      return { projectAbs, index: meta0, vectors: new Float32Array() }
    }

    if (typeof o.onTick === 'function') {
      try { o.onTick({ done: 0, total: totalNeed }) } catch {}
    }

    const texts = first.map((idx) => '[' + String(finalChunks[idx].source || '') + ']\n' + String(finalChunks[idx].text || ''))
    const vecs = await rag_embed_texts(ctx, cfg, texts, isVoyage ? 'document' : '')
    dims = vecs && vecs[0] ? (vecs[0].length | 0) : 0
    if (!dims) throw new Error(t('embedding 维度为空', 'embedding dims is empty'))

    flat = new Float32Array(finalChunks.length * dims)
    for (let i = 0; i < vecs.length; i++) {
      const idx = first[i]
      const v = vecs[i]
      if (!Array.isArray(v) || v.length !== dims) throw new Error(t('embedding 维度不一致', 'embedding dims mismatch'))
      flat.set(v, idx * dims)
    }
    pos = first.length
  } else {
    flat = new Float32Array(finalChunks.length * dims)
  }

  // 复用旧向量
  if (oldVectors && dims > 0) {
    for (let i = 0; i < finalChunks.length; i++) {
      const id = String(finalChunks[i].id || '').trim()
      if (!id) continue
      const oi = oldChunkById.get(id)
      if (!oi || oi.vector_offset == null) continue
      const off = oi.vector_offset | 0
      if (off < 0 || off + dims > oldVectors.length) continue
      flat.set(oldVectors.subarray(off, off + dims), i * dims)
    }
  }

  // 批量 embedding（剩余未命中的块）
  while (pos < totalNeed) {
    if (typeof o.onTick === 'function') {
      try { o.onTick({ done: pos, total: totalNeed }) } catch {}
    }
    const batchIdx = needIdx.slice(pos, pos + batchSize)
    const texts = batchIdx.map((idx) => '[' + String(finalChunks[idx].source || '') + ']\n' + String(finalChunks[idx].text || ''))
    const vecs = await rag_embed_texts(ctx, cfg, texts, isVoyage ? 'document' : '')
    for (let i = 0; i < vecs.length; i++) {
      const idx = batchIdx[i]
      const v = vecs[i]
      if (!Array.isArray(v) || v.length !== dims) throw new Error(t('embedding 维度不一致', 'embedding dims mismatch'))
      flat.set(v, idx * dims)
    }
    pos += batchIdx.length
  }
  if (typeof o.onTick === 'function') {
    try { o.onTick({ done: totalNeed, total: totalNeed }) } catch {}
  }

  // 写回 meta：不存 embedding（避免膨胀），只记录 vector_offset
  const outChunks = []
  for (let i = 0; i < finalChunks.length; i++) {
    const it = finalChunks[i]
    const id = String(it.id || '').trim()
    const text = String(it.text || '').trim()
    if (!id || !text) continue
    outChunks.push({
      id,
      hash: it.hash ? String(it.hash) : id,
      source: it.source ? String(it.source) : '',
      text,
      vector_offset: i * dims
    })
  }

  const meta = {
    schema_version: AIN_RAG_SCHEMA_VERSION,
    embed_key: hostKey,
    dims,
    created_at: (oldMeta && oldMeta.created_at) ? oldMeta.created_at : now,
    updated_at: now,
    files: nextFiles,
    chunks: outChunks
  }

  await rag_save_index(ctx, projectAbs, meta, flat)
  return { projectAbs, index: meta, vectors: flat }
}

async function rag_get_hits(ctx, cfg, queryText, opts) {
  const o = opts || {}
  const ragCfg = cfg && cfg.rag ? cfg.rag : {}
  if (ragCfg.enabled === false) return null
  const emb = cfg && cfg.embedding ? cfg.embedding : null
  if (!emb || !emb.baseUrl || !emb.model) return null

  const inf = await inferProjectDir(ctx, cfg)
  if (!inf) return null
  const projectAbs = inf.projectAbs
  const isVoyage = rag_is_voyage_base_url(emb.baseUrl)

  let loaded = await rag_load_index(ctx, projectAbs)
  let meta = loaded && loaded.meta ? loaded.meta : null
  let vectors = loaded && loaded.vectors ? loaded.vectors : null

  if ((!meta || !Array.isArray(meta.chunks) || !meta.chunks.length) && ragCfg.autoBuildIndex !== false) {
    const built = await rag_build_or_update_index(ctx, cfg, { onTick: o.onBuildTick })
    meta = built && built.index ? built.index : meta
    vectors = built && built.vectors ? built.vectors : vectors
  }
  if (!meta || !vectors || !Array.isArray(meta.chunks) || !meta.chunks.length) return null

  const dims = meta.dims | 0
  if (!dims) return null

  const q = safeText(queryText).trim()
  if (!q) return null

  const qVec0 = (await rag_embed_texts(ctx, cfg, [q], isVoyage ? 'query' : ''))[0]
  if (!Array.isArray(qVec0) || !qVec0.length) return null

  const qVec = Float32Array.from(qVec0)
  let qNorm = 0
  for (let i = 0; i < qVec.length; i++) qNorm += qVec[i] * qVec[i]
  qNorm = Math.sqrt(qNorm)
  if (!qNorm) return null

  function cosineScoreAt(vs, off, query, d, queryNorm) {
    let dot = 0
    let vv = 0
    const base = off | 0
    for (let i = 0; i < d; i++) {
      const v = vs[base + i]
      dot += v * query[i]
      vv += v * v
    }
    const denom = Math.sqrt(vv) * queryNorm
    if (!denom) return 0
    return dot / denom
  }

  const scored = []
  for (let i = 0; i < meta.chunks.length; i++) {
    const it = meta.chunks[i]
    if (!it) continue
    const off = it.vector_offset != null ? (it.vector_offset | 0) : -1
    if (off < 0 || off + dims > vectors.length) continue
    const s = cosineScoreAt(vectors, off, qVec, dims, qNorm)
    if (s <= 0) continue
    scored.push({ s, it })
  }
  scored.sort((a, b) => b.s - a.s)

  const topK = Math.max(1, (o.topK != null ? (o.topK | 0) : ((ragCfg.topK | 0) || 6)))
  const maxChars = Math.max(400, (o.maxChars != null ? (o.maxChars | 0) : ((ragCfg.maxChars | 0) || 2400)))
  const hitMaxChars = Math.max(200, (o.hitMaxChars != null ? (o.hitMaxChars | 0) : 1200))
  const hits = []
  let used = 0
  for (let i = 0; i < scored.length && hits.length < topK; i++) {
    const it = scored[i].it
    const src = safeText(it.source).trim() || 'unknown'
    const txt = safeText(it.text).trim()
    if (!txt) continue
    const cut = txt.length > hitMaxChars ? (txt.slice(0, hitMaxChars) + '…') : txt
    if (used + cut.length > maxChars) break
    used += cut.length
    hits.push({ source: src, text: cut })
  }
  return hits.length ? hits : null
}

async function writeTextAny(ctx, path, content) {
  if (ctx && typeof ctx.invoke === 'function') {
    await ctx.invoke('write_text_file_any', { path, content })
    return
  }
  if (ctx && typeof ctx.writeTextFile === 'function') {
    // 注意：部分宿主 API 不会自动创建父目录；所以优先走 write_text_file_any
    await ctx.writeTextFile(path, content)
    return
  }
  throw new Error(t('当前环境不支持写文件', 'File write is not supported in this environment'))
}

async function backupBeforeOverwrite(ctx, absPath, tag) {
  try {
    if (!ctx) return ''
    const p = String(absPath || '').trim()
    if (!p) return ''
    if (!(await fileExists(ctx, p))) return ''
    const old = safeText(await readTextAny(ctx, p))
    if (!old.trim()) return ''
    const ts = safeFileName(_fmtLocalTs(), 'ts')
    const tg = safeFileName(String(tag || ''), '')
    const suffix = tg ? ('.' + tg) : ''
    const bak = p + '.bak.' + ts + suffix
    await writeTextAny(ctx, bak, old)
    return bak
  } catch {
    return ''
  }
}

async function projectMarkerExists(ctx, projectAbs) {
  // 兼容旧版：00_项目.json；新版：00_项目.md；以及隐藏索引：.ainovel/index.json
  if (await fileExists(ctx, joinFsPath(projectAbs, '.ainovel/index.json'))) return true
  if (await fileExists(ctx, joinFsPath(projectAbs, '00_项目.md'))) return true
  if (await fileExists(ctx, joinFsPath(projectAbs, '00_项目.json'))) return true
  return false
}

function closeDialog() {
  try {
    if (__MINIBAR__ && __MINIBAR__.remove) __MINIBAR__.remove()
  } catch {}
  __MINIBAR__ = null
  __MINI__ = null
  try {
    if (__DIALOG__ && __DIALOG__.remove) __DIALOG__.remove()
  } catch {}
  __DIALOG__ = null
}

function ensureDialogStyle() {
  const id = 'ai-novel-style'
  const doc = document
  if (!doc || doc.getElementById(id)) return
  const st = doc.createElement('style')
  st.id = id
  st.textContent = `
.ain-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999999;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
.ain-dlg{width:min(980px,96vw);background:#0f172a;border:1px solid #1f2937;border-radius:12px;color:#e6e6e6}
.ain-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #1f2937}
.ain-title{font-size:16px;font-weight:700}
.ain-winbtns{display:flex;gap:6px;align-items:center}
.ain-winbtn{background:transparent;border:0;color:#e6e6e6;font-size:18px;cursor:pointer;min-width:32px;height:28px;line-height:28px;border-radius:8px}
.ain-winbtn:hover{background:rgba(255,255,255,.08)}
.ain-close{font-size:22px}
.ain-body{padding:14px 16px}
.ain-card{background:#0b1220;border:1px solid #243041;border-radius:10px;padding:12px;margin:10px 0}
.ain-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ain-lab{font-size:12px;color:#9ca3af;margin:8px 0 4px}
.ain-in{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#0b0f19;color:#e6e6e6;box-sizing:border-box}
.ain-ta{width:100%;min-height:120px;padding:10px;border-radius:8px;border:1px solid #334155;background:#0b0f19;color:#e6e6e6;box-sizing:border-box;resize:vertical}
.ain-out{white-space:pre-wrap;background:#0b0f19;border:1px solid #243041;border-radius:8px;padding:10px;min-height:120px}
.ain-diff{white-space:pre-wrap;background:#0b0f19;border:1px solid #243041;border-radius:8px;padding:10px;min-height:120px}
.ain-diff mark{background:rgba(34,197,94,.22);color:#e6e6e6;padding:0 2px;border-radius:3px}
.ain-diff del{background:rgba(239,68,68,.18);color:#fecaca;text-decoration:line-through;padding:0 2px;border-radius:3px}
.ain-opt{border:1px solid #243041;background:#0b0f19;border-radius:10px;padding:10px;margin:8px 0;cursor:pointer}
.ain-opt:hover{border-color:#334155}
.ain-opt.sel{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.25) inset}
.ain-opt-title{font-weight:700}
.ain-opt-sub{color:#9ca3af;font-size:12px;margin-top:4px}
.ain-selrow{display:flex;gap:10px;align-items:center;margin-top:10px}
.ain-selrow .ain-lab{margin:0}
.ain-select{min-width:260px}
.ain-btn[disabled]{opacity:.6;cursor:not-allowed}
.ain-btn{display:inline-block;padding:9px 12px;border-radius:8px;background:#2563eb;color:#fff;border:0;cursor:pointer}
.ain-btn.gray{background:#334155}
.ain-btn.red{background:#b91c1c}
.ain-muted{color:#9ca3af;font-size:12px}
.ain-ok{color:#bbf7d0}
.ain-err{color:#fecaca}
.ain-todo{background:#0b0f19;border:1px dashed #243041;border-radius:8px;padding:10px}
.ain-todo-item{display:flex;gap:8px;align-items:flex-start;margin:6px 0}
.ain-todo-st{width:18px;flex:0 0 18px;font-weight:700;line-height:18px}
.ain-todo-title{flex:1;min-width:0}
.ain-todo-title .ain-muted{margin-left:6px}
.ain-todo-log{white-space:pre-wrap;background:#0b0f19;border:1px solid #243041;border-radius:8px;padding:10px;margin-top:8px;max-height:240px;overflow:auto}
.ain-minibar{position:fixed;z-index:1000000;background:#0f172a;border:1px solid #1f2937;color:#e6e6e6;border-radius:999px;box-shadow:0 10px 28px rgba(0,0,0,.45);padding:0 8px;display:flex;align-items:center;gap:8px;height:var(--ain-bar-h,24px);line-height:var(--ain-bar-h,24px);user-select:none}
.ain-minibar .ain-minititle{font-size:12px;font-weight:700;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:grab}
.ain-minibar .ain-minititle:active{cursor:grabbing}
.ain-minibar .ain-winbtn{height:calc(var(--ain-bar-h,24px) - 2px);line-height:calc(var(--ain-bar-h,24px) - 2px);min-width:28px;border-radius:999px}
`
  doc.head.appendChild(st)
}

function _ainLineHeightPx() {
  try {
    const cs = window.getComputedStyle(document.body)
    const lh = String(cs.lineHeight || '')
    if (lh.endsWith('px')) {
      const v = Math.round(parseFloat(lh))
      if (Number.isFinite(v) && v > 0) return Math.min(44, Math.max(18, v))
    }
    const fs = Math.round(parseFloat(String(cs.fontSize || '16')) || 16)
    return Math.min(44, Math.max(18, Math.round(fs * 1.4)))
  } catch {}
  return 24
}

function _ainMinimizeToBar(title, restoreFn, closeFn) {
  const doc = document
  if (!doc || !doc.body) return

  try {
    if (__MINIBAR__ && __MINIBAR__.remove) __MINIBAR__.remove()
  } catch {}
  __MINIBAR__ = null

  const bar = doc.createElement('div')
  bar.className = 'ain-minibar'
  bar.style.left = '50%'
  bar.style.bottom = '10px'
  bar.style.transform = 'translateX(-50%)'
  bar.style.setProperty('--ain-bar-h', _ainLineHeightPx() + 'px')

  const ttl = doc.createElement('div')
  ttl.className = 'ain-minititle'
  ttl.textContent = String(title || t('AI 小说', 'AI Novel'))

  const btnMax = doc.createElement('button')
  btnMax.className = 'ain-winbtn'
  btnMax.textContent = '▢'
  btnMax.title = t('最大化', 'Maximize')
  btnMax.onclick = () => {
    try { if (typeof restoreFn === 'function') restoreFn() } catch {}
    try { if (__MINIBAR__ && __MINIBAR__.remove) __MINIBAR__.remove() } catch {}
    __MINIBAR__ = null
    __MINI__ = null
  }

  const btnClose = doc.createElement('button')
  btnClose.className = 'ain-winbtn ain-close'
  btnClose.textContent = '×'
  btnClose.title = t('关闭', 'Close')
  btnClose.onclick = () => {
    if (typeof closeFn === 'function') closeFn()
    else closeDialog()
  }

  bar.appendChild(ttl)
  bar.appendChild(btnMax)
  bar.appendChild(btnClose)
  doc.body.appendChild(bar)
  __MINIBAR__ = bar

  // 可拖拽：不影响宿主编辑，默认底部居中
  let dragging = false
  let startX = 0
  let startY = 0
  let baseL = 0
  let baseT = 0

  function _clamp(n, a, b) {
    return Math.min(b, Math.max(a, n))
  }

  bar.addEventListener('pointerdown', (e) => {
    try {
      if (!e || e.button !== 0) return
      if (e.target && e.target.closest && e.target.closest('button')) return
      const r = bar.getBoundingClientRect()
      bar.style.left = Math.round(r.left) + 'px'
      bar.style.top = Math.round(r.top) + 'px'
      bar.style.bottom = 'auto'
      bar.style.transform = 'none'
      dragging = true
      startX = e.clientX
      startY = e.clientY
      baseL = r.left
      baseT = r.top
      bar.setPointerCapture(e.pointerId)
      e.preventDefault()
    } catch {}
  })
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    const w = bar.offsetWidth || 1
    const h = bar.offsetHeight || 1
    const maxL = (window.innerWidth || 0) - w
    const maxT = (window.innerHeight || 0) - h
    const l = _clamp(baseL + dx, 0, Math.max(0, maxL))
    const t = _clamp(baseT + dy, 0, Math.max(0, maxT))
    bar.style.left = Math.round(l) + 'px'
    bar.style.top = Math.round(t) + 'px'
  })
  function _stopDrag() { dragging = false }
  bar.addEventListener('pointerup', _stopDrag)
  bar.addEventListener('pointercancel', _stopDrag)

  __MINI__ = { title: String(title || ''), restore: restoreFn, close: closeFn }
}

async function openSettingsDialog(ctx) {
  if (typeof document === 'undefined') return
  ensureDialogStyle()
  closeDialog()

  let cfg = await loadCfg(ctx)
  const overlay = document.createElement('div')
  overlay.className = 'ain-overlay'
  // 不允许点击遮罩关闭：只允许点右上角 × 关闭，避免误触

  const dlg = document.createElement('div')
  dlg.className = 'ain-dlg'

  const head = document.createElement('div')
  head.className = 'ain-head'
  const title = document.createElement('div')
  title.className = 'ain-title'
  title.textContent = t('AI 小说引擎设置', 'AI Novel Engine Settings')

  const btns = document.createElement('div')
  btns.className = 'ain-winbtns'

  const btnMin = document.createElement('button')
  btnMin.className = 'ain-winbtn'
  btnMin.textContent = '—'
  btnMin.title = t('最小化', 'Minimize')
  btnMin.onclick = () => {
    try { overlay.style.display = 'none' } catch {}
    _ainMinimizeToBar(title.textContent, () => { try { overlay.style.display = '' } catch {} }, () => closeDialog())
  }

  const btnClose = document.createElement('button')
  btnClose.className = 'ain-winbtn ain-close'
  btnClose.textContent = '×'
  btnClose.title = t('关闭', 'Close')
  btnClose.onclick = () => closeDialog()

  btns.appendChild(btnMin)
  btns.appendChild(btnClose)
  head.appendChild(title)
  head.appendChild(btns)

  const body = document.createElement('div')
  body.className = 'ain-body'

  function mkInput(label, value, type = 'text') {
    const wrap = document.createElement('div')
    const lab = document.createElement('div')
    lab.className = 'ain-lab'
    lab.textContent = label
    const inp = document.createElement('input')
    inp.className = 'ain-in'
    inp.type = type
    inp.value = value == null ? '' : String(value)
    wrap.appendChild(lab)
    wrap.appendChild(inp)
    return { wrap, inp }
  }

  function mkSelect(label, options, value) {
    const wrap = document.createElement('div')
    const lab = document.createElement('div')
    lab.className = 'ain-lab'
    lab.textContent = label
    const sel = document.createElement('select')
    sel.className = 'ain-in ain-select'
    const list = Array.isArray(options) ? options : []
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {}
      const op = document.createElement('option')
      op.value = it.value == null ? '' : String(it.value)
      op.textContent = it.label == null ? String(op.value) : String(it.label)
      sel.appendChild(op)
    }
    try { sel.value = value == null ? '' : String(value) } catch {}
    wrap.appendChild(lab)
    wrap.appendChild(sel)
    return { wrap, sel }
  }

  const secBackend = document.createElement('div')
  secBackend.className = 'ain-card'
  secBackend.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('后端', 'Backend')}</div>`
  const projHint = document.createElement('div')
  projHint.className = 'ain-muted'
  projHint.style.marginTop = '6px'
  projHint.textContent = t('当前项目：未选择（可在“小说→项目管理”里选择/弃坑）', 'Current project: not selected (use Novel → Project Manager)')
  secBackend.appendChild(projHint)

  const rowAuth = document.createElement('div')
  rowAuth.className = 'ain-row'
  const inpUser = mkInput(t('用户名', 'Username'), '', 'text')
  const inpPass = mkInput(t('密码', 'Password'), '', 'password')
  rowAuth.appendChild(inpUser.wrap)
  rowAuth.appendChild(inpPass.wrap)
  secBackend.appendChild(rowAuth)

  const btnRow = document.createElement('div')
  btnRow.style.marginTop = '10px'
  const btnLogin = document.createElement('button')
  btnLogin.className = 'ain-btn'
  btnLogin.textContent = t('登录', 'Login')
  const btnRegister = document.createElement('button')
  btnRegister.className = 'ain-btn gray'
  btnRegister.style.marginLeft = '8px'
  btnRegister.textContent = t('注册', 'Register')
  const btnMe = document.createElement('button')
  btnMe.className = 'ain-btn gray'
  btnMe.style.marginLeft = '8px'
  btnMe.textContent = t('刷新余额', 'Refresh billing')
  btnRow.appendChild(btnLogin)
  btnRow.appendChild(btnRegister)
  btnRow.appendChild(btnMe)
  secBackend.appendChild(btnRow)

  const billingBox = document.createElement('div')
  billingBox.className = 'ain-muted'
  billingBox.style.marginTop = '10px'
  billingBox.textContent = t('未登录', 'Not logged in')
  secBackend.appendChild(billingBox)

  async function refreshBilling() {
    cfg = await loadCfg(ctx)
    try {
      projHint.textContent = t('当前项目：', 'Current project: ') + (cfg.currentProjectRel ? String(cfg.currentProjectRel) : t('未选择', 'not selected'))
    } catch {}
    if (!cfg.token) {
      billingBox.textContent = t('未登录', 'Not logged in')
      return
    }
    const json = await apiGet(ctx, cfg, 'billing/status/')
    const b = json && json.billing ? json.billing : null
    if (!b) {
      billingBox.textContent = t('读取余额失败', 'Failed to load billing')
      return
    }
    const me = json && json.me ? json.me : null
    const who = me && (me.username || me.id) ? `  ·  ${t('用户', 'User')}: ${(me.username || ('#' + String(me.id)) )}` : ''
    const ts = json && json.ts ? String(json.ts) : ''
    const when = ts ? `  ·  ${t('时间', 'Time')}: ${ts}` : ''
    const explain = t(
      '计费范围：计费字符=输入+输出。输入包含：指令/硬约束/进度脉络/资料(圣经)/前文尾部/RAG命中/走向/待审计或待修订文本；输出包含：候选/正文/审计/摘要/修订结果。咨询与 embedding 不计费（仅记录日志）。',
      'Billing: billed chars = input + output. Input may include instruction/constraints/progress/meta/prev/RAG hits/choice/text-to-audit-or-revise; output includes options/story/audit/summary/revision. Consult & embeddings are not billed (logs only).'
    )
    // 不用 innerHTML：后端字段一旦异常/被污染就会形成 XSS 面
    billingBox.textContent = ''
    const line = document.createElement('div')
    const okSpan = document.createElement('span')
    okSpan.className = 'ain-ok'
    okSpan.textContent = `${t('余额', 'Balance')}: ${safeText(b.balance_chars)}`
    line.appendChild(okSpan)
    line.appendChild(document.createTextNode(
      `  ·  ${t('单价', 'Price')}: ${safeText(b.price_per_1k_chars)}/1k  ·  ${t('试用', 'Trial')}: ${safeText(b.trial_chars)}${who}${when}`
    ))
    billingBox.appendChild(line)
    const explainDiv = document.createElement('div')
    explainDiv.className = 'ain-muted'
    explainDiv.style.marginTop = '6px'
    explainDiv.textContent = explain
    billingBox.appendChild(explainDiv)
  }

  btnLogin.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const json = await apiFetch(ctx, cfg, 'auth/login/', {
        username: inpUser.inp.value,
        password: inpPass.inp.value
      })
      cfg = await saveCfg(ctx, { token: String(json.token || '') })
      await refreshBilling()
      ctx.ui.notice(t('登录成功', 'Login ok'), 'ok', 1600)
    } catch (e) {
      ctx.ui.notice(t('登录失败：', 'Login failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }

  btnRegister.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const json = await apiFetch(ctx, cfg, 'auth/register/', {
        username: inpUser.inp.value,
        password: inpPass.inp.value,
        device_id: getOrCreateDeviceId()
      })
      cfg = await saveCfg(ctx, { token: String(json.token || '') })
      await refreshBilling()
      ctx.ui.notice(t('注册成功', 'Registered'), 'ok', 1600)
    } catch (e) {
      ctx.ui.notice(t('注册失败：', 'Register failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  btnMe.onclick = async () => {
    try {
      await refreshBilling()
      ctx.ui.notice(t('已刷新', 'Refreshed'), 'ok', 1200)
    } catch (e) {
      ctx.ui.notice(t('读取失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }

  const secUp = document.createElement('div')
  secUp.className = 'ain-card'
  secUp.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('上游 AI', 'Upstream AI')}</div>`

  const rowUp1 = document.createElement('div')
  rowUp1.className = 'ain-row'
  const inpUpBase = mkInput(t('BaseURL', 'BaseURL'), cfg.upstream && cfg.upstream.baseUrl ? cfg.upstream.baseUrl : '')
  const inpUpKey = mkInput(t('ApiKey', 'ApiKey'), cfg.upstream && cfg.upstream.apiKey ? cfg.upstream.apiKey : '', 'password')
  rowUp1.appendChild(inpUpBase.wrap)
  rowUp1.appendChild(inpUpKey.wrap)
  secUp.appendChild(rowUp1)

  const rowUp2 = document.createElement('div')
  rowUp2.className = 'ain-row'
  const inpUpModel = mkInput(t('chat 模型', 'Chat model'), cfg.upstream && cfg.upstream.model ? cfg.upstream.model : '')
  const inpNovelRoot = mkInput(t('小说根目录（相对库根）', 'Novel root dir (relative to library)'), cfg.novelRootDir || '小说/')
  rowUp2.appendChild(inpUpModel.wrap)
  rowUp2.appendChild(inpNovelRoot.wrap)
  secUp.appendChild(rowUp2)

  const rowUp3 = document.createElement('div')
  rowUp3.style.marginTop = '10px'
  const btnUpCheck = document.createElement('button')
  btnUpCheck.className = 'ain-btn gray'
  btnUpCheck.textContent = t('检查连接', 'Test connection')
  rowUp3.appendChild(btnUpCheck)
  secUp.appendChild(rowUp3)

  const upCheckHint = document.createElement('div')
  upCheckHint.className = 'ain-muted'
  upCheckHint.style.marginTop = '6px'
  upCheckHint.textContent = t('提示：会发起一次“咨询”请求用于验证上游配置（不扣费）。', 'Note: sends a consult request to validate upstream settings (no billing).')
  secUp.appendChild(upCheckHint)

  btnUpCheck.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))

      const baseUrl = safeText(inpUpBase.inp.value).trim()
      const apiKey = safeText(inpUpKey.inp.value).trim()
      const model = safeText(inpUpModel.inp.value).trim()
      if (!baseUrl || !model) throw new Error(t('请先填写 BaseURL 和模型', 'Please fill BaseURL and model first'))

      setBusy(btnUpCheck, true)
      const started = Date.now()
      upCheckHint.textContent = t('检查中…', 'Testing...')

      const resp = await apiFetchConsultWithJob(ctx, cfg, {
        upstream: { baseUrl, apiKey, model },
        input: {
          async: true,
          mode: 'job',
          question: '连接测试：请只回复 OK',
          progress: '',
          bible: '',
          prev: '',
          constraints: '',
        }
      }, {
        timeoutMs: 60000,
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
          upCheckHint.textContent = t('检查中… 已等待 ', 'Testing... waited ') + s + 's'
        }
      })

      const txt = safeText(resp && resp.text).trim()
      if (!txt) throw new Error(t('上游返回空内容', 'Upstream returned empty response'))
      const ms = Math.max(0, Date.now() - started)
      upCheckHint.textContent = t('连接正常，耗时 ', 'OK. Took ') + ms + 'ms'
      ctx.ui.notice(t('上游连接正常', 'Upstream OK'), 'ok', 1800)
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      try { upCheckHint.textContent = t('检查失败：', 'Failed: ') + msg } catch {}
      ctx.ui.notice(t('检查失败：', 'Failed: ') + msg, 'err', 2600)
    } finally {
      setBusy(btnUpCheck, false)
    }
  }

  const secCtx = document.createElement('div')
  secCtx.className = 'ain-card'
  secCtx.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('上下文与约束', 'Context & Constraints')}</div>`

  const hintCtx = document.createElement('div')
  hintCtx.className = 'ain-muted'
  hintCtx.textContent = t('提示：这里的单位是“字符”，不是 token；按你的上游模型能力调整即可（例如 128K/256K/1M）。', 'Note: units are characters (not tokens). Tune based on your upstream model window (e.g. 128K/256K/1M).')
  secCtx.appendChild(hintCtx)

  const presets = [
    { label: '8K', value: '8000' },
    { label: '32K', value: '32000' },
    { label: '128K', value: '128000' },
    { label: '256K', value: '256000' },
    { label: '1M', value: '1000000' },
    { label: t('自定义', 'Custom'), value: '' },
  ]

  const rowCtx0 = document.createElement('div')
  rowCtx0.className = 'ain-row'
  const selPreset = mkSelect(t('上下文预设', 'Context preset'), presets, '')
  const inpWindow = mkInput(t('模型上下文（字符）', 'Model context (chars)'), (cfg.ctx && cfg.ctx.modelContextChars) ? String(cfg.ctx.modelContextChars) : '32000', 'number')
  rowCtx0.appendChild(selPreset.wrap)
  rowCtx0.appendChild(inpWindow.wrap)
  secCtx.appendChild(rowCtx0)

  const rowCtx1 = document.createElement('div')
  rowCtx1.className = 'ain-row'
  const inpPrevChars = mkInput(t('前文尾部上限', 'Prev tail limit'), (cfg.ctx && cfg.ctx.maxPrevChars) ? String(cfg.ctx.maxPrevChars) : '8000', 'number')
  const inpProgChars = mkInput(t('进度脉络上限', 'Progress limit'), (cfg.ctx && cfg.ctx.maxProgressChars) ? String(cfg.ctx.maxProgressChars) : '10000', 'number')
  rowCtx1.appendChild(inpPrevChars.wrap)
  rowCtx1.appendChild(inpProgChars.wrap)
  secCtx.appendChild(rowCtx1)

  const rowCtx2 = document.createElement('div')
  rowCtx2.className = 'ain-row'
  const inpBibleChars = mkInput(t('资料/圣经上限', 'Bible/meta limit'), (cfg.ctx && cfg.ctx.maxBibleChars) ? String(cfg.ctx.maxBibleChars) : ((cfg.ctx && cfg.ctx.maxProgressChars) ? String(cfg.ctx.maxProgressChars) : '10000'), 'number')
  rowCtx2.appendChild(inpBibleChars.wrap)
  secCtx.appendChild(rowCtx2)

  const rowCtx3 = document.createElement('div')
  rowCtx3.className = 'ain-row'
  const inpUpdChars = mkInput(t('进度生成源文本上限', 'Progress source limit'), (cfg.ctx && cfg.ctx.maxUpdateSourceChars) ? String(cfg.ctx.maxUpdateSourceChars) : '20000', 'number')
  rowCtx3.appendChild(inpUpdChars.wrap)
  secCtx.appendChild(rowCtx3)

  const hard = mkTextarea(t('全局硬约束（可空）', 'Global hard constraints (optional)'), getGlobalConstraints(cfg))
  secCtx.appendChild(hard.wrap)

  function applyCtxPreset(totalChars) {
    const total = _clampInt(totalChars, 8000, 10000000)
    inpWindow.inp.value = String(total)
    // 粗暴但实用的预算：让“前文/资料/进度”都有份额，避免某一项饿死。
    const prev = Math.max(4000, Math.round(total * 0.25))
    const prog = Math.max(4000, Math.round(total * 0.15))
    const bible = Math.max(4000, Math.round(total * 0.25))
    inpPrevChars.inp.value = String(prev)
    inpProgChars.inp.value = String(prog)
    inpBibleChars.inp.value = String(bible)
    const upd = Math.max(20000, Math.round(total * 0.35))
    inpUpdChars.inp.value = String(upd)
  }

  selPreset.sel.onchange = () => {
    const v = String(selPreset.sel.value || '').trim()
    if (!v) return
    applyCtxPreset(v)
  }

  const secAgent = document.createElement('div')
  secAgent.className = 'ain-card'
  secAgent.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('Agent（Plan 模式）', 'Agent (Plan mode)')}</div>`

  const agentLine = document.createElement('label')
  agentLine.style.display = 'flex'
  agentLine.style.gap = '8px'
  agentLine.style.alignItems = 'center'
  agentLine.style.marginTop = '6px'
  const cbAgent = document.createElement('input')
  cbAgent.type = 'checkbox'
  cbAgent.checked = !!(cfg.agent && cfg.agent.enabled)
  agentLine.appendChild(cbAgent)
  agentLine.appendChild(document.createTextNode(t('启用 Agent：先生成 TODO，再逐项执行', 'Enable Agent: generate TODO then execute step-by-step')))
  secAgent.appendChild(agentLine)

  const rowAgent = document.createElement('div')
  rowAgent.className = 'ain-row'
  const agentTarget0 = (() => {
    try {
      const a = cfg && cfg.agent ? cfg.agent : {}
      const v = a && (a.targetChars != null ? a.targetChars : (a.target_chars != null ? a.target_chars : null))
      const n = parseInt(String(v == null ? '' : v), 10)
      if (n === 1000 || n === 2000 || n === 3000 || n === 4000) return n
    } catch {}
    // 兼容旧配置：chunkCount -> targetChars
    try {
      const a = cfg && cfg.agent ? cfg.agent : {}
      const c = parseInt(String(a && a.chunkCount != null ? a.chunkCount : ''), 10)
      if (Number.isFinite(c)) {
        if (c <= 1) return 1000
        if (c === 2) return 2000
        if (c === 3) return 3000
        return 4000
      }
    } catch {}
    return 3000
  })()

  const selAgentTarget = mkSelect(
    t('写作字数（Agent）', 'Target chars (Agent)'),
    [
      { value: '1000', label: t('≈ 1000 字', '≈ 1000 chars') },
      { value: '2000', label: t('≈ 2000 字', '≈ 2000 chars') },
      { value: '3000', label: t('≈ 3000 字', '≈ 3000 chars') },
      { value: '4000', label: t('≈ 4000 字（上限）', '≈ 4000 chars (max)') },
    ],
    String(agentTarget0)
  )

  const auditWrap = document.createElement('div')
  const auditLab = document.createElement('div')
  auditLab.className = 'ain-lab'
  auditLab.textContent = t('一致性审计', 'Consistency audit')
  const auditLine = document.createElement('label')
  auditLine.style.display = 'flex'
  auditLine.style.gap = '8px'
  auditLine.style.alignItems = 'center'
  const cbAudit = document.createElement('input')
  cbAudit.type = 'checkbox'
  cbAudit.checked = !!(cfg.agent && cfg.agent.audit)
  auditLine.appendChild(cbAudit)
  auditLine.appendChild(document.createTextNode(t('写完后自动审计（更耗字符）', 'Audit after writing (costs more)')))
  auditWrap.appendChild(auditLab)
  auditWrap.appendChild(auditLine)

  rowAgent.appendChild(selAgentTarget.wrap)
  rowAgent.appendChild(auditWrap)
  secAgent.appendChild(rowAgent)

  const hintAgent = document.createElement('div')
  hintAgent.className = 'ain-muted'
  hintAgent.style.marginTop = '6px'
  hintAgent.textContent = t(
    '提示：Agent 会先生成 TODO，再逐项执行；写作会按你选择的字数目标控制在 ≤4000 字（为了审阅成本），但会更耗字符余额、也更慢。',
    'Note: Agent generates TODO then executes step-by-step; writing is capped to ≤4000 chars (for review cost), but it usually costs more chars and is slower.'
  )
  secAgent.appendChild(hintAgent)

  const secEmb = document.createElement('div')
  secEmb.className = 'ain-card'
  secEmb.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('Embedding', 'Embedding')}</div>`

  const rowEmb1 = document.createElement('div')
  rowEmb1.className = 'ain-row'
  const inpEmbBase = mkInput(t('BaseURL', 'BaseURL'), cfg.embedding && cfg.embedding.baseUrl ? cfg.embedding.baseUrl : '')
  const inpEmbKey = mkInput(t('ApiKey', 'ApiKey'), cfg.embedding && cfg.embedding.apiKey ? cfg.embedding.apiKey : '', 'password')
  rowEmb1.appendChild(inpEmbBase.wrap)
  rowEmb1.appendChild(inpEmbKey.wrap)
  secEmb.appendChild(rowEmb1)

  const rowEmb2 = document.createElement('div')
  rowEmb2.className = 'ain-row'
  const inpEmbModel = mkInput(t('embedding 模型', 'Embedding model'), cfg.embedding && cfg.embedding.model ? cfg.embedding.model : '')
  rowEmb2.appendChild(inpEmbModel.wrap)
  secEmb.appendChild(rowEmb2)

  const secRecharge = document.createElement('div')
  secRecharge.className = 'ain-card'
  secRecharge.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('充值卡兑换', 'Recharge')}</div>`
  const inpCard = mkInput(t('充值卡号', 'Card token'), '', 'text')
  secRecharge.appendChild(inpCard.wrap)
  const btnRedeem = document.createElement('button')
  btnRedeem.className = 'ain-btn'
  btnRedeem.textContent = t('兑换', 'Redeem')
  btnRedeem.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const json = await apiFetch(ctx, cfg, 'billing/redeem/', { token: inpCard.inp.value })
      await refreshBilling()
      ctx.ui.notice(t('兑换成功，增加字符：', 'Redeemed, chars +') + String(json.chars_grant || 0), 'ok', 2400)
    } catch (e) {
      ctx.ui.notice(t('兑换失败：', 'Redeem failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }
  secRecharge.appendChild(btnRedeem)

  const secSave = document.createElement('div')
  secSave.className = 'ain-card'
  const btnSave = document.createElement('button')
  btnSave.className = 'ain-btn'
  btnSave.textContent = t('保存设置', 'Save')
  btnSave.onclick = async () => {
    try {
      const patch = {
        novelRootDir: inpNovelRoot.inp.value,
        upstream: {
          baseUrl: inpUpBase.inp.value,
          apiKey: inpUpKey.inp.value,
          model: inpUpModel.inp.value
        },
        embedding: {
          baseUrl: inpEmbBase.inp.value,
          apiKey: inpEmbKey.inp.value,
          model: inpEmbModel.inp.value
        },
        ctx: {
          modelContextChars: _clampInt(inpWindow.inp.value, 8000, 10000000),
          maxPrevChars: _clampInt(inpPrevChars.inp.value, 1000, 10000000),
          maxProgressChars: _clampInt(inpProgChars.inp.value, 1000, 10000000),
          maxBibleChars: _clampInt(inpBibleChars.inp.value, 1000, 10000000),
          maxUpdateSourceChars: _clampInt(inpUpdChars.inp.value, 1000, 10000000),
        },
        constraints: {
          global: safeText(hard.ta.value).trim()
        },
        agent: {
          enabled: !!cbAgent.checked,
          targetChars: parseInt(String(selAgentTarget.sel.value || '3000'), 10) || 3000,
          audit: !!cbAudit.checked
        },
      }
      cfg = await saveCfg(ctx, patch)
      ctx.ui.notice(t('已保存', 'Saved'), 'ok', 1400)
    } catch (e) {
      ctx.ui.notice(t('保存失败：', 'Save failed: ') + (e && e.message ? e.message : String(e)), 'err', 2200)
    }
  }
  secSave.appendChild(btnSave)

  body.appendChild(secBackend)
  body.appendChild(secUp)
  body.appendChild(secCtx)
  body.appendChild(secAgent)
  body.appendChild(secEmb)
  body.appendChild(secRecharge)
  body.appendChild(secSave)

  dlg.appendChild(head)
  dlg.appendChild(body)
  overlay.appendChild(dlg)
  document.body.appendChild(overlay)
  __DIALOG__ = overlay

  // 初次打开尝试刷新一次
  try { await refreshBilling() } catch {}
}

function createDialogShell(title, onClose) {
  ensureDialogStyle()
  closeDialog()

  const overlay = document.createElement('div')
  overlay.className = 'ain-overlay'

  const dlg = document.createElement('div')
  dlg.className = 'ain-dlg'

  const head = document.createElement('div')
  head.className = 'ain-head'

  const ttl = document.createElement('div')
  ttl.className = 'ain-title'
  ttl.textContent = title

  const btns = document.createElement('div')
  btns.className = 'ain-winbtns'

  const btnMin = document.createElement('button')
  btnMin.className = 'ain-winbtn'
  btnMin.textContent = '—'
  btnMin.title = t('最小化', 'Minimize')
  btnMin.onclick = () => {
    try { overlay.style.display = 'none' } catch {}
    const closeFn = () => {
      if (typeof onClose === 'function') onClose()
      else closeDialog()
    }
    _ainMinimizeToBar(ttl.textContent, () => { try { overlay.style.display = '' } catch {} }, closeFn)
  }

  const btnX = document.createElement('button')
  btnX.className = 'ain-winbtn ain-close'
  btnX.textContent = '×'
  btnX.title = t('关闭', 'Close')
  btnX.onclick = () => {
    if (typeof onClose === 'function') onClose()
    else closeDialog()
  }

  btns.appendChild(btnMin)
  btns.appendChild(btnX)
  head.appendChild(ttl)
  head.appendChild(btns)

  const body = document.createElement('div')
  body.className = 'ain-body'

  dlg.appendChild(head)
  dlg.appendChild(body)
  overlay.appendChild(dlg)
  // 注意：不要通过点击遮罩关闭，避免拖拽选中文本时鼠标溢出误触导致窗口消失

  document.body.appendChild(overlay)
  __DIALOG__ = overlay
  return { overlay, dlg, head, body, ttl }
}

function mkTextarea(label, value) {
  const wrap = document.createElement('div')
  const lab = document.createElement('div')
  lab.className = 'ain-lab'
  lab.textContent = label
  const ta = document.createElement('textarea')
  ta.className = 'ain-ta'
  ta.value = value == null ? '' : String(value)
  wrap.appendChild(lab)
  wrap.appendChild(ta)
  return { wrap, ta }
}

function mkBtnRow() {
  const row = document.createElement('div')
  row.style.marginTop = '10px'
  return row
}

function openAskTextDialog(ctx, opts) {
  const o = opts || {}
  const title = String(o.title || t('输入', 'Input'))
  const label = String(o.label || '')
  const placeholder = String(o.placeholder || '')
  const initial = o.initial == null ? '' : String(o.initial)
  const allowEmpty = !!o.allowEmpty

  return new Promise((resolve) => {
    let done = false
    function finish(val) {
      if (done) return
      done = true
      try { closeDialog() } catch {}
      resolve(val)
    }

    const { body } = createDialogShell(title, () => finish(null))

    const sec = document.createElement('div')
    sec.className = 'ain-card'

    const ta = mkTextarea(label, initial)
    if (placeholder) ta.ta.placeholder = placeholder
    sec.appendChild(ta.wrap)

    const row = mkBtnRow()
    const btnOk = document.createElement('button')
    btnOk.className = 'ain-btn'
    btnOk.textContent = t('确定', 'OK')
    const btnCancel = document.createElement('button')
    btnCancel.className = 'ain-btn gray'
    btnCancel.style.marginLeft = '8px'
    btnCancel.textContent = t('取消', 'Cancel')

    row.appendChild(btnOk)
    row.appendChild(btnCancel)
    sec.appendChild(row)
    body.appendChild(sec)

    function submit() {
      const v = String(ta.ta.value || '')
      if (!allowEmpty && !v.trim()) {
        ctx && ctx.ui && ctx.ui.notice && ctx.ui.notice(t('内容不能为空', 'Value cannot be empty'), 'err', 1600)
        return
      }
      finish(v)
    }

    btnOk.onclick = submit
    btnCancel.onclick = () => finish(null)
    ta.ta.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + Enter 提交，避免 Enter 误触
      const k = e && e.key ? String(e.key) : ''
      if (k === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        submit()
      }
    })

    try { ta.ta.focus() } catch {}
  })
}

function openConfirmDialog(ctx, opts) {
  const o = opts || {}
  const title = String(o.title || t('确认', 'Confirm'))
  const message = String(o.message || '')
  const okText = String(o.okText || t('确定', 'OK'))
  const cancelText = String(o.cancelText || t('取消', 'Cancel'))

  return new Promise((resolve) => {
    let done = false
    function finish(val) {
      if (done) return
      done = true
      try { closeDialog() } catch {}
      resolve(!!val)
    }

    const { body } = createDialogShell(title, () => finish(false))

    const sec = document.createElement('div')
    sec.className = 'ain-card'

    const msg = document.createElement('div')
    msg.className = 'ain-out'
    msg.textContent = message
    sec.appendChild(msg)

    const row = mkBtnRow()
    const btnOk = document.createElement('button')
    btnOk.className = 'ain-btn'
    btnOk.textContent = okText
    const btnCancel = document.createElement('button')
    btnCancel.className = 'ain-btn gray'
    btnCancel.style.marginLeft = '8px'
    btnCancel.textContent = cancelText

    row.appendChild(btnOk)
    row.appendChild(btnCancel)
    sec.appendChild(row)
    body.appendChild(sec)

    btnOk.onclick = () => finish(true)
    btnCancel.onclick = () => finish(false)
  })
}

function openPickOptionDialog(ctx, arr) {
  const list = Array.isArray(arr) ? arr : []
  if (!list.length) return Promise.resolve(null)

  return new Promise((resolve) => {
    let done = false
    let sel = 0

    function finish(val) {
      if (done) return
      done = true
      try { closeDialog() } catch {}
      resolve(val)
    }

    const { body } = createDialogShell(t('选择走向', 'Pick option'), () => finish(null))

    const sec = document.createElement('div')
    sec.className = 'ain-card'
    sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('走向候选（点击选择）', 'Options (click to select)')}</div>`

    const box = document.createElement('div')
    sec.appendChild(box)

    const items = []
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {}
      const title = String(it.title || it.name || '').trim() || t('未命名', 'Untitled')
      const one = String(it.one_line || it.oneline || it.summary || '').trim()

      const el = document.createElement('div')
      el.className = 'ain-opt' + (i === sel ? ' sel' : '')

      const a = document.createElement('div')
      a.className = 'ain-opt-title'
      a.textContent = `${i + 1}. ${title}`

      const b = document.createElement('div')
      b.className = 'ain-opt-sub'
      b.textContent = one || t('（无一句话概括）', '(no one-line summary)')

      el.appendChild(a)
      el.appendChild(b)
      el.onclick = () => {
        sel = i
        for (let k = 0; k < items.length; k++) {
          items[k].className = 'ain-opt' + (k === sel ? ' sel' : '')
        }
      }

      items.push(el)
      box.appendChild(el)
    }

    const row = mkBtnRow()
    const btnOk = document.createElement('button')
    btnOk.className = 'ain-btn'
    btnOk.textContent = t('确定', 'OK')
    const btnCancel = document.createElement('button')
    btnCancel.className = 'ain-btn gray'
    btnCancel.style.marginLeft = '8px'
    btnCancel.textContent = t('取消', 'Cancel')

    row.appendChild(btnOk)
    row.appendChild(btnCancel)
    sec.appendChild(row)

    body.appendChild(sec)

    btnOk.onclick = () => finish(list[sel] || null)
    btnCancel.onclick = () => finish(null)
  })
}

async function openNextOptionsDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('走向候选', 'Options'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('指令', 'Instruction')}</div>`

  const inp = mkTextarea(
    t('描述你希望本章怎么发展（Ctrl+Enter 提交，不写也行）', 'Describe what you want (Ctrl+Enter to submit, optional)'),
    ''
  )
  sec.appendChild(inp.wrap)

  const extra = mkTextarea(
    t('硬约束（可空）：语气、节奏、视角、禁写项、变更单…（会进入 system）', 'Hard constraints (optional): tone, pacing, POV, no-go, change log... (goes to system)'),
    ''
  )
  sec.appendChild(extra.wrap)

  const row = mkBtnRow()
  const btnGen = document.createElement('button')
  btnGen.className = 'ain-btn'
  btnGen.textContent = t('生成候选', 'Generate options')

  const btnInsertJson = document.createElement('button')
  btnInsertJson.className = 'ain-btn gray'
  btnInsertJson.style.marginLeft = '8px'
  btnInsertJson.textContent = t('插入候选 JSON 到文末', 'Insert JSON to doc')
  btnInsertJson.disabled = true

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.style.marginLeft = '8px'
  btnWrite.textContent = t('按选中走向续写', 'Write with selected')
  btnWrite.disabled = true

  row.appendChild(btnGen)
  row.appendChild(btnInsertJson)
  row.appendChild(btnWrite)
  sec.appendChild(row)

  const optBox = document.createElement('div')
  optBox.style.marginTop = '10px'
  sec.appendChild(optBox)

  const selRow = document.createElement('div')
  selRow.className = 'ain-selrow'
  const selLab = document.createElement('div')
  selLab.className = 'ain-lab'
  selLab.textContent = t('选中走向', 'Selected')
  const selSelect = document.createElement('select')
  selSelect.className = 'ain-in ain-select'
  selSelect.disabled = true
  selSelect.onchange = () => {
    const idx = parseInt(String(selSelect.value || '0'), 10)
    if (!Number.isFinite(idx)) return
    const max = Array.isArray(lastArr) ? (lastArr.length - 1) : 0
    selectedIdx = Math.max(0, Math.min(idx, max))
    renderOptions()
  }
  const selHint = document.createElement('div')
  selHint.className = 'ain-muted'
  selHint.textContent = t('提示：点候选卡片或用下拉框切换；默认选第 1 条', 'Tip: click a card or use the dropdown; default is #1')
  selRow.appendChild(selLab)
  selRow.appendChild(selSelect)
  sec.appendChild(selRow)
  sec.appendChild(selHint)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('候选/正文会显示在这里。', 'Options/output will appear here.')
  sec.appendChild(out)

  const row2 = mkBtnRow()
  const btnAppend = document.createElement('button')
  btnAppend.className = 'ain-btn gray'
  btnAppend.textContent = t('追加到文末（立即生效）', 'Append to doc (immediate)')
  btnAppend.disabled = true

  const btnAppendDraft = document.createElement('button')
  btnAppendDraft.className = 'ain-btn gray'
  btnAppendDraft.style.marginLeft = '8px'
  btnAppendDraft.textContent = t('追加为草稿（可审阅）', 'Append as draft (reviewable)')
  btnAppendDraft.disabled = true

  const btnReview = document.createElement('button')
  btnReview.className = 'ain-btn gray'
  btnReview.style.marginLeft = '8px'
  btnReview.textContent = t('审阅/修改草稿（对话）', 'Review/Edit draft (chat)')
  btnReview.disabled = true
  row2.appendChild(btnAppend)
  row2.appendChild(btnAppendDraft)
  row2.appendChild(btnReview)
  sec.appendChild(row2)

  body.appendChild(sec)

  let lastArr = null
  let selectedIdx = 0
  let lastText = ''
  let lastDraftId = ''

  function renderOptions() {
    optBox.innerHTML = ''
    const list = Array.isArray(lastArr) ? lastArr : []
    if (!list.length) return

    const items = []
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {}
      const title = String(it.title || it.name || '').trim() || t('未命名', 'Untitled')
      const one = String(it.one_line || it.oneline || it.summary || '').trim()

      const el = document.createElement('div')
      el.className = 'ain-opt' + (i === selectedIdx ? ' sel' : '')

      const a = document.createElement('div')
      a.className = 'ain-opt-title'
      a.textContent = `${i + 1}. ${title}`
      const b = document.createElement('div')
      b.className = 'ain-opt-sub'
      b.textContent = one || t('（无一句话概括）', '(no one-line summary)')

      el.appendChild(a)
      el.appendChild(b)
      el.onclick = () => {
        selectedIdx = i
        try { selSelect.value = String(i) } catch {}
        for (let k = 0; k < items.length; k++) {
          items[k].className = 'ain-opt' + (k === selectedIdx ? ' sel' : '')
        }
      }

      items.push(el)
      optBox.appendChild(el)
    }
  }

  async function doGen() {
    cfg = await loadCfg(ctx)
    const instruction = safeText(inp.ta.value).trim()
    const localConstraints = safeText(extra.ta.value).trim()

    setBusy(btnGen, true)
    setBusy(btnWrite, true)
    setBusy(btnInsertJson, true)
    setBusy(btnAppend, true)
    btnWrite.disabled = true
    btnInsertJson.disabled = true
    btnAppend.disabled = true
    out.textContent = t('生成中…', 'Generating...')
    lastArr = null
    selectedIdx = 0
    lastText = ''

    try {
      const r = await callNovel(ctx, 'options', instruction || t('给出走向候选', 'Give options'), localConstraints)
      if (!r) {
        out.textContent = t('已取消。', 'Cancelled.')
        return
      }
      let arr = Array.isArray(r.json && r.json.data) ? r.json.data : null
      if ((!arr || !arr.length) && r.json && r.json.text) {
        arr = tryParseOptionsDataFromText(r.json.text)
      }
      if (!arr || !arr.length) {
        out.textContent = safeText((r.json && r.json.text) || t('走向候选为空', 'No options returned'))
        return
      }
      lastArr = arr
      // 填充下拉框
      try {
        selSelect.innerHTML = ''
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i] || {}
          const title = String(it.title || it.name || '').trim() || t('未命名', 'Untitled')
          const op = document.createElement('option')
          op.value = String(i)
          op.textContent = `${i + 1}. ${title}`
          selSelect.appendChild(op)
        }
        selSelect.disabled = false
        selSelect.value = '0'
      } catch {}
      renderOptions()
      out.textContent = JSON.stringify(arr, null, 2)
      btnInsertJson.disabled = false
      btnWrite.disabled = false
      ctx.ui.notice(t('已生成走向候选', 'Options ready'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnGen, false)
    }
  }

  async function doWrite() {
    const list = Array.isArray(lastArr) ? lastArr : []
    if (!list.length) return
    const chosen = list[selectedIdx] || null
    if (!chosen) return

    cfg = await loadCfg(ctx)
    const instruction = safeText(inp.ta.value).trim()
    const localConstraints = safeText(extra.ta.value).trim()
    const constraints = mergeConstraints(cfg, localConstraints)
    if (!instruction) {
      ctx.ui.notice(t('请先写一句“指令/目标”', 'Please provide instruction/goal'), 'err', 1800)
      return
    }

    const prev = await getPrevTextForRequest(ctx, cfg)
    const progress = await getProgressDocText(ctx, cfg)
    const bible = await getBibleDocText(ctx, cfg)
    let rag = null
    try {
      rag = await rag_get_hits(ctx, cfg, instruction + '\n\n' + sliceTail(prev, 2000))
    } catch {}

    setBusy(btnWrite, true)
    btnAppend.disabled = true
    btnAppendDraft.disabled = true
    btnReview.disabled = true
    out.textContent = t('续写中…', 'Writing...')
    lastText = ''
    lastDraftId = ''
    try {
      const r = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
        mode: 'novel',
        action: 'write',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          instruction,
          progress,
          bible,
          prev,
          choice: chosen,
          constraints: constraints || undefined,
          rag: rag || undefined
        }
      })
      lastText = safeText(r && r.text).trim()
      if (!lastText) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
      out.textContent = lastText
      btnAppend.disabled = false
      btnAppendDraft.disabled = false
      ctx.ui.notice(t('已生成正文（未写入文档）', 'Generated (not inserted)'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnWrite, false)
    }
  }

  btnGen.onclick = () => { doGen().catch(() => {}) }
  btnWrite.onclick = () => { doWrite().catch(() => {}) }
  selSelect.onchange = () => {
    const v = parseInt(String(selSelect.value || '0'), 10)
    if (!Number.isFinite(v)) return
    selectedIdx = Math.max(0, v | 0)
    renderOptions()
  }
  btnInsertJson.onclick = () => {
    try {
      const arr = Array.isArray(lastArr) ? lastArr : null
      if (!arr) return
      appendToDoc(ctx, JSON.stringify(arr, null, 2))
      ctx.ui.notice(t('已插入候选（JSON）到文末', 'Inserted JSON'), 'ok', 1600)
    } catch (e) {
      ctx.ui.notice(t('插入失败：', 'Insert failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }
  btnAppend.onclick = () => {
    try {
      if (!lastText) return
      appendToDoc(ctx, lastText)
      ctx.ui.notice(t('已追加到文末', 'Appended'), 'ok', 1600)
      progress_auto_update_after_accept(ctx, lastText, '下一章续写追加到文末')
    } catch (e) {
      ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }

  btnAppendDraft.onclick = async () => {
    try {
      if (!lastText) return
      cfg = await loadCfg(ctx)
      const bid = genDraftBlockId()
      const block = wrapDraftBlock(lastText, bid)
      appendToDoc(ctx, block)
      lastDraftId = bid
      try { await saveLastDraftInfo(ctx, cfg, bid) } catch {}
      btnReview.disabled = false
      ctx.ui.notice(t('已追加草稿块（不会自动更新进度）', 'Draft appended (no auto progress update)'), 'ok', 2000)
      try {
        await openDraftReviewDialog(ctx, { blockId: bid, text: lastText })
      } catch {}
    } catch (e) {
      ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  btnReview.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const bid = String(lastDraftId || '').trim()
      if (!bid) {
        ctx.ui.notice(t('没有可审阅的草稿：请先用“追加为草稿”。', 'No draft: append as draft first.'), 'err', 2200)
        return
      }
      const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
      const txt = extractDraftBlockText(doc, bid)
      if (!txt) throw new Error(t('未找到草稿块', 'Draft block not found'))
      await openDraftReviewDialog(ctx, { blockId: bid, text: txt })
    } catch (e) {
      ctx.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  inp.ta.addEventListener('keydown', (e) => {
    const k = e && e.key ? String(e.key) : ''
    if (k === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      doGen().catch(() => {})
    }
  })
}

async function openWriteWithChoiceDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('走向及续写', 'Options & Write'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('指令', 'Instruction')}</div>`

  const inp = mkTextarea(
    t('输入本章目标/要求（Ctrl+Enter 生成走向候选）', 'Input goal/constraints (Ctrl+Enter to generate options)'),
    ''
  )
  sec.appendChild(inp.wrap)

  const extra = mkTextarea(
    t('硬约束（可空）：语气、节奏、视角、禁写项、变更单…（会进入 system）', 'Hard constraints (optional): tone, pacing, POV, no-go, change log... (goes to system)'),
    ''
  )
  sec.appendChild(extra.wrap)

  const a0 = _ainAgentGetCfg(cfg)
  const agentBox = document.createElement('div')
  agentBox.style.marginTop = '8px'
  agentBox.style.display = 'flex'
  agentBox.style.flexWrap = 'wrap'
  agentBox.style.gap = '10px'
  agentBox.style.alignItems = 'center'

  const agentLine = document.createElement('label')
  agentLine.style.display = 'flex'
  agentLine.style.gap = '8px'
  agentLine.style.alignItems = 'center'
  const cbAgent = document.createElement('input')
  cbAgent.type = 'checkbox'
  cbAgent.checked = !!a0.enabled
  agentLine.appendChild(cbAgent)
  agentLine.appendChild(document.createTextNode(t('Agent（Plan/TODO 多轮写作）', 'Agent (Plan/TODO multi-round writing)')))
  agentBox.appendChild(agentLine)

  const selAgentTarget = document.createElement('select')
  selAgentTarget.className = 'ain-in ain-select'
  selAgentTarget.style.width = '180px'
  ;[1000, 2000, 3000, 4000].forEach((n) => {
    const op = document.createElement('option')
    op.value = String(n)
    op.textContent = t('≈ ', '≈ ') + String(n) + t(' 字', ' chars') + (n === 4000 ? t('（上限）', ' (max)') : '')
    selAgentTarget.appendChild(op)
  })
  try { selAgentTarget.value = String(a0.targetChars || 3000) } catch {}
  agentBox.appendChild(selAgentTarget)

  const auditLine = document.createElement('label')
  auditLine.style.display = 'flex'
  auditLine.style.gap = '8px'
  auditLine.style.alignItems = 'center'
  const cbAudit = document.createElement('input')
  cbAudit.type = 'checkbox'
  cbAudit.checked = !!a0.audit
  auditLine.appendChild(cbAudit)
  auditLine.appendChild(document.createTextNode(t('自动审计（更耗字符）', 'Auto audit (costs more)')))
  agentBox.appendChild(auditLine)

  const agentHint = document.createElement('div')
  agentHint.className = 'ain-muted'
  agentHint.textContent = t('提示：Agent 会先生成 TODO，再逐项执行，并在窗口实时更新进度；正文会按字数目标控制在 ≤4000 字（为了审阅成本），通常更耗字符余额。', 'Note: Agent generates TODO then executes step-by-step with live progress; prose is capped to ≤4000 chars (for review cost), usually costs more chars.')
  sec.appendChild(agentBox)
  sec.appendChild(agentHint)

  const row = mkBtnRow()
  const btnOptions = document.createElement('button')
  btnOptions.className = 'ain-btn'
  btnOptions.textContent = t('生成走向候选', 'Generate options')

  const btnInsertJson = document.createElement('button')
  btnInsertJson.className = 'ain-btn gray'
  btnInsertJson.style.marginLeft = '8px'
  btnInsertJson.textContent = t('插入候选 JSON 到文末', 'Insert JSON to doc')
  btnInsertJson.disabled = true

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.style.marginLeft = '8px'
  btnWrite.textContent = t('按选中走向续写', 'Write with selected')
  btnWrite.disabled = true

  const btnWriteDirect = document.createElement('button')
  btnWriteDirect.className = 'ain-btn gray'
  btnWriteDirect.style.marginLeft = '8px'
  btnWriteDirect.textContent = t('直接按指令续写', 'Write directly')

  const btnAppend = document.createElement('button')
  btnAppend.className = 'ain-btn gray'
  btnAppend.style.marginLeft = '8px'
  btnAppend.textContent = t('追加到文末（立即生效）', 'Append to doc (immediate)')
  btnAppend.disabled = true

  row.appendChild(btnOptions)
  row.appendChild(btnInsertJson)
  row.appendChild(btnWrite)
  row.appendChild(btnWriteDirect)
  row.appendChild(btnAppend)
  sec.appendChild(row)

  const optBox = document.createElement('div')
  optBox.style.marginTop = '10px'
  sec.appendChild(optBox)

  const selRow = document.createElement('div')
  selRow.className = 'ain-selrow'
  const selLab = document.createElement('div')
  selLab.className = 'ain-lab'
  selLab.textContent = t('选中走向', 'Selected')
  const selSelect = document.createElement('select')
  selSelect.className = 'ain-in ain-select'
  selSelect.disabled = true
  selSelect.onchange = () => {
    const idx = parseInt(String(selSelect.value || '0'), 10)
    if (!Number.isFinite(idx)) return
    const max = Array.isArray(lastArr) ? (lastArr.length - 1) : 0
    selectedIdx = Math.max(0, Math.min(idx, max))
    renderOptions()
  }
  const selHint = document.createElement('div')
  selHint.className = 'ain-muted'
  selHint.textContent = t('提示：点候选卡片或用下拉框切换；默认选第 1 条', 'Tip: click a card or use the dropdown; default is #1')
  selRow.appendChild(selLab)
  selRow.appendChild(selSelect)
  sec.appendChild(selRow)
  sec.appendChild(selHint)

  const agentProgress = document.createElement('div')
  agentProgress.className = 'ain-card'
  agentProgress.style.display = 'none'
  agentProgress.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('Agent 进度', 'Agent progress')}</div>`
  const agentTodo = document.createElement('div')
  agentTodo.className = 'ain-todo'
  const agentLog = document.createElement('div')
  agentLog.className = 'ain-todo-log'
  agentLog.textContent = t('等待开始。', 'Waiting.')
  agentProgress.appendChild(agentTodo)
  agentProgress.appendChild(agentLog)
  sec.appendChild(agentProgress)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('走向候选/正文会显示在这里。', 'Options/output will appear here.')
  sec.appendChild(out)

  const row2 = mkBtnRow()
  const btnAppendDraft = document.createElement('button')
  btnAppendDraft.className = 'ain-btn gray'
  btnAppendDraft.textContent = t('追加为草稿（可审阅）', 'Append as draft (reviewable)')
  btnAppendDraft.disabled = true
  const btnReview = document.createElement('button')
  btnReview.className = 'ain-btn gray'
  btnReview.style.marginLeft = '8px'
  btnReview.textContent = t('审阅/修改草稿（对话）', 'Review/Edit draft (chat)')
  btnReview.disabled = true
  row2.appendChild(btnAppendDraft)
  row2.appendChild(btnReview)
  sec.appendChild(row2)

  body.appendChild(sec)

  let lastArr = null
  let selectedIdx = 0
  let lastText = ''
  let lastDraftId = ''

  function renderAgentProgress(items, logs) {
    try { agentProgress.style.display = '' } catch {}
    try {
      agentTodo.innerHTML = ''
      const arr = Array.isArray(items) ? items : []
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i] || {}
        const row = document.createElement('div')
        row.className = 'ain-todo-item'
        const st = document.createElement('div')
        st.className = 'ain-todo-st'
        st.textContent = _ainAgentStatusSymbol(it.status)
        const ttl = document.createElement('div')
        ttl.className = 'ain-todo-title'
        ttl.textContent = safeText(it.title || '')
        const meta = document.createElement('span')
        meta.className = 'ain-muted'
        meta.textContent = safeText(it.type || '')
        ttl.appendChild(meta)
        row.appendChild(st)
        row.appendChild(ttl)
        agentTodo.appendChild(row)
      }
    } catch {}
    try {
      const lines = Array.isArray(logs) ? logs : []
      agentLog.textContent = lines.join('\n')
      agentLog.scrollTop = agentLog.scrollHeight
    } catch {}
  }

  function ensureInstruction(v, fallback) {
    const s = safeText(v).trim()
    return s || safeText(fallback).trim() || '继续'
  }

  function makeDirectChoice(instruction) {
    const ins = safeText(instruction).trim().replace(/\s+/g, ' ')
    const one = ins.length > 180 ? (ins.slice(0, 180) + '…') : ins
    return {
      title: t('直接续写', 'Direct'),
      one_line: one,
      conflict: '',
      characters: [],
      foreshadow: '',
      risks: ''
    }
  }

  function getInstructionText() {
    return safeText(inp.ta.value).trim()
  }

  function getLocalConstraintsText() {
    return safeText(extra.ta.value).trim()
  }

  function renderOptions() {
    optBox.innerHTML = ''
    const list = Array.isArray(lastArr) ? lastArr : []
    if (!list.length) return

    const items = []
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {}
      const title = String(it.title || it.name || '').trim() || t('未命名', 'Untitled')
      const one = String(it.one_line || it.oneline || it.summary || '').trim()

      const el = document.createElement('div')
      el.className = 'ain-opt' + (i === selectedIdx ? ' sel' : '')

      const a = document.createElement('div')
      a.className = 'ain-opt-title'
      a.textContent = `${i + 1}. ${title}`
      const b = document.createElement('div')
      b.className = 'ain-opt-sub'
      b.textContent = one || t('（无一句话概括）', '(no one-line summary)')

      el.appendChild(a)
      el.appendChild(b)
      el.onclick = () => {
        selectedIdx = i
        try { selSelect.value = String(i) } catch {}
        for (let k = 0; k < items.length; k++) {
          items[k].className = 'ain-opt' + (k === selectedIdx ? ' sel' : '')
        }
      }

      items.push(el)
      optBox.appendChild(el)
    }
  }

  async function doOptions() {
    cfg = await loadCfg(ctx)
    const instruction = ensureInstruction(getInstructionText(), t('基于当前上下文给出走向候选', 'Give options based on current context'))
    const localConstraints = getLocalConstraintsText()

    setBusy(btnOptions, true)
    setBusy(btnWrite, true)
    setBusy(btnWriteDirect, true)
    setBusy(btnAppend, true)
    setBusy(btnInsertJson, true)
    btnWrite.disabled = true
    btnAppend.disabled = true
    btnInsertJson.disabled = true
    out.textContent = t('生成走向候选中…（最多等 3 分钟）', 'Generating options... (up to 3 minutes)')
    lastArr = null
    selectedIdx = 0
    lastText = ''

    try {
      const opt = await callNovel(ctx, 'options', instruction, localConstraints)
      if (!opt) {
        out.textContent = t('已取消。', 'Cancelled.')
        return
      }
      let arr = Array.isArray(opt.json && opt.json.data) ? opt.json.data : null
      if ((!arr || !arr.length) && opt.json && opt.json.text) {
        arr = tryParseOptionsDataFromText(opt.json.text)
      }
      if (!arr || !arr.length) {
        out.textContent = safeText((opt.json && opt.json.text) || t('走向候选为空', 'No options returned'))
        return
      }
      lastArr = arr
      try {
        selSelect.innerHTML = ''
        for (let i = 0; i < arr.length; i++) {
          const it = arr[i] || {}
          const title = String(it.title || it.name || '').trim() || t('未命名', 'Untitled')
          const op = document.createElement('option')
          op.value = String(i)
          op.textContent = `${i + 1}. ${title}`
          selSelect.appendChild(op)
        }
        selSelect.disabled = false
        selSelect.value = '0'
      } catch {}
      renderOptions()
      out.textContent = JSON.stringify(arr, null, 2)
      btnWrite.disabled = false
      btnInsertJson.disabled = false
      ctx.ui.notice(t('已生成走向候选', 'Options ready'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnOptions, false)
      setBusy(btnInsertJson, false)
      setBusy(btnWriteDirect, false)
    }
  }

  async function doWrite() {
    const list = Array.isArray(lastArr) ? lastArr : []
    if (!list.length) return
    const chosen = list[selectedIdx] || null
    if (!chosen) return

    cfg = await loadCfg(ctx)
    const instruction = ensureInstruction(getInstructionText(), t('按选中走向续写本章', 'Write with the selected option'))
    const localConstraints = getLocalConstraintsText()
    const constraints = mergeConstraints(cfg, localConstraints)

    const prev = await getPrevTextForRequest(ctx, cfg)
    const progress = await getProgressDocText(ctx, cfg)
    const bible = await getBibleDocText(ctx, cfg)
    let rag = null
    try {
      rag = await rag_get_hits(ctx, cfg, instruction + '\n\n' + sliceTail(prev, 2000))
    } catch {}

    setBusy(btnWrite, true)
    setBusy(btnWriteDirect, true)
    btnAppend.disabled = true
    btnAppendDraft.disabled = true
    btnReview.disabled = true
    out.textContent = t('续写中…（最多等 3 分钟）', 'Writing... (up to 3 minutes)')
    lastText = ''
    lastDraftId = ''
    try {
      const agentEnabled = !!cbAgent.checked
      if (agentEnabled) {
        const targetChars = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
        const chunkCount = _ainAgentDeriveChunkCount(targetChars)
        const wantAudit = !!cbAudit.checked
        try { agentProgress.style.display = '' } catch {}
        try { agentLog.textContent = t('Agent 执行中…', 'Agent running...') } catch {}

        out.textContent = t('Agent 执行中…（多轮）', 'Agent running... (multi-round)')
        const res = await agentRunPlan(ctx, cfg, {
          instruction,
          choice: chosen,
          constraints: constraints || '',
          prev,
          progress,
          bible,
          rag: rag || null,
          targetChars,
          chunkCount,
          audit: wantAudit
        }, { render: renderAgentProgress })

        lastText = safeText(res && res.text).trim()
        if (!lastText) throw new Error(t('Agent 未返回正文', 'Agent returned empty text'))
        out.textContent = lastText
        btnAppend.disabled = false
        btnAppendDraft.disabled = false
        ctx.ui.notice(t('Agent 已完成（未写入文档）', 'Agent done (not inserted)'), 'ok', 1800)
        return
      }

      const r = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
        mode: 'novel',
        action: 'write',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          instruction,
          progress,
          bible,
          prev,
          choice: chosen,
          constraints: constraints || undefined,
          rag: rag || undefined
        }
      })
      lastText = safeText(r && r.text).trim()
      if (!lastText) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
      out.textContent = lastText
      btnAppend.disabled = false
      btnAppendDraft.disabled = false
      ctx.ui.notice(t('已生成正文（未写入文档）', 'Generated (not inserted)'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnWrite, false)
      setBusy(btnWriteDirect, false)
    }
  }

  async function doWriteDirect() {
    cfg = await loadCfg(ctx)
    const instruction = getInstructionText()
    const localConstraints = getLocalConstraintsText()
    const constraints = mergeConstraints(cfg, localConstraints)
    if (!instruction) {
      ctx.ui.notice(t('请先写清楚“本章目标/要求”', 'Please provide instruction/goal'), 'err', 2000)
      return
    }

    const prev = await getPrevTextForRequest(ctx, cfg)
    const progress = await getProgressDocText(ctx, cfg)
    const bible = await getBibleDocText(ctx, cfg)
    let rag = null
    try {
      rag = await rag_get_hits(ctx, cfg, instruction + '\n\n' + sliceTail(prev, 2000))
    } catch {}

    setBusy(btnWriteDirect, true)
    setBusy(btnWrite, true)
    btnAppend.disabled = true
    btnAppendDraft.disabled = true
    btnReview.disabled = true
    out.textContent = t('续写中…（不走候选）', 'Writing... (no options)')
    lastText = ''
    lastDraftId = ''

    try {
      const agentEnabled = !!cbAgent.checked
      if (agentEnabled) {
        const targetChars = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
        const chunkCount = _ainAgentDeriveChunkCount(targetChars)
        const wantAudit = !!cbAudit.checked
        try { agentProgress.style.display = '' } catch {}
        try { agentLog.textContent = t('Agent 执行中…', 'Agent running...') } catch {}

        out.textContent = t('Agent 执行中…（多轮，不走候选）', 'Agent running... (multi-round, no options)')
        const res = await agentRunPlan(ctx, cfg, {
          instruction,
          choice: makeDirectChoice(instruction),
          constraints: constraints || '',
          prev,
          progress,
          bible,
          rag: rag || null,
          targetChars,
          chunkCount,
          audit: wantAudit
        }, { render: renderAgentProgress })

        lastText = safeText(res && res.text).trim()
        if (!lastText) throw new Error(t('Agent 未返回正文', 'Agent returned empty text'))
        out.textContent = lastText
        btnAppend.disabled = false
        btnAppendDraft.disabled = false
        ctx.ui.notice(t('Agent 已完成（未写入文档）', 'Agent done (not inserted)'), 'ok', 1800)
        return
      }

      const r = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
        mode: 'novel',
        action: 'write',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          instruction,
          progress,
          bible,
          prev,
          choice: makeDirectChoice(instruction),
          constraints: constraints || undefined,
          rag: rag || undefined
        }
      })
      lastText = safeText(r && r.text).trim()
      if (!lastText) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
      out.textContent = lastText
      btnAppend.disabled = false
      btnAppendDraft.disabled = false
      ctx.ui.notice(t('已生成正文（未写入文档）', 'Generated (not inserted)'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnWriteDirect, false)
      setBusy(btnWrite, false)
    }
  }

  btnOptions.onclick = () => { doOptions().catch(() => {}) }
  btnWrite.onclick = () => { doWrite().catch(() => {}) }
  btnWriteDirect.onclick = () => { doWriteDirect().catch(() => {}) }
  btnInsertJson.onclick = () => {
    try {
      const arr = Array.isArray(lastArr) ? lastArr : null
      if (!arr) return
      appendToDoc(ctx, JSON.stringify(arr, null, 2))
      ctx.ui.notice(t('已插入候选（JSON）到文末', 'Inserted JSON'), 'ok', 1600)
    } catch (e) {
      ctx.ui.notice(t('插入失败：', 'Insert failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }
  selSelect.onchange = () => {
    const v = parseInt(String(selSelect.value || '0'), 10)
    if (!Number.isFinite(v)) return
    selectedIdx = Math.max(0, v | 0)
    renderOptions()
  }
  btnAppend.onclick = () => {
    try {
      if (!lastText) return
      appendToDoc(ctx, lastText)
      ctx.ui.notice(t('已追加到文末', 'Appended'), 'ok', 1600)
      progress_auto_update_after_accept(ctx, lastText, '续写正文追加到文末')
    } catch (e) {
      ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }

  btnAppendDraft.onclick = async () => {
    try {
      if (!lastText) return
      cfg = await loadCfg(ctx)
      const bid = genDraftBlockId()
      appendToDoc(ctx, wrapDraftBlock(lastText, bid))
      lastDraftId = bid
      try { await saveLastDraftInfo(ctx, cfg, bid) } catch {}
      btnReview.disabled = false
      ctx.ui.notice(t('已追加草稿块（不会自动更新进度）', 'Draft appended (no auto progress update)'), 'ok', 2000)
      try { await openDraftReviewDialog(ctx, { blockId: bid, text: lastText }) } catch {}
    } catch (e) {
      ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  btnReview.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const bid = String(lastDraftId || '').trim()
      if (!bid) {
        ctx.ui.notice(t('没有可审阅的草稿：请先用“追加为草稿”。', 'No draft: append as draft first.'), 'err', 2200)
        return
      }
      const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
      const txt = extractDraftBlockText(doc, bid)
      if (!txt) throw new Error(t('未找到草稿块', 'Draft block not found'))
      await openDraftReviewDialog(ctx, { blockId: bid, text: txt })
    } catch (e) {
      ctx.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  inp.ta.addEventListener('keydown', (e) => {
    const k = e && e.key ? String(e.key) : ''
    if (k === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      doOptions().catch(() => {})
    }
  })
}

async function callNovel(ctx, action, instructionOverride, constraintsOverride) {
  const cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))

  let instruction = (instructionOverride != null ? String(instructionOverride) : '')
  if (instructionOverride == null) {
    const v = await openAskTextDialog(ctx, {
      title: t('输入指令（小说）', 'Enter instruction'),
      label: t('描述你想让 AI 做什么（Ctrl+Enter 提交）', 'Describe what you want (Ctrl+Enter to submit)'),
      placeholder: t('例如：从这个设定开始写第一章；或者给出走向候选…', 'e.g. write chapter 1 from this idea; or give options...'),
    })
    if (v == null) return null
    instruction = String(v)
  }
  instruction = instruction.trim()
  if (!instruction) return null
  const prev = await getPrevTextForRequest(ctx, cfg)
  const progress = await getProgressDocText(ctx, cfg)
  const bible = await getBibleDocText(ctx, cfg)
  let rag = null
  try {
    rag = await rag_get_hits(ctx, cfg, instruction + '\n\n' + sliceTail(prev, 2000))
  } catch {}
  const constraints = mergeConstraints(cfg, constraintsOverride)

  const json = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
    mode: 'novel',
    action,
    upstream: {
      baseUrl: cfg.upstream.baseUrl,
      apiKey: cfg.upstream.apiKey,
      model: cfg.upstream.model
    },
    input: {
      instruction,
      progress,
      bible,
      prev,
      constraints: constraints || undefined,
      rag: rag || undefined
    }
  })
  return { json, instruction }
}

function _ainAgentGetCfg(cfg) {
  const a = (cfg && cfg.agent && typeof cfg.agent === 'object') ? cfg.agent : {}

  function normTarget(v, fallback) {
    const n = parseInt(String(v == null ? '' : v), 10)
    if (n === 1000 || n === 2000 || n === 3000 || n === 4000) return n
    const fb = parseInt(String(fallback == null ? '' : fallback), 10)
    return (fb === 1000 || fb === 2000 || fb === 3000 || fb === 4000) ? fb : 3000
  }

  // 新配置：targetChars；旧配置：chunkCount（做个粗暴映射，避免“升级后全变默认值”）
  let targetChars = normTarget(a.targetChars != null ? a.targetChars : (a.target_chars != null ? a.target_chars : null), 3000)
  if (!(targetChars === 1000 || targetChars === 2000 || targetChars === 3000 || targetChars === 4000)) {
    targetChars = 3000
  }
  if (!(a.targetChars != null || a.target_chars != null) && a.chunkCount != null) {
    const c = parseInt(String(a.chunkCount), 10)
    if (Number.isFinite(c)) {
      if (c <= 1) targetChars = 1000
      else if (c === 2) targetChars = 2000
      else if (c === 3) targetChars = 3000
      else targetChars = 4000
    }
  }

  return {
    enabled: !!a.enabled,
    targetChars: targetChars,
    audit: !!a.audit,
  }
}

function _ainAgentDeriveChunkCount(targetChars) {
  const t0 = parseInt(String(targetChars == null ? '' : targetChars), 10)
  const t = (t0 === 1000 || t0 === 2000 || t0 === 3000 || t0 === 4000) ? t0 : 3000
  // 目标字数越大，分段越多；但最多 3 段（避免把上下文挤爆，反而更容易断裂）
  if (t <= 1200) return 1
  if (t <= 2400) return 2
  return 3
}

function _ainAgentStatusSymbol(st) {
  const s = String(st || '')
  if (s === 'running') return '▶'
  if (s === 'done') return '✓'
  if (s === 'error') return '✗'
  if (s === 'skipped') return '—'
  return '□'
}

function tryParseAgentPlanDataFromText(text) {
  let t0 = safeText(text).trim()
  if (!t0) return null

  const m = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(t0)
  if (m && m[1]) t0 = safeText(m[1]).trim()
  t0 = t0.replace(/^\uFEFF/, '').trim()

  try {
    const v = JSON.parse(t0)
    if (Array.isArray(v)) return v
  } catch {}

  const a = t0.indexOf('[')
  const b = t0.lastIndexOf(']')
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(t0.slice(a, b + 1))
      if (Array.isArray(v)) return v
    } catch {}
  }

  // 文本兜底：把每行当作 title
  const lines = t0.split(/\r?\n/).map((x) => safeText(x).trim()).filter(Boolean)
  if (!lines.length) return null
  const out = []
  for (let i = 0; i < lines.length && i < 14; i++) {
    const line = lines[i]
    const mm = /^(?:\d+\s*[\.\)、)]|[-*•])\s*(.+)$/.exec(line)
    const title = safeText(mm && mm[1] ? mm[1] : line).trim()
    if (!title) continue
    out.push({ title, type: 'note', instruction: '' })
  }
  return out.length ? out : null
}

function _ainAgentNormalizePlanItem(raw, idx) {
  const it = (raw && typeof raw === 'object') ? raw : {}
  const id = safeText(it.id || '').trim()
  const title = safeText(it.title || it.name || '').trim() || (t('步骤', 'Step') + ' ' + String((idx | 0) + 1))
  const typeRaw = safeText(it.type || it.kind || it.t || '').trim().toLowerCase()
  const allow = { rag: 1, consult: 1, write: 1, audit: 1, final: 1, note: 1 }
  const type = allow[typeRaw] ? typeRaw : 'note'
  const instruction = safeText(it.instruction || it.prompt || it.task || '').trim()
  const ragQuery = safeText(it.rag_query || it.ragQuery || it.query || '').trim()
  return { id, title, type, instruction, rag_query: ragQuery, status: 'pending', error: '' }
}

function buildFallbackAgentPlan(baseInstruction, targetChars, chunkCount, wantAudit) {
  const ins = safeText(baseInstruction).trim()
  const t0 = parseInt(String(targetChars == null ? '' : targetChars), 10)
  const t = (t0 === 1000 || t0 === 2000 || t0 === 3000 || t0 === 4000) ? t0 : 3000
  const n = _clampInt(chunkCount != null ? chunkCount : _ainAgentDeriveChunkCount(t), 1, 3)
  const perChunk = Math.max(600, Math.floor(t / n))
  const plan = []
  plan.push({
    id: 'blueprint',
    title: t('写作蓝图', 'Blueprint'),
    type: 'consult',
    instruction: [
      '任务：为“下一章续写”给出写作蓝图（不是正文）。',
      '请输出要点清单：本章目标/关键冲突/必出人物/必回收伏笔/禁写雷区/节奏与视角。',
      '要求：条目化，尽量一行一条，避免长段落。',
    ].join('\n')
  })
  plan.push({
    id: 'rag',
    title: t('补充检索', 'RAG'),
    type: 'rag',
    rag_query: ins || t('检索与本章相关的设定/人物/伏笔', 'Retrieve related canon/characters/foreshadowing'),
    instruction: ''
  })
  for (let i = 0; i < n; i++) {
    plan.push({
      id: 'w' + String(i + 1),
      title: t('分段写作 ', 'Write ') + String(i + 1) + '/' + String(n),
      type: 'write',
      instruction: [
        ins,
        '',
        `写作目标：本章总字数≈${t}（上限 4000）。本段建议≈${perChunk} 字。`,
        `现在写第 ${i + 1}/${n} 段正文：承接前文，避免重复；保持叙事视角与风格一致；段尾自然收束但不要总结。`
      ].filter(Boolean).join('\n')
    })
  }
  if (wantAudit) {
    plan.push({
      id: 'audit',
      title: t('一致性审计', 'Audit'),
      type: 'audit',
      instruction: '任务：对合并后的正文做一致性审计（进度脉络/故事圣经/硬约束），列出冲突点与修复建议。'
    })
  }
  plan.push({
    id: 'final',
    title: t('交付', 'Deliver'),
    type: 'final',
    instruction: t('交付说明（不要写正文）', 'Delivery note (no prose)')
  })
  return plan.map((x, i) => _ainAgentNormalizePlanItem(x, i))
}

function _ainAgentValidatePlan(items, chunkCount, wantAudit) {
  const arr = Array.isArray(items) ? items : []
  const w = arr.filter((x) => x && x.type === 'write').length
  const hasConsult = arr.some((x) => x && x.type === 'consult')
  const hasFinal = arr.some((x) => x && x.type === 'final')
  if (!hasConsult || !hasFinal) return false
  if (w !== _clampInt(chunkCount, 1, 3)) return false
  if (wantAudit && !arr.some((x) => x && x.type === 'audit')) return false
  return true
}

async function agentBuildPlan(ctx, cfg, base) {
  const t0 = parseInt(String(base && base.targetChars != null ? base.targetChars : ''), 10)
  const targetChars = (t0 === 1000 || t0 === 2000 || t0 === 3000 || t0 === 4000) ? t0 : 3000
  const chunkCount = _clampInt(base && base.chunkCount != null ? base.chunkCount : _ainAgentDeriveChunkCount(targetChars), 1, 3)
  const wantAudit = !!(base && base.audit)

  try {
    const resp = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
      mode: 'novel',
      action: 'plan',
      upstream: {
        baseUrl: cfg.upstream.baseUrl,
        apiKey: cfg.upstream.apiKey,
        model: cfg.upstream.model
      },
      input: {
        instruction: safeText(base && base.instruction).trim(),
        progress: safeText(base && base.progress),
        bible: base && base.bible != null ? base.bible : '',
        prev: safeText(base && base.prev),
        choice: base && base.choice != null ? base.choice : undefined,
        constraints: safeText(base && base.constraints).trim() || undefined,
        rag: base && base.rag ? base.rag : undefined,
        agent: { chunk_count: chunkCount, target_chars: targetChars, include_audit: wantAudit }
      }
    })
    let raw = Array.isArray(resp && resp.data) ? resp.data : null
    if (!raw && resp && resp.text) raw = tryParseAgentPlanDataFromText(resp.text)
    const norm = Array.isArray(raw) ? raw.map((x, i) => _ainAgentNormalizePlanItem(x, i)) : null
    if (norm && _ainAgentValidatePlan(norm, chunkCount, wantAudit)) return norm
  } catch (e) {
    if (!isActionNotSupportedError(e)) throw e
  }

  // 旧后端不支持 plan：用本地兜底计划
  return buildFallbackAgentPlan(base && base.instruction, targetChars, chunkCount, wantAudit)
}

async function agentRunPlan(ctx, cfg, base, ui) {
  const render = ui && typeof ui.render === 'function' ? ui.render : null
  const logBox = ui && typeof ui.log === 'function' ? ui.log : null

  const logs = []
  function pushLog(s) {
    const line = safeText(s).trimEnd()
    if (!line) return
    logs.push(line)
    if (logs.length > 200) logs.shift()
    if (logBox) {
      try { logBox(logs) } catch {}
    }
  }

  const t0 = parseInt(String(base && base.targetChars != null ? base.targetChars : ''), 10)
  const targetChars = (t0 === 1000 || t0 === 2000 || t0 === 3000 || t0 === 4000) ? t0 : 3000
  const chunkCount = _clampInt(base && base.chunkCount != null ? base.chunkCount : _ainAgentDeriveChunkCount(targetChars), 1, 3)
  const wantAudit = !!(base && base.audit)

  let items = await agentBuildPlan(ctx, cfg, { ...base, targetChars, chunkCount, audit: wantAudit })
  if (!Array.isArray(items) || !items.length) items = buildFallbackAgentPlan(base && base.instruction, targetChars, chunkCount, wantAudit)

  if (render) {
    try { render(items, logs) } catch {}
  }

  let rag = base && base.rag ? base.rag : null
  let draft = ''
  let auditText = ''

  function sliceNiceEnd(text, maxChars) {
    const s = String(text || '')
    const m = Math.max(0, maxChars | 0)
    if (!m || s.length <= m) return s
    const min = Math.max(0, m - 140)
    for (let i = m; i > min; i--) {
      const ch = s[i - 1]
      if (_ainDiffIsBreakChar(ch)) return s.slice(0, i).trimEnd()
    }
    return s.slice(0, m).trimEnd()
  }

  function curPrev() {
    const basePrev = safeText(base && base.prev)
    const merged = (basePrev.trim() ? (basePrev.trimEnd() + '\n\n') : '') + draft.trim()
    const lim = (cfg && cfg.ctx && cfg.ctx.maxPrevChars) ? (cfg.ctx.maxPrevChars | 0) : 8000
    return sliceTail(merged, lim)
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!it || !it.type) continue
    it.status = 'running'
    it.error = ''
    if (render) {
      try { render(items, logs) } catch {}
    }

    const started = Date.now()
    try {
      if (it.type === 'rag') {
        const q = safeText(it.rag_query || it.instruction || '').trim()
        if (!q) throw new Error(t('rag_query 为空', 'Empty rag_query'))
        const ragCfg = cfg && cfg.rag ? cfg.rag : {}
        if (ragCfg.enabled === false) {
          it.status = 'skipped'
          pushLog(t('跳过检索：RAG 已关闭', 'Skip RAG: disabled'))
        } else {
          rag = await rag_get_hits(ctx, cfg, q + '\n\n' + sliceTail(curPrev(), 1800))
          const n = Array.isArray(rag) ? rag.length : 0
          pushLog(t('检索命中：', 'RAG hits: ') + String(n))
          it.status = 'done'
        }
      } else if (it.type === 'consult') {
        const question = safeText(it.instruction).trim() || t('给出写作建议', 'Give advice')
        pushLog(t('咨询：', 'Consult: ') + question.split(/\r?\n/)[0].slice(0, 80))
        const resp = await apiFetchConsultWithJob(ctx, cfg, {
          upstream: {
            baseUrl: cfg.upstream.baseUrl,
            apiKey: cfg.upstream.apiKey,
            model: cfg.upstream.model
          },
          input: {
            async: true,
            mode: 'job',
            question,
            progress: safeText(base && base.progress),
            bible: base && base.bible != null ? base.bible : '',
            prev: curPrev(),
            constraints: safeText(base && base.constraints).trim(),
            rag: rag || undefined
          }
        }, {
          onTick: ({ waitMs }) => {
            const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
            if (render) {
              try { render(items, logs.concat([t('咨询中… 已等待 ', 'Consulting... waited ') + s + 's'])) } catch {}
            }
          }
        })
        const txt = safeText(resp && resp.text).trim()
        if (txt) pushLog(txt.replace(/\n{3,}/g, '\n\n').slice(0, 1800) + (txt.length > 1800 ? '\n…' : ''))
        it.status = 'done'
      } else if (it.type === 'write') {
        if (draft.trim().length >= targetChars) {
          it.status = 'skipped'
          pushLog(t('跳过写作：已达到字数目标', 'Skip write: target reached'))
          continue
        }
        const instruction = safeText(it.instruction).trim() || safeText(base && base.instruction).trim()
        if (!instruction) throw new Error(t('instruction 为空', 'Empty instruction'))
        const prev = curPrev()
        const progress = safeText(base && base.progress)
        const bible = base && base.bible != null ? base.bible : ''
        const constraints = safeText(base && base.constraints).trim()

        const rest = Math.max(0, targetChars - draft.trim().length)
        const perChunk = Math.max(600, Math.floor(targetChars / chunkCount))
        const wantLen = Math.max(300, Math.min(perChunk, rest || perChunk))
        const ins2 = [
          instruction,
          '',
          `长度目标：本章总字数≈${targetChars}（上限 4000）；本段尽量控制在 ≈${wantLen} 字（允许 ±15%），避免超长。`
        ].filter(Boolean).join('\n')

        const r = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
          mode: 'novel',
          action: 'write',
          upstream: {
            baseUrl: cfg.upstream.baseUrl,
            apiKey: cfg.upstream.apiKey,
            model: cfg.upstream.model
          },
          input: {
            instruction: ins2,
            progress,
            bible,
            prev,
            choice: base && base.choice != null ? base.choice : undefined,
            constraints: constraints || undefined,
            rag: rag || undefined
          }
        })
        const piece = safeText(r && r.text).trim()
        if (!piece) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
        draft = draft ? (draft.trimEnd() + '\n\n' + piece) : piece
        if (draft.length > targetChars) {
          draft = sliceNiceEnd(draft, targetChars)
        }
        it.status = 'done'
        pushLog(t('写作完成：追加 ', 'Written: +') + String(piece.length) + t(' 字符', ' chars'))
      } else if (it.type === 'audit') {
        if (!draft.trim()) {
          it.status = 'skipped'
          pushLog(t('跳过审计：正文为空', 'Skip audit: empty draft'))
        } else {
          pushLog(t('审计中…', 'Auditing...'))
          const resp = await apiFetchChatWithJob(ctx, cfg, {
            mode: 'novel',
            action: 'audit',
            upstream: {
              baseUrl: cfg.upstream.baseUrl,
              apiKey: cfg.upstream.apiKey,
              model: cfg.upstream.model
            },
            input: {
              async: true,
              mode: 'job',
              text: draft,
              progress: safeText(base && base.progress),
              bible: base && base.bible != null ? base.bible : '',
              prev: curPrev(),
              constraints: safeText(base && base.constraints).trim() || undefined,
              rag: rag || undefined
            }
          }, {
            onTick: ({ waitMs }) => {
              const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
              if (render) {
                try { render(items, logs.concat([t('审计中… 已等待 ', 'Auditing... waited ') + s + 's'])) } catch {}
              }
            }
          })
          auditText = safeText(resp && resp.text).trim()
          if (auditText) pushLog(auditText.replace(/\n{3,}/g, '\n\n').slice(0, 1800) + (auditText.length > 1800 ? '\n…' : ''))
          it.status = 'done'
        }
      } else if (it.type === 'final') {
        it.status = 'done'
        pushLog(t('完成', 'Done'))
      } else {
        it.status = 'skipped'
      }
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      it.status = 'error'
      it.error = msg
      pushLog(t('步骤失败：', 'Step failed: ') + msg)
      // 写作类出错就直接停；其它步骤尽量不中断
      if (it.type === 'write') break
    } finally {
      const ms = Math.max(0, Date.now() - started)
      pushLog(t('耗时 ', 'Took ') + String(ms) + 'ms')
      if (render) {
        try { render(items, logs) } catch {}
      }
    }
  }

  return { text: draft.trim(), auditText, items, logs }
}

function setBusy(btn, busy) {
  if (!btn) return
  btn.disabled = !!busy
}

function safeText(v) {
  return v == null ? '' : String(v)
}

function _safeInt(v, fallback) {
  const n = parseInt(String(v == null ? '' : v), 10)
  return Number.isFinite(n) ? n : (fallback | 0)
}

function _clampInt(n, min, max) {
  const x = _safeInt(n, 0)
  return Math.max(min | 0, Math.min(max | 0, x))
}

function getGlobalConstraints(cfg) {
  try {
    const v = cfg && cfg.constraints && cfg.constraints.global != null ? String(cfg.constraints.global) : ''
    return v.trim()
  } catch {
    return ''
  }
}

function mergeConstraints(cfg, localConstraints) {
  const g = getGlobalConstraints(cfg)
  const l = (localConstraints == null ? '' : String(localConstraints)).trim()
  if (g && l) return g + '\n' + l
  return g || l
}

function isActionNotSupportedError(e) {
  const msg = e && e.message ? String(e.message) : String(e)
  return /action\s*不支持|不支持或输入不完整|not\s+supported|not\s+support|unsupported/i.test(msg)
}

function tryParseOptionsDataFromText(text) {
  let t0 = safeText(text).trim()
  if (!t0) return null

  // 去掉 ```json 围栏
  const m = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(t0)
  if (m && m[1]) t0 = safeText(m[1]).trim()
  // 去 BOM（某些代理会塞）
  t0 = t0.replace(/^\uFEFF/, '').trim()

  function pick(x) {
    if (Array.isArray(x)) return x
    if (x && typeof x === 'object') {
      if (Array.isArray(x.data)) return x.data
      if (Array.isArray(x.options)) return x.options
    }
    return null
  }

  try {
    const v = JSON.parse(t0)
    const arr = pick(v)
    if (arr && arr.length) return arr
  } catch {}

  const a = t0.indexOf('[')
  const b = t0.lastIndexOf(']')
  if (a >= 0 && b > a) {
    try {
      const v = JSON.parse(t0.slice(a, b + 1))
      const arr = pick(v)
      if (arr && arr.length) return arr
    } catch {}
  }

  // 截断 JSON 兜底：尽量从数组里捞出“完整对象”
  function tryParsePartialJsonArray(s) {
    const str = safeText(s)
    const i0 = str.indexOf('[')
    if (i0 < 0) return null

    let inStr = false
    let esc = false
    let depth = 0
    let objStart = -1
    const out = []

    for (let i = i0 + 1; i < str.length; i++) {
      const ch = str[i]
      if (inStr) {
        if (esc) { esc = false; continue }
        if (ch === '\\') { esc = true; continue }
        if (ch === '"') { inStr = false; continue }
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') {
        if (depth === 0) objStart = i
        depth++
        continue
      }
      if (ch === '}') {
        if (depth > 0) depth--
        if (depth === 0 && objStart >= 0) {
          const seg = str.slice(objStart, i + 1)
          objStart = -1
          try {
            const v = JSON.parse(seg)
            if (v && typeof v === 'object') out.push(v)
          } catch {}
        }
        continue
      }
      // 看到 ] 就可以停（即便有尾巴）
      if (ch === ']') break
    }

    if (!out.length) return null
    // 统一成我们 UI 需要的字段（缺省填空）
    return out.map((it) => {
      const x = it && typeof it === 'object' ? it : {}
      const fo = x.foreshadow
      const foTxt = (fo && typeof fo === 'object') ? JSON.stringify(fo, null, 2) : safeText(fo)
      return {
        title: safeText(x.title || x.name).trim() || t('未命名', 'Untitled'),
        one_line: safeText(x.one_line || x.oneline || x.summary).trim(),
        conflict: safeText(x.conflict).trim(),
        characters: Array.isArray(x.characters) ? x.characters : [],
        foreshadow: safeText(foTxt).trim(),
        risks: safeText(x.risks).trim(),
      }
    })
  }

  try {
    const arr2 = tryParsePartialJsonArray(t0)
    if (arr2 && arr2.length) return arr2
  } catch {}

  // 编号/项目符号列表兜底
  const lines = t0.split(/\r?\n/)
  const items = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = safeText(lines[i]).trim()
    if (!line) continue
    if (!cur && /^(走向|候选|以下|给出|可以考虑|建议)/.test(line)) continue
    const mm = /^(?:\d+\s*[\.\)、)]|[-*•])\s*(.+)$/.exec(line)
    if (mm && mm[1]) {
      if (cur) items.push(cur)
      const txt = safeText(mm[1]).trim()
      let title = txt
      let one = ''
      const mm2 = /^(.{1,24}?)[：:，,\-—]\s*(.+)$/.exec(txt)
      if (mm2 && mm2[1] && mm2[2]) {
        title = safeText(mm2[1]).trim()
        one = safeText(mm2[2]).trim()
      }
      cur = { title: title || t('未命名', 'Untitled'), one_line: one, conflict: '', characters: [], foreshadow: '', risks: '' }
      continue
    }
    if (cur) cur.one_line = (cur.one_line ? (cur.one_line + ' ') : '') + line
  }
  if (cur) items.push(cur)
  return items.length ? items : null
}

function appendToDoc(ctx, text) {
  const cur = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
  const sep = cur.trim() ? '\n\n' : ''
  ctx.setEditorValue(cur + sep + safeText(text))
}

function genDraftBlockId() {
  try {
    const r = Math.random().toString(16).slice(2, 10)
    return String(Date.now()) + '-' + r
  } catch {
    return String(Date.now())
  }
}

function draftBeginMarker(id) {
  return `<!-- AINOVEL:DRAFT:BEGIN id=${String(id || '').trim()} -->`
}

function draftEndMarker(id) {
  return `<!-- AINOVEL:DRAFT:END id=${String(id || '').trim()} -->`
}

function wrapDraftBlock(text, id) {
  const bid = String(id || '').trim()
  const t0 = safeText(text).trim()
  return draftBeginMarker(bid) + '\n' + t0 + '\n' + draftEndMarker(bid)
}

function findDraftBlockRange(docText, id) {
  const doc = safeText(docText)
  const bid = String(id || '').trim()
  if (!bid) return null
  const a = draftBeginMarker(bid)
  const b = draftEndMarker(bid)
  const i0 = doc.lastIndexOf(a)
  if (i0 < 0) return null
  const i1 = doc.indexOf(b, i0 + a.length)
  if (i1 < 0) return null
  const contentStart = i0 + a.length
  const contentEnd = i1
  return { i0, i1, contentStart, contentEnd, a, b }
}

function extractDraftBlockText(docText, id) {
  const r = findDraftBlockRange(docText, id)
  if (!r) return ''
  const mid = safeText(docText).slice(r.contentStart, r.contentEnd)
  return mid.replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, '').trim()
}

function replaceDraftBlockText(docText, id, newText) {
  const r = findDraftBlockRange(docText, id)
  if (!r) return null
  const doc = safeText(docText)
  const before = doc.slice(0, r.contentStart)
  const after = doc.slice(r.contentEnd)
  const mid = '\n' + safeText(newText).trim() + '\n'
  return before + mid + after
}

function findLastDraftIdInDoc(docText) {
  const doc = safeText(docText)
  const re = /<!--\s*AINOVEL:DRAFT:BEGIN\s+id=([^\s]+)\s*-->/g
  let m = null
  let last = ''
  while ((m = re.exec(doc)) !== null) {
    if (m[1]) last = String(m[1]).trim()
  }
  return last
}

async function saveLastDraftInfo(ctx, cfg, blockId) {
  try {
    const inf = await inferProjectDir(ctx, cfg)
    const val = {
      blockId: String(blockId || ''),
      projectRel: inf && inf.projectRel ? String(inf.projectRel) : '',
      ts: Date.now()
    }
    if (ctx && ctx.storage && typeof ctx.storage.set === 'function') {
      await ctx.storage.set(DRAFT_KEY, val)
    }
    return val
  } catch {
    return null
  }
}

async function loadLastDraftInfo(ctx) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return null
    const v = await ctx.storage.get(DRAFT_KEY)
    if (!v || typeof v !== 'object') return null
    const blockId = v.blockId ? String(v.blockId) : ''
    if (!blockId) return null
    return {
      blockId,
      projectRel: v.projectRel ? String(v.projectRel) : '',
      ts: v.ts ? Number(v.ts) : 0
    }
  } catch {
    return null
  }
}

function _fmtLocalTs() {
  try {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return String(Date.now())
  }
}

async function progress_generate_update(ctx, cfg, deltaText, extraNote) {
  const text = safeText(deltaText).trim()
  if (!text) return ''
  const progress = await getProgressDocText(ctx, cfg)
  const bible = await getBibleDocText(ctx, cfg)
  const prev = await getPrevTextForRequest(ctx, cfg)
  const constraints = mergeConstraints(cfg, '')
  let rag = null
  try {
    rag = await rag_get_hits(ctx, cfg, text.slice(0, 1600))
  } catch {}

  const mergedText = extraNote ? (text + '\n\n【补充说明】\n' + safeText(extraNote).trim()) : text

  try {
    const json = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
      mode: 'novel',
      action: 'summary',
      upstream: {
        baseUrl: cfg.upstream.baseUrl,
        apiKey: cfg.upstream.apiKey,
        model: cfg.upstream.model
      },
      input: {
        text: mergedText,
        progress,
        bible,
        prev,
        constraints: constraints || undefined,
        rag: rag || undefined
      }
    })
    return safeText(json && json.text).trim()
  } catch (e) {
    // 兼容旧后端：如果它不支持 summary，就降级走 consult（不计费），至少保证“更新进度脉络”可用。
    if (!isActionNotSupportedError(e)) throw e

    const q = [
      '任务：基于【新增章节文本】，生成“进度脉络更新提议”。',
      '要求：按结构化小节输出（主线/时间线/人物状态/伏笔）；只写变更点；条目化；不要正文；不要复述全书。',
      '输出：Markdown 纯文本（允许列表），不要 JSON，不要 ``` 代码块。',
      '',
      '【新增章节文本】',
      mergedText
    ].join('\n')

    const resp = await apiFetchConsultWithJob(ctx, cfg, {
      upstream: {
        baseUrl: cfg.upstream.baseUrl,
        apiKey: cfg.upstream.apiKey,
        model: cfg.upstream.model
      },
      input: {
        question: q,
        progress,
        bible,
        prev,
        rag: rag || undefined
      }
    }, { timeoutMs: 190000 })

    return safeText(resp && resp.text).trim()
  }
}

async function progress_append_block(ctx, cfg, blockText, title) {
  const inf = await inferProjectDir(ctx, cfg)
  if (!inf) throw new Error(t('无法推断当前项目，请先在“项目管理”选择小说项目', 'Cannot infer project; select one in Project Manager'))
  const p = joinFsPath(inf.projectAbs, '01_进度脉络.md')
  let cur = ''
  try { cur = await readTextAny(ctx, p) } catch { cur = '' }
  const head = title ? ('## ' + String(title)) : ('## 更新 ' + _fmtLocalTs())
  const next = (safeText(cur).trimEnd() + '\n\n' + head + '\n\n' + safeText(blockText).trim() + '\n').trimStart()
  await writeTextAny(ctx, p, next)
}

async function progress_auto_update_after_accept(ctx, deltaText, reason) {
  try {
    const cfg = await loadCfg(ctx)
    const ragCfg = cfg && cfg.rag ? cfg.rag : {}
    if (ragCfg.autoUpdateProgress === false) return
    if (!cfg.token) return
    if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) return
    const upd = await progress_generate_update(ctx, cfg, deltaText, reason ? ('触发来源：' + String(reason)) : '')
    if (!upd) return
    await progress_append_block(ctx, cfg, upd, '自动更新 ' + _fmtLocalTs())
    // 进度脉络变了：顺手把索引也更新一下（失败不影响主流程）
    try { await rag_build_or_update_index(ctx, cfg) } catch {}
  } catch {}
}

async function openBootstrapDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('一键开坑（从0开始）', 'Start from zero'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('新建小说项目', 'Create novel project')}</div>`

  const titleIn = mkTextarea(t('项目标题（可改）', 'Project title (editable)'), '')
  titleIn.ta.style.minHeight = '54px'
  sec.appendChild(titleIn.wrap)

  const idea = mkTextarea(t('用一段话说明：题材、主角、目标、冲突、风格（越具体越好）', 'Describe genre, protagonist, goal, conflict, tone'), '')
  sec.appendChild(idea.wrap)

  const rowBtn = document.createElement('div')
  rowBtn.style.marginTop = '10px'

  const btnGenMeta = document.createElement('button')
  btnGenMeta.className = 'ain-btn gray'
  btnGenMeta.textContent = t('AI 生成资料', 'AI generate meta')

  const btnGen = document.createElement('button')
  btnGen.className = 'ain-btn'
  btnGen.textContent = t('生成第一章', 'Generate chapter 1')

  const btnAppend = document.createElement('button')
  btnAppend.className = 'ain-btn gray'
  btnAppend.style.marginLeft = '8px'
  btnAppend.textContent = t('创建项目并写入文件', 'Create project & write files')
  btnAppend.disabled = true

  rowBtn.appendChild(btnGenMeta)
  rowBtn.appendChild(btnGen)
  rowBtn.appendChild(btnAppend)
  sec.appendChild(rowBtn)

  const a0 = _ainAgentGetCfg(cfg)
  const agentBox = document.createElement('div')
  agentBox.style.marginTop = '10px'
  agentBox.style.display = 'flex'
  agentBox.style.flexWrap = 'wrap'
  agentBox.style.gap = '10px'
  agentBox.style.alignItems = 'center'

  const agentLine = document.createElement('label')
  agentLine.style.display = 'flex'
  agentLine.style.gap = '8px'
  agentLine.style.alignItems = 'center'
  const cbAgent = document.createElement('input')
  cbAgent.type = 'checkbox'
  cbAgent.checked = !!a0.enabled
  agentLine.appendChild(cbAgent)
  agentLine.appendChild(document.createTextNode(t('Agent（Plan/TODO 多轮写作）', 'Agent (Plan/TODO multi-round writing)')))
  agentBox.appendChild(agentLine)

  const selAgentTarget = document.createElement('select')
  selAgentTarget.className = 'ain-in ain-select'
  selAgentTarget.style.width = '180px'
  ;[1000, 2000, 3000, 4000].forEach((n) => {
    const op = document.createElement('option')
    op.value = String(n)
    op.textContent = t('≈ ', '≈ ') + String(n) + t(' 字', ' chars') + (n === 4000 ? t('（上限）', ' (max)') : '')
    selAgentTarget.appendChild(op)
  })
  try { selAgentTarget.value = String(a0.targetChars || 3000) } catch {}
  agentBox.appendChild(selAgentTarget)

  const auditLine = document.createElement('label')
  auditLine.style.display = 'flex'
  auditLine.style.gap = '8px'
  auditLine.style.alignItems = 'center'
  const cbAudit = document.createElement('input')
  cbAudit.type = 'checkbox'
  cbAudit.checked = !!a0.audit
  auditLine.appendChild(cbAudit)
  auditLine.appendChild(document.createTextNode(t('自动审计（更耗字符）', 'Auto audit (costs more)')))
  agentBox.appendChild(auditLine)

  const agentHint = document.createElement('div')
  agentHint.className = 'ain-muted'
  agentHint.style.marginTop = '6px'
  agentHint.textContent = t('提示：Agent 会先生成 TODO，再逐项执行，并实时显示进度；正文会按字数目标控制在 ≤4000 字（为了审阅成本），通常更耗字符余额。', 'Note: Agent generates TODO then executes step-by-step with live progress; prose is capped to ≤4000 chars (for review cost), usually costs more chars.')

  const agentProgress = document.createElement('div')
  agentProgress.className = 'ain-card'
  agentProgress.style.display = 'none'
  agentProgress.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('Agent 进度', 'Agent progress')}</div>`
  const agentTodo = document.createElement('div')
  agentTodo.className = 'ain-todo'
  const agentLog = document.createElement('div')
  agentLog.className = 'ain-todo-log'
  agentLog.textContent = t('等待开始。', 'Waiting.')
  agentProgress.appendChild(agentTodo)
  agentProgress.appendChild(agentLog)

  function renderAgentProgress(items, logs) {
    try { agentProgress.style.display = '' } catch {}
    try {
      agentTodo.innerHTML = ''
      const arr = Array.isArray(items) ? items : []
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i] || {}
        const row = document.createElement('div')
        row.className = 'ain-todo-item'
        const st = document.createElement('div')
        st.className = 'ain-todo-st'
        st.textContent = _ainAgentStatusSymbol(it.status)
        const ttl = document.createElement('div')
        ttl.className = 'ain-todo-title'
        ttl.textContent = safeText(it.title || '')
        const meta = document.createElement('span')
        meta.className = 'ain-muted'
        meta.textContent = safeText(it.type || '')
        ttl.appendChild(meta)
        row.appendChild(st)
        row.appendChild(ttl)
        agentTodo.appendChild(row)
      }
    } catch {}
    try {
      const lines = Array.isArray(logs) ? logs : []
      agentLog.textContent = lines.join('\n')
      agentLog.scrollTop = agentLog.scrollHeight
    } catch {}
  }

  sec.appendChild(agentBox)
  sec.appendChild(agentHint)
  sec.appendChild(agentProgress)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('输出会显示在这里。', 'Output will appear here.')
  sec.appendChild(out)

  const follow = document.createElement('div')
  follow.className = 'ain-card'
  follow.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('补充回答（可多轮）', 'Follow-up (multi-round)')}</div>`
  const followQ = document.createElement('div')
  followQ.className = 'ain-muted'
  followQ.textContent = t('如果 AI 提出“需要你补充”，把回答写在下面，然后点“继续生成资料”。', 'If AI asks questions, answer below then click Continue.')
  follow.appendChild(followQ)
  const qList = document.createElement('div')
  qList.className = 'ain-muted'
  qList.style.marginTop = '6px'
  qList.textContent = t('当前没有待补充的问题。', 'No pending questions.')
  follow.appendChild(qList)
  const followA = mkTextarea(t('你的补充回答', 'Your answers'), '')
  follow.appendChild(followA.wrap)
  const rowFollow = mkBtnRow()
  const btnContinue = document.createElement('button')
  btnContinue.className = 'ain-btn gray'
  btnContinue.textContent = t('继续生成资料', 'Continue meta')
  btnContinue.disabled = true
  rowFollow.appendChild(btnContinue)
  follow.appendChild(rowFollow)
  sec.appendChild(follow)

  const world = mkTextarea(t('世界设定（规则/地点/阵营等，可空）', 'World settings (optional)'), '')
  sec.appendChild(world.wrap)
  const chars = mkTextarea(t('主要角色（性格/状态，可空）', 'Main characters (optional)'), '')
  sec.appendChild(chars.wrap)
  const rels = mkTextarea(t('人物关系（可空）', 'Relations (optional)'), '')
  sec.appendChild(rels.wrap)
  const outline = mkTextarea(t('章节大纲（可空）', 'Chapter outline (optional)'), '')
  sec.appendChild(outline.wrap)

  body.appendChild(sec)

  let lastChapter = ''
  let projectTitle = ''
  let lastQuestions = []

  function renderQuestions() {
    const arr = Array.isArray(lastQuestions) ? lastQuestions : []
    const clean = arr.map((x) => safeText(x).trim()).filter(Boolean).slice(0, 12)
    if (!clean.length) {
      qList.textContent = t('当前没有待补充的问题。', 'No pending questions.')
      return
    }
    qList.textContent = t('需要你补充：\n', 'Need your input:\n') + clean.map((x) => '- ' + x).join('\n')
  }

  function guessTitleFromIdea(s) {
    const t0 = safeText(s).trim().replace(/\s+/g, ' ')
    if (!t0) return ''
    const cut = t0.length > 14 ? t0.slice(0, 14) : t0
    return safeFileName(cut, '新小说')
  }

  async function ensureTitle() {
    const cur = safeText(titleIn.ta.value).trim()
    if (cur) return cur
    const g = guessTitleFromIdea(idea.ta.value)
    if (g) {
      titleIn.ta.value = g
      return g
    }
    const fallback = t('新小说', 'New novel')
    titleIn.ta.value = fallback
    return fallback
  }

  async function doGenMeta() {
    const promptIdea = safeText(idea.ta.value).trim()
    if (!promptIdea) {
      ctx.ui.notice(t('请先填写故事概念', 'Please input story idea'), 'err', 2000)
      return
    }
    cfg = await loadCfg(ctx)
    setBusy(btnGenMeta, true)
    out.textContent = t('生成资料中…（不计费）', 'Generating meta... (no billing)')
    try {
      const title0 = await ensureTitle()

      // 兼容旧后端：它只认 question，不认 task/idea；所以同时带上 question
      // 新后端会识别 task=bootstrap 并返回结构化 data
      const q = [
        '任务：为“小说项目”生成资料文件内容（不是正文续写）。',
        '硬规则：禁止输出任何可直接当作小说正文的连续叙事文本，只能是设定/要点/大纲。',
        '请按以下分节输出（不要 JSON，不要 ``` 代码块）：',
        '【标题】',
        '【世界设定】（规则/地点/阵营）',
        '【主要角色】（性格/动机/当前状态）',
        '【人物关系】（角色之间关系/矛盾/利益）',
        '【章节大纲】（粗略 8 章左右即可；每章一行）',
        '【需要你补充】（信息不足时，只列问题）',
        '格式约束：每个分节最多 6 条要点；每条尽量一行；总字数越短越好。',
        '',
        (title0 ? ('标题提示：' + title0) : ''),
        '故事概念：',
        promptIdea
      ].filter(Boolean).join('\n')

      const resp = await apiFetchConsultWithJob(ctx, cfg, {
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          async: true,
          mode: 'job',
          task: 'bootstrap',
          idea: promptIdea,
          title_hint: title0,
          question: q,
          answers: safeText(followA.ta.value).trim(),
          world: safeText(world.ta.value).trim(),
          characters: safeText(chars.ta.value).trim(),
          relations: safeText(rels.ta.value).trim(),
          outline: safeText(outline.ta.value).trim(),
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(waitMs / 1000))
          out.textContent = t('生成资料中…（不计费）已等待 ', 'Generating meta... waited ') + s + 's'
        }
      })
      const data = resp && resp.data ? resp.data : null
      if (data && typeof data === 'object') {
        if (data.title && !safeText(titleIn.ta.value).trim()) titleIn.ta.value = safeText(data.title).trim()
        if (data.world) world.ta.value = safeText(data.world).trim()
        if (data.characters) chars.ta.value = safeText(data.characters).trim()
        if (data.relations) rels.ta.value = safeText(data.relations).trim()
        if (data.outline) outline.ta.value = safeText(data.outline).trim()
        lastQuestions = Array.isArray(data.questions) ? data.questions : []
        renderQuestions()
      } else {
        // 旧后端降级：从 text 里按分节提取
        const txt = safeText(resp && resp.text)
        function grab(sectionName) {
          const re = new RegExp('【' + sectionName + '】\\s*([\\s\\S]*?)(?=\\n\\s*【|$)', 'g')
          const m = re.exec(txt)
          return m && m[1] ? String(m[1]).trim() : ''
        }
        const title1 = grab('标题')
        const world1 = grab('世界设定')
        const chars1 = grab('主要角色')
        const rels1 = grab('人物关系')
        const outline1 = grab('章节大纲')
        if (title1 && !safeText(titleIn.ta.value).trim()) titleIn.ta.value = safeFileName(title1.split(/\r?\n/)[0], title0)
        if (world1) world.ta.value = world1
        if (chars1) chars.ta.value = chars1
        if (rels1) rels.ta.value = rels1
        if (outline1) outline.ta.value = outline1
        lastQuestions = []
        renderQuestions()
      }
      out.textContent = safeText(resp && resp.text).trim() || t('已生成资料', 'Meta generated')
      btnContinue.disabled = false
      ctx.ui.notice(t('已生成资料（可编辑）', 'Meta generated (editable)'), 'ok', 1800)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnGenMeta, false)
    }
  }

  async function doGenerate() {
    const promptIdea = safeText(idea.ta.value).trim()
    if (!promptIdea) {
      ctx.ui.notice(t('请先填写故事概念', 'Please input story idea'), 'err', 2000)
      return
    }
    cfg = await loadCfg(ctx)
    await ensureTitle()
    setBusy(btnGen, true)
    setBusy(btnAppend, true)
    out.textContent = t('生成中…', 'Generating...')
    lastChapter = ''
    projectTitle = safeText(titleIn.ta.value).trim()
    try {
      const constraints = mergeConstraints(cfg, '')
      const opt = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
        mode: 'novel',
        action: 'options',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: { instruction: promptIdea, progress: '', bible: '', prev: '', constraints: constraints || undefined }
      })
      const arr = Array.isArray(opt && opt.data) ? opt.data : null
      const chosen = (arr && arr.length) ? arr[0] : { title: '自动', one_line: '自动走向', conflict: '', characters: [], foreshadow: '', risks: '' }

      const agentEnabled = !!cbAgent.checked
      if (agentEnabled) {
        const targetChars = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
        const chunkCount = _ainAgentDeriveChunkCount(targetChars)
        const wantAudit = !!cbAudit.checked
        try { agentProgress.style.display = '' } catch {}
        try { agentLog.textContent = t('Agent 执行中…', 'Agent running...') } catch {}
        out.textContent = t('Agent 执行中…（多轮）', 'Agent running... (multi-round)')

        let rag = null
        try { rag = await rag_get_hits(ctx, cfg, promptIdea) } catch {}

        const res = await agentRunPlan(ctx, cfg, {
          instruction: promptIdea,
          choice: chosen,
          constraints: constraints || '',
          prev: '',
          progress: '',
          bible: '',
          rag: rag || null,
          targetChars,
          chunkCount,
          audit: wantAudit
        }, { render: renderAgentProgress })

        lastChapter = safeText(res && res.text).trim()
      } else {
        const first = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
          mode: 'novel',
          action: 'write',
          upstream: {
            baseUrl: cfg.upstream.baseUrl,
            apiKey: cfg.upstream.apiKey,
            model: cfg.upstream.model
          },
          input: { instruction: promptIdea, progress: '', bible: '', prev: '', choice: chosen, constraints: constraints || undefined }
        })
        lastChapter = safeText(first && first.text).trim()
      }
      if (!lastChapter) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
      out.textContent = lastChapter
      btnAppend.disabled = false
      ctx.ui.notice(t('已生成第一章（未写入文档）', 'Chapter generated (not inserted)'), 'ok', 1800)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnGen, false)
    }
  }

  async function doCreateProject() {
    if (!lastChapter) return
    cfg = await loadCfg(ctx)
    const inf = await inferProjectDir(ctx, cfg)
    if (!ctx.getLibraryRoot) throw new Error(t('当前环境不支持获取库根目录', 'Cannot get library root'))
    const libRoot = normFsPath(await ctx.getLibraryRoot())
    if (!libRoot) throw new Error(t('无法获取库根目录', 'Library root is empty'))

    const rootPrefix = normFsPath(cfg.novelRootDir || '小说/').replace(/^\/+/, '')
    const title = safeFileName(projectTitle || safeText(titleIn.ta.value), '新小说')
    let projectRel = joinFsPath(rootPrefix, title)
    let projectAbs = joinFsPath(libRoot, projectRel)

    // 冲突则自动加后缀
    let n = 2
    while (await projectMarkerExists(ctx, projectAbs)) {
      projectRel = joinFsPath(rootPrefix, title + '-' + n)
      projectAbs = joinFsPath(libRoot, projectRel)
      n++
      if (n > 99) break
    }

    const ok = await openConfirmDialog(ctx, {
      title: t('创建项目', 'Create project'),
      message: t('将在以下目录创建项目：', 'Will create project at: ') + projectRel + '\n' + t('并写入资料文件与第一章。继续？', 'and write meta files + chapter 1. Continue?')
    })
    if (!ok) return

    const now = Date.now()
    const meta = {
      id: String(now),
      title: title,
      created_at: now,
      updated_at: now,
    }

    const metaMd = [
      '# 项目信息',
      '',
      `- 标题：${title}`,
      `- 创建时间：${new Date(now).toISOString()}`,
      '',
      '## 说明',
      '- 这是人类可读的项目说明文件。',
      '- 机器用的索引/元数据在 `.ainovel/` 目录下（一般不需要你手动改）。',
      ''
    ].join('\n')

    await writeTextAny(ctx, joinFsPath(projectAbs, '00_项目.md'), metaMd)
    await writeTextAny(ctx, joinFsPath(projectAbs, '.ainovel/meta.json'), JSON.stringify(meta, null, 2))
    await writeTextAny(ctx, joinFsPath(projectAbs, '01_进度脉络.md'), t('# 进度脉络\n\n- （从这里开始记录主线/时间线/人物状态/伏笔）\n', '# Progress\n\n- (Track plot/timeline/characters/foreshadowing here)\n'))
    await writeTextAny(ctx, joinFsPath(projectAbs, '02_世界设定.md'), safeText(world.ta.value).trim() || t('# 世界设定\n\n- 规则：\n- 地点：\n- 阵营：\n', '# World\n\n- Rules:\n- Places:\n- Factions:\n'))
    await writeTextAny(ctx, joinFsPath(projectAbs, '03_主要角色.md'), safeText(chars.ta.value).trim() || t('# 主要角色\n\n- 角色名：性格/动机/当前状态\n', '# Characters\n\n- Name: traits/motivation/status\n'))
    await writeTextAny(ctx, joinFsPath(projectAbs, '04_人物关系.md'), safeText(rels.ta.value).trim() || t('# 人物关系\n\n- A ↔ B：关系/矛盾/利益\n', '# Relations\n\n- A ↔ B: relation/conflict/stakes\n'))
    await writeTextAny(ctx, joinFsPath(projectAbs, '05_章节大纲.md'), safeText(outline.ta.value).trim() || t('# 章节大纲\n\n- 第 1 章：\n- 第 2 章：\n', '# Outline\n\n- Chapter 1:\n- Chapter 2:\n'))
    await writeTextAny(ctx, joinFsPath(projectAbs, '.ainovel/index.json'), JSON.stringify({ version: 1, created_at: now }, null, 2))

    const chapDir = joinFsPath(projectAbs, '03_章节')
    const chapPath = joinFsPath(chapDir, '001_第一章.md')
    await writeTextAny(ctx, chapPath, '# 第一章\n\n' + lastChapter + '\n')
 
    cfg = await saveCfg(ctx, { currentProjectRel: projectRel })

    // 项目已落盘：后台构建 RAG 索引 + 自动更新进度脉络（失败不影响主流程）
    try { rag_build_or_update_index(ctx, cfg).catch(() => {}) } catch {}
    try { progress_auto_update_after_accept(ctx, lastChapter, '创建项目写入第一章') } catch {}
 
    try {
      if (typeof ctx.openFileByPath === 'function') {
        await ctx.openFileByPath(chapPath)
      }
    } catch {}

    out.textContent = t('已创建项目并写入文件：', 'Project created: ') + projectRel
    ctx.ui.notice(t('已创建项目并打开第一章', 'Project created, chapter opened'), 'ok', 2000)
  }

  btnGen.onclick = () => { doGenerate().catch(() => {}) }
  btnAppend.onclick = () => {
    doCreateProject().catch((e) => {
      ctx.ui.notice(t('创建失败：', 'Create failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    })
  }
  btnGenMeta.onclick = () => { doGenMeta().catch(() => {}) }
  renderQuestions()
  btnContinue.onclick = () => { doGenMeta().catch(() => {}) }
}

async function openConsultDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('写作咨询（不续写）', 'Writing consult (no continuation)'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('咨询问题', 'Question')}</div>`

  const q = mkTextarea(t('你想问什么？例如：后续走向、人物动机、节奏、伏笔回收、章节安排…', 'Ask about plot, motivation, pacing, foreshadowing...'), '')
  sec.appendChild(q.wrap)
  
  const cons = mkTextarea(t('本次硬约束（可空，合并全局硬约束后一起生效）', 'Hard constraints (optional, merged with global constraints)'), '')
  cons.ta.style.minHeight = '70px'
  sec.appendChild(cons.wrap)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('回答会显示在这里。', 'Answer will appear here.')

  const rowBtn = document.createElement('div')
  rowBtn.style.marginTop = '10px'

  const btnAsk = document.createElement('button')
  btnAsk.className = 'ain-btn'
  btnAsk.textContent = t('发送咨询', 'Send')

  const btnAppend = document.createElement('button')
  btnAppend.className = 'ain-btn gray'
  btnAppend.style.marginLeft = '8px'
  btnAppend.textContent = t('把建议追加到文末', 'Append advice to doc')
  btnAppend.disabled = true

  rowBtn.appendChild(btnAsk)
  rowBtn.appendChild(btnAppend)

  sec.appendChild(rowBtn)
  sec.appendChild(out)
  body.appendChild(sec)

  let lastAdvice = ''

  async function doAsk() {
    const question = safeText(q.ta.value).trim()
    if (!question) {
      ctx.ui.notice(t('请先输入问题', 'Please input question'), 'err', 2000)
      return
    }
    cfg = await loadCfg(ctx)

    const prev = await getPrevTextForRequest(ctx, cfg)
    const progress = await getProgressDocText(ctx, cfg)
    const bible = await getBibleDocText(ctx, cfg)
    const constraints = mergeConstraints(cfg, safeText(cons.ta.value).trim())
    let rag = null
    try {
      rag = await rag_get_hits(ctx, cfg, question + '\n\n' + sliceTail(prev, 2000))
    } catch {}

    setBusy(btnAsk, true)
    btnAppend.disabled = true
    out.textContent = t('咨询中…', 'Consulting...')
    lastAdvice = ''
    try {
      const json = await apiFetchConsultWithJob(ctx, cfg, {
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          async: true,
          mode: 'job',
          question,
          progress,
          bible,
          prev,
          constraints,
          rag: rag || undefined
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(waitMs / 1000))
          out.textContent = t('咨询中… 已等待 ', 'Consulting... waited ') + s + 's'
        }
      })
      lastAdvice = safeText(json && json.text).trim()
      if (!lastAdvice) throw new Error(t('后端未返回内容', 'Backend returned empty text'))
      out.textContent = lastAdvice
      btnAppend.disabled = false
      ctx.ui.notice(t('已返回建议（未写入文档）', 'Advice returned (not inserted)'), 'ok', 1800)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnAsk, false)
    }
  }

  btnAsk.onclick = () => { doAsk().catch(() => {}) }
  btnAppend.onclick = () => {
    try {
      if (!lastAdvice) return
      appendToDoc(ctx, t('【写作咨询】\n', '[Consult]\n') + lastAdvice)
      ctx.ui.notice(t('已追加到文末', 'Appended'), 'ok', 1800)
    } catch (e) {
      ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }
}

async function openAuditDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))

  const AUDIT_FILE = '06_一致性审计.md'
  const AUDIT_TIMEOUT_MS = 190000

  async function runAuditOnce(text) {
    const inputText = safeText(text).trim()
    if (!inputText) {
      throw new Error(t('没有可用文本：请先选中一段正文，或确保当前文档有内容。', 'No text: select some content or ensure the document is not empty.'))
    }
    const progress = await getProgressDocText(ctx, cfg)
    const bible = await getBibleDocText(ctx, cfg)
    const prev = await getPrevTextForRequest(ctx, cfg)
    const constraints = mergeConstraints(cfg, '')
    let rag = null
    try {
      rag = await rag_get_hits(ctx, cfg, inputText + '\n\n' + sliceTail(prev, 2000))
    } catch {}
    const json = await apiFetchChatWithJob(ctx, cfg, {
      mode: 'novel',
      action: 'audit',
      upstream: {
        baseUrl: cfg.upstream.baseUrl,
        apiKey: cfg.upstream.apiKey,
        model: cfg.upstream.model
      },
      input: { text: inputText, progress, bible, prev, constraints: constraints || undefined, rag: rag || undefined }
    }, {
      timeoutMs: AUDIT_TIMEOUT_MS,
    })
    const out = safeText(json && json.text).trim()
    if (!out) throw new Error(t('后端未返回审计结果', 'Backend returned empty audit'))
    return out
  }

  async function runAuditWithTimeout(text, opt) {
    const timeoutMs = opt && opt.timeoutMs != null ? Math.max(1000, Number(opt.timeoutMs) || 0) : AUDIT_TIMEOUT_MS
    const onTick = opt && typeof opt.onTick === 'function' ? opt.onTick : null
    const start = Date.now()
    let timer = null
    if (onTick) {
      timer = setInterval(() => {
        try { onTick({ waitMs: Date.now() - start }) } catch {}
      }, 1000)
    }
    try {
      return await Promise.race([
        runAuditOnce(text),
        sleep(timeoutMs).then(() => {
          throw new Error(t('审计超时：后端长时间无响应，请重试或换模型', 'Audit timeout: backend not responding, please retry or switch model'))
        })
      ])
    } finally {
      if (timer) clearInterval(timer)
    }
  }

  // 无窗口环境（极少见）：降级为“直接审计并追加到文末”
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) {
    const sel = ctx && ctx.getSelection ? ctx.getSelection() : null
    const raw = sel && sel.text ? String(sel.text) : safeText(ctx && ctx.getEditorValue ? ctx.getEditorValue() : '')
    const out = await runAuditWithTimeout(raw)
    appendToDoc(ctx, out)
    ctx.ui.notice(t('已把审计结果追加到文末', 'Audit appended'), 'ok', 2200)
    return
  }

  const { body } = createDialogShell(t('一致性审计', 'Audit'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('对当前选区/文档做一致性检查（结合进度脉络与资料文件）', 'Check consistency against progress/meta files')}</div>`

  const tip = document.createElement('div')
  tip.className = 'ain-muted'
  tip.textContent = t(
    '默认会在审计完成后把结果追加到文末（兼容旧行为）；你也可以把结果写入项目内审计文件。',
    'By default it will append the result to document end (compat mode); you can also write to a project audit file.'
  )
  sec.appendChild(tip)

  const rowOpt = document.createElement('div')
  rowOpt.style.display = 'flex'
  rowOpt.style.flexWrap = 'wrap'
  rowOpt.style.gap = '14px'
  rowOpt.style.marginTop = '10px'

  function mkCheck(label, checked) {
    const wrap = document.createElement('label')
    wrap.style.display = 'inline-flex'
    wrap.style.alignItems = 'center'
    wrap.style.gap = '8px'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!checked
    const tx = document.createElement('span')
    tx.className = 'ain-muted'
    tx.textContent = label
    wrap.appendChild(cb)
    wrap.appendChild(tx)
    return { wrap, cb }
  }

  const sel0 = ctx && ctx.getSelection ? ctx.getSelection() : null
  const hasSel0 = !!(sel0 && sel0.text && String(sel0.text).trim())
  const cSelOnly = mkCheck(t('仅审计选区（无选区则退化为全文）', 'Only selection (fallback to full text)'), hasSel0)
  const cAutoAppend = mkCheck(t('审计完成后自动追加到文末', 'Auto append to document'), false)
  rowOpt.appendChild(cSelOnly.wrap)
  rowOpt.appendChild(cAutoAppend.wrap)
  sec.appendChild(rowOpt)

  const fileHint = document.createElement('div')
  fileHint.className = 'ain-muted'
  fileHint.style.marginTop = '8px'
  fileHint.textContent = t(
    `写入审计文件：将追加到项目目录下的 ${AUDIT_FILE}（需要能推断当前项目）`,
    `Audit file: will append into ${AUDIT_FILE} under project folder (project must be inferable)`
  )
  sec.appendChild(fileHint)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('点击“开始审计”后，结果会显示在这里。', 'Click "Run audit" to show the result here.')
  sec.appendChild(out)

  const rowBtn = mkBtnRow()
  const btnAudit = document.createElement('button')
  btnAudit.className = 'ain-btn'
  btnAudit.textContent = t('开始审计', 'Run audit')

  const btnAppend = document.createElement('button')
  btnAppend.className = 'ain-btn gray'
  btnAppend.style.marginLeft = '8px'
  btnAppend.textContent = t('追加到文末', 'Append to doc')
  btnAppend.disabled = true

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.style.marginLeft = '8px'
  btnWrite.textContent = t('写入审计文件', 'Write audit file')
  btnWrite.disabled = true

  const btnOpen = document.createElement('button')
  btnOpen.className = 'ain-btn gray'
  btnOpen.style.marginLeft = '8px'
  btnOpen.textContent = t('打开审计文件', 'Open audit file')
  btnOpen.disabled = true

  rowBtn.appendChild(btnAudit)
  rowBtn.appendChild(btnAppend)
  rowBtn.appendChild(btnWrite)
  rowBtn.appendChild(btnOpen)
  sec.appendChild(rowBtn)

  body.appendChild(sec)

  let lastAudit = ''
  let lastInput = ''
  let lastSource = ''
  let lastAuditFilePath = ''

  function pickInputText() {
    const sel = ctx && ctx.getSelection ? ctx.getSelection() : null
    const selText = sel && sel.text ? String(sel.text) : ''
    const docText = safeText(ctx && ctx.getEditorValue ? ctx.getEditorValue() : '')

    if (cSelOnly.cb.checked && selText.trim()) {
      lastSource = t('选区', 'Selection')
      return selText
    }
    lastSource = t('全文', 'Full document')
    return docText.trim() ? docText : selText
  }

  async function doAudit() {
    cfg = await loadCfg(ctx)
    const raw = pickInputText()
    const text = safeText(raw).trim()
    lastInput = text
    if (!text) {
      out.textContent = t('没有可用文本：请先选中一段正文，或确保当前文档有内容。', 'No text: select some content or ensure the document is not empty.')
      ctx.ui.notice(t('没有可用文本', 'No text'), 'err', 2200)
      return
    }

    setBusy(btnAudit, true)
    btnAppend.disabled = true
    btnWrite.disabled = true
    btnOpen.disabled = true
    lastAudit = ''
    out.textContent = t('审计中…', 'Auditing...')

    try {
      const res = await runAuditWithTimeout(text, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(waitMs / 1000))
          out.textContent = t('审计中… 已等待 ', 'Auditing... waited ') + s + 's'
        }
      })
      lastAudit = res
      out.textContent = res
      btnAppend.disabled = false
      btnWrite.disabled = false
      ctx.ui.notice(t('已返回审计结果', 'Audit returned'), 'ok', 1600)

      if (cAutoAppend.cb.checked) {
        try {
          appendToDoc(ctx, res)
          ctx.ui.notice(t('已把审计结果追加到文末', 'Audit appended'), 'ok', 1800)
        } catch (e) {
          ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
        }
      }
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnAudit, false)
    }
  }

  btnAudit.onclick = () => { doAudit().catch(() => {}) }
  btnAppend.onclick = () => {
    try {
      if (!lastAudit) return
      appendToDoc(ctx, lastAudit)
      ctx.ui.notice(t('已追加到文末', 'Appended'), 'ok', 1600)
    } catch (e) {
      ctx.ui.notice(t('追加失败：', 'Append failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  btnWrite.onclick = async () => {
    try {
      if (!lastAudit) return
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) {
        throw new Error(t('无法推断当前项目：请先在“项目管理”选择项目，或打开项目内任意文件。', 'Cannot infer project: select one in Project Manager, or open a file under the project folder.'))
      }

      const p = joinFsPath(inf.projectAbs, AUDIT_FILE)
      const exists = await fileExists(ctx, p)
      const old = exists ? safeText(await readTextAny(ctx, p)) : ''
      const oldTrim = safeText(old).trim()

      let sha = ''
      try { sha = await sha256Hex(lastInput) } catch {}

      const header = oldTrim ? '' : (t('# 一致性审计\n\n', '# Audit\n\n'))
      const block =
        `## ${_fmtLocalTs()}\n\n` +
        `- ${t('来源', 'Source')}: ${lastSource || t('未知', 'Unknown')}\n` +
        `- ${t('字符数', 'Chars')}: ${String(lastInput.length)}\n` +
        (sha ? (`- ${t('输入 sha256', 'Input sha256')}: ${sha}\n`) : '') +
        `\n` +
        safeText(lastAudit).trim() +
        `\n`

      const next = (header || '') + (oldTrim ? (oldTrim + '\n\n') : '') + block
      await writeTextAny(ctx, p, next)
      lastAuditFilePath = p
      btnOpen.disabled = false
      ctx.ui.notice(t('已写入审计文件：', 'Wrote audit file: ') + fsBaseName(p), 'ok', 2200)
    } catch (e) {
      ctx.ui.notice(t('写入失败：', 'Write failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  btnOpen.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目', 'Cannot infer project'))
      const p = lastAuditFilePath || joinFsPath(inf.projectAbs, AUDIT_FILE)
      if (!(await fileExists(ctx, p))) throw new Error(t('审计文件不存在：请先写入一次。', 'Audit file does not exist: write it first.'))
      if (typeof ctx.openFileByPath === 'function') {
        await ctx.openFileByPath(p)
        return
      }
      throw new Error(t('当前环境不支持打开文件：', 'openFileByPath not available: ') + p)
    } catch (e) {
      ctx.ui.notice(t('打开失败：', 'Open failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

}

async function openMetaUpdateDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('更新资料文件（提议）', 'Update meta files (proposal)'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('让 AI 生成“资料更新提议”，你审阅后再写入文件（不会自动改资料）', 'Ask AI for a proposal; you review then write files (no auto changes).')}</div>`

  const goal = mkTextarea(t('变更目标/要求（必填）', 'Goal / change request (required)'), '')
  goal.ta.style.minHeight = '90px'
  sec.appendChild(goal.wrap)

  const cons = mkTextarea(t('本次硬约束（可空）', 'Hard constraints (optional)'), '')
  cons.ta.style.minHeight = '70px'
  sec.appendChild(cons.wrap)

  const pick = document.createElement('div')
  pick.className = 'ain-muted'
  pick.style.marginTop = '6px'
  pick.textContent = t('选择要更新的文件：', 'Pick files to update:')
  sec.appendChild(pick)

  function mkCheck(label, checked) {
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.alignItems = 'center'
    row.style.gap = '8px'
    row.style.marginTop = '6px'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!checked
    const tx = document.createElement('div')
    tx.className = 'ain-muted'
    tx.textContent = label
    row.appendChild(cb)
    row.appendChild(tx)
    return { row, cb }
  }

  const cWorld = mkCheck('02_世界设定.md', true)
  const cChars = mkCheck('03_主要角色.md', true)
  const cRels = mkCheck('04_人物关系.md', true)
  const cOutline = mkCheck('05_章节大纲.md', true)
  sec.appendChild(cWorld.row)
  sec.appendChild(cChars.row)
  sec.appendChild(cRels.row)
  sec.appendChild(cOutline.row)

  const rowBtn = mkBtnRow()
  const btnGen = document.createElement('button')
  btnGen.className = 'ain-btn'
  btnGen.textContent = t('生成更新提议', 'Generate proposal')
  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.style.marginLeft = '8px'
  btnWrite.textContent = t('写入所选资料文件', 'Write selected files')
  btnWrite.disabled = true
  rowBtn.appendChild(btnGen)
  rowBtn.appendChild(btnWrite)
  sec.appendChild(rowBtn)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('生成后会在下方分文件显示，允许你手动再改。', 'After generation, per-file previews will appear below. You can edit manually.')
  sec.appendChild(out)

  const pWorld = mkTextarea('02_世界设定.md', '')
  const pChars = mkTextarea('03_主要角色.md', '')
  const pRels = mkTextarea('04_人物关系.md', '')
  const pOutline = mkTextarea('05_章节大纲.md', '')
  pWorld.ta.style.minHeight = '140px'
  pChars.ta.style.minHeight = '140px'
  pRels.ta.style.minHeight = '140px'
  pOutline.ta.style.minHeight = '140px'

  body.appendChild(sec)
  body.appendChild(pWorld.wrap)
  body.appendChild(pChars.wrap)
  body.appendChild(pRels.wrap)
  body.appendChild(pOutline.wrap)

  let lastProposal = null

  function anySelected() {
    return !!(cWorld.cb.checked || cChars.cb.checked || cRels.cb.checked || cOutline.cb.checked)
  }

  function fillFromData(data) {
    const d = data && typeof data === 'object' ? data : null
    if (!d) return false
    function sanitizeOne(k, raw) {
      const map = { world: '世界设定', characters: '主要角色', relations: '人物关系', outline: '章节大纲' }
      const name = map[k] ? String(map[k]) : ''
      const txt = safeText(raw).trim()
      if (!name || !txt) return txt
      try {
        const sec = parseSectionedText('【' + name + '】\n' + txt)
        return safeText(sec && sec[k]).trim() || txt
      } catch {
        return txt
      }
    }
    if (d.world != null) pWorld.ta.value = sanitizeOne('world', d.world)
    if (d.characters != null) pChars.ta.value = sanitizeOne('characters', d.characters)
    if (d.relations != null) pRels.ta.value = sanitizeOne('relations', d.relations)
    if (d.outline != null) pOutline.ta.value = sanitizeOne('outline', d.outline)
    return true
  }

  function parseSectionedText(txt) {
    const t0 = safeText(txt).replace(/\r\n/g, '\n')
    const keys = [
      { k: 'world', names: ['世界设定', '世界观'] },
      { k: 'characters', names: ['主要角色'] },
      { k: 'relations', names: ['人物关系'] },
      { k: 'outline', names: ['章节大纲'] },
      { k: 'questions', names: ['需要你补充', '需要补充', '问题'] },
    ]
    const out0 = { world: [], characters: [], relations: [], outline: [], questions: [] }
    let cur = 'world'

    const lines = t0.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const raw = String(lines[i] || '')
      let x = raw.trim()
      if (!x) continue

      let head = x
      const mm = /^#{1,6}\s*(.+)$/.exec(x)
      if (mm && mm[1]) head = String(mm[1]).trim()

      let matched = false
      let rest = ''
      for (let j = 0; j < keys.length; j++) {
        const it = keys[j]
        const names = Array.isArray(it.names) ? it.names : []
        for (let n = 0; n < names.length; n++) {
          const nm = String(names[n] || '').trim()
          if (!nm) continue
          if (head === `【${nm}】` || head === `[${nm}]`) {
            cur = it.k
            matched = true
            rest = ''
            break
          }
          let m1 = new RegExp(`^【${nm.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}】\\s*(.*)$`).exec(head)
          if (m1 && m1[1] != null) {
            cur = it.k
            matched = true
            rest = String(m1[1] || '').trim()
            break
          }
          let m2 = new RegExp(`^\\[${nm.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]\\s*(.*)$`).exec(head)
          if (m2 && m2[1] != null) {
            cur = it.k
            matched = true
            rest = String(m2[1] || '').trim()
            break
          }
          let m3 = new RegExp(`^${nm.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[:：]\\s*(.*)$`).exec(head)
          if (m3 && m3[1] != null) {
            cur = it.k
            matched = true
            rest = String(m3[1] || '').trim()
            break
          }
        }
        if (matched) break
      }
      if (matched) {
        if (rest) out0[cur].push(rest)
        continue
      }
      if (!out0[cur]) continue
      out0[cur].push(x)
    }

    const pick = (arr) => safeText(Array.isArray(arr) ? arr.join('\n') : '').trim()
    return {
      world: pick(out0.world),
      characters: pick(out0.characters),
      relations: pick(out0.relations),
      outline: pick(out0.outline),
      questions: pick(out0.questions),
    }
  }

  async function readMetaFiles(inf) {
    const base = inf && inf.projectAbs ? String(inf.projectAbs) : ''
    const out0 = { world: '', characters: '', relations: '', outline: '' }
    if (!base) return out0
    try { out0.world = safeText(await readTextAny(ctx, joinFsPath(base, '02_世界设定.md'))) } catch {}
    try { out0.characters = safeText(await readTextAny(ctx, joinFsPath(base, '03_主要角色.md'))) } catch {}
    try { out0.relations = safeText(await readTextAny(ctx, joinFsPath(base, '04_人物关系.md'))) } catch {}
    try { out0.outline = safeText(await readTextAny(ctx, joinFsPath(base, '05_章节大纲.md'))) } catch {}
    return out0
  }

  btnGen.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const g = safeText(goal.ta.value).trim()
      if (!g) {
        ctx.ui.notice(t('请先填写“变更目标/要求”', 'Please input goal/change request'), 'err', 2000)
        return
      }
      if (!anySelected()) {
        ctx.ui.notice(t('请至少选择一个资料文件', 'Pick at least one file'), 'err', 2000)
        return
      }

      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目：请先在“项目管理”选择项目', 'Cannot infer project; select one in Project Manager'))

      const cur = await readMetaFiles(inf)
      const progress = await getProgressDocText(ctx, cfg)
      const prev = await getPrevTextForRequest(ctx, cfg)
      let rag = null
      try {
        rag = await rag_get_hits(ctx, cfg, g + '\n\n' + sliceTail(prev, 2000))
      } catch {}

      const constraints = mergeConstraints(cfg, safeText(cons.ta.value).trim())

      setBusy(btnGen, true)
      btnWrite.disabled = true
      out.textContent = t('生成资料更新提议中…（不计费）', 'Generating proposal... (no billing)')
      lastProposal = null

      const resp = await apiFetchConsultWithJob(ctx, cfg, {
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          async: true,
          mode: 'job',
          task: 'meta_update',
          goal: g,
          constraints,
          progress,
          prev,
          rag: rag || undefined,
          world: cur.world,
          characters: cur.characters,
          relations: cur.relations,
          outline: cur.outline,
          // 兼容旧实现：同时带 question，防止后端忽略 task
          question: [
            '任务：基于“变更目标/要求”，对小说资料文件做增量修订（不是正文）。',
            '输出按分节：【世界设定】【主要角色】【人物关系】【章节大纲】【需要你补充】。',
            '重要：你的输出会被分别写入资料文件。禁止在某个分节里输出其它分节标题；允许你全盘重写，但必须整理合并：现有资料的有效信息一条都不能丢（可去重/改写/重排/合并同义项）。',
            g
          ].join('\n')
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(waitMs / 1000))
          out.textContent = t('生成中… 已等待 ', 'Generating... waited ') + s + 's'
        }
      })

      lastProposal = resp
      const data = resp && resp.data && typeof resp.data === 'object' ? resp.data : null
      if (!fillFromData(data)) {
        const txt = safeText(resp && resp.text)
        const sec = parseSectionedText(txt)
        pWorld.ta.value = safeText(sec.world).trim()
        pChars.ta.value = safeText(sec.characters).trim()
        pRels.ta.value = safeText(sec.relations).trim()
        pOutline.ta.value = safeText(sec.outline).trim()
      }

      btnWrite.disabled = false
      out.textContent = safeText(resp && resp.text).trim() || t('已生成提议', 'Proposal ready')
      ctx.ui.notice(t('已生成资料更新提议（未写入）', 'Proposal ready (not written)'), 'ok', 1800)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnGen, false)
    }
  }

  btnWrite.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目', 'Cannot infer project'))
      if (!anySelected()) return

      function cutSection(k, raw) {
        const map = { world: '世界设定', characters: '主要角色', relations: '人物关系', outline: '章节大纲' }
        const name = map[k] ? String(map[k]) : ''
        const txt = safeText(raw).trim()
        if (!name || !txt) return txt
        try {
          const sec = parseSectionedText('【' + name + '】\n' + txt)
          return safeText(sec && sec[k]).trim() || txt
        } catch {
          return txt
        }
      }

      const todo = []
      if (cWorld.cb.checked) todo.push(['02_世界设定.md', cutSection('world', pWorld.ta.value)])
      if (cChars.cb.checked) todo.push(['03_主要角色.md', cutSection('characters', pChars.ta.value)])
      if (cRels.cb.checked) todo.push(['04_人物关系.md', cutSection('relations', pRels.ta.value)])
      if (cOutline.cb.checked) todo.push(['05_章节大纲.md', cutSection('outline', pOutline.ta.value)])

      // 防呆：别把空内容覆盖掉
      const bad = todo.filter((x) => !x[1])
      if (bad.length) {
        throw new Error(t('有文件内容为空，拒绝写入：', 'Refuse to write empty: ') + bad.map((x) => x[0]).join(', '))
      }

      const ok = await openConfirmDialog(ctx, {
        title: t('写入资料文件', 'Write meta files'),
        message: t('将覆盖写入以下文件：\n', 'Will overwrite files:\n') + todo.map((x) => '- ' + x[0]).join('\n')
      })
      if (!ok) return

      setBusy(btnWrite, true)
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i]
        try { await backupBeforeOverwrite(ctx, joinFsPath(inf.projectAbs, f[0]), 'meta_update') } catch {}
        await writeTextAny(ctx, joinFsPath(inf.projectAbs, f[0]), f[1].trim() + '\n')
      }
      ctx.ui.notice(t('已写入资料文件', 'Meta files written'), 'ok', 1800)
      btnWrite.disabled = true

      const okIdx = await openConfirmDialog(ctx, {
        title: t('更新 RAG 索引', 'Update RAG index'),
        message: t('资料已更新。现在更新 RAG 索引以便检索命中最新内容？（可能会调用 embedding）', 'Meta updated. Update RAG index now? (may call embeddings)')
      })
      if (okIdx) {
        try {
          setBusy(btnWrite, true)
          await rag_build_or_update_index(ctx, cfg)
          ctx.ui.notice(t('RAG 索引已更新', 'RAG index updated'), 'ok', 1600)
        } catch (e) {
          ctx.ui.notice(t('RAG 更新失败：', 'RAG update failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
        }
      }
    } catch (e) {
      ctx.ui.notice(t('写入失败：', 'Write failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    } finally {
      setBusy(btnWrite, false)
    }
  }
}

async function openImportExistingDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }
  if (!cfg.embedding || !cfg.embedding.baseUrl || !cfg.embedding.model) {
    throw new Error(t('请先在设置里填写 embedding BaseURL 和模型（用于 RAG）', 'Please set embedding BaseURL and model (for RAG)'))
  }
  if (!ctx.getLibraryRoot) throw new Error(t('当前宿主缺少库根目录接口', 'Host missing library root API'))
  const libRoot = normFsPath(await ctx.getLibraryRoot())

  const { body } = createDialogShell(t('导入现有文稿（初始化资料）', 'Import existing writing (init meta)'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('把“已有章节正文”提炼成项目资料（进度/设定/角色/关系/大纲）。先建 RAG 索引，再让 AI 按分文件生成提议，你确认后写入。', 'Extract meta files from existing chapters. Build RAG index first, then ask AI for proposals, write after review.')}</div>`

  const hint = document.createElement('div')
  hint.className = 'ain-muted'
  hint.style.marginTop = '6px'
  hint.textContent = t('提示：现有文稿最好放在“小说根目录/项目名/03_章节/…”。如果你的目录不在小说根目录下，请先改“小说根目录”或移动文件。', 'Tip: put your writing under novelRootDir/projectName/03_章节/. Otherwise adjust novelRootDir or move files.')
  sec.appendChild(hint)

  function absNovelRoot() {
    const rootPrefix = normFsPath(cfg.novelRootDir || '小说/').replace(/^\/+/, '')
    return joinFsPath(libRoot, rootPrefix)
  }

  async function listProjects() {
    const root = absNovelRoot()
    const projects = new Map()
    if (ctx && typeof ctx.invoke === 'function') {
      try {
        const files = await ctx.invoke('flymd_list_markdown_files', { root })
        const arr = Array.isArray(files) ? files : []
        for (let i = 0; i < arr.length; i++) {
          const p = normFsPath(arr[i])
          const rel = p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, '') : ''
          const parts = rel.split('/').filter(Boolean)
          const project = parts.length ? parts[0] : ''
          if (!project) continue
          const projectRel = joinFsPath(normFsPath(cfg.novelRootDir || '小说/').replace(/^\/+/, ''), project)
          const projectAbs = joinFsPath(libRoot, projectRel)
          projects.set(projectRel, { projectRel, projectAbs, projectName: project })
        }
      } catch {}
    }
    const fixed = String(cfg.currentProjectRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (fixed && !projects.has(fixed)) {
      const name = fixed.split('/').filter(Boolean).slice(-1)[0] || fixed
      projects.set(fixed, { projectRel: fixed, projectAbs: joinFsPath(libRoot, fixed), projectName: name })
    }
    return Array.from(projects.values()).sort((a, b) => a.projectRel.localeCompare(b.projectRel))
  }

  const rowProj = document.createElement('div')
  rowProj.style.display = 'grid'
  rowProj.style.gridTemplateColumns = '80px 1fr'
  rowProj.style.gap = '8px'
  rowProj.style.alignItems = 'center'
  rowProj.style.marginTop = '10px'
  const labProj = document.createElement('div')
  labProj.className = 'ain-lab'
  labProj.textContent = t('项目', 'Project')
  const sel = document.createElement('select')
  sel.className = 'ain-in ain-select'
  rowProj.appendChild(labProj)
  rowProj.appendChild(sel)
  sec.appendChild(rowProj)

  const goal = mkTextarea(t('导入目标/要求（可空）', 'Goal / requirements (optional)'), '')
  goal.ta.style.minHeight = '80px'
  sec.appendChild(goal.wrap)

  const cons = mkTextarea(t('本次硬约束（可空）', 'Hard constraints (optional)'), '')
  cons.ta.style.minHeight = '70px'
  sec.appendChild(cons.wrap)

  const rowStrength = document.createElement('div')
  rowStrength.style.display = 'grid'
  rowStrength.style.gridTemplateColumns = '120px 1fr'
  rowStrength.style.gap = '8px'
  rowStrength.style.alignItems = 'center'
  rowStrength.style.marginTop = '10px'
  const labStrength = document.createElement('div')
  labStrength.className = 'ain-lab'
  labStrength.textContent = t('覆盖强度', 'Coverage')
  const selStrength = document.createElement('select')
  selStrength.className = 'ain-in ain-select'
  ;[
    { v: 'fast', zh: '快速（更便宜/更快，可能漏信息）', en: 'Fast (cheaper/faster, may miss info)' },
    { v: 'std', zh: '标准（推荐）', en: 'Standard (recommended)' },
    { v: 'strong', zh: '强力（更慢，覆盖更全）', en: 'Strong (slower, more coverage)' },
  ].forEach((x) => {
    const op = document.createElement('option')
    op.value = x.v
    op.textContent = t(x.zh, x.en)
    selStrength.appendChild(op)
  })
  selStrength.value = 'std'
  rowStrength.appendChild(labStrength)
  rowStrength.appendChild(selStrength)
  sec.appendChild(rowStrength)

  const pick = document.createElement('div')
  pick.className = 'ain-muted'
  pick.style.marginTop = '6px'
  pick.textContent = t('选择要写入的资料文件：', 'Pick meta files to write:')
  sec.appendChild(pick)

  function mkCheck(label, checked) {
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.alignItems = 'center'
    row.style.gap = '8px'
    row.style.marginTop = '6px'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!checked
    const tx = document.createElement('div')
    tx.className = 'ain-muted'
    tx.textContent = label
    row.appendChild(cb)
    row.appendChild(tx)
    return { row, cb }
  }

  const cProgress = mkCheck('01_进度脉络.md', true)
  const cWorld = mkCheck('02_世界设定.md', true)
  const cChars = mkCheck('03_主要角色.md', true)
  const cRels = mkCheck('04_人物关系.md', true)
  const cOutline = mkCheck('05_章节大纲.md', true)
  sec.appendChild(cProgress.row)
  sec.appendChild(cWorld.row)
  sec.appendChild(cChars.row)
  sec.appendChild(cRels.row)
  sec.appendChild(cOutline.row)

  const rowBtn = mkBtnRow()
  const btnSet = document.createElement('button')
  btnSet.className = 'ain-btn gray'
  btnSet.textContent = t('设为当前项目', 'Set current')

  const btnIndex = document.createElement('button')
  btnIndex.className = 'ain-btn gray'
  btnIndex.style.marginLeft = '8px'
  btnIndex.textContent = t('构建/更新 RAG 索引', 'Build/Update RAG')

  const btnGen = document.createElement('button')
  btnGen.className = 'ain-btn'
  btnGen.style.marginLeft = '8px'
  btnGen.textContent = t('生成初始化提议', 'Generate init proposal')

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.style.marginLeft = '8px'
  btnWrite.textContent = t('写入所选资料文件', 'Write selected files')
  btnWrite.disabled = true

  rowBtn.appendChild(btnSet)
  rowBtn.appendChild(btnIndex)
  rowBtn.appendChild(btnGen)
  rowBtn.appendChild(btnWrite)
  sec.appendChild(rowBtn)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('准备就绪。', 'Ready.')
  sec.appendChild(out)

  const pProgress = mkTextarea('01_进度脉络.md', '')
  const pWorld = mkTextarea('02_世界设定.md', '')
  const pChars = mkTextarea('03_主要角色.md', '')
  const pRels = mkTextarea('04_人物关系.md', '')
  const pOutline = mkTextarea('05_章节大纲.md', '')
  pProgress.ta.style.minHeight = '120px'
  pWorld.ta.style.minHeight = '120px'
  pChars.ta.style.minHeight = '120px'
  pRels.ta.style.minHeight = '120px'
  pOutline.ta.style.minHeight = '120px'
  sec.appendChild(pProgress.wrap)
  sec.appendChild(pWorld.wrap)
  sec.appendChild(pChars.wrap)
  sec.appendChild(pRels.wrap)
  sec.appendChild(pOutline.wrap)

  body.appendChild(sec)

  let lastResp = null
  function anySelected() {
    return !!(cProgress.cb.checked || cWorld.cb.checked || cChars.cb.checked || cRels.cb.checked || cOutline.cb.checked)
  }

  async function refreshProjectList() {
    cfg = await loadCfg(ctx)
    sel.innerHTML = ''
    const list = await listProjects()
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      const op = document.createElement('option')
      op.value = it.projectRel
      op.textContent = it.projectRel
      sel.appendChild(op)
    }
    const cur = String(cfg.currentProjectRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cur && list.some((x) => x.projectRel === cur)) sel.value = cur
    if (!sel.value && list.length) sel.value = list[0].projectRel
  }

  async function setCurrentProject() {
    const v = String(sel.value || '').trim()
    if (!v) throw new Error(t('请先选择项目', 'Pick a project first'))
    cfg = await saveCfg(ctx, { currentProjectRel: v })
    out.textContent = t('已设置当前项目：', 'Current project set: ') + v
    return v
  }

  async function buildChapterListText(inf) {
    if (!inf || !inf.projectAbs) return ''
    const base = String(inf.projectAbs)
    const chapDir = joinFsPath(base, '03_章节')
    let files = await listMarkdownFilesAny(ctx, chapDir)
    let scope = '03_章节'
    const fromChapDir = !!(files && files.length)
    if (!files.length) {
      files = await listMarkdownFilesAny(ctx, base)
      scope = t('项目目录（回退）', 'Project root (fallback)')
    }
    const skipBase = new Set([
      '00_项目.md',
      '01_进度脉络.md',
      '02_故事圣经.md',
      '02_世界设定.md',
      '03_主要角色.md',
      '04_人物关系.md',
      '05_章节大纲.md',
      '.ainovel/index.json',
    ].map((x) => x.toLowerCase()))
    files = (files || []).filter((p) => {
      const abs = normFsPath(p)
      if (!abs) return false
      const rel = abs.startsWith(normFsPath(base)) ? abs.slice(normFsPath(base).length).replace(/^\/+/, '') : ''
      if (!rel) return false
      if (rel.startsWith('.ainovel/')) return false
      if (fromChapDir) return true
      const bn = fsBaseName(rel).toLowerCase()
      if (skipBase.has(bn)) return false
      return true
    })
    files.sort((a, b) => a.localeCompare(b))
    const maxN = 80
    const lines = []
    for (let i = 0; i < files.length && i < maxN; i++) {
      lines.push('- ' + fsBaseName(files[i]))
    }
    if (!lines.length) return ''
    return t('范围：', 'Scope: ') + scope + '\n' + lines.join('\n')
  }

  async function collectRagForInit(ctx, cfg, strength) {
    const s = String(strength || 'std')
    const prof = s === 'fast'
      ? { topK: 6, maxChars: 2600, hitMaxChars: 900, maxTotal: 7000 }
      : (s === 'strong'
        ? { topK: 12, maxChars: 5200, hitMaxChars: 1200, maxTotal: 14000 }
        : { topK: 9, maxChars: 3800, hitMaxChars: 1100, maxTotal: 10000 })

    const queries = [
      '总结：主要角色清单（含身份/动机/当前状态/关键转折）。',
      '总结：人物关系网（A↔B：关系/矛盾/利益/变化节点）。',
      '总结：世界设定（规则/地点/势力/组织/体系/限制）。',
      '梳理：主线剧情时间线（关键事件顺序/转折/当前未解冲突）。',
      '梳理：伏笔清单（已埋/已回收/待回收）。',
      '按章节：每章一句话概括（若只能推断文件名也要标注不确定）。',
    ]

    const seen = new Set()
    const merged = []
    let used = 0
    for (let i = 0; i < queries.length; i++) {
      let hits = null
      try {
        hits = await rag_get_hits(ctx, cfg, queries[i], { topK: prof.topK, maxChars: prof.maxChars, hitMaxChars: prof.hitMaxChars })
      } catch {
        hits = null
      }
      if (!hits || !hits.length) continue
      for (let j = 0; j < hits.length; j++) {
        const h = hits[j]
        const key = safeText(h && h.source).trim() + '\n' + safeText(h && h.text).trim()
        if (!key.trim()) continue
        if (seen.has(key)) continue
        const add = safeText(h && h.text).trim()
        if (!add) continue
        if (used + add.length > prof.maxTotal) return merged.length ? merged : null
        used += add.length
        seen.add(key)
        merged.push({ source: safeText(h && h.source).trim(), text: add })
      }
    }
    return merged.length ? merged : null
  }

  btnSet.onclick = () => { setCurrentProject().catch((e) => ctx.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)) }

  btnIndex.onclick = async () => {
    try {
      await setCurrentProject()
      cfg = await loadCfg(ctx)
      setBusy(btnIndex, true)
      out.textContent = t('构建索引中…', 'Building index...')
      await rag_build_or_update_index(ctx, cfg, {
        onTick: ({ done, total }) => {
          out.textContent = t('构建索引中… ', 'Building index... ') + String(done) + '/' + String(total)
        }
      })
      ctx.ui.notice(t('RAG 索引已更新', 'RAG index updated'), 'ok', 1600)
      out.textContent = t('索引已更新。下一步：生成初始化提议。', 'Index ready. Next: generate proposal.')
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnIndex, false)
    }
  }

  btnGen.onclick = async () => {
    try {
      if (!anySelected()) {
        ctx.ui.notice(t('请至少选择一个资料文件', 'Pick at least one file'), 'err', 2000)
        return
      }
      await setCurrentProject()
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目：请先在“项目管理”选择项目或打开项目内文件。', 'Cannot infer project; select one or open a file under it.'))

      const strength = String(selStrength.value || 'std')
      const chapters = await buildChapterListText(inf)
      const progress = await getProgressDocText(ctx, cfg)
      const prev = await getPrevTextForRequest(ctx, cfg)
      const constraints = mergeConstraints(cfg, safeText(cons.ta.value).trim())
      const goalText = safeText(goal.ta.value).trim()

      setBusy(btnGen, true)
      btnWrite.disabled = true
      lastResp = null
      out.textContent = t('生成初始化提议中…（不计费）', 'Generating init proposal... (no billing)')

      let rag = null
      try {
        rag = await collectRagForInit(ctx, cfg, strength)
      } catch {
        rag = null
      }

      const resp = await apiFetchConsultWithJob(ctx, cfg, {
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          async: true,
          mode: 'job',
          task: 'init_project',
          goal: goalText,
          constraints,
          progress,
          prev,
          chapters,
          rag: rag || undefined,
          // 兼容旧后端：带 question 兜底
          question: [
            '任务：从现有正文中反向提取并重建项目资料文件（进度/设定/角色/关系/大纲）。',
            '必须按分节输出并最后写【END】。',
          ].join('\n')
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(waitMs / 1000))
          out.textContent = t('生成中… 已等待 ', 'Generating... waited ') + s + 's'
        }
      })

      lastResp = resp
      const data = resp && resp.data && typeof resp.data === 'object' ? resp.data : null
      const pr = data && data.progress != null ? String(data.progress) : ''
      const w = data && data.world != null ? String(data.world) : ''
      const ch = data && data.characters != null ? String(data.characters) : ''
      const rl = data && data.relations != null ? String(data.relations) : ''
      const ol = data && data.outline != null ? String(data.outline) : ''
      pProgress.ta.value = pr.trim()
      pWorld.ta.value = w.trim()
      pChars.ta.value = ch.trim()
      pRels.ta.value = rl.trim()
      pOutline.ta.value = ol.trim()

      btnWrite.disabled = false
      out.textContent = safeText(resp && resp.text).trim() || t('已生成提议', 'Proposal ready')
      ctx.ui.notice(t('已生成初始化提议（未写入）', 'Proposal ready (not written)'), 'ok', 1800)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnGen, false)
    }
  }

  async function ensureProjectSkeleton(inf) {
    if (!inf || !inf.projectAbs) return
    const base = String(inf.projectAbs)
    try {
      if (!(await fileExists(ctx, joinFsPath(base, '.ainovel/index.json')))) {
        await writeTextAny(ctx, joinFsPath(base, '.ainovel/index.json'), JSON.stringify({ version: 1, created_at: Date.now() }, null, 2))
      }
    } catch {}
    try {
      if (!(await fileExists(ctx, joinFsPath(base, '00_项目.md')))) {
        const name = inf.projectName || safeFileName(fsBaseName(base), '项目')
        const metaMd = ['# ' + name, '', '- 本项目由“导入现有文稿（初始化资料）”创建资料文件。', '- 资料文件：01_进度脉络/02_世界设定/03_主要角色/04_人物关系/05_章节大纲', ''].join('\n')
        await writeTextAny(ctx, joinFsPath(base, '00_项目.md'), metaMd)
      }
    } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '01_进度脉络.md')))) await writeTextAny(ctx, joinFsPath(base, '01_进度脉络.md'), '# 进度脉络\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '02_世界设定.md')))) await writeTextAny(ctx, joinFsPath(base, '02_世界设定.md'), '# 世界设定\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '03_主要角色.md')))) await writeTextAny(ctx, joinFsPath(base, '03_主要角色.md'), '# 主要角色\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '04_人物关系.md')))) await writeTextAny(ctx, joinFsPath(base, '04_人物关系.md'), '# 人物关系\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '05_章节大纲.md')))) await writeTextAny(ctx, joinFsPath(base, '05_章节大纲.md'), '# 章节大纲\n\n') } catch {}
  }

  btnWrite.onclick = async () => {
    try {
      await setCurrentProject()
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目', 'Cannot infer project'))
      if (!anySelected()) return

      function stripDocHeading(s) {
        const t0 = safeText(s).trim()
        return t0.replace(/^#\\s+.*\\n+/u, '').trim()
      }

      const todo = []
      if (cProgress.cb.checked) todo.push(['01_进度脉络.md', '# 进度脉络\n\n' + stripDocHeading(pProgress.ta.value) + '\n'])
      if (cWorld.cb.checked) todo.push(['02_世界设定.md', '# 世界设定\n\n' + stripDocHeading(pWorld.ta.value) + '\n'])
      if (cChars.cb.checked) todo.push(['03_主要角色.md', '# 主要角色\n\n' + stripDocHeading(pChars.ta.value) + '\n'])
      if (cRels.cb.checked) todo.push(['04_人物关系.md', '# 人物关系\n\n' + stripDocHeading(pRels.ta.value) + '\n'])
      if (cOutline.cb.checked) todo.push(['05_章节大纲.md', '# 章节大纲\n\n' + stripDocHeading(pOutline.ta.value) + '\n'])

      const bad = todo.filter((x) => !safeText(x[1]).trim().replace(/^#\\s+.*\\n+/u, '').trim())
      if (bad.length) throw new Error(t('有文件内容为空，拒绝写入：', 'Refuse to write empty: ') + bad.map((x) => x[0]).join(', '))

      const ok = await openConfirmDialog(ctx, {
        title: t('写入资料文件', 'Write meta files'),
        message: t('将覆盖写入以下文件：\n', 'Will overwrite files:\n') + todo.map((x) => '- ' + x[0]).join('\n')
      })
      if (!ok) return

      setBusy(btnWrite, true)
      await ensureProjectSkeleton(inf)
      for (let i = 0; i < todo.length; i++) {
        try { await backupBeforeOverwrite(ctx, joinFsPath(inf.projectAbs, todo[i][0]), 'init_meta') } catch {}
        await writeTextAny(ctx, joinFsPath(inf.projectAbs, todo[i][0]), todo[i][1])
      }
      ctx.ui.notice(t('已写入资料文件', 'Meta files written'), 'ok', 1800)
      btnWrite.disabled = true

      const okIdx = await openConfirmDialog(ctx, {
        title: t('更新 RAG 索引', 'Update RAG index'),
        message: t('资料已写入。现在更新 RAG 索引以便检索命中最新内容？（会调用 embedding）', 'Meta written. Update RAG index now? (will call embeddings)')
      })
      if (okIdx) {
        try {
          setBusy(btnWrite, true)
          await rag_build_or_update_index(ctx, cfg)
          ctx.ui.notice(t('RAG 索引已更新', 'RAG index updated'), 'ok', 1600)
        } catch (e) {
          ctx.ui.notice(t('RAG 更新失败：', 'RAG update failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
        }
      }
    } catch (e) {
      ctx.ui.notice(t('写入失败：', 'Write failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    } finally {
      setBusy(btnWrite, false)
    }
  }

  await refreshProjectList()
}

async function openRagIndexDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.embedding || !cfg.embedding.baseUrl || !cfg.embedding.model) {
    throw new Error(t('请先在设置里填写 embedding BaseURL 和模型', 'Please set embedding BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('RAG 索引（向量检索）', 'RAG Index (Embeddings)'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('索引状态', 'Status')}</div>`

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('准备就绪。', 'Ready.')

  const row = mkBtnRow()
  const btnBuild = document.createElement('button')
  btnBuild.className = 'ain-btn'
  btnBuild.textContent = t('构建/更新索引', 'Build/Update')

  const btnOpen = document.createElement('button')
  btnOpen.className = 'ain-btn gray'
  btnOpen.style.marginLeft = '8px'
  btnOpen.textContent = t('打开索引文件', 'Open index file')

  row.appendChild(btnBuild)
  row.appendChild(btnOpen)
  sec.appendChild(row)
  sec.appendChild(out)
  body.appendChild(sec)

  async function refresh() {
    cfg = await loadCfg(ctx)
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) {
      out.textContent = t('无法推断当前项目：请先在“项目管理”选择小说项目，或打开项目内任意文件。', 'Cannot infer project: select one in Project Manager, or open a file under the project folder.')
      return
    }
    const loaded = await rag_load_index(ctx, inf.projectAbs)
    const meta = loaded && loaded.meta ? loaded.meta : null
    const n = meta && Array.isArray(meta.chunks) ? meta.chunks.length : 0
    const dims = meta && Number.isFinite(meta.dims) ? (meta.dims | 0) : 0
    out.textContent =
      t('当前项目：', 'Project: ') + inf.projectRel +
      '\n' + t('索引块数：', 'Chunks: ') + n +
      '\n' + t('维度：', 'Dims: ') + dims +
      '\n' + t('索引文件：', 'Index files: ') +
      '\n- ' + joinFsPath(inf.projectAbs, AIN_RAG_META_FILE) +
      '\n- ' + joinFsPath(inf.projectAbs, AIN_RAG_VEC_FILE) +
      '\n' + t('embedding：', 'embedding: ') + String(cfg.embedding.baseUrl) + ' / ' + String(cfg.embedding.model)
  }

  btnBuild.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      setBusy(btnBuild, true)
      out.textContent = t('构建中…', 'Building...')
      const started = Date.now()
      const built = await rag_build_or_update_index(ctx, cfg, {
        onTick: ({ done, total }) => {
          const s = Math.max(0, Math.round((Date.now() - started) / 1000))
          out.textContent = t('构建中… 已处理 ', 'Building... done ') + done + '/' + total + t('，已等待 ', ', waited ') + s + 's'
        }
      })
      const idx = built && built.index ? built.index : null
      const n = idx && Array.isArray(idx.chunks) ? idx.chunks.length : 0
      out.textContent = t('构建完成。索引块数：', 'Done. Chunks: ') + n
      ctx.ui.notice(t('RAG 索引已更新', 'RAG index updated'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnBuild, false)
    }
  }

  btnOpen.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目', 'Cannot infer project'))
      const p = joinFsPath(inf.projectAbs, AIN_RAG_META_FILE)
      if (typeof ctx.openFileByPath === 'function') {
        await ctx.openFileByPath(p)
      } else {
        out.textContent = t('当前环境不支持打开文件：', 'openFileByPath not available: ') + p
      }
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    }
  }

  await refresh()
}

async function openProgressUpdateDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const { body } = createDialogShell(t('更新进度脉络', 'Update progress'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('从文本生成“进度脉络更新提议”并写入 01_进度脉络.md', 'Generate progress update and write to 01_进度脉络.md')}</div>`

  const note = mkTextarea(t('补充说明（可空）：例如你希望强调哪些信息', 'Extra note (optional)'), '')
  note.ta.style.minHeight = '70px'
  sec.appendChild(note.wrap)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('点击“生成更新”后这里会显示结果。', 'Click Generate to preview update.')
  sec.appendChild(out)

  const row = mkBtnRow()
  const btnGen = document.createElement('button')
  btnGen.className = 'ain-btn'
  btnGen.textContent = t('生成更新（优先选中文本）', 'Generate (prefer selection)')
  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.style.marginLeft = '8px'
  btnWrite.textContent = t('写入进度脉络文件', 'Write to file')
  btnWrite.disabled = true
  const btnOpen = document.createElement('button')
  btnOpen.className = 'ain-btn gray'
  btnOpen.style.marginLeft = '8px'
  btnOpen.textContent = t('打开 01_进度脉络.md', 'Open 01_进度脉络.md')
  row.appendChild(btnGen)
  row.appendChild(btnWrite)
  row.appendChild(btnOpen)
  sec.appendChild(row)

  body.appendChild(sec)

  let lastUpdate = ''

  btnGen.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const sel = ctx.getSelection ? ctx.getSelection() : null
      const raw = sel && sel.text ? String(sel.text) : String(ctx.getEditorValue ? (ctx.getEditorValue() || '') : '')
      const lim = (cfg && cfg.ctx && cfg.ctx.maxUpdateSourceChars) ? (cfg.ctx.maxUpdateSourceChars | 0) : 20000
      const base = sliceTail(raw, lim).trim()
      if (!base) {
        out.textContent = t('没有可用文本：请先选中一段正文，或确保当前文档有内容。', 'No text: select some content or ensure the document is not empty.')
        return
      }
      setBusy(btnGen, true)
      setBusy(btnWrite, true)
      btnWrite.disabled = true
      out.textContent = t('生成中…', 'Generating...')
      lastUpdate = await progress_generate_update(ctx, cfg, base, safeText(note.ta.value).trim())
      if (!lastUpdate) throw new Error(t('后端未返回内容', 'Backend returned empty text'))
      out.textContent = lastUpdate
      btnWrite.disabled = false
      ctx.ui.notice(t('已生成更新（未写入）', 'Generated (not written yet)'), 'ok', 1600)
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnGen, false)
    }
  }

  btnWrite.onclick = async () => {
    try {
      if (!lastUpdate) return
      cfg = await loadCfg(ctx)
      setBusy(btnWrite, true)
      await progress_append_block(ctx, cfg, lastUpdate, '手动更新 ' + _fmtLocalTs())
      try { await rag_build_or_update_index(ctx, cfg) } catch {}
      ctx.ui.notice(t('已写入进度脉络', 'Progress updated'), 'ok', 1600)
      btnWrite.disabled = true
    } catch (e) {
      out.textContent = t('写入失败：', 'Write failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnWrite, false)
    }
  }

  btnOpen.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const inf = await inferProjectDir(ctx, cfg)
      if (!inf) throw new Error(t('无法推断当前项目', 'Cannot infer project'))
      const p = joinFsPath(inf.projectAbs, '01_进度脉络.md')
      if (typeof ctx.openFileByPath === 'function') {
        await ctx.openFileByPath(p)
      } else {
        out.textContent = t('当前环境不支持打开文件：', 'openFileByPath not available: ') + p
      }
    } catch (e) {
      out.textContent = t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e))
    }
  }
}

async function callNovelRevise(ctx, cfg, baseText, instruction, localConstraints, history) {
  if (!cfg || !cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }
  const inst = safeText(instruction).trim()
  if (!inst) throw new Error(t('请先写清楚“修改要求”', 'Please provide edit request'))

  const text = safeText(baseText)
  const prev = await getPrevTextForRevise(ctx, cfg, text)
  const progress = await getProgressDocText(ctx, cfg)
  const bible = await getBibleDocText(ctx, cfg)
  const constraints = mergeConstraints(cfg, localConstraints)

  let rag = null
  try {
    const q = inst + '\n\n' + sliceTail(text, 2000) + '\n\n' + sliceTail(prev, 2000)
    rag = await rag_get_hits(ctx, cfg, q)
  } catch {}

  const json = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
    mode: 'novel',
    action: 'revise',
    upstream: {
      baseUrl: cfg.upstream.baseUrl,
      apiKey: cfg.upstream.apiKey,
      model: cfg.upstream.model
    },
    input: {
      instruction: inst,
      text,
      history: Array.isArray(history) ? history.slice(-10) : undefined,
      progress,
      bible,
      prev,
      constraints: constraints || undefined,
      rag: rag || undefined
    }
  })

  const ctxMeta = (() => {
    try {
      const ragHits = Array.isArray(rag) ? rag.length : (rag ? 1 : 0)
      const ragChars = Array.isArray(rag)
        ? rag.reduce((a, it) => a + safeText(it && (it.text != null ? it.text : it)).length, 0)
        : safeText(rag).length
      return {
        progressChars: safeText(progress).length,
        bibleChars: safeText(bible).length,
        prevChars: safeText(prev).length,
        constraintsChars: safeText(constraints).length,
        ragHits,
        ragChars
      }
    } catch {
      return null
    }
  })()

  return { json, ctxMeta }
}

async function openDraftReviewDialog(ctx, opts) {
  let cfg = await loadCfg(ctx)
  if (!cfg.token) throw new Error(t('请先登录后端', 'Please login first'))
  if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) {
    throw new Error(t('请先在设置里填写上游 BaseURL 和模型', 'Please set upstream BaseURL and model in Settings first'))
  }

  const o = opts || {}
  const blockId = o.blockId ? String(o.blockId) : ''
  const title = String(o.title || t('审阅/修改草稿（对话）', 'Review/Edit (chat)'))
  const initialText = safeText(o.text)

  const { body } = createDialogShell(title)

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('草稿正文（可手动改）', 'Draft text (editable)')}</div>`

  const taText = mkTextarea('', initialText)
  taText.ta.style.minHeight = '220px'
  sec.appendChild(taText.wrap)

  const secDiff = document.createElement('div')
  secDiff.className = 'ain-card'
  secDiff.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('修改高亮预览', 'Highlight changes')}</div>`

  const diffMeta = document.createElement('div')
  diffMeta.className = 'ain-muted'
  diffMeta.textContent = t('发送修改请求后，这里会高亮显示本次改动（绿色为新增；可选显示删除）。', 'After sending, changes will be highlighted here (green=inserted; optionally show deletions).')
  secDiff.appendChild(diffMeta)

  const diffTools = document.createElement('div')
  diffTools.style.marginTop = '8px'
  diffTools.style.display = 'flex'
  diffTools.style.gap = '12px'
  diffTools.style.alignItems = 'center'

  const labShowDel = document.createElement('label')
  labShowDel.className = 'ain-muted'
  labShowDel.style.display = 'flex'
  labShowDel.style.gap = '6px'
  labShowDel.style.alignItems = 'center'
  labShowDel.style.cursor = 'pointer'
  labShowDel.style.userSelect = 'none'
  const chkShowDel = document.createElement('input')
  chkShowDel.type = 'checkbox'
  const spShowDel = document.createElement('span')
  spShowDel.textContent = t('显示删除', 'Show deletions')
  labShowDel.appendChild(chkShowDel)
  labShowDel.appendChild(spShowDel)
  diffTools.appendChild(labShowDel)

  const btnRecalc = document.createElement('button')
  btnRecalc.className = 'ain-btn gray'
  btnRecalc.textContent = t('重新计算高亮', 'Recompute highlight')
  btnRecalc.disabled = true
  diffTools.appendChild(btnRecalc)

  secDiff.appendChild(diffTools)

  const diffOut = document.createElement('div')
  diffOut.className = 'ain-diff'
  diffOut.style.marginTop = '10px'
  diffOut.textContent = t('暂无对比结果：先发送一次修改请求。', 'No diff yet: send an edit request first.')
  secDiff.appendChild(diffOut)

  const secChat = document.createElement('div')
  secChat.className = 'ain-card'
  secChat.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('对话修改', 'Chat edits')}</div>`

  const taCons = mkTextarea(t('本次硬约束（可空）', 'Hard constraints (optional)'), '')
  taCons.ta.style.minHeight = '70px'
  secChat.appendChild(taCons.wrap)

  const taAsk = mkTextarea(t('你希望怎么改？（一条条说，越具体越好）', 'What to change? (be specific)'), '')
  taAsk.ta.style.minHeight = '90px'
  secChat.appendChild(taAsk.wrap)

  const log = document.createElement('div')
  log.className = 'ain-out'
  log.style.marginTop = '10px'
  log.textContent = t('这里会记录对话。', 'Conversation will appear here.')
  secChat.appendChild(log)

  const row = mkBtnRow()
  const btnSend = document.createElement('button')
  btnSend.className = 'ain-btn'
  btnSend.textContent = t('发送修改请求', 'Send edit request')
  const btnApply = document.createElement('button')
  btnApply.className = 'ain-btn gray'
  btnApply.style.marginLeft = '8px'
  btnApply.textContent = t('覆盖草稿块（定稿）', 'Overwrite draft block (finalize)')
  btnApply.disabled = !blockId
  row.appendChild(btnSend)
  row.appendChild(btnApply)
  secChat.appendChild(row)

  body.appendChild(sec)
  body.appendChild(secDiff)
  body.appendChild(secChat)

  const history = []

  let lastDiff = null
  let lastDiffBase = ''

  function renderDiff() {
    try {
      if (!lastDiff || !lastDiff.ops || !Array.isArray(lastDiff.ops)) {
        diffOut.textContent = t('暂无对比结果：先发送一次修改请求。', 'No diff yet: send an edit request first.')
        diffMeta.textContent = t('发送修改请求后，这里会高亮显示本次改动（绿色为新增；可选显示删除）。', 'After sending, changes will be highlighted here (green=inserted; optionally show deletions).')
        btnRecalc.disabled = true
        return
      }

      const st = lastDiff.stats || _ainDiffStats(lastDiff.ops)
      const ins = st && Number.isFinite(st.insChars) ? st.insChars : 0
      const del = st && Number.isFinite(st.delChars) ? st.delChars : 0
      const chg = ins + del

      const ctxm = lastDiff.ctxMeta || null
      let ctxText = ''
      if (ctxm && typeof ctxm === 'object') {
        ctxText =
          t('上下文：进度 ', 'Context: progress ') +
          String(ctxm.progressChars | 0) +
          t(' 字，设定 ', ' chars, bible ') +
          String(ctxm.bibleChars | 0) +
          t(' 字，检索 ', ' chars, rag ') +
          String(ctxm.ragHits | 0) +
          t(' 条', ' hits')
      }

      const metaText = chg <= 0
        ? t('本次无改动。', 'No changes.')
        : (t('本次改动：新增 ', 'Changes: +') + String(ins) + t(' 字，删除 ', ' chars, -') + String(del) + t(' 字。', ' chars.'))
      diffMeta.textContent = ctxText ? (metaText + ' ' + ctxText) : metaText

      const mode = chkShowDel.checked ? 'combined' : 'new'
      diffOut.innerHTML = _ainDiffRenderHtml(lastDiff.ops, mode)
      btnRecalc.disabled = false
    } catch {
      diffOut.textContent = t('对比渲染失败（文本过大或浏览器不支持）。', 'Diff render failed (too large or unsupported).')
    }
  }

  function updateDiff(baseText, nextText, ctxMeta) {
    const base = safeText(baseText)
    const next = safeText(nextText)
    lastDiffBase = base
    const chunkLen = Math.max(40, Math.min(160, Math.round(Math.max(base.length, next.length) / 80) || 80))
    const ops = _ainDiffLcsOps(_ainDiffTokenize(base, chunkLen), _ainDiffTokenize(next, chunkLen))
    lastDiff = { base, next, ops, stats: _ainDiffStats(ops), ctxMeta: ctxMeta || null }
    renderDiff()
    return lastDiff.stats
  }

  chkShowDel.onchange = () => renderDiff()
  btnRecalc.onclick = () => {
    try {
      const cur = safeText(taText.ta.value)
      updateDiff(lastDiffBase, cur, lastDiff && lastDiff.ctxMeta ? lastDiff.ctxMeta : null)
      ctx.ui.notice(t('已刷新高亮', 'Highlight refreshed'), 'ok', 1200)
    } catch {
      ctx.ui.notice(t('刷新失败', 'Refresh failed'), 'err', 1800)
    }
  }

  function renderLog() {
    if (!history.length) {
      log.textContent = t('这里会记录对话。', 'Conversation will appear here.')
      return
    }
    const lines = []
    const take = history.slice(-12)
    for (let i = 0; i < take.length; i++) {
      const it = take[i] || {}
      const u = safeText(it.user).trim()
      const st = it.stats && typeof it.stats === 'object' ? it.stats : null
      if (u) lines.push('用户：' + u)
      if (st) {
        const ins = Number.isFinite(st.insChars) ? (st.insChars | 0) : 0
        const del = Number.isFinite(st.delChars) ? (st.delChars | 0) : 0
        const msg = (ins + del) <= 0
          ? t('AI：未改动（返回与原文一致）', 'AI: no changes (identical)')
          : (t('AI：已修订（新增 ', 'AI: revised (+') + String(ins) + t(' 字，删除 ', ' chars, -') + String(del) + t(' 字）', ' chars)'))
        lines.push(msg)
      }
      lines.push('')
    }
    log.textContent = lines.join('\n').trim()
  }

  btnSend.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const ask = safeText(taAsk.ta.value).trim()
      if (!ask) {
        ctx.ui.notice(t('请先写清楚“修改要求”', 'Please input edit request'), 'err', 1800)
        return
      }
      const curText = safeText(taText.ta.value)
      setBusy(btnSend, true)
      outBusy()
      // 只带“用户修改要求”历史：草稿正文已经在 curText 里，再把 AI 全文塞进历史只会重复、膨胀、降低命中率。
      const hist = history.slice(-10).map((x) => ({ user: x.user, assistant: '' }))
      const res = await callNovelRevise(ctx, cfg, curText, ask, safeText(taCons.ta.value).trim(), hist)
      const json = res && res.json ? res.json : res
      const next = safeText(json && json.text).trim()
      if (!next) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
      taText.ta.value = next
      const st = updateDiff(curText, next, res && res.ctxMeta ? res.ctxMeta : null)
      history.push({ user: ask, assistant: '', stats: st, ctxMeta: res && res.ctxMeta ? res.ctxMeta : null })
      taAsk.ta.value = ''
      renderLog()

      const noChange = st && (st.insChars | 0) === 0 && (st.delChars | 0) === 0
      if (btnApply) btnApply.className = noChange ? 'ain-btn gray' : 'ain-btn'
      if (noChange) {
        ctx.ui.notice(t('AI 返回与发送前一致：把“修改要求”写得更具体。', 'AI returned identical text: be more specific.'), 'err', 2400)
      } else {
        ctx.ui.notice(t('已生成修订版本（未写入）：点“覆盖草稿块”写回。', 'Revised (not written): click Overwrite draft block.'), 'ok', 2400)
      }
    } catch (e) {
      ctx.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    } finally {
      setBusy(btnSend, false)
    }

    function outBusy() {
      try { log.textContent = t('生成修订中…', 'Revising...') } catch {}
    }
  }

  btnApply.onclick = async () => {
    try {
      if (!blockId) return
      cfg = await loadCfg(ctx)
      const nextText = safeText(taText.ta.value).trim()
      if (!nextText) {
        ctx.ui.notice(t('正文不能为空', 'Text cannot be empty'), 'err', 1800)
        return
      }
      const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
      const replaced = replaceDraftBlockText(doc, blockId, nextText)
      if (replaced == null) {
        throw new Error(t('未找到草稿块：可能已被手动删除或文件已切换。', 'Draft block not found.'))
      }
      setBusy(btnApply, true)
      ctx.setEditorValue(replaced)
      // 定稿后再更新进度（避免反复改稿污染进度脉络）
      try { progress_auto_update_after_accept(ctx, nextText, '草稿定稿覆盖写入') } catch {}
      ctx.ui.notice(t('已覆盖草稿块', 'Draft overwritten'), 'ok', 1800)
    } catch (e) {
      ctx.ui.notice(t('覆盖失败：', 'Overwrite failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    } finally {
      setBusy(btnApply, false)
    }
  }

  renderLog()
}

async function openProjectManagerDialog(ctx) {
  let cfg = await loadCfg(ctx)
  if (!ctx.getLibraryRoot) throw new Error(t('当前环境不支持获取库根目录', 'Cannot get library root'))
  const libRoot = normFsPath(await ctx.getLibraryRoot())
  if (!libRoot) throw new Error(t('无法获取库根目录', 'Library root is empty'))

  const { body } = createDialogShell(t('项目管理', 'Project Manager'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('选择当前小说项目', 'Select current project')}</div>`

  const row = document.createElement('div')
  row.className = 'ain-selrow'
  const lab = document.createElement('div')
  lab.className = 'ain-lab'
  lab.textContent = t('项目', 'Project')
  const sel = document.createElement('select')
  sel.className = 'ain-in ain-select'
  row.appendChild(lab)
  row.appendChild(sel)
  sec.appendChild(row)

  const hint = document.createElement('div')
  hint.className = 'ain-muted'
  hint.style.marginTop = '6px'
  hint.textContent = t('提示：项目目录在“小说根目录/项目名/…”。', 'Tip: projects live under novelRootDir/projectName/...')
  sec.appendChild(hint)

  const rowBtn = mkBtnRow()
  const btnRefresh = document.createElement('button')
  btnRefresh.className = 'ain-btn gray'
  btnRefresh.textContent = t('刷新列表', 'Refresh')
  const btnUse = document.createElement('button')
  btnUse.className = 'ain-btn'
  btnUse.style.marginLeft = '8px'
  btnUse.textContent = t('设为当前项目', 'Set current')
  const btnOpenMeta = document.createElement('button')
  btnOpenMeta.className = 'ain-btn gray'
  btnOpenMeta.style.marginLeft = '8px'
  btnOpenMeta.textContent = t('打开资料文件', 'Open meta files')
  const btnAbandon = document.createElement('button')
  btnAbandon.className = 'ain-btn red'
  btnAbandon.style.marginLeft = '8px'
  btnAbandon.textContent = t('弃坑（删除项目）', 'Abandon (delete)')
  rowBtn.appendChild(btnRefresh)
  rowBtn.appendChild(btnUse)
  rowBtn.appendChild(btnOpenMeta)
  rowBtn.appendChild(btnAbandon)
  sec.appendChild(rowBtn)

  const out = document.createElement('div')
  out.className = 'ain-out'
  out.style.marginTop = '10px'
  out.textContent = t('这里会显示项目路径与操作结果。', 'Project path & actions appear here.')
  sec.appendChild(out)

  body.appendChild(sec)

  function absNovelRoot() {
    const rootPrefix = normFsPath(cfg.novelRootDir || '小说/').replace(/^\/+/, '')
    return joinFsPath(libRoot, rootPrefix)
  }

  async function listProjects() {
    // 优先用宿主命令扫描 markdown 文件，推断项目名
    const root = absNovelRoot()
    const projects = new Map()
    if (ctx && typeof ctx.invoke === 'function') {
      try {
        const files = await ctx.invoke('flymd_list_markdown_files', { root })
        const arr = Array.isArray(files) ? files : []
        for (let i = 0; i < arr.length; i++) {
          const p = normFsPath(arr[i])
          const rel = p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, '') : ''
          const parts = rel.split('/').filter(Boolean)
          const project = parts.length ? parts[0] : ''
          if (!project) continue
          const projectRel = joinFsPath(normFsPath(cfg.novelRootDir || '小说/').replace(/^\/+/, ''), project)
          const projectAbs = joinFsPath(libRoot, projectRel)
          projects.set(projectRel, { projectRel, projectAbs, projectName: project })
        }
      } catch {}
    }

    // 如果当前配置了 projectRel，但扫描没扫到，也把它放进去（避免“项目没 markdown”就消失）
    const fixed = String(cfg.currentProjectRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (fixed && !projects.has(fixed)) {
      const name = fixed.split('/').filter(Boolean).slice(-1)[0] || fixed
      projects.set(fixed, { projectRel: fixed, projectAbs: joinFsPath(libRoot, fixed), projectName: name })
    }

    return Array.from(projects.values()).sort((a, b) => a.projectRel.localeCompare(b.projectRel))
  }

  let lastList = []

  async function refresh() {
    cfg = await loadCfg(ctx)
    out.textContent = t('扫描中…', 'Scanning...')
    sel.innerHTML = ''
    lastList = await listProjects()
    if (!lastList.length) {
      out.textContent = t('未发现项目：请先用“一键开坑”创建项目，或确认小说根目录是否正确。', 'No projects found: create one via Start-from-zero or check novelRootDir.')
      return
    }
    for (let i = 0; i < lastList.length; i++) {
      const it = lastList[i]
      const op = document.createElement('option')
      op.value = it.projectRel
      op.textContent = it.projectRel
      sel.appendChild(op)
    }
    const cur = String(cfg.currentProjectRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cur && lastList.some((x) => x.projectRel === cur)) {
      sel.value = cur
    }
    out.textContent = t('当前项目：', 'Current project: ') + (cur || t('未选择（从当前文件推断）', 'not set (infer from current file)'))
  }

  function pick() {
    const v = String(sel.value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!v) return null
    return lastList.find((x) => x.projectRel === v) || null
  }

  btnRefresh.onclick = () => { refresh().catch(() => {}) }

  btnUse.onclick = () => {
    const it = pick()
    if (!it) return
    saveCfg(ctx, { currentProjectRel: it.projectRel })
      .then(() => {
        out.textContent = t('已设为当前项目：', 'Set current: ') + it.projectRel
        ctx.ui.notice(t('已切换项目', 'Project switched'), 'ok', 1400)
      })
      .catch((e) => ctx.ui.notice(t('保存失败：', 'Save failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400))
  }

  btnOpenMeta.onclick = async () => {
    const it = pick()
    if (!it) return
    if (typeof ctx.openFileByPath !== 'function') {
      ctx.ui.notice(t('当前环境不支持打开文件', 'openFileByPath not available'), 'err', 2000)
      return
    }
    const files = ['01_进度脉络.md', '02_世界设定.md', '03_主要角色.md', '04_人物关系.md', '05_章节大纲.md']
    for (let i = 0; i < files.length; i++) {
      const p = joinFsPath(it.projectAbs, files[i])
      if (!(await fileExists(ctx, p))) {
        await writeTextAny(ctx, p, '# ' + files[i].replace(/\\.md$/i, '') + '\n')
      }
      try { await ctx.openFileByPath(p) } catch {}
    }
    out.textContent = t('已打开资料文件：', 'Opened meta files: ') + it.projectRel
  }

  btnAbandon.onclick = async () => {
    const it = pick()
    if (!it) return
    const ok = await openConfirmDialog(ctx, {
      title: t('弃坑确认', 'Confirm abandon'),
      message: t('将删除整个项目目录：', 'This will delete the whole project directory: ') + '\n' + it.projectRel + '\n\n' + t('此操作不可恢复。继续？', 'This cannot be undone. Continue?'),
      okText: t('删除', 'Delete'),
      cancelText: t('取消', 'Cancel')
    })
    if (!ok) return
    if (!ctx || typeof ctx.invoke !== 'function') {
      ctx.ui.notice(t('当前环境不支持删除目录', 'Delete is not supported'), 'err', 2400)
      return
    }
    try {
      await ctx.invoke('force_remove_path', { path: it.projectAbs })
      cfg = await loadCfg(ctx)
      if (String(cfg.currentProjectRel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') === it.projectRel) {
        await saveCfg(ctx, { currentProjectRel: '' })
      }
      out.textContent = t('已删除项目：', 'Deleted: ') + it.projectRel
      ctx.ui.notice(t('已弃坑并删除项目', 'Project deleted'), 'ok', 1800)
      await refresh()
    } catch (e) {
      ctx.ui.notice(t('删除失败：', 'Delete failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  await refresh()
}

export function activate(context) {
  __CTX__ = context
  try {
    context.addMenuItem({
      label: t('小说', 'Novel'),
      children: [
        { label: t('设置', 'Settings'), onClick: async () => await openSettingsDialog(context) },
        {
          label: t('项目管理', 'Project Manager'),
          onClick: async () => {
            try {
              await openProjectManagerDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('一键开坑（从0开始）', 'Start from zero (auto first chapter)'),
          onClick: async () => {
            try {
              await openBootstrapDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('导入现有文稿（初始化资料）', 'Import existing writing (init meta)'),
          onClick: async () => {
            try {
              await openImportExistingDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('写作咨询（不续写）', 'Writing consult (no continuation)'),
          onClick: async () => {
            try {
              await openConsultDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        { type: 'divider' },
        {
          label: t('开始下一章（新建章节文件）', 'Start next chapter (new file)'),
          onClick: async () => {
            try {
              const cfg = await loadCfg(context)
              const inf = await computeNextChapterPath(context, cfg)
              if (!inf) throw new Error(t('未发现项目：请先在“小说→项目管理”选择项目，或打开项目内文件。', 'No project: select one in Project Manager or open a file under the project.'))
              const ok = await openConfirmDialog(context, {
                title: t('新建下一章', 'Create next chapter'),
                message:
                  t('将在章节目录创建文件：\n', 'Will create file under chapters:\n') +
                  String(inf.chapPath || '') +
                  '\n\n' +
                  t('创建并打开它？', 'Create and open it?'),
              })
              if (!ok) return
              const title = `# 第${inf.chapZh}章`
              await writeTextAny(context, inf.chapPath, title + '\n\n')
              try {
                if (typeof context.openFileByPath === 'function') {
                  await context.openFileByPath(inf.chapPath)
                }
              } catch {}
              context.ui.notice(t('已创建并打开：', 'Created: ') + String(fsBaseName(inf.chapPath)), 'ok', 2000)
              context.ui.notice(t('提示：打开该章节后再用“续写正文”并追加，就会写入第二章文件。', 'Tip: open this chapter then use Write and append; it will go into this file.'), 'ok', 2600)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('走向及续写', 'Options & Write'),
          onClick: async () => {
            try {
              await openWriteWithChoiceDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('审阅/修改草稿（对话）', 'Review/Edit draft (chat)'),
          onClick: async () => {
            try {
              const cfg = await loadCfg(context)
              const doc = safeText(context.getEditorValue ? context.getEditorValue() : '')
              let bid = findLastDraftIdInDoc(doc)
              if (!bid) {
                const last = await loadLastDraftInfo(context)
                bid = last && last.blockId ? String(last.blockId) : ''
              }
              bid = String(bid || '').trim()
              if (!bid) {
                throw new Error(t('未发现草稿块：请先用“追加为草稿（可审阅）”。', 'No draft block: append as draft first.'))
              }
              const txt = extractDraftBlockText(doc, bid)
              if (!txt) throw new Error(t('未找到草稿块：可能已被手动删除或当前文件不是写入文件。', 'Draft block not found in current doc.'))
              await openDraftReviewDialog(context, { blockId: bid, text: txt })
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('更新资料文件（提议）', 'Update meta files (proposal)'),
          onClick: async () => {
            try {
              await openMetaUpdateDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('更新进度脉络', 'Update progress'),
          onClick: async () => {
            try {
              await openProgressUpdateDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('RAG 索引（向量检索）', 'RAG index (embeddings)'),
          onClick: async () => {
            try {
              await openRagIndexDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('一致性审计', 'Audit'),
          onClick: async () => {
            try {
              await openAuditDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        { type: 'divider' },
        {
          label: t('兑换充值卡', 'Redeem card'),
          onClick: async () => {
            try { await openSettingsDialog(context) } catch {}
          }
        }
      ]
    })
  } catch (e) {
    console.error('[ai-novel] activate failed', e)
  }
}

export function deactivate() {
  try { closeDialog() } catch {}
  __CTX__ = null
}

export async function openSettings(context) {
  await openSettingsDialog(context)
}

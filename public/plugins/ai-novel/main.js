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

// 余额低于该阈值时给出常驻警告（字符）
const LOW_BALANCE_WARN_CHARS = 50000
const LOW_BALANCE_WARN_TEXT = '当前剩余字符不足5万，大文本场景写作可能失败或无响应'

// 自动探测余额的最小间隔：避免频繁打开窗口时反复打后端
const BILLING_PROBE_TTL_MS = 20000

const DEFAULT_CFG = {
  // 后端地址：强制内置，不在设置里展示
  backendBaseUrl: 'https://flymd.nyc.mn/xiaoshuo',
  token: '',
  novelRootDir: '小说/', // 相对库根目录，用户可改
  currentProjectRel: '', // 当前小说项目（相对库根目录），为空则从当前文件路径推断
  upstream: {
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-chat'
  },
  // 可选：仅用于 Agent 的 plan/TODO 生成；任一字段为空则自动沿用 upstream 对应字段
  planUpstream: {
    baseUrl: '',
    apiKey: '',
    model: ''
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
    // 仅建议 macOS 遇到 forbidden path 时开启：把索引落到 AppLocalData（插件数据目录），避免 Documents 等路径被 fs scope 拦截。
    indexInAppLocalData: false,
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
    // 写作字数目标（总字数）：目标值，不做硬截断（避免“超一点就被砍掉”）
    targetChars: 3000,
    // 思考模式（默认 none）：
    // - none：不思考（就是现在的 Agent：咨询只显示，不注入写作）
    // - normal：正常思考（把咨询提炼出的检查清单注入每段写作上下文）
    // - strong：强思考（每段写作前刷新检索 + 注入咨询清单，更慢更贵但更稳）
    thinkingMode: 'none',
    // 自动审计默认关闭（让用户自己决定要不要花预算）
    audit: false
  }
}

let __CTX__ = null
let __CTX_MENU_DISPOSER__ = null
let __DIALOG__ = null
let __MINIBAR__ = null
let __MINI__ = null
let __LOW_BALANCE_WARN_SHOWN__ = false
let __LAST_BILLING_PROBE_AT__ = 0
let __BILLING_PROBE_INFLIGHT__ = false

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
      // 关键：cfg 需要按“已知嵌套结构”做浅层深合并，否则加新字段会被旧对象整体覆盖掉
      try {
        const ru = raw.upstream && typeof raw.upstream === 'object' ? raw.upstream : {}
        const rpu = raw.planUpstream && typeof raw.planUpstream === 'object' ? raw.planUpstream : {}
        const re = raw.embedding && typeof raw.embedding === 'object' ? raw.embedding : {}
        const rc = raw.ctx && typeof raw.ctx === 'object' ? raw.ctx : {}
        const rr = raw.rag && typeof raw.rag === 'object' ? raw.rag : {}
        const rcon = raw.constraints && typeof raw.constraints === 'object' ? raw.constraints : {}
        const ra = raw.agent && typeof raw.agent === 'object' ? raw.agent : {}
        out.upstream = { ...DEFAULT_CFG.upstream, ...ru }
        out.planUpstream = { ...DEFAULT_CFG.planUpstream, ...rpu }
        out.embedding = { ...DEFAULT_CFG.embedding, ...re }
        out.ctx = { ...DEFAULT_CFG.ctx, ...rc }
        out.rag = { ...DEFAULT_CFG.rag, ...rr }
        out.constraints = { ...DEFAULT_CFG.constraints, ...rcon }
        out.agent = { ...DEFAULT_CFG.agent, ...ra }
      } catch {}
      // 兼容旧配置：upstream.planModel -> planUpstream.model
      try {
        const legacyPlanModel = safeText(out && out.upstream && out.upstream.planModel).trim()
        const curPlanModel = safeText(out && out.planUpstream && out.planUpstream.model).trim()
        if (!curPlanModel && legacyPlanModel) {
          out.planUpstream = { ...(out.planUpstream || {}), model: legacyPlanModel }
        }
      } catch {}
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
  const p = patch && typeof patch === 'object' ? patch : {}
  const out = { ...cur, ...p }
  // 与 loadCfg 对称：对已知嵌套结构做合并，避免 patch 覆盖掉其它字段
  try {
    if (p.upstream && typeof p.upstream === 'object') out.upstream = { ...(cur.upstream || {}), ...p.upstream }
    if (p.planUpstream && typeof p.planUpstream === 'object') out.planUpstream = { ...(cur.planUpstream || {}), ...p.planUpstream }
    if (p.embedding && typeof p.embedding === 'object') out.embedding = { ...(cur.embedding || {}), ...p.embedding }
    if (p.ctx && typeof p.ctx === 'object') out.ctx = { ...(cur.ctx || {}), ...p.ctx }
    if (p.rag && typeof p.rag === 'object') out.rag = { ...(cur.rag || {}), ...p.rag }
    if (p.constraints && typeof p.constraints === 'object') out.constraints = { ...(cur.constraints || {}), ...p.constraints }
    if (p.agent && typeof p.agent === 'object') out.agent = { ...(cur.agent || {}), ...p.agent }
  } catch {}
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

async function sleepWithAbort(ms, control) {
  const total = Math.max(0, ms | 0)
  if (!total) return
  const step = 220
  let left = total
  while (left > 0) {
    if (control && control.aborted) throw new Error(t('已终止本次任务', 'Task aborted'))
    const chunk = Math.min(step, left)
    await sleep(chunk)
    left -= chunk
  }
}

async function apiFetchConsultWithJob(ctx, cfg, body, opt) {
  const onTick = opt && typeof opt.onTick === 'function' ? opt.onTick : null
  const timeoutMs = opt && opt.timeoutMs ? Number(opt.timeoutMs) : 190000
  const control = opt && opt.control && typeof opt.control === 'object' ? opt.control : null

  const b = body && typeof body === 'object' ? body : {}
  const input = (b.input && typeof b.input === 'object') ? b.input : {}
  const body2 = { ...b, input: { ...input, async: true, mode: 'job' } }

  const first = await apiFetch(ctx, cfg, 'ai/proxy/consult/', body2)
  const jobId = first && (first.job_id || first.jobId)
  if (!jobId) return first

  const start = Date.now()
  let waitMs = 0
  let netFail = 0
  for (;;) {
    if (control && control.aborted) throw new Error(t('已终止本次任务', 'Task aborted'))
    waitMs = Date.now() - start
    if (waitMs > timeoutMs) {
      throw new Error(t('咨询超时：任务仍未完成，请稍后重试或换模型', 'Consult timeout: job still pending, please retry or switch model'))
    }

    if (onTick) {
      try { onTick({ jobId, waitMs }) } catch {}
    }

    await sleepWithAbort(netFail > 0 ? Math.min(5000, 1200 + netFail * 500) : 1000, control)
    let st = null
    try {
      st = await apiGet(ctx, cfg, 'ai/proxy/consult/status/?id=' + encodeURIComponent(String(jobId)))
      netFail = 0
    } catch (e) {
      // 轮询阶段允许网络抖动：只要总超时没到，就继续等（否则“任务已完成但客户端拿不到”）
      netFail++
      const msg = e && e.message ? String(e.message) : String(e)
      if (onTick) {
        try { onTick({ jobId, waitMs, netFail, netError: msg }) } catch {}
      }
      // 连续失败太久就别无限等：把错误抛出去让 UI 提示用户检查网络/站点
      if (netFail >= 12 && waitMs > 45000) throw e
      continue
    }
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
  const control = opt && opt.control && typeof opt.control === 'object' ? opt.control : null

  const b = body && typeof body === 'object' ? body : {}
  const action = safeText(b.action).trim().toLowerCase()
  function timeoutMsg() {
    if (action === 'audit') return t('审计超时：任务仍未完成，请稍后重试或换模型', 'Audit timeout: job still pending, please retry or switch model')
    if (action === 'write') return t('写作超时：任务仍未完成，请稍后重试或换模型', 'Write timeout: job still pending, please retry or switch model')
    return t('请求超时：任务仍未完成，请稍后重试或换模型', 'Request timeout: job still pending, please retry or switch model')
  }
  const input = (b.input && typeof b.input === 'object') ? b.input : {}
  const body2 = { ...b, input: { ...input, async: true, mode: 'job' } }

  const first = await apiFetch(ctx, cfg, 'ai/proxy/chat/', body2)
  const jobId = first && (first.job_id || first.jobId)
  // 兼容旧后端：不支持 job 时会直接返回 {text,...}
  if (!jobId) return first

  const start = Date.now()
  let waitMs = 0
  let netFail = 0
  for (;;) {
    if (control && control.aborted) throw new Error(t('已终止本次任务', 'Task aborted'))
    waitMs = Date.now() - start
    if (waitMs > timeoutMs) {
      throw new Error(timeoutMsg())
    }

    if (onTick) {
      try { onTick({ jobId, waitMs }) } catch {}
    }

    await sleepWithAbort(netFail > 0 ? Math.min(5000, 1200 + netFail * 500) : 1000, control)
    let st = null
    try {
      st = await apiGet(ctx, cfg, 'ai/proxy/chat/status/?id=' + encodeURIComponent(String(jobId)))
      netFail = 0
    } catch (e) {
      // 轮询阶段允许网络抖动：只要总超时没到，就继续等（否则“任务已完成但客户端拿不到”）
      netFail++
      const msg = e && e.message ? String(e.message) : String(e)
      if (onTick) {
        try { onTick({ jobId, waitMs, netFail, netError: msg }) } catch {}
      }
      if (netFail >= 12 && waitMs > 45000) throw e
      continue
    }
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

  const chapRoot = joinFsPath(inf.projectAbs, '03_章节')
  const chapDir = await inferCurrentChapterDir(ctx, inf, chapRoot)
  const filesAll = await listMarkdownFilesAny(ctx, chapRoot)
  const files = (filesAll || []).filter((p) => fsDirName(p) === chapDir)

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

function parseVolumeNoFromDirName(name) {
  // 约定：卷目录名形如：卷02_第二卷（允许无后缀：卷2）
  const bn = safeFileName(String(name || '').trim(), '')
  const m = /^卷(\d{1,3})(?:_|$)/.exec(bn)
  if (!m || !m[1]) return 0
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function pickLastChapterPathInDir(filesAll, dirAbs, excludeBase) {
  const dir = normFsPath(dirAbs).replace(/\/+$/, '')
  const ex = String(excludeBase || '').trim()
  let maxNo = 0
  let best = ''
  for (let i = 0; i < (filesAll || []).length; i++) {
    const p = normFsPath(filesAll[i] || '')
    if (!p) continue
    if (fsDirName(p) !== dir) continue
    const bn = fsBaseName(p)
    if (!bn) continue
    if (ex && bn === ex) continue
    const m = /^(\d{3,})_/.exec(bn)
    if (!m || !m[1]) continue
    const n = parseInt(m[1], 10)
    if (!Number.isFinite(n) || n <= 0) continue
    if (n > maxNo) { maxNo = n; best = p }
  }
  return best
}

function findVolumeDirByNo(filesAll, chapRoot, volNo) {
  const root = normFsPath(chapRoot).replace(/\/+$/, '')
  const want = volNo | 0
  if (want <= 0) return ''
  for (let i = 0; i < (filesAll || []).length; i++) {
    const p = normFsPath(filesAll[i] || '')
    if (!p.startsWith(root + '/')) continue
    const d = fsDirName(p)
    if (!d || d === root) continue
    const relDir = d.slice(root.length).replace(/^\/+/, '')
    const first = (relDir.split('/').filter(Boolean)[0] || '')
    if (parseVolumeNoFromDirName(first) === want) return joinFsPath(root, first)
  }
  return ''
}

async function inferCurrentChapterDir(ctx, inf, chapRoot) {
  // 目标：让“下一章”默认在当前卷/当前目录下递增，而不是全项目混着算。
  // - 旧项目：章节都在 03_章节/ 下 => 兼容
  // - 新项目：卷= 03_章节/卷02_第二卷/ => 每卷章节从 001 开始
  try {
    if (!ctx || !inf) return chapRoot
    let curPath = ''
    try {
      if (ctx.getCurrentFilePath) curPath = String(await ctx.getCurrentFilePath() || '')
    } catch {}
    const cur = normFsPath(curPath)
    const root = normFsPath(chapRoot).replace(/\/+$/, '')
    if (cur && cur.startsWith(root + '/')) {
      const rel = cur.slice(root.length).replace(/^\/+/, '')
      const first = (rel.split('/').filter(Boolean)[0] || '')
      // 只把“卷目录”当成作用域，避免用户在 03_章节 里随手建其它目录导致“下一章”跑偏
      if (parseVolumeNoFromDirName(first) > 0) return joinFsPath(root, first)
      return root
    }
    return root
  } catch {
    return chapRoot
  }
}

async function computeNextVolumeChapterPath(ctx, cfg) {
  // 新开卷：创建卷目录 + 生成该卷第一章（001_第一章.md）
  const inf = await inferProjectDir(ctx, cfg)
  if (!inf) return null

  const chapRoot = joinFsPath(inf.projectAbs, '03_章节')
  const filesAll = await listMarkdownFilesAny(ctx, chapRoot)

  const root = normFsPath(chapRoot).replace(/\/+$/, '')
  let hasRootChapters = false
  let maxVol = 0

  for (let i = 0; i < (filesAll || []).length; i++) {
    const p = normFsPath(filesAll[i] || '')
    if (!p.startsWith(root + '/')) continue
    const dir = fsDirName(p)
    if (dir === root) { hasRootChapters = true; continue }
    const relDir = dir.slice(root.length).replace(/^\/+/, '')
    const first = (relDir.split('/').filter(Boolean)[0] || '')
    const v = parseVolumeNoFromDirName(first)
    if (v > maxVol) maxVol = v
  }

  const baseVol = Math.max(maxVol, hasRootChapters ? 1 : 0)
  const volNo = baseVol > 0 ? (baseVol + 1) : 1
  const volZh = zhNumber(volNo)
  const volDirName = `卷${String(volNo).padStart(2, '0')}_第${volZh}卷`
  const volDir = joinFsPath(chapRoot, volDirName)

  const chapNo = 1
  const chapZh = zhNumber(chapNo)
  const chapPath = joinFsPath(volDir, `${String(chapNo).padStart(3, '0')}_第${chapZh}章.md`)

  // 如果极端情况下同名已存在，就递增卷号再试（避免用户手工创建冲突目录）
  for (let tries = 0; tries < 200; tries++) {
    const dirName = `卷${String(volNo + tries).padStart(2, '0')}_第${zhNumber(volNo + tries)}卷`
    const dir = joinFsPath(chapRoot, dirName)
    const path = joinFsPath(dir, `001_第一章.md`)
    if (!(await fileExists(ctx, path))) {
      return { ...inf, chapRoot, chapDir: dir, chapPath: path, chapNo: 1, chapZh: '一', volNo: (volNo + tries), volZh: zhNumber(volNo + tries), volDirName: dirName }
    }
  }
  return null
}

async function getPrevChapterTailText(ctx, cfg, maxChars) {
  try {
    if (!ctx || !cfg) return ''
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return ''

    const chapRoot = joinFsPath(inf.projectAbs, '03_章节')
    const chapDir = await inferCurrentChapterDir(ctx, inf, chapRoot)
    const filesAll = await listMarkdownFilesAny(ctx, chapRoot)
    const files = (filesAll || []).filter((p) => fsDirName(p) === chapDir)
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

    if (targetNo <= 0) {
      // 新开卷的第一章：优先回退到“上一卷最后一章”，这样续写/咨询不会丢上下文
      const curVolNo = parseVolumeNoFromDirName(fsBaseName(chapDir))
      if (curVolNo > 1) {
        const prevVolNo = curVolNo - 1
        const chapRootAbs = normFsPath(chapRoot).replace(/\/+$/, '')
        const prevDir = findVolumeDirByNo(filesAll, chapRoot, prevVolNo) || (prevVolNo === 1 ? chapRootAbs : '')
        const fallbackPath = prevDir ? pickLastChapterPathInDir(filesAll, prevDir, '') : ''
        if (fallbackPath) {
          const raw = await readTextAny(ctx, fallbackPath)
          return sliceTail(String(raw || ''), maxChars)
        }
      }
      return ''
    }
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

async function findPrevChapterPath(ctx, cfg) {
  // 目标：定位“上一章文件路径”，用于人物提取/状态展示等。
  try {
    if (!ctx || !cfg) return ''
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return ''

    const chapRoot = joinFsPath(inf.projectAbs, '03_章节')
    const chapDir = await inferCurrentChapterDir(ctx, inf, chapRoot)
    const filesAll = await listMarkdownFilesAny(ctx, chapRoot)
    const files = (filesAll || []).filter((p) => fsDirName(p) === chapDir)
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

    // 优先取“当前章节号 - 1”；否则取目录里最大章节号（排除当前文件）
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

    if (targetNo <= 0) {
      // 新开卷的第一章：回退到“上一卷最后一章”
      const curVolNo = parseVolumeNoFromDirName(fsBaseName(chapDir))
      if (curVolNo > 1) {
        const prevVolNo = curVolNo - 1
        const chapRootAbs = normFsPath(chapRoot).replace(/\/+$/, '')
        const prevDir = findVolumeDirByNo(filesAll, chapRoot, prevVolNo) || (prevVolNo === 1 ? chapRootAbs : '')
        const fallbackPath = prevDir ? pickLastChapterPathInDir(filesAll, prevDir, '') : ''
        return fallbackPath || ''
      }
      return ''
    }

    const pad = String(targetNo).padStart(3, '0')
    for (let i = 0; i < files.length; i++) {
      const bn = fsBaseName(files[i] || '')
      if (bn && bn.startsWith(pad + '_')) return files[i]
    }
    return ''
  } catch {
    return ''
  }
}

async function getPrevChapterTextForExtract(ctx, cfg, maxChars) {
  // 人物提取更需要覆盖“开头+结尾”，避免只截尾导致漏角色
  try {
    const p = await findPrevChapterPath(ctx, cfg)
    if (!p) return { path: '', text: '' }
    const raw = await readTextAny(ctx, p)
    const lim = Math.max(2000, (maxChars | 0) || 20000)
    return { path: p, text: sliceHeadTail(String(raw || ''), lim, 0.55) }
  } catch {
    return { path: '', text: '' }
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

function _ainCharStateSplitH2Blocks(mdText) {
  const text = _ainDiffNormEol(mdText)
  const re = /^##\s+.*$/gm
  const hits = []
  let m
  while ((m = re.exec(text))) {
    hits.push({ i: m.index, header: m[0] ? String(m[0]).trim() : '##' })
    if (hits.length >= 200) break
  }
  if (!hits.length) return []
  const blocks = []
  for (let k = 0; k < hits.length; k++) {
    const start = hits[k].i
    const end = (k + 1 < hits.length) ? hits[k + 1].i : text.length
    const full = text.slice(start, end).trim()
    if (!full) continue
    blocks.push({ header: hits[k].header, full })
  }
  return blocks
}

function _ainCharStatePickLatestBlock(mdText) {
  const blocks = _ainCharStateSplitH2Blocks(mdText)
  if (!blocks.length) return ''

  // 优先取“快照”块；没有就退回最后一块（哪怕是失败/原文）
  for (let i = blocks.length - 1; i >= 0; i--) {
    const h = safeText(blocks[i].header)
    if (/^##\s*快照\b/u.test(h)) return blocks[i].full
  }
  return blocks[blocks.length - 1].full
}

function _ainCharStateParseItemsFromBlock(blockText) {
  const t0 = safeText(blockText)
  if (!t0.trim()) return []
  const lines = _ainDiffNormEol(t0).split('\n')
  const out = []
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').trim()
    if (!line) continue
    if (!/^[-*]\s+/.test(line)) continue
    let s = line.replace(/^[-*]\s+/, '').trim()
    if (!s) continue
    if (s === '（无）' || s === '(none)') continue
    let p = s.indexOf('：')
    if (p < 0) p = s.indexOf(':')
    if (p < 0) continue
    const name = s.slice(0, p).trim()
    const status = s.slice(p + 1).trim()
    if (!name) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, status })
    if (out.length >= 80) break
  }
  return out
}

async function getCharStateDocRaw(ctx, cfg) {
  try {
    if (!ctx) return ''
    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return ''
    const abs = joinFsPath(inf.projectAbs, '06_人物状态.md')
    const text = await readTextAny(ctx, abs)
    return safeText(text)
  } catch {
    return ''
  }
}

async function getCharStateBlockForContext(ctx, cfg) {
  try {
    const raw = await getCharStateDocRaw(ctx, cfg)
    const block = _ainCharStatePickLatestBlock(raw)
    if (!safeText(block).trim()) return ''
    const lim = (cfg && cfg.ctx && cfg.ctx.maxCharStateChars) ? Math.max(0, cfg.ctx.maxCharStateChars | 0) : 6000
    return sliceHeadTail(block, lim, 0.55).trim()
  } catch {
    return ''
  }
}

async function getCharStateBlockForUpdate(ctx, cfg) {
  try {
    const raw = await getCharStateDocRaw(ctx, cfg)
    const block = _ainCharStatePickLatestBlock(raw)
    if (!safeText(block).trim()) return ''
    const lim = (cfg && cfg.ctx && cfg.ctx.maxCharStateUpdateChars) ? Math.max(0, cfg.ctx.maxCharStateUpdateChars | 0) : 16000
    return sliceHeadTail(block, lim, 0.55).trim()
  } catch {
    return ''
  }
}

async function getCharStateConstraintsText(ctx, cfg) {
  try {
    const block = await getCharStateBlockForContext(ctx, cfg)
    if (!block) return ''
    return [
      t('【人物状态（自动注入）】', '[Character states (auto)]'),
      block,
      t('规则：以上是“已发生的事实”。续写必须保持一致；若要改变，必须在剧情中给出原因与过程。', 'Rule: The above are established facts. Keep consistency; if changed, justify it in-story.')
    ].join('\n')
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

async function rag_get_index_paths(ctx, cfg, projectAbs) {
  const projectAbsNorm = normFsPath(projectAbs)
  const projectMetaPath = joinFsPath(projectAbsNorm, AIN_RAG_META_FILE)
  const projectVecPath = joinFsPath(projectAbsNorm, AIN_RAG_VEC_FILE)
  const legacyPath = joinFsPath(projectAbsNorm, '.ainovel/rag_index.json')

  const useApp = !!(cfg && cfg.rag && cfg.rag.indexInAppLocalData)
  if (useApp && ctx && typeof ctx.getPluginDataDir === 'function') {
    try {
      const base = normFsPath(await ctx.getPluginDataDir())
      if (base) {
        const key = await sha256Hex('ainovel:rag:' + projectAbsNorm)
        const dir = joinFsPath(base, 'ai-novel/rag/' + key)
        return {
          mode: 'appLocalData',
          metaPath: joinFsPath(dir, 'rag_meta.json'),
          vecPath: joinFsPath(dir, 'rag_vectors.f32'),
          legacyPath,
          projectMetaPath,
          projectVecPath,
        }
      }
    } catch {}
  }

  return {
    mode: 'project',
    metaPath: projectMetaPath,
    vecPath: projectVecPath,
    legacyPath,
    projectMetaPath,
    projectVecPath,
  }
}

async function rag_load_index(ctx, cfg, projectAbs) {
  // 索引落盘：meta.json（文本）+ vectors.f32（二进制）。避免 JSON 存向量导致索引膨胀/解析卡死。
  const paths = await rag_get_index_paths(ctx, cfg, projectAbs)
  const metaPath = paths.metaPath
  const vecPath = paths.vecPath
  const legacyPath = paths.legacyPath

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
      await rag_save_index(ctx, cfg, projectAbs, meta, flat)
      return { meta, vectors: flat }
    } catch {
      return false
    }
  }

  async function tryLoadAt(metaPath2, vecPath2) {
    const raw = await readTextAny(ctx, metaPath2)
    const meta = JSON.parse(String(raw || '{}'))
    if (!meta || typeof meta !== 'object') return null
    if ((meta.schema_version | 0) !== AIN_RAG_SCHEMA_VERSION) return null

    const dims = meta.dims | 0
    if (dims < 0) return null

    const bytes = await readFileBinaryAny(ctx, vecPath2)
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    if (ab.byteLength % 4 !== 0) return null
    const vectors = new Float32Array(ab)

    if (dims === 0) return { meta, vectors: new Float32Array() }
    if (!vectors.length || vectors.length % dims !== 0) return null

    return { meta, vectors }
  }

  try {
    const loaded = await tryLoadAt(metaPath, vecPath)
    if (loaded) return loaded
  } catch {}

  // 开启“落到 AppLocalData”后，为了兼容旧用户：如果 AppLocalData 没有索引，再尝试从项目目录读取一次。
  try {
    if (paths.mode === 'appLocalData') {
      const loaded2 = await tryLoadAt(paths.projectMetaPath, paths.projectVecPath)
      if (loaded2) return loaded2
    }
  } catch {}

  // 如果新索引不存在，尝试从旧 JSON 索引迁移一次
  try {
    const migrated = await tryMigrateLegacy()
    if (!migrated) return null
    return migrated
  } catch {
    return null
  }
}

async function rag_save_index(ctx, cfg, projectAbs, meta, vectors) {
  const paths = await rag_get_index_paths(ctx, cfg, projectAbs)
  const metaPath = paths.metaPath
  const vecPath = paths.vecPath

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
  try { oldLoaded = await rag_load_index(ctx, cfg, projectAbs) } catch { oldLoaded = null }
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
    await rag_save_index(ctx, cfg, projectAbs, meta0, new Float32Array())
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
      await rag_save_index(ctx, cfg, projectAbs, meta0, new Float32Array())
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

  await rag_save_index(ctx, cfg, projectAbs, meta, flat)
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

  let loaded = await rag_load_index(ctx, cfg, projectAbs)
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
.ain-overlay{position:fixed;inset:0;background:rgba(2,6,23,.75);z-index:999999;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
.ain-dlg{width:min(980px,96vw);background:#0f172a;border:1px solid #334155;border-radius:10px;color:#e2e8f0;box-shadow:0 25px 50px -12px rgba(0,0,0,.5)}
.ain-head{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid #334155}
.ain-title{font-size:16px;font-weight:600;color:#f1f5f9}
.ain-winbtns{display:flex;gap:6px;align-items:center}
.ain-winbtn{background:transparent;border:0;color:#94a3b8;font-size:16px;cursor:pointer;min-width:28px;height:28px;line-height:28px;border-radius:6px}
.ain-winbtn:hover{background:rgba(148,163,184,.15);color:#e2e8f0}
.ain-close{font-size:20px}
.ain-body{padding:20px}
.ain-card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:12px 0}
.ain-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ain-lab{font-size:12px;color:#94a3b8;margin:10px 0 6px;font-weight:500}
.ain-in{width:100%;padding:10px 14px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;box-sizing:border-box}
.ain-in:focus{border-color:#3b82f6;outline:none;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.ain-ta{width:100%;min-height:120px;padding:10px 14px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;box-sizing:border-box;resize:vertical}
.ain-ta:focus{border-color:#3b82f6;outline:none;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.ain-out{white-space:pre-wrap;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;min-height:120px;color:#cbd5e1}
.ain-diff{white-space:pre-wrap;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;min-height:120px}
.ain-diff mark{background:rgba(34,197,94,.2);color:#86efac;padding:0 2px;border-radius:2px}
.ain-diff del{background:rgba(239,68,68,.2);color:#fca5a5;text-decoration:line-through;padding:0 2px;border-radius:2px}
.ain-opt{border:1px solid #334155;background:#1e293b;border-radius:8px;padding:12px;margin:8px 0;cursor:pointer}
.ain-opt:hover{border-color:#3b82f6;background:#1e3a5f}
.ain-opt.sel{border-color:#3b82f6;background:#1e3a5f}
.ain-opt-title{font-weight:600;color:#f1f5f9}
.ain-opt-sub{color:#94a3b8;font-size:12px;margin-top:4px}
.ain-selrow{display:flex;gap:12px;align-items:center;margin-top:12px}
.ain-selrow .ain-lab{margin:0}
.ain-select{min-width:260px}
.ain-btn-group{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.ain-btn[disabled]{opacity:.5;cursor:not-allowed}
.ain-btn{display:inline-block;padding:9px 16px;border-radius:6px;background:#3b82f6;color:#fff;border:0;cursor:pointer;font-size:13px;font-weight:500}
.ain-btn:hover:not([disabled]){background:#2563eb}
.ain-btn.gray{background:#475569}
.ain-btn.gray:hover:not([disabled]){background:#64748b}
.ain-btn.red{background:#ef4444}
.ain-btn.red:hover:not([disabled]){background:#dc2626}
.ain-muted{color:#94a3b8;font-size:12px}
.ain-ok{color:#86efac}
.ain-err{color:#fca5a5}
.ain-todo{background:#1e293b;border:1px dashed #475569;border-radius:8px;padding:12px}
.ain-todo-item{display:flex;gap:8px;align-items:flex-start;margin:6px 0}
.ain-todo-st{width:18px;flex:0 0 18px;font-weight:600;line-height:18px}
.ain-todo-title{flex:1;min-width:0}
.ain-todo-title .ain-muted{margin-left:6px}
.ain-todo-log{white-space:pre-wrap;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin-top:10px;max-height:240px;overflow:auto}
.ain-table-wrap{max-height:320px;overflow:auto;border:1px solid #334155;border-radius:8px;background:#0f172a}
.ain-table{width:100%;border-collapse:collapse}
.ain-table th,.ain-table td{border-bottom:1px solid #334155;padding:10px 12px;font-size:12px;vertical-align:top;white-space:nowrap}
.ain-table th{position:sticky;top:0;background:#1e293b;font-weight:600;z-index:1;color:#f1f5f9}
.ain-table td.num,.ain-table th.num{text-align:right}
.ain-table td.mono,.ain-table th.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
.ain-minibar{position:fixed;z-index:1000000;background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:999px;padding:0 12px;display:flex;align-items:center;gap:10px;height:var(--ain-bar-h,28px);line-height:var(--ain-bar-h,28px);user-select:none;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.ain-minibar .ain-minititle{font-size:12px;font-weight:600;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:grab}
.ain-minibar .ain-minititle:active{cursor:grabbing}
.ain-minibar .ain-winbtn{height:calc(var(--ain-bar-h,28px) - 4px);line-height:calc(var(--ain-bar-h,28px) - 4px);min-width:24px;border-radius:999px}
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
  secBackend.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('账户', 'Account')}</div>`
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
  btnRow.className = 'ain-btn-group'
  const btnLogin = document.createElement('button')
  btnLogin.className = 'ain-btn'
  btnLogin.textContent = t('登录', 'Login')
  const btnRegister = document.createElement('button')
  btnRegister.className = 'ain-btn gray'
  btnRegister.textContent = t('注册', 'Register')
  const btnDocs = document.createElement('a')
  btnDocs.className = 'ain-btn gray'
  btnDocs.textContent = t('使用文档', 'Docs')
  btnDocs.href = 'https://www.llingfei.com/novel.html'
  btnDocs.target = '_blank'
  btnDocs.rel = 'noopener noreferrer'
  btnDocs.style.textDecoration = 'none'
  const btnMe = document.createElement('button')
  btnMe.className = 'ain-btn gray'
  btnMe.textContent = t('刷新余额', 'Refresh billing')
  const inpCard = document.createElement('input')
  inpCard.className = 'ain-in'
  inpCard.type = 'text'
  inpCard.placeholder = t('充值卡号', 'Card token')
  inpCard.style.width = '220px'
  const btnRedeem = document.createElement('button')
  btnRedeem.className = 'ain-btn gray'
  btnRedeem.textContent = t('兑换', 'Redeem')
  const btnBuyCard = document.createElement('button')
  btnBuyCard.className = 'ain-btn gray'
  btnBuyCard.textContent = t('购买充值卡', 'Buy Card')
  btnRow.appendChild(btnLogin)
  btnRow.appendChild(btnRegister)
  btnRow.appendChild(btnDocs)
  btnRow.appendChild(btnMe)
  btnRow.appendChild(inpCard)
  btnRow.appendChild(btnRedeem)
  btnRow.appendChild(btnBuyCard)
  secBackend.appendChild(btnRow)

  const shopImgWrap = document.createElement('div')
  shopImgWrap.style.marginTop = '12px'
  shopImgWrap.style.display = 'none'
  shopImgWrap.style.textAlign = 'center'
  const shopImg = document.createElement('img')
  shopImg.src = 'https://flymd.llingfei.com/pdf/shop.png'
  shopImg.style.maxWidth = '100%'
  shopImg.style.borderRadius = '8px'
  shopImg.style.border = '1px solid #334155'
  shopImgWrap.appendChild(shopImg)
  secBackend.appendChild(shopImgWrap)

  btnBuyCard.onclick = () => {
    shopImgWrap.style.display = shopImgWrap.style.display === 'none' ? 'block' : 'none'
  }

  const billingBox = document.createElement('div')
  billingBox.className = 'ain-muted'
  billingBox.style.marginTop = '10px'
  billingBox.textContent = t('未登录', 'Not logged in')
  secBackend.appendChild(billingBox)

  const authStatus = document.createElement('div')
  authStatus.style.marginTop = '8px'
  authStatus.style.padding = '8px 12px'
  authStatus.style.borderRadius = '6px'
  authStatus.style.fontSize = '13px'
  authStatus.style.display = 'none'
  secBackend.appendChild(authStatus)

  function showAuthStatus(msg, type) {
    authStatus.textContent = msg
    authStatus.style.display = 'block'
    if (type === 'ok') {
      authStatus.style.background = 'rgba(34,197,94,.15)'
      authStatus.style.color = '#86efac'
      authStatus.style.border = '1px solid rgba(34,197,94,.3)'
    } else {
      authStatus.style.background = 'rgba(239,68,68,.15)'
      authStatus.style.color = '#fca5a5'
      authStatus.style.border = '1px solid rgba(239,68,68,.3)'
    }
    setTimeout(() => { authStatus.style.display = 'none' }, type === 'ok' ? 3000 : 5000)
  }

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

    // 余额过低：给宿主右下角发一个“常驻通知”（仅首次触发，避免刷屏）
    try { maybeShowLowBalanceWarn(ctx, b.balance_chars) } catch {}
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
      showAuthStatus(t('登录成功', 'Login successful'), 'ok')
      ctx.ui.notice(t('登录成功', 'Login ok'), 'ok', 1600)
    } catch (e) {
      const msg = t('登录失败：', 'Login failed: ') + (e && e.message ? e.message : String(e))
      showAuthStatus(msg, 'err')
      ctx.ui.notice(msg, 'err', 2400)
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
      showAuthStatus(t('注册成功', 'Registration successful'), 'ok')
      ctx.ui.notice(t('注册成功', 'Registered'), 'ok', 1600)
    } catch (e) {
      const msg = t('注册失败：', 'Register failed: ') + (e && e.message ? e.message : String(e))
      showAuthStatus(msg, 'err')
      ctx.ui.notice(msg, 'err', 2600)
    }
  }

  async function openExternalViaTauri(url) {
    const u = String(url || '').trim()
    if (!u) return false
    try {
      const tauri = (globalThis && globalThis.__TAURI__) ? globalThis.__TAURI__ : null
      if (!tauri) return false
      const open1 = tauri.opener && typeof tauri.opener.openUrl === 'function' ? tauri.opener.openUrl : null
      const open2 = tauri.plugin && tauri.plugin.opener && typeof tauri.plugin.opener.openUrl === 'function' ? tauri.plugin.opener.openUrl : null
      const open3 = tauri.shell && typeof tauri.shell.open === 'function' ? tauri.shell.open : null
      const open4 = tauri.plugin && tauri.plugin.shell && typeof tauri.plugin.shell.open === 'function' ? tauri.plugin.shell.open : null
      const fns = [open1, open2, open3, open4].filter(Boolean)
      for (let i = 0; i < fns.length; i++) {
        try {
          const r = fns[i](u)
          if (r && typeof r.then === 'function') await r
          return true
        } catch {}
      }
      // 最后兜底：直接 invoke（版本差异大，失败就算了）
      try { if (tauri.core && typeof tauri.core.invoke === 'function') { await tauri.core.invoke('plugin:opener|open_url', { url: u }); return true } } catch {}
    } catch {}
    return false
  }

  btnDocs.addEventListener('click', async (ev) => {
    // 关键点：必须是真实 <a href> 点击，宿主才可能拦截并用系统浏览器打开
    // 我们只在确认走了 Tauri opener 时才阻止默认行为；否则放行给宿主/浏览器处理
    try {
      const url = btnDocs.href
      const ok = await openExternalViaTauri(url)
      if (ok) {
        try { ev.preventDefault() } catch {}
        return
      }
      // 不兜底弹窗：FlyMD 很可能禁了 window.open；默认行为比“假打开”靠谱
    } catch {}
  })

  btnMe.onclick = async () => {
    try {
      await refreshBilling()
      ctx.ui.notice(t('已刷新', 'Refreshed'), 'ok', 1200)
    } catch (e) {
      ctx.ui.notice(t('读取失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }

  btnRedeem.onclick = async () => {
    try {
      cfg = await loadCfg(ctx)
      const token = (inpCard.value || '').trim()
      if (!token) throw new Error(t('请输入充值卡号', 'Please input card token'))
      const json = await apiFetch(ctx, cfg, 'billing/redeem/', { token })
      await refreshBilling()
      ctx.ui.notice(t('兑换成功，增加字符：', 'Redeemed, chars +') + String(json.chars_grant || 0), 'ok', 2400)
    } catch (e) {
      ctx.ui.notice(t('兑换失败：', 'Redeem failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
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
  const inpNovelRoot = mkInput(t('小说根目录（务必在主程序库管理设定好库文件夹！）', 'Novel root dir (relative to library)'), cfg.novelRootDir || '小说/')
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
  hintCtx.textContent = t('提示：这里的单位是“字符”，不是 token；按你的上游模型能力调整即可（例如 128K/256K/400K/1M）。', 'Note: units are characters (not tokens). Tune based on your upstream model window (e.g. 128K/256K/400K/1M).')
  secCtx.appendChild(hintCtx)

  const presets = [
    { label: '8K', value: '8000' },
    { label: '32K', value: '32000' },
    { label: '128K', value: '128000' },
    { label: '256K', value: '256000' },
    { label: '400K', value: '400000' },
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

    // 更“科学”的预算：
    // - 上下文窗口不是越塞越好：前文/圣经太长会显著增加复述/重写概率，还会把成本/延迟拉爆。
    // - 我们对核心上下文做“递增但封顶”的分配，留出足够余量给：系统包装/指令/走向 choice/RAG 片段/模型输出。
    // - 预设只给保守建议；想塞更多就选“自定义”自己改。
    if (total <= 12000) {
      inpPrevChars.inp.value = String(1500)
      inpProgChars.inp.value = String(1500)
      inpBibleChars.inp.value = String(1500)
      inpUpdChars.inp.value = String(3000)
      return
    }

    const prev = _clampInt(Math.round(total * 0.20), 2000, 20000)
    const prog = _clampInt(Math.round(total * 0.18), 2000, 26000)
    const bible = _clampInt(Math.round(total * 0.22), 2000, 32000)
    // “进度生成源文本”会与 progress/bible/prev 同时进入摘要提示词，不能按比例无限膨胀。
    const upd = _clampInt(Math.round(total * 0.30), 6000, 80000)

    inpPrevChars.inp.value = String(prev)
    inpProgChars.inp.value = String(prog)
    inpBibleChars.inp.value = String(bible)
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
  agentLine.appendChild(document.createTextNode(t('启用 Agent', 'Enable Agent ')))
  secAgent.appendChild(agentLine)

  const rowAgent = document.createElement('div')
  rowAgent.className = 'ain-row'
  const agentTarget0 = (() => {
    try {
      const a = cfg && cfg.agent ? cfg.agent : {}
      const v = a && (a.targetChars != null ? a.targetChars : (a.target_chars != null ? a.target_chars : null))
      const n = parseInt(String(v == null ? '' : v), 10)
      if (n === 1000 || n === 2000 || n === 3000) return n
      if (n === 4000) return 3000
    } catch {}
    // 兼容旧配置：chunkCount -> targetChars
    try {
      const a = cfg && cfg.agent ? cfg.agent : {}
      const c = parseInt(String(a && a.chunkCount != null ? a.chunkCount : ''), 10)
      if (Number.isFinite(c)) {
        if (c <= 1) return 1000
        if (c === 2) return 2000
        if (c === 3) return 3000
        return 3000
      }
    } catch {}
    return 3000
  })()
  const agentMode0 = (() => {
    try {
      const a = _ainAgentGetCfg(cfg)
      const v = a && a.thinkingMode ? String(a.thinkingMode) : ''
      return (v === 'none' || v === 'normal' || v === 'strong') ? v : 'none'
    } catch {}
    return 'none'
  })()

  const selAgentTarget = mkSelect(
    t('写作字数（Agent）', 'Target chars (Agent)'),
    [
      { value: '1000', label: t('≈ 1000 字', '≈ 1000 chars') },
      { value: '2000', label: t('≈ 2000 字', '≈ 2000 chars') },
      { value: '3000', label: t('≈ 3000 字', '≈ 3000 chars') },
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

  const selThinkingMode = mkSelect(
    t('思考模式（Agent）', 'Thinking mode (Agent)'),
    [
      { value: 'none', label: t('正常', 'default') },
      { value: 'normal', label: t('中等', 'Normal') },
      { value: 'strong', label: t('加强', 'Strong') },
    ],
    agentMode0
  )

  function syncAgentTargetByMode() {
    const max = _ainAgentMaxTargetCharsByMode(selThinkingMode.sel.value)
    try {
      const opts = selAgentTarget.sel.querySelectorAll('option')
      for (let i = 0; i < opts.length; i++) {
        const v = parseInt(String(opts[i].value || '0'), 10) || 0
        opts[i].disabled = v > max
      }
    } catch {}
    const cur = parseInt(String(selAgentTarget.sel.value || '3000'), 10) || 3000
    const next = _ainAgentClampTargetCharsByMode(selThinkingMode.sel.value, cur)
    if (next !== cur) {
      try { selAgentTarget.sel.value = String(next) } catch {}
    }
  }
  try { selThinkingMode.sel.onchange = () => syncAgentTargetByMode() } catch {}
  syncAgentTargetByMode()

  rowAgent.appendChild(selAgentTarget.wrap)
  rowAgent.appendChild(auditWrap)
  rowAgent.appendChild(selThinkingMode.wrap)
  secAgent.appendChild(rowAgent)

  const rowPlanUp1 = document.createElement('div')
  rowPlanUp1.className = 'ain-row'
  const pu = (cfg && cfg.planUpstream && typeof cfg.planUpstream === 'object') ? cfg.planUpstream : {}
  const inpPlanUpBase = mkInput(t('Plan BaseURL（可空=沿用 chat）', 'Plan BaseURL (optional, empty = chat)'), pu.baseUrl || '')
  const inpPlanUpKey = mkInput(t('Plan ApiKey（可空=沿用 chat）', 'Plan ApiKey (optional, empty = chat)'), pu.apiKey || '', 'password')
  rowPlanUp1.appendChild(inpPlanUpBase.wrap)
  rowPlanUp1.appendChild(inpPlanUpKey.wrap)
  secAgent.appendChild(rowPlanUp1)

  const rowPlanUp2 = document.createElement('div')
  rowPlanUp2.className = 'ain-row'
  const inpPlanUpModel = mkInput(t('Plan 模型', 'Plan model'), pu.model || '')
  rowPlanUp2.appendChild(inpPlanUpModel.wrap)
  secAgent.appendChild(rowPlanUp2)

  const hintAgent = document.createElement('div')
  hintAgent.className = 'ain-muted'
  hintAgent.style.marginTop = '6px'
  hintAgent.textContent = t(
    '提示：Agent 会先生成 TODO，再逐项执行；字数是“目标值”而不是硬上限（超出一点没关系）。思考模式：默认≈3000，中等≈2000，加强≈1000（越高越耗 token，甚至翻倍）。',
    'Note: Agent generates TODO then executes step-by-step; the target is a guideline (not a hard cap). Targets: None≈3000, Normal≈2000, Strong≈1000 (higher costs more tokens, sometimes ~2x).'
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

  const ragIdxLine = document.createElement('label')
  ragIdxLine.style.display = 'flex'
  ragIdxLine.style.gap = '8px'
  ragIdxLine.style.alignItems = 'center'
  ragIdxLine.style.marginTop = '10px'
  const cbRagIndexInApp = document.createElement('input')
  cbRagIndexInApp.type = 'checkbox'
  cbRagIndexInApp.checked = !!(cfg.rag && cfg.rag.indexInAppLocalData)
  ragIdxLine.appendChild(cbRagIndexInApp)
  ragIdxLine.appendChild(document.createTextNode(
    t('RAG 索引改写到 AppLocalData（仅建议 mac 遇 forbidden path 后开启）', 'Write RAG index to AppLocalData (recommended only if mac hits forbidden path)')
  ))
  secEmb.appendChild(ragIdxLine)

  const ragIdxHint = document.createElement('div')
  ragIdxHint.className = 'ain-muted'
  ragIdxHint.style.marginTop = '6px'
  ragIdxHint.textContent = t(
    '说明：开启后，索引文件不再落在项目目录的 .ainovel/ 下，而是写到应用数据目录（按“项目路径”隔离）。备份项目目录时不会包含索引文件。',
    'Note: when enabled, index files are stored in app data (scoped per project path), not under project .ainovel/. Project folder backups won’t include the index files.'
  )
  secEmb.appendChild(ragIdxHint)

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
          model: inpUpModel.inp.value,
        },
        planUpstream: {
          baseUrl: inpPlanUpBase.inp.value,
          apiKey: inpPlanUpKey.inp.value,
          model: inpPlanUpModel.inp.value
        },
        embedding: {
          baseUrl: inpEmbBase.inp.value,
          apiKey: inpEmbKey.inp.value,
          model: inpEmbModel.inp.value
        },
        rag: {
          indexInAppLocalData: !!cbRagIndexInApp.checked
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
          targetChars: _ainAgentClampTargetCharsByMode(
            selThinkingMode.sel.value,
            parseInt(String(selAgentTarget.sel.value || '3000'), 10) || 3000
          ),
          thinkingMode: _ainAgentNormThinkingMode(selThinkingMode.sel.value) || 'none',
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
  body.appendChild(secSave)

  dlg.appendChild(head)
  dlg.appendChild(body)
  overlay.appendChild(dlg)
  document.body.appendChild(overlay)
  __DIALOG__ = overlay

  // 初次打开尝试刷新一次
  try { await refreshBilling() } catch {}
}

async function openUsageLogsDialog(ctx) {
  if (typeof document === 'undefined') return

  const { body } = createDialogShell(t('消费日志', 'Usage logs'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  const title = document.createElement('div')
  title.style.fontWeight = '700'
  title.style.marginBottom = '6px'
  title.textContent = t('消费日志（仅当前账号）', 'Usage logs (current account only)')
  sec.appendChild(title)

  const row = document.createElement('div')
  row.className = 'ain-btn-group'
  row.style.marginTop = '6px'
  const btnRefresh = document.createElement('button')
  btnRefresh.className = 'ain-btn gray'
  btnRefresh.textContent = t('刷新日志', 'Refresh')
  const btnOpenSettings = document.createElement('button')
  btnOpenSettings.className = 'ain-btn gray'
  btnOpenSettings.textContent = t('去登录/设置', 'Open settings')
  btnOpenSettings.onclick = async () => {
    try { await openSettingsDialog(ctx) } catch {}
  }
  row.appendChild(btnRefresh)
  row.appendChild(btnOpenSettings)
  sec.appendChild(row)

  const hint = document.createElement('div')
  hint.className = 'ain-muted'
  hint.style.marginTop = '6px'
  sec.appendChild(hint)

  const wrap = document.createElement('div')
  wrap.className = 'ain-table-wrap'
  wrap.style.marginTop = '8px'
  sec.appendChild(wrap)

  const table = document.createElement('table')
  table.className = 'ain-table'
  wrap.appendChild(table)

  const thead = document.createElement('thead')
  const trh = document.createElement('tr')
  function mkTh(text, cls) {
    const th = document.createElement('th')
    if (cls) th.className = cls
    th.textContent = safeText(text)
    return th
  }
  trh.appendChild(mkTh(t('时间', 'Time'), 'mono'))
  trh.appendChild(mkTh(t('功能', 'Feature'), ''))
  trh.appendChild(mkTh(t('字符', 'Chars'), 'num mono'))
  trh.appendChild(mkTh(t('费用(元)', 'Cost(CNY)'), 'num mono'))
  thead.appendChild(trh)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  function mkTd(text, cls) {
    const td = document.createElement('td')
    if (cls) td.className = cls
    td.textContent = safeText(text)
    return td
  }

  function renderRows(items) {
    tbody.textContent = ''
    const arr = Array.isArray(items) ? items : []
    if (!arr.length) {
      const tr = document.createElement('tr')
      const td = document.createElement('td')
      td.colSpan = 4
      td.className = 'ain-muted'
      td.textContent = t('暂无记录', 'No records')
      tr.appendChild(td)
      tbody.appendChild(tr)
      return
    }
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i] || {}
      const tr = document.createElement('tr')
      const time = safeText(it.time || '')
      const feature = safeText(it.feature || '')
      const chars = safeText(it.chars == null ? '' : it.chars)
      const cost = safeText(it.cost_cny == null ? '' : it.cost_cny)
      tr.appendChild(mkTd(time, 'mono'))
      tr.appendChild(mkTd(feature, ''))
      tr.appendChild(mkTd(chars, 'num mono'))
      tr.appendChild(mkTd(cost, 'num mono'))
      tbody.appendChild(tr)
    }
  }

  async function refresh() {
    let cfg = null
    try { cfg = await loadCfg(ctx) } catch {}
    if (!cfg || !cfg.token) {
      hint.textContent = t('未登录：请先在“小说→设置”里登录后端。', 'Not logged in: please login via Novel → Settings.')
      renderRows([])
      return
    }

    try {
      setBusy(btnRefresh, true)
      hint.textContent = t('加载中…', 'Loading...')
      const json = await apiGet(ctx, cfg, 'billing/usage/?limit=200')
      const logs = json && Array.isArray(json.logs) ? json.logs : []
      renderRows(logs)
      const me = json && json.me ? json.me : null
      const who = me && (me.username || me.id) ? `  ·  ${(me.username || ('#' + String(me.id)) )}` : ''
      hint.textContent = t('仅显示当前账号。', 'Current account only.') + who
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      hint.textContent = t('读取日志失败：', 'Failed to load logs: ') + msg
      renderRows([])
    } finally {
      setBusy(btnRefresh, false)
    }
  }

  btnRefresh.onclick = async () => {
    try {
      await refresh()
      ctx.ui.notice(t('已刷新', 'Refreshed'), 'ok', 1200)
    } catch (e) {
      ctx.ui.notice(t('读取失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2400)
    }
  }

  body.appendChild(sec)

  try { await refresh() } catch {}
}

function createDialogShell(title, onClose) {
  ensureDialogStyle()
  closeDialog()
  // 打开任意窗口时自动探测一次余额（仅用于低余额常驻提醒；做了节流）
  try { void probeLowBalanceWarnThrottled(__CTX__) } catch {}

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
  row.className = 'ain-btn-group'
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
  btnInsertJson.textContent = t('插入候选 JSON 到文末', 'Insert JSON to doc')
  btnInsertJson.disabled = true

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
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

  btnAppendDraft.textContent = t('追加为草稿（可审阅）', 'Append as draft (reviewable)')
  btnAppendDraft.disabled = true

  const btnReview = document.createElement('button')
  btnReview.className = 'ain-btn gray'

  btnReview.textContent = t('审阅/修改草稿（对话）', 'Review/Edit draft (chat)')
  btnReview.disabled = true

  const btnPickDraft = document.createElement('button')
  btnPickDraft.className = 'ain-btn gray'
  btnPickDraft.textContent = t('选择草稿块…', 'Pick draft…')
  row2.appendChild(btnAppend)
  row2.appendChild(btnAppendDraft)
  row2.appendChild(btnReview)
  row2.appendChild(btnPickDraft)
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
    const constraints = await mergeConstraintsWithCharState(ctx, cfg, localConstraints)
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
      const r = await apiFetchChatWithJob(ctx, cfg, {
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
          rag: rag || undefined,
          novel_style: 'iceberg'
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
          out.textContent = t('续写中… 已等待 ', 'Writing... waited ') + s + 's'
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

  btnPickDraft.onclick = async () => {
    try {
      await openDraftPickerDialog(ctx)
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

  // 人物状态（06_人物状态.md）——自动注入到硬约束，避免“人被忘掉”（这会直接影响剧情走向）
  const _castState = { items: [] }

  function normCastItem(x) {
    const o = x && typeof x === 'object' ? x : {}
    const name = safeText(o.name).trim()
    const status = safeText(o.status).trim()
    const plan = safeText(o.plan).trim()
    const appear = o.appear == null ? true : !!o.appear
    return { name, status, plan, appear }
  }

  function buildCastConstraintsText() {
    const arr0 = Array.isArray(_castState.items) ? _castState.items : []
    const seen = new Set()
    const rows = []
    for (let i = 0; i < arr0.length; i++) {
      const it = normCastItem(arr0[i])
      if (!it.name) continue
      const key = it.name
      if (seen.has(key)) continue
      seen.add(key)
      const parts = []
      if (it.status) parts.push(t('上一章：', 'Prev: ') + it.status)
      parts.push(t('下一章：', 'Next: ') + (it.appear ? t('出场', 'appear') : t('不出场', 'not appear')))
      if (it.plan) parts.push(t('走向：', 'Arc: ') + it.plan)
      rows.push('- ' + it.name + (parts.length ? ('：' + parts.join('；')) : ''))
    }
    if (!rows.length) return ''
    return [
      t('【人物走向（用户指定）】', '[Character steering (user)]'),
      ...rows,
      t('规则：勾选“出场”的人物，下一章至少出现一次或有一句话交代；未勾选但写了“走向”的，也需要一句话交代。', 'Rule: If marked appear, the character must show up or be mentioned at least once; if not appear but has an arc, add one-sentence update.')
    ].join('\n')
  }

  const castCard = document.createElement('div')
  castCard.className = 'ain-card'
  castCard.style.marginTop = '10px'
  castCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('人物状态（06_人物状态.md）', 'Character states (06_人物状态.md)')}</div>`
  const castHint = document.createElement('div')
  castHint.className = 'ain-muted'
  castHint.textContent = t(
    '自动读取 06_人物状态.md 的最近“快照”并注入到硬约束；点“更新人物状态”会基于上一章正文更新 06_人物状态.md。若解析失败，会显示 AI 原文作为兜底（也会写入文件，便于手动整理）。',
    'Auto-reads latest snapshot from 06_人物状态.md and injects into constraints. Click Update to refresh states from previous chapter. If parsing fails, raw AI output will be shown (also saved to file for manual editing).'
  )
  castCard.appendChild(castHint)

  const castTools = mkBtnRow()
  const btnCastExtract = document.createElement('button')
  btnCastExtract.className = 'ain-btn gray'
  btnCastExtract.textContent = t('更新人物状态', 'Update states')
  const btnCastAdd = document.createElement('button')
  btnCastAdd.className = 'ain-btn gray'

  btnCastAdd.textContent = t('添加人物', 'Add')
  const btnCastClear = document.createElement('button')
  btnCastClear.className = 'ain-btn gray'

  btnCastClear.textContent = t('清空', 'Clear')
  castTools.appendChild(btnCastExtract)
  castTools.appendChild(btnCastAdd)
  castTools.appendChild(btnCastClear)
  castCard.appendChild(castTools)

  const castStatus = document.createElement('div')
  castStatus.className = 'ain-muted'
  castStatus.style.marginTop = '6px'
  castStatus.textContent = t('未读取人物状态。', 'No state loaded.')
  castCard.appendChild(castStatus)

  const castStateTitle = document.createElement('div')
  castStateTitle.className = 'ain-muted'
  castStateTitle.style.marginTop = '6px'
  castStateTitle.textContent = t('最近快照（来自 06_人物状态.md）：', 'Latest snapshot (from 06_人物状态.md):')
  // 不展示“快照原文”，避免占空间；下方的“人物列表”足够用
  castStateTitle.style.display = 'none'
  castCard.appendChild(castStateTitle)

  const castStateOut = document.createElement('div')
  castStateOut.className = 'ain-out'
  castStateOut.style.minHeight = '90px'
  castStateOut.style.marginTop = '6px'
  castStateOut.textContent = t('（未发现快照）', '(no snapshot found)')
  castStateOut.style.display = 'none'
  castCard.appendChild(castStateOut)

  const castRawTitle = document.createElement('div')
  castRawTitle.className = 'ain-muted'
  castRawTitle.style.marginTop = '6px'
  castRawTitle.textContent = t('AI 原文（解析失败时显示）：', 'Raw AI output (shown on parse failure):')
  castRawTitle.style.display = 'none'
  castCard.appendChild(castRawTitle)

  const castRawOut = document.createElement('div')
  castRawOut.className = 'ain-out'
  castRawOut.style.minHeight = '90px'
  castRawOut.style.marginTop = '6px'
  castRawOut.style.display = 'none'
  castCard.appendChild(castRawOut)

  const castList = document.createElement('div')
  castList.style.marginTop = '8px'
  castCard.appendChild(castList)
  sec.appendChild(castCard)

  let _charStateLastBlockFull = ''

  async function refreshCharStateFromFile(opt) {
    const o = opt && typeof opt === 'object' ? opt : {}
    const overwriteItems = !!o.overwriteItems
    try {
      cfg = await loadCfg(ctx)
      const raw = await getCharStateDocRaw(ctx, cfg)
      const blockFull = _ainCharStatePickLatestBlock(raw)
      _charStateLastBlockFull = safeText(blockFull).trim()

      const show = _charStateLastBlockFull ? sliceHeadTail(_charStateLastBlockFull, 6000, 0.55).trim() : ''
      castStateOut.textContent = show || t('（未发现快照）', '(no snapshot found)')

      const items = _ainCharStateParseItemsFromBlock(_charStateLastBlockFull)
      const hasItems = Array.isArray(items) && items.length

      if (overwriteItems || !(Array.isArray(_castState.items) && _castState.items.length)) {
        _castState.items = hasItems
          ? items.map((x) => ({ name: safeText(x.name).trim(), status: safeText(x.status).trim(), plan: '', appear: true }))
          : []
        renderCastList()
      }

      castStatus.textContent = _charStateLastBlockFull
        ? t('已读取人物状态快照。', 'State snapshot loaded.')
        : t('未发现人物状态快照。', 'No state snapshot found.')
    } catch (e) {
      castStatus.textContent = t('读取失败：', 'Read failed: ') + (e && e.message ? e.message : String(e))
    }
  }

  function renderCastList() {
    castList.innerHTML = ''
    const arr = Array.isArray(_castState.items) ? _castState.items : []
    if (!arr.length) {
      const empty = document.createElement('div')
      empty.className = 'ain-muted'
      empty.textContent = t('暂无人物：可点“更新人物状态”或“添加人物”。', 'No characters: update states or add manually.')
      castList.appendChild(empty)
      return
    }

    const head = document.createElement('div')
    head.className = 'ain-muted'
    head.textContent = t('格式：出场 / 人物名 / 上一章状态 / 下一章走向（可空）', 'Format: appear / name / prev status / next arc (optional)')
    castList.appendChild(head)

    for (let i = 0; i < arr.length; i++) {
      const it = normCastItem(arr[i])
      arr[i] = it

      const row = document.createElement('div')
      row.style.display = 'grid'
      row.style.gridTemplateColumns = '70px 140px 1fr 1fr 60px'
      row.style.gap = '8px'
      row.style.alignItems = 'center'
      row.style.marginTop = '8px'

      const lab = document.createElement('label')
      lab.className = 'ain-muted'
      lab.style.display = 'flex'
      lab.style.gap = '6px'
      lab.style.alignItems = 'center'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !!it.appear
      cb.onchange = () => { it.appear = !!cb.checked }
      const sp = document.createElement('span')
      sp.textContent = t('出场', 'Appear')
      lab.appendChild(cb)
      lab.appendChild(sp)

      const inpName = document.createElement('input')
      inpName.className = 'ain-in'
      inpName.value = it.name
      inpName.placeholder = t('人物名', 'Name')
      inpName.oninput = () => { it.name = inpName.value }

      const inpStatus = document.createElement('input')
      inpStatus.className = 'ain-in'
      inpStatus.value = it.status
      inpStatus.placeholder = t('上一章状态（可空）', 'Prev status (optional)')
      inpStatus.oninput = () => { it.status = inpStatus.value }

      const inpPlan = document.createElement('input')
      inpPlan.className = 'ain-in'
      inpPlan.value = it.plan
      inpPlan.placeholder = t('下一章走向（可空）', 'Next arc (optional)')
      inpPlan.oninput = () => { it.plan = inpPlan.value }

      const btnDel = document.createElement('button')
      btnDel.className = 'ain-btn gray'
      btnDel.textContent = t('删除', 'Del')
      btnDel.onclick = () => {
        try {
          _castState.items = arr.filter((_, k) => k !== i)
        } catch {
          _castState.items = []
        }
        renderCastList()
      }

      row.appendChild(lab)
      row.appendChild(inpName)
      row.appendChild(inpStatus)
      row.appendChild(inpPlan)
      row.appendChild(btnDel)

      castList.appendChild(row)
    }
  }

  async function doUpdateCharacterState() {
    try {
      cfg = await loadCfg(ctx)
      setBusy(btnCastExtract, true)
      castRawTitle.style.display = 'none'
      castRawOut.style.display = 'none'
      castRawOut.textContent = ''
      castStatus.textContent = t('更新中…', 'Updating...')

      const lim = (cfg && cfg.ctx && cfg.ctx.maxUpdateSourceChars) ? (cfg.ctx.maxUpdateSourceChars | 0) : 20000
      const prev = await getPrevChapterTextForExtract(ctx, cfg, lim)
      if (!prev || !safeText(prev.text).trim()) {
        throw new Error(t('未找到上一章正文：请先打开章节文件，或确认章节目录存在。', 'No previous chapter text: open a chapter file or check chapters folder.'))
      }

      if (!_charStateLastBlockFull) {
        try { await refreshCharStateFromFile({ overwriteItems: false }) } catch {}
      }

      const res = await char_state_extract_from_text(ctx, cfg, {
        text: safeText(prev.text),
        path: safeText(prev.path),
        existing: _charStateLastBlockFull
      })

      const ts = _fmtLocalTs()
      const title = (res.ok ? '快照 ' : '解析失败 ') + ts + '（上一章提取）'

      if (res.ok) {
        const md = char_state_format_snapshot_md(res.data)
        await char_state_append_block(ctx, cfg, md, title)
        castStatus.textContent = t('已更新人物状态：', 'States updated: ') + String((res.data && res.data.length) ? res.data.length : 0)
        ctx.ui.notice(t('已更新人物状态', 'States updated'), 'ok', 1600)
        await refreshCharStateFromFile({ overwriteItems: true })
        return
      }

      const rawShort = sliceHeadTail(safeText(res.raw).trim(), 12000, 0.6)
      const failBlock = [
        t('> 解析失败：', '> Parse failed: ') + safeText(res.error || ''),
        t('> 以下为 AI 原文（可手动整理为条目）：', '> Raw AI output (you can manually format it):'),
        '```text',
        rawShort,
        '```'
      ].join('\n')
      await char_state_append_block(ctx, cfg, failBlock, title)

      castStatus.textContent = t('更新失败：', 'Update failed: ') + safeText(res.error || '')
      castRawTitle.style.display = ''
      castRawOut.style.display = ''
      castRawOut.textContent = rawShort || t('（空）', '(empty)')
      ctx.ui.notice(t('人物状态更新失败：已显示并写入 AI 原文（请手动整理）', 'State update failed: raw output shown and saved (please edit manually)'), 'err', 2800)
    } catch (e) {
      castStatus.textContent = t('更新失败：', 'Update failed: ') + (e && e.message ? e.message : String(e))
    } finally {
      setBusy(btnCastExtract, false)
    }
  }

  btnCastExtract.onclick = () => { doUpdateCharacterState().catch(() => {}) }
  btnCastAdd.onclick = () => {
    try {
      _castState.items = (Array.isArray(_castState.items) ? _castState.items.slice(0) : [])
      _castState.items.push({ name: '', status: '', plan: '', appear: true })
    } catch {
      _castState.items = [{ name: '', status: '', plan: '', appear: true }]
    }
    renderCastList()
  }
  btnCastClear.onclick = () => {
    _castState.items = []
    renderCastList()
  }
  renderCastList()
  refreshCharStateFromFile({ overwriteItems: true }).catch(() => {})

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
  agentLine.appendChild(document.createTextNode(t('Agent（Plan模式）', 'Agent (Plan)')))
  agentBox.appendChild(agentLine)

  const selAgentTarget = document.createElement('select')
  selAgentTarget.className = 'ain-in ain-select'
  selAgentTarget.style.width = '180px'
  ;[1000, 2000, 3000].forEach((n) => {
    const op = document.createElement('option')
    op.value = String(n)
    op.textContent = t('≈ ', '≈ ') + String(n) + t(' 字', ' chars') + (n === 3000 ? t('（上限）', ' (max)') : '')
    selAgentTarget.appendChild(op)
  })
  try {
    const v0 = parseInt(String(a0.targetChars || 3000), 10) || 3000
    selAgentTarget.value = String((v0 === 1000 || v0 === 2000 || v0 === 3000) ? v0 : 3000)
  } catch {}
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

  const modeLine = document.createElement('label')
  modeLine.style.display = 'flex'
  modeLine.style.gap = '8px'
  modeLine.style.alignItems = 'center'
  const selThinkingMode = document.createElement('select')
  selThinkingMode.className = 'ain-in ain-select'
  selThinkingMode.style.width = '260px'
  ;[
    { v: 'none', zh: '默认（普遍场景）', en: 'None (default)' },
    { v: 'normal', zh: '中等（加入质询）', en: 'Normal (inject checklist)' },
    { v: 'strong', zh: '加强（校对增强）', en: 'Strong (slower, steadier)' },
  ].forEach((it) => {
    const op = document.createElement('option')
    op.value = String(it.v)
    op.textContent = t(String(it.zh), String(it.en))
    selThinkingMode.appendChild(op)
  })
  try { selThinkingMode.value = String(a0.thinkingMode || 'none') } catch {}
  modeLine.appendChild(document.createTextNode(t('思考模式：', 'Mode: ')))
  modeLine.appendChild(selThinkingMode)
  agentBox.appendChild(modeLine)

  const planModelLine = document.createElement('label')
  planModelLine.style.display = 'flex'
  planModelLine.style.gap = '8px'
  planModelLine.style.alignItems = 'center'
  const inpPlanModel = document.createElement('input')
  inpPlanModel.className = 'ain-in'
  inpPlanModel.style.width = '260px'
  inpPlanModel.placeholder = t('可空：沿用 chat 模型', 'Optional: use chat model')
  try {
    const pu = (cfg && cfg.planUpstream && typeof cfg.planUpstream === 'object') ? cfg.planUpstream : {}
    inpPlanModel.value = safeText(pu && pu.model ? pu.model : '').trim()
  } catch {
    inpPlanModel.value = ''
  }
  planModelLine.appendChild(document.createTextNode(t('Plan 模型：', 'Plan model: ')))
  planModelLine.appendChild(inpPlanModel)
  agentBox.appendChild(planModelLine)

  function _choiceAgentSyncTargetOptions() {
    const max = _ainAgentMaxTargetCharsByMode(selThinkingMode.value)
    try {
      const opts = selAgentTarget.querySelectorAll('option')
      for (let i = 0; i < opts.length; i++) {
        const v = parseInt(String(opts[i].value || '0'), 10) || 0
        opts[i].disabled = v > max
      }
    } catch {}
    const cur = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
    const next = _ainAgentClampTargetCharsByMode(selThinkingMode.value, cur)
    if (next !== cur) {
      try { selAgentTarget.value = String(next) } catch {}
    }
  }
  selThinkingMode.onchange = () => { _choiceAgentSyncTargetOptions() }
  _choiceAgentSyncTargetOptions()

  const agentHint = document.createElement('div')
  agentHint.className = 'ain-muted'
  agentHint.textContent = t(
    '提示：Agent 会先生成 Plan，再逐项执行；字数是“目标值”不是硬上限：默认≈3000，中等≈2000，加强≈1000（越高越耗 token，甚至翻倍）。中等/加强对模型能力要求很高，慎用。',
    'Note: Agent generates a plan then executes step-by-step; targets (not hard caps): None≈3000, Normal≈2000, Strong≈1000 (higher costs more tokens, sometimes ~2x). Normal/Strong require a capable model.'
  )
  sec.appendChild(agentBox)
  sec.appendChild(agentHint)

  const row = mkBtnRow()
  const btnOptions = document.createElement('button')
  btnOptions.className = 'ain-btn'
  btnOptions.textContent = t('生成走向候选', 'Generate options')

  const btnInsertJson = document.createElement('button')
  btnInsertJson.className = 'ain-btn gray'
  btnInsertJson.textContent = t('插入候选 JSON 到文末', 'Insert JSON to doc')
  btnInsertJson.disabled = true

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'
  btnWrite.textContent = t('按选中走向续写', 'Write with selected')
  btnWrite.disabled = true

  const btnWriteDirect = document.createElement('button')
  btnWriteDirect.className = 'ain-btn gray'

  btnWriteDirect.textContent = t('直接按指令续写', 'Write directly')

  const btnAppend = document.createElement('button')
  btnAppend.className = 'ain-btn gray'

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

  const agentCtrlRow = mkBtnRow()
  agentCtrlRow.style.marginTop = '8px'
  const btnAgentAbort = document.createElement('button')
  btnAgentAbort.className = 'ain-btn gray'
  btnAgentAbort.textContent = t('终止本次任务', 'Abort task')
  btnAgentAbort.disabled = true
  const btnAgentRetry = document.createElement('button')
  btnAgentRetry.className = 'ain-btn gray'
  btnAgentRetry.textContent = t('重试', 'Retry')
  btnAgentRetry.style.display = 'none'
  const btnAgentSkip = document.createElement('button')
  btnAgentSkip.className = 'ain-btn gray'
  btnAgentSkip.textContent = t('跳过该步骤', 'Skip step')
  btnAgentSkip.style.display = 'none'
  agentCtrlRow.appendChild(btnAgentAbort)
  agentCtrlRow.appendChild(btnAgentRetry)
  agentCtrlRow.appendChild(btnAgentSkip)
  agentProgress.appendChild(agentCtrlRow)
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

  btnReview.textContent = t('审阅/修改草稿（对话）', 'Review/Edit draft (chat)')
  btnReview.disabled = true
  const btnPickDraft = document.createElement('button')
  btnPickDraft.className = 'ain-btn gray'
  btnPickDraft.textContent = t('选择草稿块…', 'Pick draft…')
  row2.appendChild(btnAppendDraft)
  row2.appendChild(btnReview)
  row2.appendChild(btnPickDraft)
  sec.appendChild(row2)

  body.appendChild(sec)

  let lastArr = null
  let selectedIdx = 0
  let lastText = ''
  let lastDraftId = ''
  let agentControl = null

  function _syncAgentCtrlUiPaused(meta) {
    btnAgentRetry.style.display = ''
    btnAgentSkip.style.display = (meta && meta.type === 'write') ? 'none' : ''
  }

  function _syncAgentCtrlUiRunning() {
    btnAgentRetry.style.display = 'none'
    btnAgentSkip.style.display = 'none'
  }

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

  btnAgentAbort.onclick = () => {
    try {
      if (!agentControl || typeof agentControl.abort !== 'function') return
      agentControl.abort()
      ctx.ui.notice(t('已发出终止请求', 'Abort requested'), 'ok', 1200)
    } catch {}
  }
  btnAgentRetry.onclick = () => {
    try {
      if (!agentControl || typeof agentControl.resume !== 'function') return
      agentControl.resume('retry')
    } catch {}
  }
  btnAgentSkip.onclick = () => {
    try {
      if (!agentControl || typeof agentControl.resume !== 'function') return
      agentControl.resume('skip')
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
    const base = safeText(extra.ta.value).trim()
    const more = safeText(buildCastConstraintsText()).trim()
    if (base && more) return base + '\n\n' + more
    return base || more
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
    const constraints = await mergeConstraintsWithCharState(ctx, cfg, localConstraints)

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
          const thinkingMode = _ainAgentNormThinkingMode(selThinkingMode.value) || 'none'
          const targetChars0 = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
          const targetChars = _ainAgentClampTargetCharsByMode(thinkingMode, targetChars0)
          if (targetChars !== targetChars0) {
            try { selAgentTarget.value = String(targetChars) } catch {}
          ctx.ui.notice(t('已按思考模式收紧字数目标：', 'Target adjusted by mode: ') + String(targetChars), 'ok', 1800)
          }
          const chunkCount = _ainAgentDeriveChunkCount(targetChars)
        const wantAudit = !!cbAudit.checked
        // 记住用户选择（但不强行改动“是否默认启用 Agent”）
        try {
          const curEnabled = !!(cfg && cfg.agent && cfg.agent.enabled)
          cfg = await saveCfg(ctx, {
            agent: { enabled: curEnabled, targetChars, thinkingMode, audit: wantAudit },
            planUpstream: { model: safeText(inpPlanModel && inpPlanModel.value ? inpPlanModel.value : '').trim() }
          })
        } catch {}
        try { agentProgress.style.display = '' } catch {}
        try { agentLog.textContent = t('Agent 执行中…', 'Agent running...') } catch {}

        try {
          if (agentControl && typeof agentControl.abort === 'function') agentControl.abort()
        } catch {}
        agentControl = _ainCreateAgentRunControl()
        agentControl.onEvent = (ev, meta) => {
          if (ev === 'paused') _syncAgentCtrlUiPaused(meta)
          else _syncAgentCtrlUiRunning()
          if (ev === 'abort') btnAgentAbort.disabled = true
        }
        btnAgentAbort.disabled = false
        _syncAgentCtrlUiRunning()

        out.textContent = t('Agent 执行中…（多轮）', 'Agent running... (multi-round)')
        const res = await agentRunPlan(ctx, cfg, {
          instruction,
          choice: chosen,
          constraints: constraints || '',
          prev,
          progress,
          bible,
          rag: rag || null,
          thinkingMode,
          targetChars,
          chunkCount,
          audit: wantAudit
        }, { render: renderAgentProgress, control: agentControl })

        const aborted = !!(agentControl && agentControl.aborted)
        lastText = safeText(res && res.text).trim()
        out.textContent = lastText || (aborted ? t('已终止（无输出）', 'Aborted (no output)') : '')
        btnAgentAbort.disabled = true
        _syncAgentCtrlUiRunning()
        agentControl = null

        if (aborted) {
          btnAppend.disabled = !lastText
          btnAppendDraft.disabled = !lastText
          ctx.ui.notice(t('Agent 已终止（未写入文档）', 'Agent aborted (not inserted)'), 'ok', 1800)
          return
        }

        if (!lastText) throw new Error(t('Agent 未返回正文', 'Agent returned empty text'))
        btnAppend.disabled = false
        btnAppendDraft.disabled = false
        ctx.ui.notice(t('Agent 已完成（未写入文档）', 'Agent done (not inserted)'), 'ok', 1800)
        return
      }

      const r = await apiFetchChatWithJob(ctx, cfg, {
        mode: 'novel',
        action: 'write',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          instruction: instruction,
          progress,
          bible,
          prev,
          choice: chosen,
          constraints: constraints || undefined,
          rag: rag || undefined,
          novel_style: 'iceberg'
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
          out.textContent = t('续写中…（最多等 3 分钟）已等待 ', 'Writing... (up to 3 minutes) waited ') + s + 's'
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
      try { btnAgentAbort.disabled = true } catch {}
      try { _syncAgentCtrlUiRunning() } catch {}
      agentControl = null
    }
  }

  async function doWriteDirect() {
    cfg = await loadCfg(ctx)
    const instruction = getInstructionText()
    const localConstraints = getLocalConstraintsText()
    const constraints = await mergeConstraintsWithCharState(ctx, cfg, localConstraints)
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
          const thinkingMode = _ainAgentNormThinkingMode(selThinkingMode.value) || 'none'
          const targetChars0 = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
          const targetChars = _ainAgentClampTargetCharsByMode(thinkingMode, targetChars0)
          if (targetChars !== targetChars0) {
            try { selAgentTarget.value = String(targetChars) } catch {}
          ctx.ui.notice(t('已按思考模式收紧字数目标：', 'Target adjusted by mode: ') + String(targetChars), 'ok', 1800)
          }
          const chunkCount = _ainAgentDeriveChunkCount(targetChars)
        const wantAudit = !!cbAudit.checked
        // 记住用户选择（但不强行改动“是否默认启用 Agent”）
        try {
          const curEnabled = !!(cfg && cfg.agent && cfg.agent.enabled)
          cfg = await saveCfg(ctx, {
            agent: { enabled: curEnabled, targetChars, thinkingMode, audit: wantAudit },
            planUpstream: { model: safeText(inpPlanModel && inpPlanModel.value ? inpPlanModel.value : '').trim() }
          })
        } catch {}
        try { agentProgress.style.display = '' } catch {}
        try { agentLog.textContent = t('Agent 执行中…', 'Agent running...') } catch {}

        try {
          if (agentControl && typeof agentControl.abort === 'function') agentControl.abort()
        } catch {}
        agentControl = _ainCreateAgentRunControl()
        agentControl.onEvent = (ev, meta) => {
          if (ev === 'paused') _syncAgentCtrlUiPaused(meta)
          else _syncAgentCtrlUiRunning()
          if (ev === 'abort') btnAgentAbort.disabled = true
        }
        btnAgentAbort.disabled = false
        _syncAgentCtrlUiRunning()

        out.textContent = t('Agent 执行中…（多轮，不走候选）', 'Agent running... (multi-round, no options)')
        const res = await agentRunPlan(ctx, cfg, {
          instruction,
          choice: makeDirectChoice(instruction),
          constraints: constraints || '',
          prev,
          progress,
          bible,
          rag: rag || null,
          thinkingMode,
          targetChars,
          chunkCount,
          audit: wantAudit
        }, { render: renderAgentProgress, control: agentControl })

        const aborted = !!(agentControl && agentControl.aborted)
        lastText = safeText(res && res.text).trim()
        out.textContent = lastText || (aborted ? t('已终止（无输出）', 'Aborted (no output)') : '')
        btnAgentAbort.disabled = true
        _syncAgentCtrlUiRunning()
        agentControl = null

        if (aborted) {
          btnAppend.disabled = !lastText
          btnAppendDraft.disabled = !lastText
          ctx.ui.notice(t('Agent 已终止（未写入文档）', 'Agent aborted (not inserted)'), 'ok', 1800)
          return
        }

        if (!lastText) throw new Error(t('Agent 未返回正文', 'Agent returned empty text'))
        btnAppend.disabled = false
        btnAppendDraft.disabled = false
        ctx.ui.notice(t('Agent 已完成（未写入文档）', 'Agent done (not inserted)'), 'ok', 1800)
        return
      }

      const r = await apiFetchChatWithJob(ctx, cfg, {
        mode: 'novel',
        action: 'write',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: {
          instruction: instruction,
          progress,
          bible,
          prev,
          choice: makeDirectChoice(instruction),
          constraints: constraints || undefined,
          rag: rag || undefined,
          novel_style: 'iceberg'
        }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
          out.textContent = t('续写中…（不走候选）已等待 ', 'Writing... (no options) waited ') + s + 's'
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
      try { btnAgentAbort.disabled = true } catch {}
      try { _syncAgentCtrlUiRunning() } catch {}
      agentControl = null
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

  btnPickDraft.onclick = async () => {
    try {
      await openDraftPickerDialog(ctx)
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
  const constraints = await mergeConstraintsWithCharState(ctx, cfg, constraintsOverride)

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

function _ainAgentNormThinkingMode(v) {
  const raw = safeText(v).trim()
  if (!raw) return ''
  const s = raw.toLowerCase()
  if (s === 'none' || s === 'off' || s === 'no' || s === '0') return 'none'
  if (s === 'normal' || s === 'std' || s === 'standard') return 'normal'
  if (s === 'strong' || s === 'hard' || s === 'st') return 'strong'
  // 兼容中文存储（极少数场景可能会有）
  if (raw === '不思考') return 'none'
  if (raw === '正常思考') return 'normal'
  if (raw === '强思考') return 'strong'
  return ''
}

function _ainAgentExtractChecklistFromConsult(text, maxChars) {
  const t0 = safeText(text).replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim()
  if (!t0) return ''

  // 参考“更新资料文件”的分节截断：让 AI 把“检查清单”和“需要补充”分开写，我们只取检查清单。
  const keys = [
    { k: 'checklist', names: ['写作检查清单', '检查清单', '写作蓝图', '蓝图', '修改建议', '建议', 'Checklist', 'Blueprint'] },
    { k: 'questions', names: ['需要你补充', '需要补充', '待补充', '待确认', '问题', 'Questions', 'Need your input'] },
  ]
  const out0 = { checklist: [], questions: [] }
  let cur = 'checklist'

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
        const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (head === `【${nm}】` || head === `[${nm}]`) {
          cur = it.k
          matched = true
          rest = ''
          break
        }
        let m1 = new RegExp(`^【${esc}】\\s*(.*)$`).exec(head)
        if (m1 && m1[1] != null) {
          cur = it.k
          matched = true
          rest = String(m1[1] || '').trim()
          break
        }
        let m2 = new RegExp(`^\\[${esc}\\]\\s*(.*)$`).exec(head)
        if (m2 && m2[1] != null) {
          cur = it.k
          matched = true
          rest = String(m2[1] || '').trim()
          break
        }
        let m3 = new RegExp(`^${esc}\\s*[:：]\\s*(.*)$`).exec(head)
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

  let s = safeText(out0.checklist.join('\n')).trim()
  if (!s) {
    // 兜底：没分节时，用粗暴截断，把“需要你补充”之后丢掉。
    s = t0
    const cutMarks = ['【需要你补充】', '【需要补充】', '【待补充】', '【待确认】', '【问题】']
    for (let i = 0; i < cutMarks.length; i++) {
      const at = s.indexOf(cutMarks[i])
      if (at >= 0) {
        s = s.slice(0, at).trim()
        break
      }
    }
  }
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  if (!s) return ''

  const m = Math.max(200, (maxChars | 0) || 900)
  if (s.length <= m) return s
  // 尽量在句号/换行处截断
  const min = Math.max(0, m - 120)
  for (let i = m; i > min; i--) {
    const ch = s[i - 1]
    if (_ainDiffIsBreakChar(ch)) return s.slice(0, i).trimEnd()
  }
  return s.slice(0, m).trimEnd()
}

function _ainAgentNormTargetChars(v, fallback) {
  // 只保留 1k/2k/3k（历史上的 4k 统一压到 3k）
  const n = parseInt(String(v == null ? '' : v), 10)
  if (n === 1000 || n === 2000 || n === 3000) return n
  if (n === 4000) return 3000
  const fb = parseInt(String(fallback == null ? '' : fallback), 10)
  return (fb === 1000 || fb === 2000 || fb === 3000) ? fb : 3000
}

function _ainAgentMaxTargetCharsByMode(thinkingMode) {
  const m = _ainAgentNormThinkingMode(thinkingMode) || 'none'
  if (m === 'strong') return 1000
  if (m === 'normal') return 2000
  return 3000
}

function _ainAgentClampTargetCharsByMode(thinkingMode, targetChars) {
  const n = _ainAgentNormTargetChars(targetChars, 3000)
  const max = _ainAgentMaxTargetCharsByMode(thinkingMode)
  return Math.min(n, max)
}

function _ainAgentGetCfg(cfg) {
  const a = (cfg && cfg.agent && typeof cfg.agent === 'object') ? cfg.agent : {}

  // 新配置：targetChars；旧配置：chunkCount（做个粗暴映射，避免“升级后全变默认值”）
  let targetChars = _ainAgentNormTargetChars(a.targetChars != null ? a.targetChars : (a.target_chars != null ? a.target_chars : null), 3000)
  if (!(a.targetChars != null || a.target_chars != null) && a.chunkCount != null) {
    const c = parseInt(String(a.chunkCount), 10)
    if (Number.isFinite(c)) {
      if (c <= 1) targetChars = 1000
      else if (c === 2) targetChars = 2000
      else if (c === 3) targetChars = 3000
      else targetChars = 3000
    }
  }

  // 新配置：thinkingMode；旧配置：strongThinking（映射为 strong）
  let thinkingMode =
    _ainAgentNormThinkingMode(a.thinkingMode != null ? a.thinkingMode : (a.thinking_mode != null ? a.thinking_mode : '')) ||
    (a.strongThinking || a.strong_thinking ? 'strong' : 'none')
  if (!(thinkingMode === 'none' || thinkingMode === 'normal' || thinkingMode === 'strong')) thinkingMode = 'none'

  // 按思考模式收紧目标（避免“强思考还选 3000”导致成本爆炸）
  targetChars = _ainAgentClampTargetCharsByMode(thinkingMode, targetChars)

  return {
    enabled: !!a.enabled,
    targetChars: targetChars,
    thinkingMode: thinkingMode,
    // 兼容旧字段：外部若还在读 strongThinking，不会直接炸
    strongThinking: thinkingMode === 'strong',
    audit: !!a.audit,
  }
}

function _ainAgentDeriveChunkCount(targetChars) {
  const t = _ainAgentNormTargetChars(targetChars, 3000)
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
  const typeRaw0 = safeText(it.type || it.kind || it.t || '').trim().toLowerCase()
  const typeRaw = typeRaw0
    .replace(/^step[-_\s]*/, '')
    .replace(/^todo[-_\s]*/, '')
    .replace(/^task[-_\s]*/, '')
  const allow = { rag: 1, consult: 1, write: 1, audit: 1, final: 1, note: 1 }
  let type = allow[typeRaw] ? typeRaw : ''
  if (!type) {
    // 容错：一些模型会输出同义词/中文/带序号的 type
    if (typeRaw === 'search' || typeRaw === 'retrieve' || typeRaw === 'retrieval' || typeRaw === 'lookup') type = 'rag'
    else if (typeRaw === 'plan' || typeRaw === 'blueprint' || typeRaw === 'outline') type = 'consult'
    else if (typeRaw === 'writing' || typeRaw === 'compose' || typeRaw === 'prose' || typeRaw === 'draft') type = 'write'
    else if (typeRaw === 'review' || typeRaw === 'check' || typeRaw === 'verify') type = 'audit'
    else if (typeRaw === 'deliver' || typeRaw === 'delivery') type = 'final'
  }
  if (!type) {
    // 进一步从标题推断（Plan 模型最常在 type 字段上犯蠢）
    const ti = title.toLowerCase()
    if (/rag|检索|搜索|查找|补充检索|retriev|search|lookup/.test(ti)) type = 'rag'
    else if (/consult|蓝图|大纲|写作蓝图|检查清单|建议|咨询|plan|outline|blueprint/.test(ti)) type = 'consult'
    else if (/write|写作|正文|分段写作|续写|prose|draft/.test(ti)) type = 'write'
    else if (/audit|审计|一致性|风险审计|校对|核对|review/.test(ti)) type = 'audit'
    else if (/final|交付|总结|下一步|deliver/.test(ti)) type = 'final'
    else type = 'note'
  }
  const instruction = safeText(it.instruction || it.prompt || it.task || '').trim()
  const ragQuery = safeText(it.rag_query || it.ragQuery || it.query || '').trim()
  return { id, title, type, instruction, rag_query: ragQuery, status: 'pending', error: '' }
}

function buildFallbackAgentPlan(baseInstruction, targetChars, chunkCount, wantAudit) {
  const ins = safeText(baseInstruction).trim()
  const totalChars = _ainAgentNormTargetChars(targetChars, 3000)
  const n = _clampInt(chunkCount != null ? chunkCount : _ainAgentDeriveChunkCount(totalChars), 1, 3)
  const perChunk = Math.max(600, Math.floor(totalChars / n))
  const plan = []
  plan.push({
    id: 'blueprint',
    title: t('写作蓝图', 'Blueprint'),
    type: 'consult',
    instruction: ins
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
      instruction: ins
    })
  }
  if (wantAudit) {
    plan.push({
      id: 'audit',
      title: t('一致性审计', 'Audit'),
      type: 'audit',
      instruction: ''
    })
  }
  plan.push({
    id: 'final',
    title: t('交付', 'Deliver'),
    type: 'final',
    instruction: ''
  })
  return plan.map((x, i) => _ainAgentNormalizePlanItem(x, i))
}

function _ainAgentCoercePlanToExecutable(aiItems, baseInstruction, targetChars, chunkCount, wantAudit) {
  // 目标：尽量保留 Plan 模型给出的计划（多 consult/rag/audit 往往是“质量”本体），只修结构让它必定可执行。
  // 之前那种“拿模型内容去覆盖 5 步模板”的做法，用户看起来就是“全在走兜底”，观感与实际都很差。
  const basePlan = buildFallbackAgentPlan(baseInstruction, targetChars, chunkCount, wantAudit)
  const ai0 = Array.isArray(aiItems) ? aiItems : []
  const ai = ai0.map((x, i) => ({ ..._ainAgentNormalizePlanItem(x, i), __idx: i }))
  if (!ai.length) return basePlan

  function byType(kind) {
    return ai.filter((x) => x && x.type === kind).sort((a, b) => (a.__idx | 0) - (b.__idx | 0))
  }

  const rags = byType('rag')
  const consults = byType('consult')
  const writes = byType('write')
  const audits = byType('audit')
  const finals = byType('final')

  const wantWrites = _clampInt(chunkCount, 1, 3)
  const out = []

  // 1) rag：最多 2 个，避免预算爆炸；没有就用兜底 rag。
  const takeRags = rags.slice(0, 2)
  if (takeRags.length) out.push(...takeRags.map(({ __idx, ...x }) => x))
  else {
    const fbRag = basePlan.find((x) => x && x.type === 'rag')
    if (fbRag) out.push({ ...fbRag })
  }

  // 2) consult：必须至少 1 个；尽量保留模型给的（最多 4 个）。
  if (consults.length) out.push(...consults.slice(0, 4).map(({ __idx, ...x }) => x))
  else {
    const fbConsult = basePlan.find((x) => x && x.type === 'consult')
    if (fbConsult) out.push({ ...fbConsult })
  }

  // 3) write：必须恰好 wantWrites 个；多了裁掉，少了用兜底补齐。
  const takeWrites = writes.slice(0, wantWrites).map(({ __idx, ...x }) => ({ ...x }))
  if (takeWrites.length < wantWrites) {
    const fbWrites = basePlan.filter((x) => x && x.type === 'write')
    for (let i = takeWrites.length; i < wantWrites; i++) {
      const fb = fbWrites[i] || fbWrites[fbWrites.length - 1]
      if (fb) takeWrites.push({ ...fb })
    }
  }
  out.push(...takeWrites)

  // 4) audit：用户开启才保留；只保留 1 个（runtime 会把 audit 放到写作之后）。
  if (wantAudit) {
    const a0 = (audits[0] ? audits[0] : null)
    const a = a0 ? (({ __idx, ...x }) => x)(a0) : (basePlan.find((x) => x && x.type === 'audit') || null)
    if (a) out.push({ ...a })
  }

  // 5) final：必须最后 1 个；没有就用兜底 final。
  const f0 = (finals[0] ? finals[0] : null)
  const fin = f0 ? (({ __idx, ...x }) => x)(f0) : (basePlan.find((x) => x && x.type === 'final') || null)
  if (fin) out.push({ ...fin })

  return out.map((x, i) => _ainAgentNormalizePlanItem(x, i))
}

function _ainAgentValidatePlan(items, chunkCount, wantAudit) {
  const arr = Array.isArray(items) ? items : []
  const w = arr.filter((x) => x && x.type === 'write').length
  const hasConsult = arr.some((x) => x && x.type === 'consult')
  const hasFinal = arr.some((x) => x && x.type === 'final')
  if (!hasConsult || !hasFinal) return false
  // 保证 consult 在首次 write 之前：否则“正常/强思考”的检查清单注入就失效。
  const idxC = arr.findIndex((x) => x && x.type === 'consult')
  const idxW = arr.findIndex((x) => x && x.type === 'write')
  if (idxC < 0 || idxW < 0 || idxC > idxW) return false
  if (w !== _clampInt(chunkCount, 1, 3)) return false
  if (wantAudit && !arr.some((x) => x && x.type === 'audit')) return false
  return true
}

function _ainAgentNormalizePlanRuntime(items, wantAudit) {
  let arr = Array.isArray(items) ? items.slice(0) : []

  // 用户没开“审计”就别自作主张塞 audit：这会浪费时间/预算，还制造“正文为空→跳过审计”的垃圾分支。
  if (!wantAudit) {
    arr = arr.filter((x) => !(x && x.type === 'audit'))
  }

  // 即使用户开了审计，也必须放在最后一段写作之后：否则审计对象为空，纯属自嗨。
  const audits = arr.filter((x) => x && x.type === 'audit')
  if (audits.length) {
    const rest = arr.filter((x) => !(x && x.type === 'audit'))
    let lastWrite = -1
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i] && rest[i].type === 'write') { lastWrite = i; break }
    }
    const insertAt = lastWrite >= 0 ? (lastWrite + 1) : rest.length
    rest.splice(insertAt, 0, ...audits)
    arr = rest
  }

  return arr
}

async function agentBuildPlan(ctx, cfg, base) {
  let targetChars = _ainAgentNormTargetChars(base && base.targetChars != null ? base.targetChars : null, 3000)
  const chunkCount = _clampInt(base && base.chunkCount != null ? base.chunkCount : _ainAgentDeriveChunkCount(targetChars), 1, 3)
  const wantAudit = !!(base && base.audit)
  const thinkingMode =
    _ainAgentNormThinkingMode(base && base.thinkingMode) ||
    (base && base.strongThinking ? 'strong' : 'none')
  targetChars = _ainAgentClampTargetCharsByMode(thinkingMode, targetChars)
  const strongThinking = thinkingMode === 'strong'

  try {
    const planModel = safeText(cfg && cfg.upstream && cfg.upstream.planModel).trim()
    const pu = (cfg && cfg.planUpstream && typeof cfg.planUpstream === 'object') ? cfg.planUpstream : {}
    const model =
      safeText(pu.model).trim() ||
      planModel ||
      (cfg && cfg.upstream ? cfg.upstream.model : '')
    const baseUrl =
      safeText(pu.baseUrl).trim() ||
      (cfg && cfg.upstream ? cfg.upstream.baseUrl : '')
    const apiKey =
      safeText(pu.apiKey).trim() ||
      (cfg && cfg.upstream ? cfg.upstream.apiKey : '')

    const baseConstraints = safeText(base && base.constraints).trim()
    const hasPlanOverride = !!(safeText(pu.model).trim() || safeText(pu.baseUrl).trim() || safeText(pu.apiKey).trim() || planModel)
    const constraints = baseConstraints
    const resp = await apiFetch(ctx, cfg, 'ai/proxy/chat/', {
      mode: 'novel',
      action: 'plan',
      upstream: {
        baseUrl,
        apiKey,
        model
      },
      input: {
        instruction: safeText(base && base.instruction).trim(),
        progress: safeText(base && base.progress),
        bible: base && base.bible != null ? base.bible : '',
        prev: safeText(base && base.prev),
        choice: base && base.choice != null ? base.choice : undefined,
        constraints: constraints || undefined,
        rag: base && base.rag ? base.rag : undefined,
        plan_strict: hasPlanOverride,
        agent: { chunk_count: chunkCount, target_chars: targetChars, include_audit: wantAudit, strong_thinking: strongThinking, thinking_mode: thinkingMode }
      }
    })
    let raw = Array.isArray(resp && resp.data) ? resp.data : null
    if (!raw && resp && resp.text) raw = tryParseAgentPlanDataFromText(resp.text)
    const norm = Array.isArray(raw) ? raw.map((x, i) => _ainAgentNormalizePlanItem(x, i)) : null
    if (norm && _ainAgentValidatePlan(norm, chunkCount, wantAudit)) {
      try {
        norm.__ain_plan_src = 'ai'
        norm.__ain_plan_info = `model=${model}; items=${norm.length}; writes=${norm.filter((x) => x && x.type === 'write').length}`
      } catch {}
      return norm
    }
    if (norm && norm.length) {
      // Plan 模型输出不合格：尽量修复成可执行计划，而不是直接废掉。
      const fixed = _ainAgentCoercePlanToExecutable(norm, base && base.instruction, targetChars, chunkCount, wantAudit)
      try {
        fixed.__ain_plan_src = 'fixed'
        fixed.__ain_plan_info = `model=${model}; raw_items=${norm.length}; fixed_items=${fixed.length}; fixed_writes=${fixed.filter((x) => x && x.type === 'write').length}`
      } catch {}
      return fixed
    }
  } catch (e) {
    if (!isActionNotSupportedError(e)) throw e
  }

  // 旧后端不支持 plan：用本地兜底计划
  const fb = buildFallbackAgentPlan(base && base.instruction, targetChars, chunkCount, wantAudit)
  try {
    fb.__ain_plan_src = 'fallback'
    fb.__ain_plan_info = `items=${fb.length}; writes=${fb.filter((x) => x && x.type === 'write').length}`
  } catch {}
  return fb
}

function _ainCreateAgentRunControl() {
  const c = {
    aborted: false,
    paused: null,
    _resolve: null,
    onEvent: null,
    abort: null,
    wait: null,
    resume: null,
  }

  c.abort = () => {
    c.aborted = true
    if (typeof c.onEvent === 'function') {
      try { c.onEvent('abort', {}) } catch {}
    }
    if (c._resolve) {
      const r = c._resolve
      c._resolve = null
      try { r('abort') } catch {}
    }
  }

  c.wait = async (meta) => {
    if (c.aborted) return 'abort'
    c.paused = meta && typeof meta === 'object' ? meta : {}
    if (typeof c.onEvent === 'function') {
      try { c.onEvent('paused', c.paused) } catch {}
    }
    return await new Promise((resolve) => {
      c._resolve = (action) => {
        c._resolve = null
        c.paused = null
        if (typeof c.onEvent === 'function') {
          try { c.onEvent('resume', { action: safeText(action) }) } catch {}
        }
        resolve(safeText(action) || 'retry')
      }
    })
  }

  c.resume = (action) => {
    if (!c._resolve) return
    try { c._resolve(safeText(action) || 'retry') } catch {}
  }

  return c
}

async function agentRunPlan(ctx, cfg, base, ui) {
  const render = ui && typeof ui.render === 'function' ? ui.render : null
  const logBox = ui && typeof ui.log === 'function' ? ui.log : null
  const control = ui && ui.control && typeof ui.control === 'object' ? ui.control : null

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

  const thinkingMode =
    _ainAgentNormThinkingMode(base && base.thinkingMode) ||
    (base && base.strongThinking ? 'strong' : 'none')
  const targetChars = _ainAgentClampTargetCharsByMode(thinkingMode, base && base.targetChars != null ? base.targetChars : null)
  const chunkCount = _clampInt(base && base.chunkCount != null ? base.chunkCount : _ainAgentDeriveChunkCount(targetChars), 1, 3)
  const wantAudit = !!(base && base.audit)
  const strongThinking = thinkingMode === 'strong'
  const injectChecklist = thinkingMode === 'normal' || thinkingMode === 'strong'

  let items = await agentBuildPlan(ctx, cfg, { ...base, targetChars, chunkCount, audit: wantAudit })
  if (!Array.isArray(items) || !items.length) items = buildFallbackAgentPlan(base && base.instruction, targetChars, chunkCount, wantAudit)
  try {
    const src = items && items.__ain_plan_src ? String(items.__ain_plan_src) : ''
    const info = items && items.__ain_plan_info ? String(items.__ain_plan_info) : ''
    if (src) pushLog(t('计划来源：', 'Plan source: ') + src + (info ? (' (' + info + ')') : ''))
  } catch {}
  items = _ainAgentNormalizePlanRuntime(items, wantAudit)

  // 强思考模式：每段写作前都插入一个 rag（刷新命中片段，更稳但更慢）
  if (strongThinking) {
    const writeTotal = items.filter((x) => x && x.type === 'write').length || chunkCount
    const expanded = []
    let segNo = 0
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it && it.type === 'write') {
        segNo++
        const prev = expanded.length ? expanded[expanded.length - 1] : null
        if (!(prev && prev.type === 'rag')) {
          const baseQ = safeText(base && base.instruction).trim()
          const q = [
            baseQ || t('检索相关设定/人物/伏笔', 'Retrieve related canon/characters/foreshadowing'),
            `强思考：写第 ${segNo}/${writeTotal} 段前，检索相关设定/人物当前状态/伏笔/时间线冲突。`
          ].filter(Boolean).join('\n')
          expanded.push({
            id: 'st-rag-' + String(segNo),
            title: t('强思考检索 ', 'Strong RAG ') + String(segNo) + '/' + String(writeTotal),
            type: 'rag',
            instruction: '',
            rag_query: q,
            status: 'pending',
            error: ''
          })
        }
      }
      expanded.push(it)
    }
    items = expanded
  }

  if (render) {
    try { render(items, logs) } catch {}
  }

  let rag = base && base.rag ? base.rag : null
  let draft = ''
  let auditText = ''
  let consultChecklist = ''
  const writeTotal = items.filter((x) => x && x.type === 'write').length || chunkCount
  let writeNo = 0

  // Agent 分段续写的“低风险兜底”：尽量只消掉“重复拼接”这类明显错误，别自作主张改正文内容。
  function _ainNormWs(s) {
    return safeText(s).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  function _ainFindOverlapSuffixPrefix(a, b, opt) {
    const aa = _ainNormWs(a)
    const bb = _ainNormWs(b)
    if (!aa || !bb) return 0
    const maxLen = Math.max(0, (opt && opt.maxLen != null ? opt.maxLen : 1200) | 0)
    const minLen = Math.max(0, (opt && opt.minLen != null ? opt.minLen : 160) | 0)
    const max = Math.min(maxLen, aa.length, bb.length)
    for (let len = max; len >= minLen; len--) {
      if (aa.slice(aa.length - len) === bb.slice(0, len)) return len
    }
    return 0
  }

  function _ainMergeAgentSegment(curDraft, piece, hintPrev, segNo) {
    const d0 = safeText(curDraft).trim()
    let p0 = safeText(piece).trim()
    if (!p0) return { draft: d0, piece: '', merged: d0, mode: 'empty' }
    if (!d0) return { draft: p0, piece: p0, merged: p0, mode: 'init' }

    // 1) 完全重复：直接忽略（避免双份）
    if (p0 === d0) return { draft: d0, piece: '', merged: d0, mode: 'dup_all' }
    if (d0.includes(p0) && p0.length >= 500) return { draft: d0, piece: '', merged: d0, mode: 'dup_in_draft' }
    if (p0.includes(d0) && d0.length >= 500) return { draft: p0, piece: p0, merged: p0, mode: 'rewrite_full' }

    // 2) 常见：段首复述上一段结尾（严格重叠才裁剪，避免误伤）
    // 只在第 2 段及之后启用；第 1 段允许自然承接，但也不该回顾前文。
    if ((segNo | 0) > 1) {
      const prevHint = safeText(hintPrev).trim()
      const overlap = _ainFindOverlapSuffixPrefix(prevHint || d0, p0, { maxLen: 1200, minLen: 160 })
      if (overlap > 0) {
        const pn = _ainNormWs(p0)
        const cut = pn.slice(0, overlap)
        const idx = _ainNormWs(p0).indexOf(cut)
        // idx 理论上总是 0；这里写得更保守一点，避免归一化导致错位
        if (idx === 0) {
          // 用“归一化后的裁剪长度”去裁原文会不精确；所以直接按原文前缀近似裁剪：取同长度的原文前缀丢掉。
          p0 = p0.slice(Math.min(p0.length, cut.length)).trimStart()
          if (!p0) return { draft: d0, piece: '', merged: d0, mode: 'trim_to_empty' }
          const merged = d0.trimEnd() + '\n\n' + p0
          return { draft: merged, piece: p0, merged, mode: 'trim_overlap' }
        }
      }
    }

    const merged = d0.trimEnd() + '\n\n' + p0
    return { draft: merged, piece: p0, merged, mode: 'append' }
  }

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
    if (control && control.aborted) {
      pushLog(t('已终止本次任务', 'Task aborted'))
      break
    }
    it.status = 'running'
    it.error = ''
    if (render) {
      try { render(items, logs) } catch {}
    }

    const started = Date.now()
    try {
      if (it.type === 'rag') {
        // 强思考插入的 rag：如果已经达到字数目标就别再浪费时间检索了
        if (strongThinking && /^st-rag-/.test(String(it.id || '')) && draft.trim().length >= targetChars) {
          it.status = 'skipped'
          pushLog(t('跳过强思考检索：已达到字数目标', 'Skip strong RAG: target reached'))
          continue
        }
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
        const baseQ = safeText(it.instruction).trim()
        pushLog(t('咨询：', 'Consult: ') + (baseQ ? baseQ.split(/\r?\n/)[0].slice(0, 80) : t('写作检查清单', 'Checklist')))
        const resp = await apiFetchConsultWithJob(ctx, cfg, {
          upstream: {
            baseUrl: cfg.upstream.baseUrl,
            apiKey: cfg.upstream.apiKey,
            model: cfg.upstream.model
          },
          input: {
            async: true,
            mode: 'job',
            task: 'agent_checklist',
            instruction: baseQ,
            progress: safeText(base && base.progress),
            bible: base && base.bible != null ? base.bible : '',
            prev: curPrev(),
            constraints: safeText(base && base.constraints).trim(),
            rag: rag || undefined
          }
        }, {
          control,
          onTick: ({ waitMs }) => {
            const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
            if (render) {
              try { render(items, logs.concat([t('咨询中… 已等待 ', 'Consulting... waited ') + s + 's'])) } catch {}
            }
          }
        })
        const txt = safeText(resp && resp.text).trim()
        if (txt) pushLog(txt.replace(/\n{3,}/g, '\n\n').slice(0, 1800) + (txt.length > 1800 ? '\n…' : ''))
        if (injectChecklist && txt) {
          consultChecklist = _ainAgentExtractChecklistFromConsult(txt, 900)
          if (consultChecklist) {
            pushLog(t('已提炼写作检查清单：', 'Checklist extracted: ') + String(consultChecklist.length) + t(' 字（将注入后续写作）', ' chars (will be injected)'))
          } else {
            pushLog(t('未提炼到检查清单：后续写作将不注入（请检查后端 agent_checklist 输出格式）', 'No checklist extracted: will not inject (check backend agent_checklist output format)'))
          }
        }
        it.status = 'done'
      } else if (it.type === 'write') {
        writeNo++
        const instruction = safeText(it.instruction).trim() || safeText(base && base.instruction).trim()
        if (!instruction) throw new Error(t('instruction 为空', 'Empty instruction'))
        const prevFull = curPrev()
        // 分段续写：只喂“尾巴”，减少模型回头重写的诱因；同时把分段信息传给后端做增量约束（不影响非 Agent）。
        const prev = writeNo > 1 ? sliceTail(prevFull, 2400) : prevFull
        const progress = safeText(base && base.progress)
        const bible = base && base.bible != null ? base.bible : ''
        const constraints = safeText(base && base.constraints).trim()

        const curLen = draft.trim().length
        const rest = targetChars - curLen
        const perChunk = Math.max(600, Math.floor(targetChars / chunkCount))
        const wantLen = rest > 0
          ? Math.max(300, Math.min(perChunk, rest))
          : Math.max(200, Math.min(perChunk, Math.floor(perChunk * 0.5)))
        const r = await apiFetchChatWithJob(ctx, cfg, {
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
            choice: base && base.choice != null ? base.choice : undefined,
            constraints: constraints || undefined,
            rag: rag || undefined,
            // 可选字段：仅用于 Agent 分段续写的增量约束/去重兜底；不影响旧后端/非 Agent。
            novel_style: 'iceberg',
            agent: {
              segmented: true,
              seg_no: writeNo,
              seg_total: writeTotal,
              prev_tail_chars: prev.length,
              chunk_count: chunkCount,
              target_chars: targetChars,
              want_len: wantLen,
              checklist: (injectChecklist && consultChecklist) ? consultChecklist : ''
            }
          }
        }, {
          control,
          onTick: ({ waitMs }) => {
            const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
            if (render) {
              try { render(items, logs.concat([t('写作中… 已等待 ', 'Writing... waited ') + s + 's'])) } catch {}
            }
          }
        })
        const pieceRaw = safeText(r && r.text).trim()
        if (!pieceRaw) throw new Error(t('后端未返回正文', 'Backend returned empty text'))
        const m = _ainMergeAgentSegment(draft, pieceRaw, prevFull, writeNo)
        const piece = m && m.piece != null ? safeText(m.piece).trim() : ''
        if (!piece) {
          it.status = 'skipped'
          pushLog(t('写作返回重复内容：已忽略（继续下一步）', 'Write returned duplicate: ignored (continue)'))
        } else {
          draft = m && m.draft != null ? safeText(m.draft).trim() : (draft ? (draft.trimEnd() + '\n\n' + piece) : piece)
          it.status = 'done'
          pushLog(t('写作完成：', 'Written: ') + (m && m.mode ? ('[' + String(m.mode) + '] ') : '') + String(piece.length) + t(' 字符', ' chars'))
        }
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
            control,
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

      if (control && control.aborted) {
        it.status = 'skipped'
        it.error = ''
        pushLog(t('已终止本次任务', 'Task aborted'))
        break
      }

      if (control && typeof control.wait === 'function') {
        pushLog(t('已暂停：请在界面选择“重试/跳过/终止”。', 'Paused: choose retry/skip/abort in UI.'))
        const action = safeText(await control.wait({
          index: i,
          type: safeText(it.type),
          title: safeText(it.title),
          error: msg
        })).trim().toLowerCase()

        if (action === 'retry' || action === 'replay' || action === 'again') {
          it.status = 'pending'
          it.error = ''
          pushLog(t('用户选择：重试该步骤', 'User chose: retry this step'))
          i--
          continue
        }

        if (action === 'skip' && it.type !== 'write') {
          it.status = 'skipped'
          it.error = ''
          pushLog(t('用户选择：跳过该步骤', 'User chose: skip this step'))
          continue
        }

        pushLog(t('用户选择：终止本次任务', 'User chose: abort task'))
        it.status = 'skipped'
        it.error = ''
        break
      }

      // 兼容旧行为：写作类出错就直接停；其它步骤尽量不中断
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

async function mergeConstraintsWithCharState(ctx, cfg, localConstraints) {
  const base = mergeConstraints(cfg, localConstraints)
  try {
    const cs = await getCharStateConstraintsText(ctx, cfg)
    if (!cs) return base
    // 用户手动写了【人物状态】就别重复注入
    if (base && /【人物状态/u.test(base)) return base
    if (base) return base + '\n\n' + cs
    return cs
  } catch {
    return base
  }
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

function listDraftBlocksInDoc(docText) {
  const doc = safeText(docText).replace(/\r\n/g, '\n')
  const re = /<!--\s*AINOVEL:DRAFT:BEGIN\s+id=([^\s]+)\s*-->/g
  const out = []
  let m = null
  while ((m = re.exec(doc)) !== null) {
    const id = m && m[1] ? String(m[1]).trim() : ''
    if (!id) continue
    const i0 = m.index
    const a = m[0]
    const b = draftEndMarker(id)
    const i1 = doc.indexOf(b, i0 + a.length)
    if (i1 < 0) continue
    const end = i1 + b.length
    const contentStart = i0 + a.length
    const contentEnd = i1
    const text = doc.slice(contentStart, contentEnd).replace(/^\s*\n/, '').replace(/\n\s*$/, '').trim()
    out.push({ id, i0, end, contentStart, contentEnd, text })
  }
  return out
}

function _ainDraftMetaFromId(id) {
  const bid = String(id || '').trim()
  const m = /^(\d{13})-/.exec(bid)
  if (!m) return ''
  const ts = parseInt(String(m[1] || ''), 10)
  if (!Number.isFinite(ts) || ts <= 0) return ''
  try {
    const d = new Date(ts)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return ''
  }
}

function _ainDraftLabelFromText(text, id) {
  const s = safeText(text).replace(/\r\n/g, '\n').trim()
  const first = s.split('\n').map((x) => String(x || '').trim()).filter(Boolean)[0] || ''
  const meta = _ainDraftMetaFromId(id)
  let title = first || s.replace(/\s+/g, ' ').slice(0, 60)
  if (!title) title = t('空草稿', 'Empty draft')
  if (title.length > 80) title = title.slice(0, 80) + '…'
  return meta ? (meta + ' / ' + title) : title
}

function removeDraftBlockFromDoc(docText, id) {
  const doc = safeText(docText).replace(/\r\n/g, '\n')
  const bid = String(id || '').trim()
  if (!bid) return null
  const r = findDraftBlockRange(doc, bid)
  if (!r) return null

  const start = Math.max(0, r.i0 | 0)
  const end = Math.max(start, ((r.i1 | 0) + String(r.b || '').length))
  let before = doc.slice(0, start)
  let after = doc.slice(end)

  const bt = (/\n+$/.exec(before) || [''])[0].length
  const al = (/^\n+/.exec(after) || [''])[0].length

  if (bt && al) {
    before = before.replace(/\n+$/, '')
    after = after.replace(/^\n+/, '')
    return before + '\n\n' + after
  }
  if (bt > 2) before = before.replace(/\n+$/, '\n\n')
  if (al > 2) after = after.replace(/^\n+/, '\n\n')
  return before + after
}

function unwrapDraftBlockFromDoc(docText, id) {
  // 只删除草稿标签，保留正文（把草稿块变成普通正文）
  const doc = safeText(docText).replace(/\r\n/g, '\n')
  const bid = String(id || '').trim()
  if (!bid) return null
  const r = findDraftBlockRange(doc, bid)
  if (!r) return null

  const start = Math.max(0, r.i0 | 0)
  const end = Math.max(start, ((r.i1 | 0) + String(r.b || '').length))
  const txt = extractDraftBlockText(doc, bid)
  const mid = '\n' + safeText(txt).trim() + '\n'

  let before = doc.slice(0, start)
  let after = doc.slice(end)

  // 尽量把“删标签”变成自然的段落拼接，别留下奇怪的多行空白
  const bt = (/\n+$/.exec(before) || [''])[0].length
  const al = (/^\n+/.exec(after) || [''])[0].length
  if (bt && al) {
    before = before.replace(/\n+$/, '')
    after = after.replace(/^\n+/, '')
    return before + '\n\n' + safeText(txt).trim() + '\n\n' + after
  }
  if (bt > 2) before = before.replace(/\n+$/, '\n\n')
  if (al > 2) after = after.replace(/^\n+/, '\n\n')
  return before + mid + after
}

function _ainArmDangerButton(btn, armText, opt) {
  // 两次点击确认（不依赖 confirm，避免某些宿主环境 confirm 不弹窗导致误删）
  const b = btn
  if (!b) return false
  const ms = Math.max(1500, (opt && opt.ms != null ? (opt.ms | 0) : 4500))
  const now = Date.now()
  const armedUntil = b.__ainArmedUntil ? Number(b.__ainArmedUntil) : 0
  if (Number.isFinite(armedUntil) && armedUntil > now) {
    b.__ainArmedUntil = 0
    try { b.textContent = b.__ainArmedText0 || String(b.textContent || '') } catch {}
    return true
  }
  b.__ainArmedText0 = String(b.textContent || '')
  b.__ainArmedUntil = now + ms
  try { b.textContent = String(armText || '') || b.__ainArmedText0 } catch {}
  try {
    setTimeout(() => {
      try {
        const until = b.__ainArmedUntil ? Number(b.__ainArmedUntil) : 0
        if (!until) return
        if (Date.now() >= until) {
          b.__ainArmedUntil = 0
          b.textContent = b.__ainArmedText0 || b.textContent
        }
      } catch {}
    }, ms + 50)
  } catch {}
  return false
}

async function clearLastDraftInfoIfMatch(ctx, blockId) {
  try {
    const last = await loadLastDraftInfo(ctx)
    const bid = String(blockId || '').trim()
    if (!last || !bid) return
    if (String(last.blockId || '').trim() !== bid) return
    if (ctx && ctx.storage && typeof ctx.storage.set === 'function') {
      await ctx.storage.set(DRAFT_KEY, { blockId: '', projectRel: '', ts: 0 })
    }
  } catch {}
}

async function openDraftPickerDialog(ctx) {
  const { body } = createDialogShell(t('选择草稿块', 'Pick draft block'))

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('草稿块列表（当前文档）', 'Draft blocks (current doc)')}</div>`

  const hint = document.createElement('div')
  hint.className = 'ain-muted'
  hint.style.marginTop = '6px'
  hint.textContent = t('提示：会以草稿块正文的“第一行”作为标题。你也可以按格式写：出场/人物名/上一章状态/下一章走向（可空）。', 'Tip: uses first line of draft as title. Suggested: Cast/Character/Prev status/Next arc (optional).')
  sec.appendChild(hint)

  const rowBtn = mkBtnRow()
  const btnRefresh = document.createElement('button')
  btnRefresh.className = 'ain-btn gray'
  btnRefresh.textContent = t('刷新列表', 'Refresh')
  rowBtn.appendChild(btnRefresh)
  sec.appendChild(rowBtn)

  const listBox = document.createElement('div')
  listBox.style.marginTop = '10px'
  sec.appendChild(listBox)

  body.appendChild(sec)

  function renderList(blocks) {
    listBox.innerHTML = ''
    const arr = Array.isArray(blocks) ? blocks : []
    if (!arr.length) {
      const empty = document.createElement('div')
      empty.className = 'ain-muted'
      empty.textContent = t('当前文档未发现草稿块。', 'No draft blocks found in current doc.')
      listBox.appendChild(empty)
      return
    }

    const show = arr.slice(0).reverse()
    for (let i = 0; i < show.length; i++) {
      const it = show[i] || {}
      const bid = String(it.id || '').trim()
      const label = _ainDraftLabelFromText(it.text, bid)

      const row = document.createElement('div')
      row.className = 'ain-card'
      row.style.marginTop = '10px'

      const head = document.createElement('div')
      head.style.display = 'flex'
      head.style.alignItems = 'center'
      head.style.justifyContent = 'space-between'
      head.style.gap = '10px'

      const left = document.createElement('div')
      left.style.flex = '1'
      const ttl = document.createElement('div')
      ttl.style.fontWeight = '700'
      ttl.textContent = label
      const meta = document.createElement('div')
      meta.className = 'ain-muted'
      meta.textContent = 'id=' + bid
      left.appendChild(ttl)
      left.appendChild(meta)

      const btns = document.createElement('div')
      btns.style.display = 'flex'
      btns.style.gap = '8px'

      const btnOpen = document.createElement('button')
      btnOpen.className = 'ain-btn gray'
      btnOpen.textContent = t('审阅', 'Review')

      const btnDel = document.createElement('button')
      btnDel.className = 'ain-btn red'
      btnDel.textContent = t('删除草稿标签', 'Delete')

      btns.appendChild(btnOpen)
      btns.appendChild(btnDel)

      head.appendChild(left)
      head.appendChild(btns)
      row.appendChild(head)

      const preview = document.createElement('div')
      preview.className = 'ain-muted'
      preview.style.marginTop = '6px'
      const p0 = safeText(it.text).replace(/\r\n/g, '\n').trim()
      preview.textContent = p0 ? p0.slice(0, 120).replace(/\n+/g, ' / ') + (p0.length > 120 ? '…' : '') : t('（空）', '(empty)')
      row.appendChild(preview)

      btnOpen.onclick = async () => {
        try {
          const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
          const txt = extractDraftBlockText(doc, bid)
          if (!txt) throw new Error(t('未找到草稿块：可能已被删除或文件已切换。', 'Draft block not found.'))
          await openDraftReviewDialog(ctx, { blockId: bid, text: txt })
        } catch (e) {
          ctx.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
        }
      }

      btnDel.onclick = async () => {
        try {
          if (!bid) return
          if (!_ainArmDangerButton(btnDel, t('再次点击确认', 'Click again to confirm'))) return

          const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
          const nextDoc = unwrapDraftBlockFromDoc(doc, bid)
          if (nextDoc == null) throw new Error(t('未找到草稿块：可能已被删除或文件已切换。', 'Draft block not found.'))
          ctx.setEditorValue(nextDoc)
          try { await clearLastDraftInfoIfMatch(ctx, bid) } catch {}
          ctx.ui.notice(t('已删除草稿标签（正文保留）', 'Draft markers removed (text kept)'), 'ok', 1800)
          await refresh()
        } catch (e) {
          ctx.ui.notice(t('删除失败：', 'Delete failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
        }
      }

      listBox.appendChild(row)
    }
  }

  async function refresh() {
    const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
    const blocks = listDraftBlocksInDoc(doc)
    renderList(blocks)
  }

  btnRefresh.onclick = () => { refresh().catch(() => {}) }

  await refresh()
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

async function openLastDraftReviewFromEditor(ctx) {
  const doc = safeText(ctx && ctx.getEditorValue ? ctx.getEditorValue() : '')
  let bid = findLastDraftIdInDoc(doc)
  if (!bid) {
    const last = await loadLastDraftInfo(ctx)
    bid = last && last.blockId ? String(last.blockId) : ''
  }
  bid = String(bid || '').trim()
  if (!bid) throw new Error(t('未发现草稿块：请先用“追加为草稿（可审阅）”。', 'No draft block: append as draft first.'))
  const txt = extractDraftBlockText(doc, bid)
  if (!txt) throw new Error(t('未找到草稿块：可能已被手动删除或当前文件不是写入文件。', 'Draft block not found in current doc.'))
  await openDraftReviewDialog(ctx, { blockId: bid, text: txt })
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
    const resp = await apiFetchConsultWithJob(ctx, cfg, {
      upstream: {
        baseUrl: cfg.upstream.baseUrl,
        apiKey: cfg.upstream.apiKey,
        model: cfg.upstream.model
      },
      input: {
        task: 'progress_update',
        text: mergedText,
        progress,
        bible,
        prev,
        constraints: constraints || undefined,
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

async function progress_try_update_from_prev_chapter(ctx, cfg, prev, reason) {
  try {
    const ragCfg = cfg && cfg.rag ? cfg.rag : {}
    if (ragCfg.autoUpdateProgress === false) return { ok: true, updated: false, skipped: true, why: 'disabled' }
    if (!cfg || !cfg.token) return { ok: true, updated: false, skipped: true, why: 'no_token' }
    if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) return { ok: true, updated: false, skipped: true, why: 'no_upstream' }

    const p0 = prev && typeof prev === 'object' ? prev : null
    const text = safeText(p0 && p0.text).trim()
    if (!text) return { ok: true, updated: false, skipped: true, why: 'no_prev' }

    const inf = await inferProjectDir(ctx, cfg)
    if (!inf) return { ok: true, updated: false, skipped: true, why: 'no_project' }

    const src = safeText(p0 && p0.path).trim()
    const srcBase = src ? fsBaseName(src) : ''
    const headTitle = '自动更新（开始下一章）' + (srcBase ? (' - ' + srcBase) : '')
    const progressPath = joinFsPath(inf.projectAbs, '01_进度脉络.md')
    let cur = ''
    try { cur = await readTextAny(ctx, progressPath) } catch { cur = '' }
    if (cur && cur.includes('## ' + headTitle)) return { ok: true, updated: false, skipped: true, why: 'already' }

    const note = [
      reason ? ('触发来源：' + String(reason)) : '',
      srcBase ? ('来源章节：' + srcBase) : ''
    ].filter(Boolean).join('\n')
    const upd = await progress_generate_update(ctx, cfg, text, note)
    if (!upd) return { ok: true, updated: false, skipped: true, why: 'empty' }

    await progress_append_block(ctx, cfg, upd, headTitle)
    try { await rag_build_or_update_index(ctx, cfg) } catch {}
    return { ok: true, updated: true, skipped: false, why: '' }
  } catch (e) {
    return { ok: false, updated: false, skipped: false, why: 'exception', error: (e && e.message ? e.message : String(e)) }
  }
}

function char_state_format_snapshot_md(data) {
  const arr = Array.isArray(data) ? data : []
  const seen = new Set()
  const lines = []
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] && typeof arr[i] === 'object' ? arr[i] : null
    if (!it) continue
    const name = safeText(it.name != null ? it.name : (it.character != null ? it.character : '')).trim()
    if (!name) continue
    if (seen.has(name)) continue
    seen.add(name)
    const status = safeText(it.status != null ? it.status : (it.state != null ? it.state : '')).trim()
    const note = safeText(it.note != null ? it.note : '').trim()
    const s = status || note
    if (!s) continue
    let line = '- ' + name + '：' + s
    if (status && note && note !== status) line += '（' + note + '）'
    lines.push(line)
    if (lines.length >= 60) break
  }
  if (!lines.length) return t('- （无）', '- (none)')
  return lines.join('\n')
}

async function char_state_append_block(ctx, cfg, blockText, title) {
  const inf = await inferProjectDir(ctx, cfg)
  if (!inf) throw new Error(t('无法推断当前项目，请先在“项目管理”选择小说项目', 'Cannot infer project; select one in Project Manager'))
  const p = joinFsPath(inf.projectAbs, '06_人物状态.md')
  let cur = ''
  try { cur = await readTextAny(ctx, p) } catch { cur = '' }
  const base = safeText(cur).trim() ? safeText(cur) : t('# 人物状态\n\n', '# Character states\n\n')
  const head = title ? ('## ' + String(title)) : ('## 快照 ' + _fmtLocalTs())
  const next = (safeText(base).trimEnd() + '\n\n' + head + '\n\n' + safeText(blockText).trim() + '\n').trimStart()
  await writeTextAny(ctx, p, next)
}

async function char_state_extract_from_text(ctx, cfg, opt) {
  const o = (opt && typeof opt === 'object') ? opt : {}
  const text = safeText(o.text).trim()
  if (!text) return { ok: false, data: [], raw: '', error: t('章节文本为空', 'Empty chapter text') }
  const existing = safeText(o.existing).trim()
  const path = safeText(o.path).trim()

  const resp = await apiFetch(ctx, cfg, 'ai/proxy/cast/', {
    upstream: {
      baseUrl: cfg.upstream.baseUrl,
      apiKey: cfg.upstream.apiKey,
      model: cfg.upstream.model
    },
    input: {
      text,
      path: path || undefined,
      existing: existing || undefined
    }
  })

  const raw = safeText(resp && resp.text).trim()
  const data = Array.isArray(resp && resp.data) ? resp.data : null
  const perr = safeText(resp && resp.parse_error).trim()
  if (data && data.length) return { ok: true, data, raw, error: '' }
  return { ok: false, data: [], raw, error: perr || t('人物状态解析失败', 'Parse failed') }
}

async function char_state_auto_update_after_accept(ctx, deltaText, reason) {
  try {
    const cfg = await loadCfg(ctx)
    const ragCfg = cfg && cfg.rag ? cfg.rag : {}
    if (ragCfg.autoUpdateCharState === false) return
    if (!cfg.token) return
    if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) return

    const text = safeText(deltaText).trim()
    if (!text) return

    const existing = await getCharStateBlockForUpdate(ctx, cfg)
    const res = await char_state_extract_from_text(ctx, cfg, { text, existing })

    const ts = _fmtLocalTs()
    const title = (res.ok ? '快照 ' : '解析失败 ') + ts + (reason ? ('（' + String(reason) + '）') : '')

    if (res.ok) {
      const md = char_state_format_snapshot_md(res.data)
      await char_state_append_block(ctx, cfg, md, title)
      return
    }

    const rawShort = sliceHeadTail(safeText(res.raw).trim(), 12000, 0.6)
    const failBlock = [
      t('> 解析失败：', '> Parse failed: ') + safeText(res.error || ''),
      t('> 以下为 AI 原文（可手动整理为条目）：', '> Raw AI output (you can manually format it):'),
      '```text',
      rawShort,
      '```'
    ].join('\n')
    await char_state_append_block(ctx, cfg, failBlock, title)
    try {
      ctx.ui.notice(t('人物状态自动更新失败：已把 AI 原文写入 06_人物状态.md（请手动整理）', 'Character state auto update failed: raw output saved to 06_人物状态.md (please format manually)'), 'err', 2600)
    } catch {}
  } catch {}
}

function ui_notice_hold_begin(ctx, msg) {
  // 优先用新版可手动关闭的通知；否则尽力降级（不要因此打断主流程）
  try {
    if (ctx && ctx.ui && typeof ctx.ui.showNotification === 'function' && typeof ctx.ui.hideNotification === 'function') {
      const id = ctx.ui.showNotification(String(msg || ''), { type: 'info', duration: 0 })
      return { kind: 'ui', id }
    }
  } catch {}
  try {
    const nm = (typeof window !== 'undefined') ? window.NotificationManager : null
    if (nm && typeof nm.show === 'function' && typeof nm.hide === 'function') {
      const id = nm.show('extension', String(msg || ''), 0)
      return { kind: 'nm', id }
    }
  } catch {}
  try {
    if (ctx && ctx.ui && typeof ctx.ui.notice === 'function') {
      ctx.ui.notice(String(msg || ''), 'ok', 999999)
      return { kind: 'notice', id: '' }
    }
  } catch {}
  return null
}

function ui_notice_hold_end(ctx, hold) {
  if (!hold || !hold.kind) return
  if (hold.kind === 'ui') {
    try { ctx && ctx.ui && ctx.ui.hideNotification && ctx.ui.hideNotification(hold.id) } catch {}
    return
  }
  if (hold.kind === 'nm') {
    try { window.NotificationManager && window.NotificationManager.hide && window.NotificationManager.hide(hold.id) } catch {}
  }
}

function maybeShowLowBalanceWarn(ctx, balanceChars) {
  if (__LOW_BALANCE_WARN_SHOWN__) return
  const n = parseInt(String(balanceChars == null ? '' : balanceChars), 10)
  if (!Number.isFinite(n)) return
  if (n >= LOW_BALANCE_WARN_CHARS) return
  __LOW_BALANCE_WARN_SHOWN__ = true
  ui_notice_hold_begin(ctx, LOW_BALANCE_WARN_TEXT)
}

async function probeLowBalanceWarn(ctx) {
  try {
    const cfg = await loadCfg(ctx)
    if (!cfg || !cfg.token) return
    const json = await apiGet(ctx, cfg, 'billing/status/')
    const b = json && json.billing ? json.billing : null
    if (!b) return
    maybeShowLowBalanceWarn(ctx, b.balance_chars)
  } catch {}
}

async function probeLowBalanceWarnThrottled(ctx) {
  try {
    if (!ctx) return
    const now = Date.now()
    if (__BILLING_PROBE_INFLIGHT__) return
    if (__LAST_BILLING_PROBE_AT__ && (now - __LAST_BILLING_PROBE_AT__) < BILLING_PROBE_TTL_MS) return
    __LAST_BILLING_PROBE_AT__ = now
    __BILLING_PROBE_INFLIGHT__ = true
    try {
      await probeLowBalanceWarn(ctx)
    } finally {
      __BILLING_PROBE_INFLIGHT__ = false
    }
  } catch {}
}

async function char_state_try_update_from_prev_chapter(ctx, cfg, reason, opt) {
  // 约定：在“开始下一章/新开一卷”创建并打开新章节后调用；
  // 这样“上一章”才会被正确识别（尤其是新开卷的第一章要回退到上一卷最后一章）。
  const onBegin = opt && typeof opt.onBegin === 'function' ? opt.onBegin : null
  try {
    const ragCfg = cfg && cfg.rag ? cfg.rag : {}
    if (ragCfg.autoUpdateCharState === false) return { ok: true, updated: false, skipped: true, why: 'disabled' }
    if (!cfg || !cfg.token) return { ok: true, updated: false, skipped: true, why: 'no_token' }
    if (!cfg.upstream || !cfg.upstream.baseUrl || !cfg.upstream.model) return { ok: true, updated: false, skipped: true, why: 'no_upstream' }

    const lim = (cfg && cfg.ctx && cfg.ctx.maxUpdateSourceChars) ? (cfg.ctx.maxUpdateSourceChars | 0) : 20000
    const prev0 = opt && opt.prev && typeof opt.prev === 'object' ? opt.prev : null
    const prev = prev0 ? prev0 : await getPrevChapterTextForExtract(ctx, cfg, lim)
    if (!prev || !safeText(prev.text).trim()) return { ok: true, updated: false, skipped: true, why: 'no_prev' }

    if (onBegin) {
      try { onBegin() } catch {}
    }

    const existing = await getCharStateBlockForUpdate(ctx, cfg)
    const res = await char_state_extract_from_text(ctx, cfg, { text: safeText(prev.text), path: safeText(prev.path), existing })

    const ts = _fmtLocalTs()
    const title = (res.ok ? '快照 ' : '解析失败 ') + ts + (reason ? ('（' + String(reason) + '）') : '') + (prev.path ? (' - ' + fsBaseName(prev.path)) : '')

    if (res.ok) {
      const md = char_state_format_snapshot_md(res.data)
      await char_state_append_block(ctx, cfg, md, title)
      return { ok: true, updated: true, parseOk: true, error: '' }
    }

    const rawShort = sliceHeadTail(safeText(res.raw).trim(), 12000, 0.6)
    const failBlock = [
      t('> 解析失败：', '> Parse failed: ') + safeText(res.error || ''),
      t('> 以下为 AI 原文（可手动整理为条目）：', '> Raw AI output (you can manually format it):'),
      '```text',
      rawShort,
      '```'
    ].join('\n')
    await char_state_append_block(ctx, cfg, failBlock, title)
    return { ok: true, updated: true, parseOk: false, error: safeText(res.error || '') }
  } catch (e) {
    return { ok: false, updated: false, skipped: false, why: 'exception', error: (e && e.message ? e.message : String(e)) }
  }
}

async function _ainTryReplaceFirstLineInPath(ctx, absPath, expectedLine, nextLine) {
  try {
    const p = String(absPath || '').trim()
    if (!p) return false
    const expected = safeText(expectedLine).trim()
    const next = safeText(nextLine).trimEnd()
    if (!expected || !next) return false

    let curPath = ''
    try {
      if (ctx && typeof ctx.getCurrentFilePath === 'function') curPath = String(await ctx.getCurrentFilePath() || '')
    } catch {}
    const isCurrent = !!(curPath && normFsPath(curPath) === normFsPath(p))

    const raw = isCurrent
      ? safeText(ctx && ctx.getEditorValue ? (ctx.getEditorValue() || '') : '')
      : safeText(await readTextAny(ctx, p))

    if (!raw) return false

    const m = /^([^\r\n]*)(\r?\n|$)/.exec(raw)
    const firstLine = m && m[1] != null ? String(m[1]) : ''
    const eol = m && m[2] != null ? String(m[2]) : '\n'
    if (safeText(firstLine).trim() !== expected) return false

    const headLen = m ? String(m[0] || '').length : 0
    const rest = raw.slice(Math.max(0, headLen))
    const replaced = next + (eol || '\n') + rest

    if (isCurrent && ctx && typeof ctx.setEditorValue === 'function') {
      try { ctx.setEditorValue(replaced) } catch {}
    }
    await writeTextAny(ctx, p, replaced)
    return true
  } catch {
    return false
  }
}

async function novel_create_next_chapter(ctx) {
  const cfg = await loadCfg(ctx)
  const inf = await computeNextChapterPath(ctx, cfg)
  if (!inf) throw new Error(t('未发现项目：请先在“小说→项目管理”选择项目，或打开项目内文件。', 'No project: select one in Project Manager or open a file under the project.'))
  const ok = await openConfirmDialog(ctx, {
    title: t('新建下一章', 'Create next chapter'),
    message:
      t('将在章节目录创建文件：\n', 'Will create file under chapters:\n') +
      String(inf.chapPath || '') +
      '\n\n' +
      t('创建并打开它？', 'Create and open it?'),
  })
  if (!ok) return null
  const title = `# 第${inf.chapZh}章`
  const titleBusy = '# 正在更新人物状态/进度脉络……请耐心等待'
  await writeTextAny(ctx, inf.chapPath, title + '\n\n')
  let opened = false
  try {
    if (typeof ctx.openFileByPath === 'function') {
      await ctx.openFileByPath(inf.chapPath)
      opened = true
    }
  } catch {}

  // 自动更新人物状态：只在“开始下一章”时更新，避免草稿小片段导致信息丢失
  if (opened) {
    let hold = null
    let r = null
    let pr = null
    try {
      try { await _ainTryReplaceFirstLineInPath(ctx, inf.chapPath, title, titleBusy) } catch {}
      const lim = (cfg && cfg.ctx && cfg.ctx.maxUpdateSourceChars) ? (cfg.ctx.maxUpdateSourceChars | 0) : 20000
      const prev = await getPrevChapterTextForExtract(ctx, cfg, lim)
      hold = ui_notice_hold_begin(ctx, t('人物状态/进度脉络更新中…请等待更新完成再使用续写功能', 'Updating character states/progress... Please wait until it finishes before continuing.'))
      r = await char_state_try_update_from_prev_chapter(ctx, cfg, t('开始下一章', 'Start next chapter'), { prev })
      pr = await progress_try_update_from_prev_chapter(ctx, cfg, prev, '开始下一章')
    } catch (e) {
      try { ctx.ui.notice(t('更新失败：', 'Update failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600) } catch {}
    } finally {
      ui_notice_hold_end(ctx, hold)
      try { await _ainTryReplaceFirstLineInPath(ctx, inf.chapPath, titleBusy, title) } catch {}
    }

    if (r && r.updated) {
      if (r.parseOk) {
        try { ctx.ui.notice(t('人物状态已更新（写入 06_人物状态.md）', 'Character states updated (written to 06_人物状态.md)'), 'ok', 2000) } catch {}
      } else {
        try { ctx.ui.notice(t('人物状态更新失败：已把 AI 原文写入 06_人物状态.md（请手动整理）', 'Character state update failed: raw output saved to 06_人物状态.md'), 'err', 2600) } catch {}
      }
    } else if (r && r.ok === false) {
      try { ctx.ui.notice(t('人物状态更新失败：', 'Character state update failed: ') + safeText(r.error || ''), 'err', 2600) } catch {}
    }
    if (pr && pr.updated) {
      try { ctx.ui.notice(t('进度脉络已更新（写入 01_进度脉络.md）', 'Progress updated (written to 01_进度脉络.md)'), 'ok', 2000) } catch {}
    } else if (pr && pr.ok === false) {
      try { ctx.ui.notice(t('进度脉络更新失败：', 'Progress update failed: ') + safeText(pr.error || ''), 'err', 2600) } catch {}
    }
  }

  ctx.ui.notice(t('已创建并打开：', 'Created: ') + String(fsBaseName(inf.chapPath)), 'ok', 2000)
  ctx.ui.notice(t('提示：打开该章节后再用“续写正文”并追加，就会写入该章节文件。', 'Tip: open this chapter then use Write and append; it will go into this file.'), 'ok', 2600)
  return inf
}

async function novel_create_next_volume(ctx) {
  const cfg = await loadCfg(ctx)
  const inf = await computeNextVolumeChapterPath(ctx, cfg)
  if (!inf) throw new Error(t('未发现项目：请先在“小说→项目管理”选择项目，或打开项目内文件。', 'No project: select one in Project Manager or open a file under the project.'))
  const ok = await openConfirmDialog(ctx, {
    title: t('新开一卷', 'Create new volume'),
    message:
      t('将在章节目录创建卷目录：\n', 'Will create volume folder under chapters:\n') +
      String(inf.chapDir || '') +
      '\n\n' +
      t('并创建第一章文件：\n', 'And create chapter 1 file:\n') +
      String(inf.chapPath || '') +
      '\n\n' +
      t('创建并打开它？', 'Create and open it?'),
  })
  if (!ok) return null
  const title = `# 第${inf.volZh}卷 第一章`
  const titleBusy = '# 正在更新人物状态/进度脉络……请耐心等待'
  await writeTextAny(ctx, inf.chapPath, title + '\n\n')
  let opened = false
  try {
    if (typeof ctx.openFileByPath === 'function') {
      await ctx.openFileByPath(inf.chapPath)
      opened = true
    }
  } catch {}

  // 新开卷后：同样用“上一卷最后一章”自动更新人物状态
  if (opened) {
    let hold = null
    let r = null
    let pr = null
    try {
      try { await _ainTryReplaceFirstLineInPath(ctx, inf.chapPath, title, titleBusy) } catch {}
      const lim = (cfg && cfg.ctx && cfg.ctx.maxUpdateSourceChars) ? (cfg.ctx.maxUpdateSourceChars | 0) : 20000
      const prev = await getPrevChapterTextForExtract(ctx, cfg, lim)
      hold = ui_notice_hold_begin(ctx, t('人物状态/进度脉络更新中…请等待更新完成再使用续写功能', 'Updating character states/progress... Please wait until it finishes before continuing.'))
      r = await char_state_try_update_from_prev_chapter(ctx, cfg, t('新开一卷', 'Start new volume'), { prev })
      pr = await progress_try_update_from_prev_chapter(ctx, cfg, prev, '新开一卷')
    } catch (e) {
      try { ctx.ui.notice(t('更新失败：', 'Update failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600) } catch {}
    } finally {
      ui_notice_hold_end(ctx, hold)
      try { await _ainTryReplaceFirstLineInPath(ctx, inf.chapPath, titleBusy, title) } catch {}
    }

    if (r && r.updated) {
      if (r.parseOk) {
        try { ctx.ui.notice(t('人物状态已更新（写入 06_人物状态.md）', 'Character states updated (written to 06_人物状态.md)'), 'ok', 2000) } catch {}
      } else {
        try { ctx.ui.notice(t('人物状态更新失败：已把 AI 原文写入 06_人物状态.md（请手动整理）', 'Character state update failed: raw output saved to 06_人物状态.md'), 'err', 2600) } catch {}
      }
    } else if (r && r.ok === false) {
      try { ctx.ui.notice(t('人物状态更新失败：', 'Character state update failed: ') + safeText(r.error || ''), 'err', 2600) } catch {}
    }
    if (pr && pr.updated) {
      try { ctx.ui.notice(t('进度脉络已更新（写入 01_进度脉络.md）', 'Progress updated (written to 01_进度脉络.md)'), 'ok', 2000) } catch {}
    } else if (pr && pr.ok === false) {
      try { ctx.ui.notice(t('进度脉络更新失败：', 'Progress update failed: ') + safeText(pr.error || ''), 'err', 2600) } catch {}
    }
  }

  ctx.ui.notice(t('已新开：', 'Created: ') + `第${inf.volZh}卷/第一章`, 'ok', 2000)
  ctx.ui.notice(t('提示：后续“开始下一章”会在当前卷目录内递增。', 'Tip: Start next chapter will increment within current volume.'), 'ok', 2600)
  return inf
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
  agentLine.appendChild(document.createTextNode(t('Agent（Plan模式）', 'Agent (Plan)')))
  agentBox.appendChild(agentLine)

  const selAgentTarget = document.createElement('select')
  selAgentTarget.className = 'ain-in ain-select'
  selAgentTarget.style.width = '180px'
  ;[1000, 2000, 3000].forEach((n) => {
    const op = document.createElement('option')
    op.value = String(n)
    op.textContent = t('≈ ', '≈ ') + String(n) + t(' 字', ' chars') + (n === 3000 ? t('（上限）', ' (max)') : '')
    selAgentTarget.appendChild(op)
  })
  try { selAgentTarget.value = String(_ainAgentNormTargetChars(a0.targetChars || 3000, 3000)) } catch {}
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

  const modeLine = document.createElement('label')
  modeLine.style.display = 'flex'
  modeLine.style.gap = '8px'
  modeLine.style.alignItems = 'center'
  const selThinkingMode = document.createElement('select')
  selThinkingMode.className = 'ain-in ain-select'
  selThinkingMode.style.width = '260px'
  ;[
    { v: 'none', zh: '不思考', en: 'None (default)' },
    { v: 'normal', zh: '正常思考', en: 'Normal (inject checklist)' },
    { v: 'strong', zh: '强思考', en: 'Strong (slower, steadier)' },
  ].forEach((it) => {
    const op = document.createElement('option')
    op.value = String(it.v)
    op.textContent = t(String(it.zh), String(it.en))
    selThinkingMode.appendChild(op)
  })
  try { selThinkingMode.value = String(a0.thinkingMode || 'none') } catch {}
  modeLine.appendChild(document.createTextNode(t('思考模式：', 'Mode: ')))
  modeLine.appendChild(selThinkingMode)
  agentBox.appendChild(modeLine)

  function _bootstrapSyncTargetOptions() {
    const max = _ainAgentMaxTargetCharsByMode(selThinkingMode.value)
    try {
      const opts = selAgentTarget.querySelectorAll('option')
      for (let i = 0; i < opts.length; i++) {
        const v = parseInt(String(opts[i].value || '0'), 10) || 0
        opts[i].disabled = v > max
      }
    } catch {}
    const cur = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
    const next = _ainAgentClampTargetCharsByMode(selThinkingMode.value, cur)
    if (next !== cur) {
      try { selAgentTarget.value = String(next) } catch {}
    }
  }
  selThinkingMode.onchange = () => { _bootstrapSyncTargetOptions() }
  _bootstrapSyncTargetOptions()

  const agentHint = document.createElement('div')
  agentHint.className = 'ain-muted'
  agentHint.style.marginTop = '6px'
  agentHint.textContent = t(
    '提示：Agent 会先生成 TODO，再逐项执行，并实时显示进度；字数是“目标值”不是硬上限：默认≈3000，中等≈2000，加强≈1000（越高越耗字符余额）。',
    'Note: Agent generates TODO then executes step-by-step with live progress; targets (not hard caps): None≈3000, Normal≈2000, Strong≈1000 (higher costs more tokens).'
  )

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
  let agentControl = null

  function _syncAgentCtrlUiPaused(meta) {
    btnAgentRetry.style.display = ''
    btnAgentSkip.style.display = (meta && meta.type === 'write') ? 'none' : ''
  }

  function _syncAgentCtrlUiRunning() {
    btnAgentRetry.style.display = 'none'
    btnAgentSkip.style.display = 'none'
  }

  btnAgentAbort.onclick = () => {
    try {
      if (!agentControl || typeof agentControl.abort !== 'function') return
      agentControl.abort()
      ctx.ui.notice(t('已发出终止请求', 'Abort requested'), 'ok', 1200)
    } catch {}
  }
  btnAgentRetry.onclick = () => {
    try {
      if (!agentControl || typeof agentControl.resume !== 'function') return
      agentControl.resume('retry')
    } catch {}
  }
  btnAgentSkip.onclick = () => {
    try {
      if (!agentControl || typeof agentControl.resume !== 'function') return
      agentControl.resume('skip')
    } catch {}
  }

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
        const wantAudit = !!cbAudit.checked
        const thinkingMode = _ainAgentNormThinkingMode(selThinkingMode.value) || 'none'
        const targetChars0 = parseInt(String(selAgentTarget.value || '3000'), 10) || 3000
        const targetChars = _ainAgentClampTargetCharsByMode(thinkingMode, targetChars0)
        if (targetChars !== targetChars0) {
          try { selAgentTarget.value = String(targetChars) } catch {}
          ctx.ui.notice(t('已按思考模式收紧字数目标：', 'Target adjusted by mode: ') + String(targetChars), 'ok', 1800)
        }
        const chunkCount = _ainAgentDeriveChunkCount(targetChars)
        // 记住用户选择（但不强行改动“是否默认启用 Agent”）
        try {
          const curEnabled = !!(cfg && cfg.agent && cfg.agent.enabled)
          cfg = await saveCfg(ctx, { agent: { enabled: curEnabled, targetChars, thinkingMode, audit: wantAudit } })
        } catch {}
        try { agentProgress.style.display = '' } catch {}
        try { agentLog.textContent = t('Agent 执行中…', 'Agent running...') } catch {}

        try {
          if (agentControl && typeof agentControl.abort === 'function') agentControl.abort()
        } catch {}
        agentControl = _ainCreateAgentRunControl()
        agentControl.onEvent = (ev, meta) => {
          if (ev === 'paused') _syncAgentCtrlUiPaused(meta)
          else _syncAgentCtrlUiRunning()
          if (ev === 'abort') btnAgentAbort.disabled = true
        }
        btnAgentAbort.disabled = false
        _syncAgentCtrlUiRunning()

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
          thinkingMode,
          targetChars,
          chunkCount,
          audit: wantAudit
        }, { render: renderAgentProgress, control: agentControl })

        const aborted = !!(agentControl && agentControl.aborted)
        lastChapter = safeText(res && res.text).trim()
        out.textContent = lastChapter || (aborted ? t('已终止（无输出）', 'Aborted (no output)') : '')
        btnAgentAbort.disabled = true
        _syncAgentCtrlUiRunning()
        agentControl = null

        if (aborted) {
          btnAppend.disabled = !lastChapter
          ctx.ui.notice(t('Agent 已终止（未写入文档）', 'Agent aborted (not inserted)'), 'ok', 1800)
          return
        }
      } else {
      const first = await apiFetchChatWithJob(ctx, cfg, {
        mode: 'novel',
        action: 'write',
        upstream: {
          baseUrl: cfg.upstream.baseUrl,
          apiKey: cfg.upstream.apiKey,
          model: cfg.upstream.model
        },
        input: { instruction: promptIdea, progress: '', bible: '', prev: '', choice: chosen, constraints: constraints || undefined, novel_style: 'iceberg' }
      }, {
        onTick: ({ waitMs }) => {
          const s = Math.max(0, Math.round(Number(waitMs || 0) / 1000))
          out.textContent = t('生成中… 已等待 ', 'Generating... waited ') + s + 's'
        }
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
      try { btnAgentAbort.disabled = true } catch {}
      try { _syncAgentCtrlUiRunning() } catch {}
      agentControl = null
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
    await writeTextAny(ctx, joinFsPath(projectAbs, '06_人物状态.md'), t('# 人物状态\n\n- （自动维护：每次更新会追加一个“快照”，用于续写上下文）\n', '# Character states\n\n- (Auto-maintained snapshots for writing context)\n'))
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
    const constraints = await mergeConstraintsWithCharState(ctx, cfg, safeText(cons.ta.value).trim())
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
    const constraints = await mergeConstraintsWithCharState(ctx, cfg, '')
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

  btnAppend.textContent = t('追加到文末', 'Append to doc')
  btnAppend.disabled = true

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'

  btnWrite.textContent = t('写入审计文件', 'Write audit file')
  btnWrite.disabled = true

  const btnOpen = document.createElement('button')
  btnOpen.className = 'ain-btn gray'

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

      const constraints = await mergeConstraintsWithCharState(ctx, cfg, safeText(cons.ta.value).trim())

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

  btnIndex.textContent = t('构建/更新 RAG 索引', 'Build/Update RAG')

  const btnGen = document.createElement('button')
  btnGen.className = 'ain-btn'

  btnGen.textContent = t('生成初始化提议', 'Generate init proposal')

  const btnWrite = document.createElement('button')
  btnWrite.className = 'ain-btn gray'

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
      if (fromChapDir) {
        const abs = normFsPath(files[i] || '')
        const root = normFsPath(chapDir).replace(/\/+$/, '')
        const rel = abs.startsWith(root + '/') ? abs.slice(root.length).replace(/^\/+/, '') : fsBaseName(abs)
        lines.push('- ' + rel)
      } else {
        lines.push('- ' + fsBaseName(files[i]))
      }
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
      const constraints = await mergeConstraintsWithCharState(ctx, cfg, safeText(cons.ta.value).trim())
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
        const metaMd = ['# ' + name, '', '- 本项目由“导入现有文稿（初始化资料）”创建资料文件。', '- 资料文件：01_进度脉络/02_世界设定/03_主要角色/04_人物关系/05_章节大纲/06_人物状态', ''].join('\n')
        await writeTextAny(ctx, joinFsPath(base, '00_项目.md'), metaMd)
      }
    } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '01_进度脉络.md')))) await writeTextAny(ctx, joinFsPath(base, '01_进度脉络.md'), '# 进度脉络\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '02_世界设定.md')))) await writeTextAny(ctx, joinFsPath(base, '02_世界设定.md'), '# 世界设定\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '03_主要角色.md')))) await writeTextAny(ctx, joinFsPath(base, '03_主要角色.md'), '# 主要角色\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '04_人物关系.md')))) await writeTextAny(ctx, joinFsPath(base, '04_人物关系.md'), '# 人物关系\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '05_章节大纲.md')))) await writeTextAny(ctx, joinFsPath(base, '05_章节大纲.md'), '# 章节大纲\n\n') } catch {}
    try { if (!(await fileExists(ctx, joinFsPath(base, '06_人物状态.md')))) await writeTextAny(ctx, joinFsPath(base, '06_人物状态.md'), '# 人物状态\n\n') } catch {}
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
    const loaded = await rag_load_index(ctx, cfg, inf.projectAbs)
    const meta = loaded && loaded.meta ? loaded.meta : null
    const n = meta && Array.isArray(meta.chunks) ? meta.chunks.length : 0
    const dims = meta && Number.isFinite(meta.dims) ? (meta.dims | 0) : 0
    const paths = await rag_get_index_paths(ctx, cfg, inf.projectAbs)
    out.textContent =
      t('当前项目：', 'Project: ') + inf.projectRel +
      '\n' + t('索引块数：', 'Chunks: ') + n +
      '\n' + t('维度：', 'Dims: ') + dims +
      (paths && paths.mode === 'appLocalData'
        ? ('\n' + t('索引位置：AppLocalData（插件数据目录）', 'Index location: AppLocalData (plugin data dir)'))
        : '') +
      '\n' + t('索引文件：', 'Index files: ') +
      '\n- ' + paths.metaPath +
      '\n- ' + paths.vecPath +
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
      const paths = await rag_get_index_paths(ctx, cfg, inf.projectAbs)
      const p = paths && paths.metaPath ? paths.metaPath : joinFsPath(inf.projectAbs, AIN_RAG_META_FILE)
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

  btnWrite.textContent = t('写入进度脉络文件', 'Write to file')
  btnWrite.disabled = true
  const btnOpen = document.createElement('button')
  btnOpen.className = 'ain-btn gray'

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
  const constraints = await mergeConstraintsWithCharState(ctx, cfg, localConstraints)

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
      rag: rag || undefined,
      novel_style: 'iceberg'
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
  let curBlockId = String(blockId || '').trim()

  const { body } = createDialogShell(title)

  const sec = document.createElement('div')
  sec.className = 'ain-card'
  sec.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${t('草稿正文（可手动改）', 'Draft text (editable)')}</div>`

  // 草稿块选择（在“审阅窗口”里直接切换/删除草稿块）
  const pickRow = document.createElement('div')
  pickRow.className = 'ain-row'
  const pickWrap = document.createElement('div')
  const pickLab = document.createElement('div')
  pickLab.className = 'ain-lab'
  pickLab.textContent = t('草稿块', 'Draft block')
  const selDraft = document.createElement('select')
  selDraft.className = 'ain-in ain-select'
  pickWrap.appendChild(pickLab)
  pickWrap.appendChild(selDraft)
  pickRow.appendChild(pickWrap)

  const btnDelDraft = document.createElement('button')
  btnDelDraft.className = 'ain-btn red'
  btnDelDraft.textContent = t('删除该草稿标签', 'Delete this draft')
  btnDelDraft.style.alignSelf = 'end'
  pickRow.appendChild(btnDelDraft)
  sec.appendChild(pickRow)

  const pickHint = document.createElement('div')
  pickHint.className = 'ain-muted'
  pickHint.style.marginTop = '6px'
  pickHint.textContent = t('标题取草稿正文第一行；建议格式：出场/人物名/上一章状态/下一章走向（可空）。', 'Title uses first line; suggested: Cast/Character/Prev status/Next arc (optional).')
  sec.appendChild(pickHint)

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

  btnApply.textContent = t('覆盖草稿块（定稿）', 'Overwrite draft block (finalize)')
  btnApply.disabled = !curBlockId
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
      const bid = String(curBlockId || '').trim()
      if (!bid) return
      cfg = await loadCfg(ctx)
      const nextText = safeText(taText.ta.value).trim()
      if (!nextText) {
        ctx.ui.notice(t('正文不能为空', 'Text cannot be empty'), 'err', 1800)
        return
      }
      const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
      const replaced = replaceDraftBlockText(doc, bid, nextText)
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

  function loadDraftToEditor(id) {
    const bid = String(id || '').trim()
    if (!bid) return false
    const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
    const txt = extractDraftBlockText(doc, bid)
    if (!txt) return false
    curBlockId = bid
    taText.ta.value = txt
    btnApply.disabled = false
    return true
  }

  function refreshDraftSelect() {
    const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
    const blocks = listDraftBlocksInDoc(doc)
    selDraft.innerHTML = ''
    const list = Array.isArray(blocks) ? blocks : []
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {}
      const bid = String(it.id || '').trim()
      if (!bid) continue
      const op = document.createElement('option')
      op.value = bid
      op.textContent = _ainDraftLabelFromText(it.text, bid)
      selDraft.appendChild(op)
    }

    let pick = String(curBlockId || '').trim()
    if (!pick) pick = findLastDraftIdInDoc(doc)
    try { selDraft.value = pick } catch {}

    const has = !!(selDraft.value && String(selDraft.value).trim())
    btnDelDraft.disabled = !has
    btnApply.disabled = !has
    if (has) {
      const ok = loadDraftToEditor(selDraft.value)
      if (!ok) btnApply.disabled = true
    } else {
      curBlockId = ''
      btnApply.disabled = true
    }
  }

  selDraft.onchange = () => {
    try {
      const bid = String(selDraft.value || '').trim()
      if (!bid) return
      const ok = loadDraftToEditor(bid)
      if (!ok) throw new Error(t('未找到草稿块：可能已被删除或文件已切换。', 'Draft block not found.'))
      btnDelDraft.disabled = false
    } catch (e) {
      ctx.ui.notice(t('切换失败：', 'Switch failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  btnDelDraft.onclick = async () => {
    try {
      const bid = String(selDraft.value || curBlockId || '').trim()
      if (!bid) return
      if (!_ainArmDangerButton(btnDelDraft, t('再次点击确认', 'Click again to confirm'))) return

      const doc = safeText(ctx.getEditorValue ? ctx.getEditorValue() : '')
      const nextDoc = unwrapDraftBlockFromDoc(doc, bid)
      if (nextDoc == null) throw new Error(t('未找到草稿块：可能已被删除或文件已切换。', 'Draft block not found.'))
      ctx.setEditorValue(nextDoc)
      try { await clearLastDraftInfoIfMatch(ctx, bid) } catch {}
      ctx.ui.notice(t('已删除草稿标签（正文保留）', 'Draft markers removed (text kept)'), 'ok', 1800)
      refreshDraftSelect()
    } catch (e) {
      ctx.ui.notice(t('删除失败：', 'Delete failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
    }
  }

  // 初始化：允许在 opts.text 为空/过期时也能从当前文档恢复
  try { refreshDraftSelect() } catch {}

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

  btnUse.textContent = t('设为当前项目', 'Set current')
  const btnOpenMeta = document.createElement('button')
  btnOpenMeta.className = 'ain-btn gray'

  btnOpenMeta.textContent = t('打开资料文件', 'Open meta files')
  const btnAbandon = document.createElement('button')
  btnAbandon.className = 'ain-btn red'

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
    const files = ['01_进度脉络.md', '02_世界设定.md', '03_主要角色.md', '04_人物关系.md', '05_章节大纲.md', '06_人物状态.md']
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
    // 右键菜单：源码/小说模式通用
    try {
      if (typeof __CTX_MENU_DISPOSER__ === 'function') __CTX_MENU_DISPOSER__()
    } catch {}
    __CTX_MENU_DISPOSER__ = null
    try {
      if (typeof context.addContextMenuItem === 'function') {
        __CTX_MENU_DISPOSER__ = context.addContextMenuItem({
          label: t('小说引擎', 'Novel Engine'),
          icon: '📚',
          condition: (ctx) => {
            if (!ctx) return true
            return ctx.mode === 'edit' || ctx.mode === 'wysiwyg'
          },
          children: [
            {
              label: t('写作咨询', 'Writing consult'),
              onClick: () => { void openConsultDialog(context) }
            },
            {
              label: t('走向续写', 'Options & Write'),
              onClick: () => { void openWriteWithChoiceDialog(context) }
            },
            {
              label: t('新建下章', 'Create next chapter'),
              onClick: () => { void novel_create_next_chapter(context).catch((e) => context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)) }
            },
            {
              label: t('审阅草稿', 'Review draft'),
              onClick: () => { void openLastDraftReviewFromEditor(context).catch((e) => context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)) }
            },
          ]
        })
      }
    } catch (e) {
      try { console.error('[ai-novel] 注册右键菜单失败：', e) } catch {}
    }

    context.addMenuItem({
      label: t('小说', 'Novel'),
      children: [
        { label: t('设置', 'Settings'), onClick: async () => await openSettingsDialog(context) },
        {
          label: t('消费日志', 'Usage logs'),
          onClick: async () => {
            try {
              await openUsageLogsDialog(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
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
          label: t('新开一卷（创建卷目录+第一章）', 'Start new volume (folder + chapter 1)'),
          onClick: async () => {
            try {
              await novel_create_next_volume(context)
            } catch (e) {
              context.ui.notice(t('失败：', 'Failed: ') + (e && e.message ? e.message : String(e)), 'err', 2600)
            }
          }
        },
        {
          label: t('开始下一章（新建章节文件）', 'Start next chapter (new file)'),
          onClick: async () => {
            try {
              await novel_create_next_chapter(context)
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
              await openLastDraftReviewFromEditor(context)
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

    // 启动后尝试拉一次余额：低余额时给出“常驻通知”（不阻塞主流程）
    try { void probeLowBalanceWarn(context) } catch {}
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

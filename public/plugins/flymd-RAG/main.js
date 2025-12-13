// flymd-RAG：本地知识库索引（向量检索）
// 约束（已确认最终路线）：
// - 默认关闭：用户显式开启才会索引/发 embedding 请求
// - embedding 连接默认复用 ai-assistant 的 baseUrl/apiKey（模型单独配置；也可切换为自定义）
// - 第一版仅支持 md/markdown/txt
// - 排除规则：目录前缀（遍历阶段跳过）
// - 索引落盘：AppLocalData/flymd/plugin-data/<pluginId>/<libraryKey>/

const CFG_KEY = 'flysmart.byLibrary'
const SCHEMA_VERSION = 1
const META_FILE = 'meta.json'
const VEC_FILE = 'vectors.f32'
const INDEX_LOG_FILE = 'flymd-rag-index.log'

const DEFAULT_CFG = {
  enabled: false,
  includeExtensions: ['md', 'markdown', 'txt'],
  includeDirs: [],
  excludeDirs: [],
  maxDepth: 32,
  // 分块：优先按 Markdown 标题段落切分（更贴近语义），再做长度上限
  chunk: { maxChars: 512, overlapChars: 0, byHeading: true },
  embedding: {
    provider: 'reuse-ai-assistant', // 'reuse-ai-assistant' | 'custom'
    baseUrl: '',
    apiKey: '',
    model: 'text-embedding-3-small',
  },
  search: { topK: 8, minScore: 0, contextMaxChars: 1024 },
}

let FLYSMART_CTX = null
let FLYSMART_BUSY = false
let FLYSMART_STATUS = {
  state: 'idle',
  phase: '',
  totalFiles: 0,
  totalChunks: 0,
  processedFiles: 0,
  processedChunks: 0,
  batchesDone: 0,
  batchesTotal: 0,
  lastProgressAt: 0,
  currentFile: '',
  lastIndexedAt: 0,
  lastError: '',
}

let FLYSMART_CACHE = {
  libraryKey: '',
  meta: null,
  vectors: null, // Float32Array
}

let FLYSMART_DIALOG = null
let FLYSMART_STATUS_HOOK = null // (status)=>void，用于设置窗口实时刷新
let FLYSMART_NOTIFY_ID = ''
let FLYSMART_NOTIFY_LAST_AT = 0
let FLYSMART_LOG_HOOK = null // ({text,filePath})=>void，用于设置窗口实时刷新日志
let FLYSMART_LOG = {
  filePath: '',
  writeMode: 'overwrite', // overwrite | append
  lines: [],
  pending: [], // 等待落盘的新增行（append 模式用它做“历史追加”）
  maxLines: 240,
  flushTimer: 0,
}

let FLYSMART_WATCH_DISPOSERS = [] // (()=>void)[]
let FLYSMART_INCR_QUEUE = [] // string[]
let FLYSMART_INCR_SET = new Set() // Set<string>
let FLYSMART_INCR_TIMER = 0
let FLYSMART_INCR_RUNNING = false

function nowMs() {
  try { return Date.now() } catch { return 0 }
}

function fmtTimeHHMMSS(t) {
  try {
    const d = new Date(typeof t === 'number' ? t : Date.now())
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch {
    return ''
  }
}

function safeJson(x) {
  try {
    const s = JSON.stringify(x)
    if (!s) return ''
    return s.length > 600 ? s.slice(0, 600) + '…' : s
  } catch {
    return ''
  }
}

function pushLogLine(line) {
  try {
    const s = String(line || '').trimEnd()
    if (!s) return
    FLYSMART_LOG.lines.push(s)
    try {
      FLYSMART_LOG.pending.push(s)
    } catch {}
    const max = FLYSMART_LOG.maxLines | 0
    if (max > 0 && FLYSMART_LOG.lines.length > max) {
      FLYSMART_LOG.lines.splice(0, FLYSMART_LOG.lines.length - max)
    }
    if (FLYSMART_LOG_HOOK && typeof FLYSMART_LOG_HOOK === 'function') {
      try {
        FLYSMART_LOG_HOOK({
          text: FLYSMART_LOG.lines.join('\n'),
          filePath: FLYSMART_LOG.filePath,
        })
      } catch {}
    }
  } catch {}

  // 增量索引：根据 enabled/includeDirs 自动启用监听
  try { void refreshIncrementalWatch(context) } catch {}
}

async function flushLogNow(ctx) {
  try {
    if (!ctx) return
    if (!FLYSMART_LOG.filePath) return
    const mode = String(FLYSMART_LOG.writeMode || 'overwrite')
    if (
      mode === 'append' &&
      typeof ctx.appendTextFile === 'function'
    ) {
      const pending = Array.isArray(FLYSMART_LOG.pending)
        ? FLYSMART_LOG.pending
        : []
      if (!pending.length) return
      const text = pending.join('\n') + '\n'
      FLYSMART_LOG.pending = []
      await ctx.appendTextFile(FLYSMART_LOG.filePath, text)
      return
    }
    if (typeof ctx.writeTextFile !== 'function') return
    const text = FLYSMART_LOG.lines.join('\n') + '\n'
    FLYSMART_LOG.pending = []
    await ctx.writeTextFile(FLYSMART_LOG.filePath, text)
  } catch {}
}

function scheduleFlushLog(ctx) {
  try {
    if (!ctx) return
    if (!FLYSMART_LOG.filePath) return
    if (
      String(FLYSMART_LOG.writeMode || 'overwrite') === 'append' &&
      typeof ctx.appendTextFile !== 'function'
    ) {
      // 宿主不支持追加写入时降级为覆盖模式
      FLYSMART_LOG.writeMode = 'overwrite'
    }
    if (FLYSMART_LOG.flushTimer) return
    FLYSMART_LOG.flushTimer = setTimeout(() => {
      FLYSMART_LOG.flushTimer = 0
      void flushLogNow(ctx)
    }, 450)
  } catch {}
}

async function dbg(ctx, msg, extra, forceFlush) {
  try {
    const t = fmtTimeHHMMSS(Date.now())
    const base = `[${t}] ${String(msg || '').trim()}`
    const js = safeJson(extra)
    const line = js ? `${base} ${js}` : base
    pushLogLine(line)
    if (forceFlush) await flushLogNow(ctx)
    else scheduleFlushLog(ctx)
  } catch {}
}

async function withTimeout(promise, ms, label) {
  const timeoutMs =
    typeof ms === 'number' && Number.isFinite(ms) ? Math.max(1, Math.floor(ms)) : 15000
  if (!timeoutMs) return await promise
  let timer = null
  try {
    const p = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error((label ? String(label) : '操作') + '超时（' + timeoutMs + 'ms）'))
      }, timeoutMs)
    })
    return await Promise.race([promise, p])
  } finally {
    if (timer) {
      try { clearTimeout(timer) } catch {}
    }
  }
}

function decodeTextBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (!u8.length) return ''
  let enc = 'utf-8'
  let start = 0
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    enc = 'utf-8'
    start = 3
  } else if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
    enc = 'utf-16le'
    start = 2
  } else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
    enc = 'utf-16be'
    start = 2
  }
  const view = start ? u8.subarray(start) : u8
  try {
    if (typeof TextDecoder === 'function') {
      return new TextDecoder(enc, { fatal: false }).decode(view)
    }
  } catch {}
  // 兜底：把字节当作 latin1（不保证中文正确，但至少不会卡死）
  try {
    let s = ''
    const max = Math.min(view.length, 2000000)
    for (let i = 0; i < max; i++) s += String.fromCharCode(view[i])
    return s
  } catch {
    return ''
  }
}

async function readTextBestEffort(ctx, absPath, timeoutMs) {
  const p = String(absPath || '').trim()
  if (!p) return ''
  // 优先走二进制读取 + TextDecoder：绕开某些环境下 readTextFile 的异常/挂起
  try {
    if (ctx && typeof ctx.readFileBinary === 'function') {
      const bytes = await withTimeout(ctx.readFileBinary(p), timeoutMs || 15000, '读取文件')
      return decodeTextBytes(bytes)
    }
  } catch {}
  if (ctx && typeof ctx.readTextFile === 'function') {
    return await withTimeout(ctx.readTextFile(p), timeoutMs || 15000, '读取文件')
  }
  throw new Error('当前环境不支持读文件')
}

async function yieldToUi() {
  try {
    if (typeof requestAnimationFrame === 'function') {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      return
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function withDefaultStatusPatch(patch) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const out = {}
  if (typeof p.phase === 'string') out.phase = p.phase
  if (typeof p.processedFiles === 'number' && Number.isFinite(p.processedFiles)) {
    out.processedFiles = p.processedFiles
  }
  if (typeof p.processedChunks === 'number' && Number.isFinite(p.processedChunks)) {
    out.processedChunks = p.processedChunks
  }
  if (typeof p.batchesDone === 'number' && Number.isFinite(p.batchesDone)) {
    out.batchesDone = p.batchesDone
  }
  if (typeof p.batchesTotal === 'number' && Number.isFinite(p.batchesTotal)) {
    out.batchesTotal = p.batchesTotal
  }
  if (typeof p.lastProgressAt === 'number' && Number.isFinite(p.lastProgressAt)) {
    out.lastProgressAt = p.lastProgressAt
  }
  return out
}

function setStatus(patch) {
  try {
    const p = patch && typeof patch === 'object' ? patch : {}
    FLYSMART_STATUS = { ...FLYSMART_STATUS, ...p, ...withDefaultStatusPatch(p) }
    if (FLYSMART_STATUS_HOOK && typeof FLYSMART_STATUS_HOOK === 'function') {
      try { FLYSMART_STATUS_HOOK({ ...FLYSMART_STATUS }) } catch {}
    }
  } catch {}
}

function uiNotice(ctx, msg, level = 'ok', ms = 1800) {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.notice === 'function') {
      ctx.ui.notice(String(msg || ''), level, ms)
    }
  } catch {}
}

function uiShowNotify(ctx, text, opt) {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.showNotification === 'function') {
      return ctx.ui.showNotification(String(text || ''), opt || { type: 'info', duration: 0 })
    }
  } catch {}
  return ''
}

function uiHideNotify(ctx, id) {
  try {
    if (!id) return
    if (ctx && ctx.ui && typeof ctx.ui.hideNotification === 'function') {
      ctx.ui.hideNotification(id)
    }
  } catch {}
}

function updateLongNotify(ctx, text, force) {
  try {
    const t = String(text || '').trim()
    if (!t) return
    const now = nowMs()
    if (!force && now && FLYSMART_NOTIFY_LAST_AT && now - FLYSMART_NOTIFY_LAST_AT < 900) return
    FLYSMART_NOTIFY_LAST_AT = now
    if (FLYSMART_NOTIFY_ID) {
      uiHideNotify(ctx, FLYSMART_NOTIFY_ID)
      FLYSMART_NOTIFY_ID = ''
    }
    FLYSMART_NOTIFY_ID = uiShowNotify(ctx, t, { type: 'info', duration: 0 })
  } catch {}
}

function isWindowsPath(p) {
  const s = String(p || '')
  return /[a-zA-Z]:[\\/]/.test(s) || s.includes('\\')
}

function normalizePathForKey(p) {
  const raw = String(p || '').trim()
  const win = isWindowsPath(raw)
  let out = raw
    .replace(/[\\/]+$/, '')
    .replace(/[\\]+/g, '/')
    .replace(/\/+/g, '/')
  if (win) out = out.toLowerCase()
  return out
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5
  const prime = 0x01000193
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, prime)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

async function sha1Hex(str) {
  try {
    const c = typeof crypto !== 'undefined' ? crypto : null
    if (c && c.subtle && typeof c.subtle.digest === 'function') {
      const enc = new TextEncoder().encode(String(str || ''))
      const buf = await c.subtle.digest('SHA-1', enc)
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {}
  return fnv1aHex(String(str || ''))
}

function joinFs(base, name) {
  const b = String(base || '').replace(/[\\/]+$/, '')
  const sep = b.includes('\\') ? '\\' : '/'
  return b + sep + String(name || '').replace(/^[/\\]+/, '')
}

function joinAbs(root, relative) {
  const r = String(root || '').replace(/[\\/]+$/, '')
  const sep = r.includes('\\') ? '\\' : '/'
  const rel = String(relative || '')
    .replace(/^\/+/, '')
    .replace(/[\\]+/g, '/')
    .replace(/\//g, sep)
  return r + sep + rel
}

function normalizeDirPrefixes(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const it of list) {
    const raw = String(it || '').trim()
    if (!raw) continue
    const d = raw
      .replace(/[\\]+/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/^\.\//, '')
      .trim()
    if (!d) continue
    const key = d.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

function matchDirPrefix(relativePath, prefixes, caseInsensitive) {
  if (!prefixes || !prefixes.length) return false
  let rel = String(relativePath || '').replace(/[\\]+/g, '/')
  rel = rel.replace(/^\/+/, '').replace(/\/+$/, '')
  const relCmp = caseInsensitive ? rel.toLowerCase() : rel
  for (const raw of prefixes) {
    const p = caseInsensitive ? String(raw).toLowerCase() : String(raw)
    if (!p) continue
    if (relCmp === p) return true
    if (relCmp.startsWith(p + '/')) return true
  }
  return false
}

function normalizeExtensions(list) {
  const raw = Array.isArray(list) ? list : []
  const out = []
  const seen = new Set()
  for (const it of raw) {
    const ext = String(it || '')
      .trim()
      .replace(/^\./, '')
      .toLowerCase()
    if (!ext) continue
    if (seen.has(ext)) continue
    seen.add(ext)
    out.push(ext)
  }
  return out.length ? out : [...DEFAULT_CFG.includeExtensions]
}

function normalizeRelativePath(p) {
  return String(p || '')
    .replace(/[\\]+/g, '/')
    .replace(/^\/+/, '')
}

function shouldIndexRel(rel, cfg, caseInsensitive) {
  const r = normalizeRelativePath(rel)
  if (!r) return false
  const extList = normalizeExtensions(
    cfg && cfg.includeExtensions ? cfg.includeExtensions : [],
  )
  const allow = new Set(extList.map((x) => String(x || '').toLowerCase()))
  const nm = r.split('/').pop() || ''
  const ext = (nm.split('.').pop() || '').toLowerCase()
  if (allow.size > 0 && !allow.has(ext)) return false
  const includeDirs = normalizeDirPrefixes(cfg && cfg.includeDirs ? cfg.includeDirs : [])
  const excludeDirs = normalizeDirPrefixes(cfg && cfg.excludeDirs ? cfg.excludeDirs : [])
  if (matchDirPrefix(r, excludeDirs, caseInsensitive)) return false
  if (includeDirs.length > 0 && !matchDirPrefix(r, includeDirs, caseInsensitive)) return false
  return true
}

function stopIncrementalWatch() {
  try {
    for (const fn of FLYSMART_WATCH_DISPOSERS || []) {
      try { fn && fn() } catch {}
    }
  } catch {}
  FLYSMART_WATCH_DISPOSERS = []
}

async function refreshIncrementalWatch(ctx, cfgOverride) {
  stopIncrementalWatch()
  try {
    if (!ctx) return
    const cfg = cfgOverride || (await loadConfig(ctx))
    if (!cfg || !cfg.enabled) return
    if (typeof ctx.getLibraryRoot !== 'function') return
    const root = await ctx.getLibraryRoot()
    if (!root) return
    const caseInsensitive = isWindowsPath(root)
    const includeDirs = normalizeDirPrefixes(cfg.includeDirs || [])

    const onEvent = async (ev) => {
      try {
        const e = ev || {}
        const type = String(e.type || '')
        // 有些平台 create 不可靠：对“未索引过的文件”允许 modify 触发一次补偿
        const allowed = type === 'create' || type === 'modify' || type === 'any'
        if (!allowed) return
        const rels = Array.isArray(e.relatives) ? e.relatives : []
        for (const rawRel of rels) {
          const rel = normalizeRelativePath(rawRel)
          if (!rel) continue
          if (!shouldIndexRel(rel, cfg, caseInsensitive)) continue
          enqueueIncremental(rel)
        }
      } catch {}
    }

    // includeDirs 为空：监听整个库
    if (!includeDirs.length) {
      if (typeof ctx.watchLibrary === 'function') {
        const unwatch = await ctx.watchLibrary(onEvent, { recursive: true, immediate: true })
        if (typeof unwatch === 'function') FLYSMART_WATCH_DISPOSERS.push(unwatch)
      }
      return
    }

    // includeDirs 非空：尽量只监听这些目录，避免全库噪音
    if (typeof ctx.watchPaths !== 'function') return
    for (const d of includeDirs) {
      try {
        const abs = joinAbs(root, d)
        if (typeof ctx.exists === 'function') {
          const ok = await ctx.exists(abs)
          if (!ok) continue
        }
        const unwatch = await ctx.watchPaths(abs, onEvent, {
          base: 'absolute',
          recursive: true,
          immediate: true,
        })
        if (typeof unwatch === 'function') FLYSMART_WATCH_DISPOSERS.push(unwatch)
      } catch {}
    }
  } catch {}
}

function enqueueIncremental(rel) {
  try {
    const r = normalizeRelativePath(rel)
    if (!r) return
    if (FLYSMART_INCR_SET.has(r)) return
    FLYSMART_INCR_SET.add(r)
    FLYSMART_INCR_QUEUE.push(r)
    if (FLYSMART_INCR_TIMER) return
    FLYSMART_INCR_TIMER = setTimeout(() => {
      FLYSMART_INCR_TIMER = 0
      void runIncrementalQueue()
    }, 420)
  } catch {}
}

async function runIncrementalQueue() {
  if (FLYSMART_INCR_RUNNING) return
  if (FLYSMART_BUSY) {
    try {
      if (!FLYSMART_INCR_TIMER) {
        FLYSMART_INCR_TIMER = setTimeout(() => {
          FLYSMART_INCR_TIMER = 0
          void runIncrementalQueue()
        }, 800)
      }
    } catch {}
    return
  }
  const ctx = FLYSMART_CTX
  if (!ctx) return
  if (!FLYSMART_INCR_QUEUE.length) return
  FLYSMART_INCR_RUNNING = true
  try {
    while (FLYSMART_INCR_QUEUE.length) {
      const rel = FLYSMART_INCR_QUEUE.shift()
      try { FLYSMART_INCR_SET.delete(rel) } catch {}
      if (!rel) continue
      try {
        await incrementalIndexOne(ctx, rel)
      } catch (e) {
        try {
          await dbg(
            ctx,
            '增量索引失败',
            { rel, error: e && e.message ? String(e.message) : String(e) },
            true,
          )
        } catch {}
      }
      await yieldToUi()
    }
  } finally {
    FLYSMART_INCR_RUNNING = false
  }
}

function normalizeConfig(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const out = {
    ...DEFAULT_CFG,
    ...c,
  }
  out.enabled = !!out.enabled
  out.includeExtensions = normalizeExtensions(out.includeExtensions)
  out.includeDirs = normalizeDirPrefixes(out.includeDirs)
  out.excludeDirs = normalizeDirPrefixes(out.excludeDirs)
  out.maxDepth =
    typeof out.maxDepth === 'number' && Number.isFinite(out.maxDepth)
      ? Math.max(0, Math.floor(out.maxDepth))
      : DEFAULT_CFG.maxDepth
  out.chunk = {
    ...DEFAULT_CFG.chunk,
    ...(out.chunk && typeof out.chunk === 'object' ? out.chunk : {}),
  }
  out.chunk.maxChars =
    typeof out.chunk.maxChars === 'number' && Number.isFinite(out.chunk.maxChars)
      ? Math.max(200, Math.floor(out.chunk.maxChars))
      : DEFAULT_CFG.chunk.maxChars
  out.chunk.overlapChars =
    typeof out.chunk.overlapChars === 'number' &&
    Number.isFinite(out.chunk.overlapChars)
      ? Math.max(0, Math.floor(out.chunk.overlapChars))
      : DEFAULT_CFG.chunk.overlapChars
  out.chunk.byHeading = !!out.chunk.byHeading
  out.embedding =
    out.embedding && typeof out.embedding === 'object' ? out.embedding : {}
  out.embedding.provider = String(
    out.embedding.provider || DEFAULT_CFG.embedding.provider,
  ).trim()
  if (out.embedding.provider !== 'custom' && out.embedding.provider !== 'reuse-ai-assistant') {
    out.embedding.provider = DEFAULT_CFG.embedding.provider
  }
  out.embedding.baseUrl = String(out.embedding.baseUrl || '').trim()
  out.embedding.apiKey = String(out.embedding.apiKey || '').trim()
  out.embedding.model = String(
    out.embedding.model || DEFAULT_CFG.embedding.model,
  ).trim()
  if (!out.embedding.model) out.embedding.model = DEFAULT_CFG.embedding.model
  out.search = {
    ...DEFAULT_CFG.search,
    ...(out.search && typeof out.search === 'object' ? out.search : {}),
  }
  out.search.topK =
    typeof out.search.topK === 'number' && Number.isFinite(out.search.topK)
      ? Math.max(1, Math.min(50, Math.floor(out.search.topK)))
      : DEFAULT_CFG.search.topK
  out.search.minScore =
    typeof out.search.minScore === 'number' && Number.isFinite(out.search.minScore)
      ? Math.max(-1, Math.min(1, Number(out.search.minScore)))
      : DEFAULT_CFG.search.minScore
  out.search.contextMaxChars =
    typeof out.search.contextMaxChars === 'number' && Number.isFinite(out.search.contextMaxChars)
      ? Math.max(200, Math.min(20000, Math.floor(out.search.contextMaxChars)))
      : DEFAULT_CFG.search.contextMaxChars
  return out
}

async function getLibraryRootRequired(ctx) {
  if (!ctx || typeof ctx.getLibraryRoot !== 'function') {
    throw new Error('当前环境不支持库能力')
  }
  const root = await ctx.getLibraryRoot()
  if (!root) throw new Error('当前未打开任何库')
  return String(root)
}

async function getLibraryKey(ctx) {
  const root = await getLibraryRootRequired(ctx)
  return await sha1Hex(normalizePathForKey(root))
}

async function loadCfgMap(ctx) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return {}
    const raw = await ctx.storage.get(CFG_KEY)
    if (raw && typeof raw === 'object') return raw
  } catch {}
  return {}
}

async function loadConfig(ctx) {
  const libraryKey = await getLibraryKey(ctx)
  const map = await loadCfgMap(ctx)
  const raw =
    map &&
    typeof map === 'object' &&
    map[libraryKey] &&
    typeof map[libraryKey] === 'object'
      ? map[libraryKey]
      : {}
  const cfg = normalizeConfig({ ...DEFAULT_CFG, ...raw })
  cfg.libraryKey = libraryKey
  return cfg
}

async function saveConfig(ctx, patch) {
  const libraryKey = await getLibraryKey(ctx)
  const map = await loadCfgMap(ctx)
  const cur =
    map &&
    typeof map === 'object' &&
    map[libraryKey] &&
    typeof map[libraryKey] === 'object'
      ? map[libraryKey]
      : {}
  const next = normalizeConfig({ ...DEFAULT_CFG, ...cur, ...(patch || {}) })
  next.libraryKey = libraryKey
  const out = map && typeof map === 'object' ? map : {}
  out[libraryKey] = next
  if (!ctx || !ctx.storage || typeof ctx.storage.set !== 'function') {
    throw new Error('当前环境不支持保存配置')
  }
  await ctx.storage.set(CFG_KEY, out)
  return next
}

async function getEmbeddingConnFromAiAssistant(ctx) {
  if (!ctx || typeof ctx.getPluginAPI !== 'function') {
    throw new Error('当前环境不支持插件 API')
  }
  const api = ctx.getPluginAPI('ai-assistant')
  if (!api || typeof api.getConfig !== 'function') {
    throw new Error('未找到 AI 助手插件（ai-assistant），请先安装并启用')
  }
  const cfg = await api.getConfig()
  const provider = String(cfg && cfg.provider ? cfg.provider : '')
  if (provider === 'free') {
    throw new Error(
      'AI 助手当前为免费模式，Embedding 暂不支持；请切换到自定义供应商并配置 API Key',
    )
  }
  const baseUrl = String(cfg && cfg.baseUrl ? cfg.baseUrl : '').trim()
  const apiKey = String(cfg && cfg.apiKey ? cfg.apiKey : '').trim()
  if (!baseUrl) throw new Error('AI 助手 baseUrl 为空')
  return { baseUrl, apiKey }
}

async function getEmbeddingConn(ctx, vecCfg) {
  // 兼容两种入参：
  // 1) 传入完整 cfg（包含 cfg.embedding）
  // 2) 直接传入 embedding 配置对象（cfg.embedding）
  let emb = {}
  if (vecCfg && typeof vecCfg === 'object') {
    if (vecCfg.embedding && typeof vecCfg.embedding === 'object') emb = vecCfg.embedding
    else emb = vecCfg
  }
  const provider = String(emb.provider || 'reuse-ai-assistant').trim()
  if (provider === 'custom') {
    const baseUrl = String(emb.baseUrl || '').trim()
    const apiKey = String(emb.apiKey || '').trim()
    if (!baseUrl) throw new Error('Embedding baseUrl 为空（自定义模式）')
    return { baseUrl, apiKey }
  }
  return await getEmbeddingConnFromAiAssistant(ctx)
}

function isVoyageBaseUrl(baseUrl) {
  return /voyageai\.com/i.test(String(baseUrl || ''))
}

function ensureVoyageV1Base(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  if (/\/v1$/i.test(raw)) return raw
  return raw + '/v1'
}

async function fetchEmbeddings(conn, model, inputs, opt) {
  const rawBase = String(conn && conn.baseUrl ? conn.baseUrl : '').trim()
  const base0 = rawBase.replace(/\/+$/, '')
  const isVoyage = isVoyageBaseUrl(base0)
  const base = isVoyage ? ensureVoyageV1Base(base0) : base0
  const url = base + '/embeddings'
  const headers = { 'Content-Type': 'application/json' }
  if (conn && conn.apiKey) headers.Authorization = 'Bearer ' + conn.apiKey
  const m = String(model || '').trim()
  if (!m) throw new Error('Embedding model 为空')
  const body = { model: m, input: inputs }
  const inputType = opt && opt.inputType ? String(opt.inputType).trim() : ''
  if (isVoyage && (inputType === 'query' || inputType === 'document')) {
    body.input_type = inputType
  }
  const timeoutMs =
    opt && typeof opt.timeoutMs === 'number' && Number.isFinite(opt.timeoutMs)
      ? Math.max(1000, Math.floor(opt.timeoutMs))
      : 60000

  // 避免“网络卡住导致无限等待”，给 embedding 请求加超时
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  if (ctrl) {
    try {
      timer = setTimeout(() => {
        try { ctrl.abort() } catch {}
      }, timeoutMs)
    } catch {
      timer = null
    }
  }
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    })
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'Embedding 请求超时' : 'Embedding 请求失败'
    throw new Error(msg + '：' + (e && e.message ? e.message : String(e)))
  } finally {
    if (timer) {
      try { clearTimeout(timer) } catch {}
    }
  }

  if (!res.ok) {
    let msg = 'Embedding 调用失败：' + res.status
    try {
      const t = await res.text()
      if (t) msg += ' ' + t.slice(0, 300)
    } catch {}
    throw new Error(msg)
  }

  const json = await res.json()
  const arr = json && Array.isArray(json.data) ? json.data : []
  const out = arr.map((x) =>
    x && Array.isArray(x.embedding) ? x.embedding : null,
  )
  if (!out.length) throw new Error('Embedding 返回为空')
  return out
}

function isFenceToggleLine(line) {
  return /^\s{0,3}(```|~~~)/.test(String(line || ''))
}

function parseAtxHeadingLine(line) {
  const m = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/)
  if (!m) return null
  const level = (m[1] || '').length | 0
  let text = String(m[2] || '').trim()
  // 兼容 "## Title ###" 这种尾部收尾
  text = text.replace(/\s+#+\s*$/, '').trim()
  if (!text) return null
  return { level, text }
}

function splitMarkdownBlocks(lines, minLevel) {
  const out = []
  const len = Array.isArray(lines) ? lines.length : 0
  if (!len) return out

  const heads = []
  let inFence = false
  for (let i = 0; i < len; i++) {
    const ln = String(lines[i] || '')
    if (isFenceToggleLine(ln)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = parseAtxHeadingLine(ln)
    if (!h) continue
    if (h.level >= (minLevel | 0)) {
      heads.push({ i, level: h.level, text: h.text })
    }
  }

  // 没有二级及以下标题：整个文档当作一个块
  if (!heads.length) {
    out.push({ start: 0, end: len - 1, heading: '', level: 0 })
    return out
  }

  let start = 0
  let heading = ''
  let level = 0
  for (const h of heads) {
    if (h.i > start) {
      out.push({ start, end: h.i - 1, heading, level })
    }
    start = h.i
    heading = String(h.text || '')
    level = h.level | 0
  }
  out.push({ start, end: len - 1, heading, level })
  return out
}

function chunkLineRange(lines, startIdx, endIdx, maxChars, overlap) {
  const chunks = []
  const len = Array.isArray(lines) ? lines.length : 0
  if (!len) return chunks
  const max = Math.max(200, maxChars | 0)
  const ov = Math.max(0, overlap | 0)

  let start = Math.max(0, startIdx | 0)
  const endLimit = Math.min(len - 1, endIdx | 0)
  while (start <= endLimit) {
    let end = start
    let cur = 0
    while (end <= endLimit) {
      const add = String(lines[end] || '').length + 1
      if (cur > 0 && cur + add > max) break
      cur += add
      end++
    }
    if (end <= start) end = Math.min(endLimit + 1, start + 1)
    const text = lines.slice(start, end).join('\n').trim()
    if (text) chunks.push({ startIdx: start, endIdx: end - 1, text })
    if (end > endLimit) break
    if (!ov) {
      start = end
      continue
    }
    let back = end
    let backLen = 0
    while (back > start && backLen < ov) {
      back--
      backLen += String(lines[back] || '').length + 1
    }
    // 关键：必须保证 start 前进，否则会死循环卡死 UI
    const nextStart = Math.max(startIdx | 0, back)
    start = nextStart > start ? nextStart : end
  }
  return chunks
}

function splitParagraphRanges(lines, startIdx, endIdx) {
  const out = []
  const len = Array.isArray(lines) ? lines.length : 0
  if (!len) return out
  let s = -1
  const a = Math.max(0, startIdx | 0)
  const b = Math.min(len - 1, endIdx | 0)
  for (let i = a; i <= b; i++) {
    const blank = !String(lines[i] || '').trim()
    if (blank) {
      if (s >= 0) out.push([s, i - 1])
      s = -1
      continue
    }
    if (s < 0) s = i
  }
  if (s >= 0) out.push([s, b])
  return out
}

function chunkMarkdownRange(lines, startIdx, endIdx, maxChars, overlap) {
  const chunks = []
  const paras = splitParagraphRanges(lines, startIdx, endIdx)
  if (!paras.length) return chunks
  const max = Math.max(200, maxChars | 0)

  let curStart = -1
  let curEnd = -1
  let curLen = 0

  const push = () => {
    if (curStart < 0 || curEnd < curStart) return
    const text = lines.slice(curStart, curEnd + 1).join('\n').trim()
    if (text) chunks.push({ startIdx: curStart, endIdx: curEnd, text })
    curStart = -1
    curEnd = -1
    curLen = 0
  }

  for (const pr of paras) {
    const ps = pr[0] | 0
    const pe = pr[1] | 0
    const pText = lines.slice(ps, pe + 1).join('\n').trim()
    if (!pText) continue
    if (pText.length > max) {
      push()
      const parts = chunkLineRange(lines, ps, pe, max, overlap)
      for (const it of parts) {
        if (it && it.text) chunks.push(it)
      }
      continue
    }
    const add = pText.length + (curLen > 0 ? 2 : 0)
    if (curLen > 0 && curLen + add > max) {
      push()
    }
    if (curLen === 0) curStart = ps
    curEnd = pe
    curLen += add
  }
  push()
  return chunks
}

function chunkByLines(lines, opt) {
  const maxChars = opt && opt.maxChars ? Math.max(200, opt.maxChars | 0) : 512
  const overlap =
    opt && opt.overlapChars ? Math.max(0, opt.overlapChars | 0) : 0
  const byHeading = !!(opt && opt.byHeading)

  const chunks = []
  const blocks = byHeading ? splitMarkdownBlocks(lines, 2) : [{ start: 0, end: (lines || []).length - 1, heading: '', level: 0 }]
  for (const b of blocks) {
    if (!b || b.end < b.start) continue
    const parts = chunkMarkdownRange(lines, b.start, b.end, maxChars, overlap)
    for (const it of parts) {
      if (!it || !it.text) continue
      chunks.push({
        startLine: (it.startIdx | 0) + 1,
        endLine: (it.endIdx | 0) + 1,
        heading: String(b.heading || ''),
        text: String(it.text || ''),
      })
    }
  }
  return chunks
}

function buildChunkId(relativePath, startLine, endLine, text) {
  const rel = String(relativePath || '').replace(/[\\]+/g, '/')
  const a = Math.max(1, startLine | 0)
  const b = Math.max(a, endLine | 0)
  const h = fnv1aHex(String(text || ''))
  return `${rel}:${a}-${b}:${h}`
}

async function readJsonMaybe(ctx, absPath) {
  try {
    const raw = await ctx.readTextFile(absPath)
    return JSON.parse(String(raw || ''))
  } catch {
    return null
  }
}

async function loadIndexFromDisk(ctx, cfg) {
  const dataDir = await ctx.getPluginDataDir()
  const metaPath = joinFs(dataDir, META_FILE)
  const vecPath = joinFs(dataDir, VEC_FILE)
  const meta = await readJsonMaybe(ctx, metaPath)
  if (!meta || meta.schemaVersion !== SCHEMA_VERSION) return null
  if (meta.embeddingModel !== cfg.embedding.model) return null

  const bytes = await ctx.readFileBinary(vecPath)
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
  if (ab.byteLength % 4 !== 0) throw new Error('向量文件损坏（长度不是 4 的倍数）')
  const vectors = new Float32Array(ab)

  const dims = meta.dims | 0
  if (!dims || vectors.length % dims !== 0) {
    throw new Error('向量文件与 meta 不匹配')
  }

  return { meta, vectors }
}

async function ensureIndexLoaded(ctx, cfg) {
  const libraryKey = cfg.libraryKey || (await getLibraryKey(ctx))
  if (
    FLYSMART_CACHE &&
    FLYSMART_CACHE.libraryKey === libraryKey &&
    FLYSMART_CACHE.meta &&
    FLYSMART_CACHE.vectors
  ) {
    return FLYSMART_CACHE
  }
  const loaded = await loadIndexFromDisk(ctx, cfg)
  if (!loaded) return null
  FLYSMART_CACHE = { libraryKey, meta: loaded.meta, vectors: loaded.vectors }
  return FLYSMART_CACHE
}

function cosineScoreAt(vectors, offset, query, dims, queryNorm) {
  let dot = 0
  let vv = 0
  const base = offset | 0
  for (let i = 0; i < dims; i++) {
    const v = vectors[base + i]
    dot += v * query[i]
    vv += v * v
  }
  const denom = Math.sqrt(vv) * queryNorm
  if (!denom) return 0
  return dot / denom
}

async function buildIndex(ctx) {
  if (FLYSMART_BUSY) throw new Error('正在执行任务，请稍后重试')
  FLYSMART_BUSY = true
  setStatus({
    state: 'indexing',
    phase: 'init',
    lastError: '',
    processedFiles: 0,
    processedChunks: 0,
    batchesDone: 0,
    batchesTotal: 0,
    lastProgressAt: nowMs(),
    currentFile: '',
  })

  try {
    if (!ctx) throw new Error('插件未激活')
    if (typeof ctx.getPluginDataDir !== 'function') {
      throw new Error('宿主版本过老：缺少 getPluginDataDir')
    }
    if (typeof ctx.writeFileBinary !== 'function') {
      throw new Error('宿主版本过老：缺少 writeFileBinary')
    }
    if (typeof ctx.listLibraryFiles !== 'function') {
      throw new Error('宿主版本过老：缺少 listLibraryFiles')
    }

    const cfg = await loadConfig(ctx)
    if (!cfg.enabled) {
      throw new Error('知识库索引默认关闭，请在设置中开启 enabled')
    }

    const libraryRoot = await getLibraryRootRequired(ctx)
    const caseInsensitive = isWindowsPath(libraryRoot)
    const cfgKey = cfg.libraryKey || (await sha1Hex(normalizePathForKey(libraryRoot)))
    const dataDir = await ctx.getPluginDataDir()
    FLYSMART_LOG.filePath = joinFs(dataDir, INDEX_LOG_FILE)
    FLYSMART_LOG.writeMode = 'overwrite'
    FLYSMART_LOG.lines = []
    FLYSMART_LOG.pending = []
    await dbg(
      ctx,
      '开始重建索引',
      {
        libraryRoot,
        includeDirs: cfg.includeDirs || [],
        excludeDirs: cfg.excludeDirs || [],
        model: cfg.embedding && cfg.embedding.model ? cfg.embedding.model : '',
        provider: cfg.embedding && cfg.embedding.provider ? cfg.embedding.provider : '',
        baseUrl:
          cfg.embedding && cfg.embedding.provider === 'custom'
            ? String(cfg.embedding.baseUrl || '')
            : 'reuse-ai-assistant',
      },
      true,
    )

    updateLongNotify(ctx, 'flymd-RAG：正在扫描文件…', true)
    setStatus({ phase: 'scan', lastProgressAt: nowMs() })
    await yieldToUi()

    const conn = await getEmbeddingConn(ctx, cfg)
    const tScan0 = nowMs()
    let files = await ctx.listLibraryFiles({
      extensions: cfg.includeExtensions,
      maxDepth: cfg.maxDepth,
      includeDirs: cfg.includeDirs,
      excludeDirs: cfg.excludeDirs,
    })
    // 兼容旧宿主：若宿主未实现 includeDirs，这里做一次兜底过滤
    if (cfg.includeDirs && cfg.includeDirs.length) {
      files = (files || []).filter((f) =>
        matchDirPrefix(String(f && f.relative ? f.relative : ''), cfg.includeDirs, caseInsensitive),
      )
    }
    const totalFiles = (files || []).length
    await dbg(
      ctx,
      '扫描文件完成',
      { totalFiles, ms: Math.max(0, nowMs() - tScan0) },
      true,
    )

    setStatus({
      totalFiles,
      totalChunks: 0,
      processedFiles: 0,
      processedChunks: 0,
      phase: 'chunk',
      lastProgressAt: nowMs(),
    })

    const allChunks = []
    const fileToChunkIds = {}
    let processedFiles = 0

    for (const f of files || []) {
      const rel = String(f.relative || '')
      setStatus({ phase: 'read', currentFile: rel, lastProgressAt: nowMs() })
      updateLongNotify(
        ctx,
        `flymd-RAG：读取中 ${Math.min(processedFiles + 1, totalFiles)}/${totalFiles}（${rel}）`,
      )
      await yieldToUi()
      let text = ''
      try {
        await dbg(ctx, '读取文件开始', { rel }, true)
        const tRead0 = nowMs()
        text = await readTextBestEffort(ctx, f.path, 6000)
        await dbg(
          ctx,
          '读取文件结束',
          { rel, chars: String(text || '').length, ms: Math.max(0, nowMs() - tRead0) },
          false,
        )
      } catch (e) {
        await dbg(
          ctx,
          '读取文件失败',
          { rel, error: e && e.message ? String(e.message) : String(e) },
          true,
        )
        processedFiles++
        setStatus({
          processedFiles,
          totalChunks: allChunks.length,
          processedChunks: allChunks.length,
          phase: 'chunk',
          lastProgressAt: nowMs(),
        })
        updateLongNotify(
          ctx,
          `flymd-RAG：分块中 ${processedFiles}/${totalFiles}（chunks=${allChunks.length}）`,
        )
        await yieldToUi()
        continue
      }
      // 防止极端大文件把 UI/内存拖死：第一版宁可跳过也别假死
      const maxFileChars = 5_000_000
      if (String(text || '').length > maxFileChars) {
        await dbg(ctx, '跳过超大文件', { rel, chars: String(text || '').length }, true)
        processedFiles++
        setStatus({
          processedFiles,
          totalChunks: allChunks.length,
          processedChunks: allChunks.length,
          phase: 'chunk',
          lastProgressAt: nowMs(),
        })
        uiNotice(ctx, `跳过超大文件：${rel}`, 'err', 2400)
        updateLongNotify(
          ctx,
          `flymd-RAG：分块中 ${processedFiles}/${totalFiles}（chunks=${allChunks.length}，已跳过超大文件）`,
        )
        await yieldToUi()
        continue
      }
      const lines = String(text || '').split(/\r?\n/)
      const parts = chunkByLines(lines, cfg.chunk)
      await dbg(ctx, '分块完成', { rel, chunks: parts.length }, false)
      const ids = []
      for (const c of parts) {
        const id = buildChunkId(rel, c.startLine, c.endLine, c.text)
        ids.push(id)
        allChunks.push({
          id,
          relativePath: rel,
          heading: c.heading || '',
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
        })
      }
      fileToChunkIds[rel] = ids
      processedFiles++
      setStatus({
        processedFiles,
        totalChunks: allChunks.length,
        processedChunks: allChunks.length,
        phase: 'chunk',
        lastProgressAt: nowMs(),
      })
      updateLongNotify(
        ctx,
        `flymd-RAG：分块中 ${processedFiles}/${totalFiles}（chunks=${allChunks.length}）`,
      )
      await yieldToUi()
    }

    const metaPath = joinFs(dataDir, META_FILE)
    const vecPath = joinFs(dataDir, VEC_FILE)

    if (!allChunks.length) {
      updateLongNotify(ctx, 'flymd-RAG：未发现可索引内容（写入空索引）…', true)
      setStatus({ phase: 'write', lastProgressAt: nowMs() })
      await yieldToUi()
      await ctx.writeFileBinary(vecPath, new Uint8Array())
      const emptyMeta = {
        schemaVersion: SCHEMA_VERSION,
        libraryKey: cfgKey,
        embeddingModel: cfg.embedding.model,
        dims: 0,
        builtAt: Date.now(),
        files: {},
        chunks: {},
      }
      await ctx.writeTextFile(metaPath, JSON.stringify(emptyMeta, null, 2))
      setStatus({ state: 'idle', lastIndexedAt: Date.now() })
      FLYSMART_CACHE = {
        libraryKey: cfgKey,
        meta: emptyMeta,
        vectors: new Float32Array(),
      }
      uiNotice(ctx, 'flymd-RAG：索引重建完成（空）', 'ok', 1600)
      return
    }

    const texts = allChunks.map((c) => c.text)
    const batchSize = 16
    let dims = 0
    let flat = null
    const batchesTotal = Math.ceil(texts.length / batchSize)
    let batchesDone = 0

    setStatus({
      phase: 'embed',
      batchesDone,
      batchesTotal,
      processedChunks: 0,
      totalChunks: texts.length,
      lastProgressAt: nowMs(),
    })
    updateLongNotify(
      ctx,
      `flymd-RAG：向量化 0/${batchesTotal}（0/${texts.length}）`,
      true,
    )
    await yieldToUi()

    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize)
      const tEmb0 = nowMs()
      await dbg(ctx, 'Embedding 请求', { batch: batchesDone + 1, size: slice.length }, true)
      const embs = await fetchEmbeddings(conn, cfg.embedding.model, slice, {
        inputType: 'document',
        timeoutMs: 60000,
      })
      await dbg(
        ctx,
        'Embedding 返回',
        { batch: batchesDone + 1, size: embs.length, ms: Math.max(0, nowMs() - tEmb0) },
        true,
      )
      if (embs.length !== slice.length) {
        throw new Error('Embedding 返回数量不匹配')
      }
      for (const e of embs) {
        if (!Array.isArray(e) || !e.length) {
          throw new Error('Embedding 返回格式异常')
        }
        if (!dims) {
          dims = e.length
          flat = new Float32Array(texts.length * dims)
        }
        if (e.length !== dims) throw new Error('Embedding 维度不一致')
      }

      // 写入本 batch 的向量：避免额外 vecList + 二次拷贝，降低内存峰值
      if (!flat || !dims) throw new Error('Embedding 初始化失败')
      for (let j = 0; j < embs.length; j++) {
        const e = embs[j]
        flat.set(e, (i + j) * dims)
      }

      batchesDone++
      setStatus({
        phase: 'embed',
        batchesDone,
        batchesTotal,
        processedChunks: Math.min(i + slice.length, texts.length),
        totalChunks: texts.length,
        lastProgressAt: nowMs(),
      })
      updateLongNotify(
        ctx,
        `flymd-RAG：向量化 ${batchesDone}/${batchesTotal}（${Math.min(
          i + slice.length,
          texts.length,
        )}/${texts.length}）`,
      )
      await yieldToUi()
    }

    if (!flat || !dims) throw new Error('Embedding 结果为空')

    const meta = {
      schemaVersion: SCHEMA_VERSION,
      libraryKey: cfgKey,
      embeddingModel: cfg.embedding.model,
      dims,
      builtAt: Date.now(),
      files: {},
      chunks: {},
    }

    setStatus({ phase: 'write', lastProgressAt: nowMs() })
    updateLongNotify(ctx, 'flymd-RAG：写入索引文件…', true)
    await yieldToUi()
    await dbg(ctx, '写入索引文件', { metaPath: joinFs(dataDir, META_FILE), vecPath: joinFs(dataDir, VEC_FILE) }, true)

    for (let i = 0; i < allChunks.length; i++) {
      const c = allChunks[i]
      meta.chunks[c.id] = {
        relativePath: c.relativePath,
        heading: c.heading || '',
        startLine: c.startLine,
        endLine: c.endLine,
        vectorOffset: i * dims,
      }
    }

    for (const f of files || []) {
      const rel = String(f.relative || '')
      if (!Object.prototype.hasOwnProperty.call(fileToChunkIds, rel)) continue
      meta.files[rel] = {
        mtimeMs: typeof f.mtime === 'number' ? f.mtime : 0,
        chunkIds: fileToChunkIds[rel] || [],
      }
    }

    await ctx.writeFileBinary(vecPath, new Uint8Array(flat.buffer))
    await ctx.writeTextFile(metaPath, JSON.stringify(meta, null, 2))
    await dbg(ctx, '索引写入完成', { totalFiles, totalChunks: allChunks.length, dims }, true)

    setStatus({
      state: 'idle',
      totalFiles,
      totalChunks: allChunks.length,
      lastIndexedAt: Date.now(),
      lastError: '',
      currentFile: '',
    })
    FLYSMART_CACHE = { libraryKey: cfgKey, meta, vectors: flat }
    uiNotice(ctx, 'flymd-RAG：索引重建完成', 'ok', 1600)
  } catch (e) {
    setStatus({
      state: 'error',
      lastError: e && e.message ? String(e.message) : String(e),
    })
    await dbg(
      ctx,
      '索引失败',
      { error: e && e.message ? String(e.message) : String(e) },
      true,
    )
    try {
      uiNotice(ctx, 'flymd-RAG：索引失败：' + (e && e.message ? e.message : String(e)), 'err', 2600)
    } catch {}
    throw e
  } finally {
    FLYSMART_BUSY = false
    try {
      uiHideNotify(ctx, FLYSMART_NOTIFY_ID)
    } catch {}
    FLYSMART_NOTIFY_ID = ''
    FLYSMART_NOTIFY_LAST_AT = 0
  }
}

async function incrementalIndexOne(ctx, relativePath) {
  if (!ctx) return
  if (FLYSMART_BUSY) return
  FLYSMART_BUSY = true
  try {
    const cfg = await loadConfig(ctx)
    if (!cfg || !cfg.enabled) return
    const libraryRoot = await getLibraryRootRequired(ctx)
    const caseInsensitive = isWindowsPath(libraryRoot)
    const rel = normalizeRelativePath(relativePath)
    if (!shouldIndexRel(rel, cfg, caseInsensitive)) return

    if (typeof ctx.getPluginDataDir !== 'function') {
      throw new Error('宿主版本过老：缺少 getPluginDataDir')
    }
    if (typeof ctx.writeFileBinary !== 'function') {
      throw new Error('宿主版本过老：缺少 writeFileBinary')
    }
    if (typeof ctx.writeTextFile !== 'function') {
      throw new Error('宿主版本过老：缺少 writeTextFile')
    }

    const cfgKey =
      cfg.libraryKey || (await sha1Hex(normalizePathForKey(libraryRoot)))
    const dataDir = await ctx.getPluginDataDir()
    const metaPath = joinFs(dataDir, META_FILE)
    const vecPath = joinFs(dataDir, VEC_FILE)

    // 增量日志：历史追加
    FLYSMART_LOG.filePath = joinFs(dataDir, INDEX_LOG_FILE)
    FLYSMART_LOG.writeMode = 'append'
    FLYSMART_LOG.pending = []

    setStatus({
      state: 'indexing',
      phase: 'incremental',
      lastError: '',
      lastProgressAt: nowMs(),
      currentFile: rel,
    })

    // 读取现有 meta，决定能否增量
    let meta = null
    try {
      if (typeof ctx.exists === 'function') {
        const ok = await ctx.exists(metaPath)
        if (ok) meta = await readJsonMaybe(ctx, metaPath)
      } else {
        meta = await readJsonMaybe(ctx, metaPath)
      }
    } catch {
      meta = null
    }

    if (meta && meta.schemaVersion !== SCHEMA_VERSION) {
      throw new Error('索引版本不兼容，请点击“重建索引”')
    }
    if (meta && meta.embeddingModel && meta.embeddingModel !== cfg.embedding.model) {
      throw new Error('Embedding 模型已变化，请点击“重建索引”')
    }

    let vectors = null
    if (meta) {
      let loaded = null
      try {
        loaded = await ensureIndexLoaded(ctx, cfg)
      } catch {
        loaded = null
      }
      if (!loaded || !loaded.meta || !loaded.vectors) {
        throw new Error('读取索引失败，请点击“重建索引”')
      }
      meta = loaded.meta
      vectors = loaded.vectors
    } else {
      meta = {
        schemaVersion: SCHEMA_VERSION,
        libraryKey: cfgKey,
        embeddingModel: cfg.embedding.model,
        dims: 0,
        builtAt: 0,
        updatedAt: Date.now(),
        files: {},
        chunks: {},
      }
      vectors = new Float32Array()
    }

    if (!meta.files || typeof meta.files !== 'object') meta.files = {}
    if (!meta.chunks || typeof meta.chunks !== 'object') meta.chunks = {}

    if (Object.prototype.hasOwnProperty.call(meta.files, rel)) {
      await dbg(ctx, '增量索引：已存在，跳过', { rel }, true)
      return
    }

    const absPath = joinAbs(libraryRoot, rel)
    const text = await readTextBestEffort(ctx, absPath, 15000)
    const maxFileChars = 5_000_000
    if (String(text || '').length > maxFileChars) {
      await dbg(
        ctx,
        '增量索引：跳过超大文件',
        { rel, chars: String(text || '').length },
        true,
      )
      return
    }

    const lines = String(text || '').split(/\r?\n/)
    const parts = chunkByLines(lines, cfg.chunk)
    if (!parts.length) {
      await dbg(ctx, '增量索引：无可索引内容，跳过', { rel }, true)
      meta.files[rel] = { mtimeMs: 0, chunkIds: [] }
      meta.updatedAt = Date.now()
      await ctx.writeTextFile(metaPath, JSON.stringify(meta, null, 2))
      FLYSMART_CACHE = { libraryKey: cfgKey, meta, vectors }
      return
    }

    const conn = await getEmbeddingConn(ctx, cfg)
    const texts = parts.map((c) => c.text)
    const batchSize = 16
    const batchesTotal = Math.ceil(texts.length / batchSize)
    let batchesDone = 0
    let dims = meta.dims | 0

    await dbg(
      ctx,
      '增量索引：开始',
      { rel, chunks: parts.length, model: cfg.embedding.model },
      true,
    )

    const embsAll = []
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize)
      const tEmb0 = nowMs()
      const embs = await fetchEmbeddings(conn, cfg.embedding.model, slice, {
        inputType: 'document',
        timeoutMs: 60000,
      })
      if (embs.length !== slice.length) {
        throw new Error('Embedding 返回数量不匹配')
      }
      for (const e of embs) {
        if (!Array.isArray(e) || !e.length) throw new Error('Embedding 返回格式异常')
        if (!dims) dims = e.length
        if (e.length !== dims) throw new Error('Embedding 维度不一致')
      }
      for (const e of embs) embsAll.push(e)
      batchesDone++
      setStatus({
        phase: 'incremental/embed',
        batchesDone,
        batchesTotal,
        processedChunks: Math.min(i + slice.length, texts.length),
        totalChunks: texts.length,
        lastProgressAt: nowMs(),
        currentFile: rel,
      })
      await dbg(
        ctx,
        '增量索引：Embedding 批次完成',
        { rel, batch: batchesDone, batchesTotal, ms: Math.max(0, nowMs() - tEmb0) },
        false,
      )
      await yieldToUi()
    }

    if (!dims) throw new Error('Embedding 维度为空')
    if (meta.dims && (meta.dims | 0) !== dims) {
      throw new Error('索引维度与当前 Embedding 不一致，请点击“重建索引”')
    }

    const oldVectors = vectors instanceof Float32Array ? vectors : new Float32Array()
    const oldDims = meta.dims | 0
    const useDims = oldDims || dims
    if (oldVectors.length && !useDims) throw new Error('索引维度异常')
    if (useDims && oldVectors.length % useDims !== 0) throw new Error('向量文件与 meta 不匹配')

    const oldLen = oldVectors.length
    const newFlat = new Float32Array(oldLen + embsAll.length * useDims)
    if (oldLen) newFlat.set(oldVectors, 0)
    for (let i = 0; i < embsAll.length; i++) {
      newFlat.set(embsAll[i], oldLen + i * useDims)
    }

    meta.dims = useDims
    meta.updatedAt = Date.now()

    const chunkIds = []
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i]
      let id = buildChunkId(rel, c.startLine, c.endLine, c.text)
      if (Object.prototype.hasOwnProperty.call(meta.chunks, id)) {
        let k = 1
        while (Object.prototype.hasOwnProperty.call(meta.chunks, id + ':dup' + k)) k++
        id = id + ':dup' + k
      }
      chunkIds.push(id)
      meta.chunks[id] = {
        relativePath: rel,
        heading: c.heading || '',
        startLine: c.startLine,
        endLine: c.endLine,
        vectorOffset: oldLen + i * useDims,
      }
    }
    meta.files[rel] = { mtimeMs: 0, chunkIds }

    await ctx.writeFileBinary(vecPath, new Uint8Array(newFlat.buffer))
    await ctx.writeTextFile(metaPath, JSON.stringify(meta, null, 2))

    FLYSMART_CACHE = { libraryKey: cfgKey, meta, vectors: newFlat }
    await dbg(
      ctx,
      '增量索引：完成',
      { rel, chunks: parts.length, dims: useDims, totalVectors: newFlat.length },
      true,
    )
    uiNotice(ctx, `增量索引完成：${rel}`, 'ok', 1400)
  } finally {
    FLYSMART_BUSY = false
    setStatus({ state: 'idle', phase: '', currentFile: '', lastProgressAt: nowMs() })
  }
}

async function clearIndex(ctx) {
  if (FLYSMART_BUSY) throw new Error('正在索引，稍后再试')
  if (!ctx) throw new Error('插件未激活')
  if (typeof ctx.getPluginDataDir !== 'function') {
    throw new Error('宿主版本过老：缺少 getPluginDataDir')
  }
  if (typeof ctx.writeFileBinary !== 'function') {
    throw new Error('宿主版本过老：缺少 writeFileBinary')
  }
  if (typeof ctx.writeTextFile !== 'function') {
    throw new Error('宿主版本过老：缺少 writeTextFile')
  }

  const cfg = await loadConfig(ctx)
  const libraryRoot = await getLibraryRootRequired(ctx)
  const cfgKey = cfg.libraryKey || (await sha1Hex(normalizePathForKey(libraryRoot)))
  const dataDir = await ctx.getPluginDataDir()
  const metaPath = joinFs(dataDir, META_FILE)
  const vecPath = joinFs(dataDir, VEC_FILE)

  FLYSMART_LOG.filePath = joinFs(dataDir, INDEX_LOG_FILE)
  FLYSMART_LOG.writeMode = 'overwrite'
  FLYSMART_LOG.pending = []
  await dbg(ctx, '清空索引：开始', { metaPath, vecPath }, true)

  await ctx.writeFileBinary(vecPath, new Uint8Array())
  const emptyMeta = {
    schemaVersion: SCHEMA_VERSION,
    libraryKey: cfgKey,
    embeddingModel: cfg.embedding.model,
    dims: 0,
    builtAt: 0,
    files: {},
    chunks: {},
  }
  await ctx.writeTextFile(metaPath, JSON.stringify(emptyMeta, null, 2))

  FLYSMART_CACHE = {
    libraryKey: cfgKey,
    meta: emptyMeta,
    vectors: new Float32Array(),
  }
  setStatus({
    state: 'idle',
    phase: '',
    totalFiles: 0,
    totalChunks: 0,
    processedFiles: 0,
    processedChunks: 0,
    batchesDone: 0,
    batchesTotal: 0,
    lastProgressAt: nowMs(),
    currentFile: '',
    lastIndexedAt: 0,
    lastError: '',
  })
  await dbg(ctx, '清空索引：完成', {}, true)
  uiNotice(ctx, 'flymd-RAG：索引已删除', 'ok', 1600)
}

function spanLenByLines(lines, startIdx, endIdx) {
  let n = 0
  for (let i = startIdx; i <= endIdx; i++) {
    n += String(lines[i] || '').length + 1
  }
  return n
}

function findBlockByLine(blocks, lineIdx) {
  const arr = Array.isArray(blocks) ? blocks : []
  for (const b of arr) {
    if (!b) continue
    const s = b.start | 0
    const e = b.end | 0
    if (lineIdx >= s && lineIdx <= e) return b
  }
  return arr.length ? arr[0] : { start: 0, end: Math.max(0, lineIdx | 0), heading: '', level: 0 }
}

function fitRangeWithinMaxChars(lines, blockStartIdx, blockEndIdx, startIdx, endIdx, maxChars) {
  const max = Math.max(200, maxChars | 0)
  let s = Math.max(blockStartIdx | 0, startIdx | 0)
  let e = Math.min(blockEndIdx | 0, endIdx | 0)
  if (e < s) e = s

  let len = spanLenByLines(lines, s, e)
  // 极端情况：命中范围本身就超长，先收缩到可用
  while (len > max && s < e) {
    const left = String(lines[s] || '').length + 1
    const right = String(lines[e] || '').length + 1
    if (right >= left) {
      len -= right
      e--
    } else {
      len -= left
      s++
    }
  }

  // 再向两侧扩展（优先吃“更短的一侧”以塞入更多信息）
  while (len < max && (s > blockStartIdx || e < blockEndIdx)) {
    const canL = s > blockStartIdx ? String(lines[s - 1] || '').length + 1 : 1e18
    const canR = e < blockEndIdx ? String(lines[e + 1] || '').length + 1 : 1e18
    if (canL === 1e18 && canR === 1e18) break

    const chooseLeft = canL <= canR
    if (chooseLeft && len + canL <= max) {
      s--
      len += canL
      continue
    }
    if (!chooseLeft && len + canR <= max) {
      e++
      len += canR
      continue
    }
    // 选中的一侧放不下，尝试另一侧
    if (chooseLeft && canR < 1e18 && len + canR <= max) {
      e++
      len += canR
      continue
    }
    if (!chooseLeft && canL < 1e18 && len + canL <= max) {
      s--
      len += canL
      continue
    }
    break
  }

  return { startIdx: s, endIdx: e }
}

function buildSnippetInfoFromLines(lines, blocks, focusStartLine, focusEndLine, maxChars) {
  const arr = Array.isArray(lines) ? lines : []
  if (!arr.length) {
    return { snippet: '', startLine: 1, endLine: 1, blockStartLine: 1, blockEndLine: 1, heading: '' }
  }
  const a = Math.max(1, Math.floor(focusStartLine || 1))
  const b = Math.max(a, Math.floor(focusEndLine || a))
  const s0 = Math.min(arr.length, a) - 1
  const e0 = Math.min(arr.length, b) - 1

  const block = findBlockByLine(blocks, s0)
  const bs = Math.max(0, block.start | 0)
  const be = Math.min(arr.length - 1, block.end | 0)

  const r = fitRangeWithinMaxChars(arr, bs, be, s0, e0, maxChars)
  let snippet = arr.slice(r.startIdx, r.endIdx + 1).join('\n').trim()
  if (snippet) {
    if (r.startIdx > bs) snippet = '…\n' + snippet
    if (r.endIdx < be) snippet = snippet + '\n…'
  }

  return {
    snippet,
    startLine: r.startIdx + 1,
    endLine: r.endIdx + 1,
    blockStartLine: bs + 1,
    blockEndLine: be + 1,
    heading: String(block && block.heading ? block.heading : ''),
  }
}

async function extractSnippet(ctx, absPath, startLine, endLine, maxChars) {
  const text = await readTextBestEffort(ctx, absPath, 12000)
  const lines = String(text || '').split(/\r?\n/)
  const blocks = splitMarkdownBlocks(lines, 2)
  const info = buildSnippetInfoFromLines(lines, blocks, startLine, endLine, maxChars || 1024)
  return info.snippet
}

async function searchIndex(ctx, query, opt) {
  if (!ctx) throw new Error('插件未激活')
  const cfg = await loadConfig(ctx)
  if (!cfg.enabled) return []
  if (FLYSMART_BUSY) throw new Error('正在索引，稍后再试')

  const q = String(query || '').trim()
  if (!q) return []

  const conn = await getEmbeddingConn(ctx, cfg)
  const embs = await fetchEmbeddings(conn, cfg.embedding.model, [q], {
    inputType: 'query',
  })
  const qArr = embs && embs[0]
  if (!Array.isArray(qArr) || !qArr.length) throw new Error('查询向量生成失败')

  const loaded = await ensureIndexLoaded(ctx, cfg)
  if (!loaded || !loaded.meta || !loaded.vectors) return []

  const dims = loaded.meta.dims | 0
  if (!dims) return []

  const qVec = Float32Array.from(qArr)
  if (qVec.length !== dims) throw new Error('查询向量维度与索引不一致')

  let qn = 0
  for (let i = 0; i < dims; i++) qn += qVec[i] * qVec[i]
  const qNorm = Math.sqrt(qn) || 1

  const topK =
    opt && typeof opt.topK === 'number' && Number.isFinite(opt.topK)
      ? Math.max(1, Math.min(50, Math.floor(opt.topK)))
      : cfg.search.topK
  const minScore =
    opt && typeof opt.minScore === 'number' && Number.isFinite(opt.minScore)
      ? Number(opt.minScore)
      : cfg.search.minScore

  const items = []
  const chunks = loaded.meta && loaded.meta.chunks ? loaded.meta.chunks : {}
  for (const [id, c] of Object.entries(chunks)) {
    const off = c && typeof c.vectorOffset === 'number' ? c.vectorOffset : -1
    if (off < 0) continue
    const score = cosineScoreAt(loaded.vectors, off, qVec, dims, qNorm)
    if (score < minScore) continue
    items.push({
      id,
      score,
      relativePath: String(c.relativePath || ''),
      heading: String(c.heading || ''),
      startLine: c.startLine | 0,
      endLine: c.endLine | 0,
    })
  }

  items.sort((a, b) => b.score - a.score)

  const root = await getLibraryRootRequired(ctx)
  const out = []
  const ctxMaxChars =
    opt && typeof opt.contextMaxChars === 'number' && Number.isFinite(opt.contextMaxChars)
      ? Math.max(200, Math.min(20000, Math.floor(opt.contextMaxChars)))
      : cfg.search.contextMaxChars
  const fileCache = new Map() // absPath -> { lines, blocks }
  const seenBlocks = new Set()

  for (const it of items) {
    if (out.length >= topK) break
    const absPath = joinAbs(root, it.relativePath)
    if (!absPath) continue

    let cached = fileCache.get(absPath)
    if (!cached) {
      try {
        const text = await readTextBestEffort(ctx, absPath, 12000)
        const lines = String(text || '').split(/\r?\n/)
        const blocks = splitMarkdownBlocks(lines, 2)
        cached = { lines, blocks }
        fileCache.set(absPath, cached)
      } catch {
        cached = { lines: [], blocks: [] }
        fileCache.set(absPath, cached)
      }
    }
    if (!cached.lines || !cached.lines.length) continue

    const info = buildSnippetInfoFromLines(
      cached.lines,
      cached.blocks,
      it.startLine,
      it.endLine,
      ctxMaxChars,
    )
    const key = `${it.relativePath}:${info.blockStartLine}-${info.blockEndLine}`
    if (seenBlocks.has(key)) continue
    seenBlocks.add(key)

    out.push({
      id: it.id,
      score: it.score,
      filePath: absPath,
      relative: it.relativePath,
      heading: info.heading || it.heading,
      startLine: info.startLine,
      endLine: info.endLine,
      snippet: info.snippet,
    })
  }
  return out
}

async function explainHit(ctx, hitId) {
  const cfg = await loadConfig(ctx)
  const loaded = await ensureIndexLoaded(ctx, cfg)
  const meta = loaded && loaded.meta ? loaded.meta : null
  if (!meta || !meta.chunks) throw new Error('索引不存在')
  const c = meta.chunks[hitId]
  if (!c) throw new Error('未找到命中记录')
  const root = await getLibraryRootRequired(ctx)
  const absPath = joinAbs(root, String(c.relativePath || ''))
  const text = await readTextBestEffort(ctx, absPath, 12000)
  const lines = String(text || '').split(/\r?\n/)
  const blocks = splitMarkdownBlocks(lines, 2)
  const info = buildSnippetInfoFromLines(
    lines,
    blocks,
    c.startLine,
    c.endLine,
    (cfg && cfg.search ? cfg.search.contextMaxChars : 1024) || 1024,
  )
  return {
    filePath: absPath,
    relative: String(c.relativePath || ''),
    heading: info.heading || String(c.heading || ''),
    startLine: info.startLine | 0,
    endLine: info.endLine | 0,
    snippet: info.snippet,
  }
}

function ensureDialogStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById('flysmart-style')) return
  const style = document.createElement('style')
  style.id = 'flysmart-style'
  style.textContent = `
.flysmart-overlay{
  position:fixed;
  inset:0;
  background:rgba(0,0,0,.35);
  /* 需要高于扩展市场 ext-overlay (z-index: 80000) */
  z-index:90060;
  display:flex;
  align-items:center;
  justify-content:center;
}
.flysmart-dialog{
  width:760px;
  max-width:92vw;
  max-height:86vh;
  overflow:hidden;
  background:#fff;
  border-radius:10px;
  box-shadow:0 20px 60px rgba(0,0,0,.25);
  display:flex;
  flex-direction:column;
}
.flysmart-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:12px 14px;
  border-bottom:1px solid rgba(0,0,0,.08);
  font-weight:600;
}
.flysmart-body{ padding:12px 14px; overflow:auto; }
.flysmart-row{ margin:10px 0; }
.flysmart-row label{ display:flex; gap:10px; align-items:center; }
.flysmart-tip{
  margin-top:6px;
  color:rgba(0,0,0,.55);
  font-size:12px;
  line-height:1.4;
}
.flysmart-btn{
  padding:6px 10px;
  border-radius:6px;
  border:1px solid rgba(0,0,0,.18);
  background:#f6f6f6;
  cursor:pointer;
}
.flysmart-btn.primary{ background:#1e80ff; color:#fff; border-color:#1e80ff; }
.flysmart-btn.danger{ background:#ef4444; color:#fff; border-color:#ef4444; }
.flysmart-btn:disabled{ opacity:.55; cursor:not-allowed; }
.flysmart-close{ font-size:18px; line-height:1; padding:0 8px; }
.flysmart-grid{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.flysmart-input{
  width:100%;
  padding:6px 8px;
  border-radius:6px;
  border:1px solid rgba(0,0,0,.18);
  outline:none;
}
.flysmart-textarea{
  width:100%;
  min-height:86px;
  padding:6px 8px;
  border-radius:6px;
  border:1px solid rgba(0,0,0,.18);
  outline:none;
  resize:vertical;
}
.flysmart-results{
  margin-top:10px;
  border:1px solid rgba(0,0,0,.1);
  border-radius:8px;
  overflow:hidden;
}
.flysmart-item{
  padding:10px 12px;
  border-top:1px solid rgba(0,0,0,.06);
  cursor:pointer;
}
.flysmart-item:first-child{ border-top:none; }
.flysmart-item:hover{ background:rgba(30,128,255,.06); }
.flysmart-item .t{ font-weight:600; font-size:13px; margin-bottom:4px; }
.flysmart-item .s{
  color:rgba(0,0,0,.65);
  font-size:12px;
  white-space:pre-wrap;
}
  `
  document.head.appendChild(style)
}

function closeDialog() {
  try {
    if (FLYSMART_DIALOG) FLYSMART_DIALOG.remove()
  } catch {}
  FLYSMART_DIALOG = null
  FLYSMART_STATUS_HOOK = null
  FLYSMART_LOG_HOOK = null
}

async function openSettingsDialog(settingsCtx) {
  if (typeof document === 'undefined') return
  ensureDialogStyle()
  closeDialog()

  const runtime = FLYSMART_CTX
  if (!runtime) {
    uiNotice(settingsCtx, 'flymd-RAG 未激活：请先启用插件', 'err', 2200)
    return
  }

  let cfg
  try {
    cfg = await loadConfig(runtime)
  } catch (e) {
    uiNotice(settingsCtx, e && e.message ? e.message : '读取配置失败', 'err', 2200)
    return
  }

  // 尝试读取上次的索引日志（无法打开控制台时靠它定位）
  try {
    if (typeof runtime.getPluginDataDir === 'function') {
      const dataDir = await runtime.getPluginDataDir()
      const logPath = joinFs(dataDir, INDEX_LOG_FILE)
      FLYSMART_LOG.filePath = logPath
      FLYSMART_LOG.pending = []
      let raw = ''
      if (typeof runtime.exists === 'function') {
        const ok = await runtime.exists(logPath)
        if (ok && typeof runtime.readTextFile === 'function') {
          raw = await runtime.readTextFile(logPath)
        }
      } else if (typeof runtime.readTextFile === 'function') {
        raw = await runtime.readTextFile(logPath)
      }
      if (raw) {
        const arr = String(raw || '').split(/\r?\n/).filter(Boolean)
        const max = FLYSMART_LOG.maxLines | 0
        FLYSMART_LOG.lines = max > 0 ? arr.slice(-max) : arr
      } else {
        FLYSMART_LOG.lines = []
      }
    }
  } catch {}

  const overlay = document.createElement('div')
  overlay.className = 'flysmart-overlay'

  const dialog = document.createElement('div')
  dialog.className = 'flysmart-dialog'

  const head = document.createElement('div')
  head.className = 'flysmart-header'
  const title = document.createElement('div')
  title.textContent = 'flymd-RAG 知识库索引'
  const btnClose = document.createElement('button')
  btnClose.className = 'flysmart-btn flysmart-close'
  btnClose.textContent = '×'
  btnClose.onclick = () => closeDialog()
  head.appendChild(title)
  head.appendChild(btnClose)

  const body = document.createElement('div')
  body.className = 'flysmart-body'

  const rowEnabled = document.createElement('div')
  rowEnabled.className = 'flysmart-row'
  const labelEnabled = document.createElement('label')
  const inputEnabled = document.createElement('input')
  inputEnabled.type = 'checkbox'
  inputEnabled.checked = !!cfg.enabled
  const spanEnabled = document.createElement('span')
  spanEnabled.textContent = '启用知识库索引（默认关闭）'
  labelEnabled.appendChild(inputEnabled)
  labelEnabled.appendChild(spanEnabled)
  const tipEnabled = document.createElement('div')
  tipEnabled.className = 'flysmart-tip'
  tipEnabled.textContent =
    '开启后，索引/检索会把文本发送到 embedding 服务生成向量；未开启时不会索引也不会发请求。'
  rowEnabled.appendChild(labelEnabled)
  rowEnabled.appendChild(tipEnabled)

  const grid = document.createElement('div')
  grid.className = 'flysmart-grid'

  const rowModel = document.createElement('div')
  rowModel.className = 'flysmart-row'
  const modelLabel = document.createElement('div')
  modelLabel.style.fontWeight = '600'
  modelLabel.textContent = 'Embedding 模型'
  const inputModel = document.createElement('input')
  inputModel.className = 'flysmart-input'
  inputModel.value = String(cfg.embedding.model || '')
  inputModel.placeholder = '例如：voyage-3.5-lite / text-embedding-3-small'
  const modelTip = document.createElement('div')
  modelTip.className = 'flysmart-tip'
  modelTip.textContent =
    '支持 VoyageAI（model=voyage-3.5/voyage-3.5-lite 等）；连接默认复用 AI 助手，也可切换为自定义。'
  rowModel.appendChild(modelLabel)
  rowModel.appendChild(inputModel)
  rowModel.appendChild(modelTip)

  const rowConn = document.createElement('div')
  rowConn.className = 'flysmart-row'
  const connLabel = document.createElement('div')
  connLabel.style.fontWeight = '600'
  connLabel.textContent = 'Embedding 连接'
  const selectProvider = document.createElement('select')
  selectProvider.className = 'flysmart-input'
  const optReuse = document.createElement('option')
  optReuse.value = 'reuse-ai-assistant'
  optReuse.textContent = '复用 AI 助手'
  const optCustom = document.createElement('option')
  optCustom.value = 'custom'
  optCustom.textContent = '自定义（VoyageAI 等）'
  selectProvider.appendChild(optReuse)
  selectProvider.appendChild(optCustom)
  selectProvider.value = String(cfg.embedding.provider || 'reuse-ai-assistant')
  const connTip = document.createElement('div')
  connTip.className = 'flysmart-tip'
  rowConn.appendChild(connLabel)
  rowConn.appendChild(selectProvider)
  rowConn.appendChild(connTip)

  grid.appendChild(rowModel)
  grid.appendChild(rowConn)

  const rowCustomConn = document.createElement('div')
  rowCustomConn.className = 'flysmart-row'
  const customConnLabel = document.createElement('div')
  customConnLabel.style.fontWeight = '600'
  customConnLabel.textContent = '自定义 Embedding BaseURL / Key'
  const inputEmbedBaseUrl = document.createElement('input')
  inputEmbedBaseUrl.className = 'flysmart-input'
  inputEmbedBaseUrl.placeholder = '例如：https://api.voyageai.com/v1'
  inputEmbedBaseUrl.value = String(cfg.embedding.baseUrl || '').trim()
  const inputEmbedApiKey = document.createElement('input')
  inputEmbedApiKey.className = 'flysmart-input'
  inputEmbedApiKey.type = 'password'
  inputEmbedApiKey.placeholder = '例如：VOYAGE_API_KEY（可留空）'
  inputEmbedApiKey.value = String(cfg.embedding.apiKey || '')
  const customConnTip = document.createElement('div')
  customConnTip.className = 'flysmart-tip'
  customConnTip.textContent =
    'VoyageAI：baseUrl=https://api.voyageai.com/v1；model=voyage-3.5/voyage-3.5-lite（会自动使用 input_type=query/document）。'
  rowCustomConn.appendChild(customConnLabel)
  rowCustomConn.appendChild(inputEmbedBaseUrl)
  rowCustomConn.appendChild(inputEmbedApiKey)
  rowCustomConn.appendChild(customConnTip)

  function refreshConnHint() {
    const isCustom = selectProvider.value === 'custom'
    rowCustomConn.style.display = isCustom ? '' : 'none'
    connTip.textContent = isCustom
      ? '使用自定义 embedding 连接（不依赖 AI 助手配置）。'
      : '复用 AI 助手（ai-assistant）的 baseUrl/apiKey'
  }
  selectProvider.onchange = refreshConnHint
  refreshConnHint()

  const rowInclude = document.createElement('div')
  rowInclude.className = 'flysmart-row'
  const includeLabel = document.createElement('div')
  includeLabel.style.fontWeight = '600'
  includeLabel.textContent = '仅扫描目录（可选，目录前缀，一行一个）'
  const textareaInclude = document.createElement('textarea')
  textareaInclude.className = 'flysmart-textarea'
  textareaInclude.placeholder = '例如：\n笔记/\n随笔/\nProjects/'
  textareaInclude.value = (cfg.includeDirs || []).join('\n')
  const includeTip = document.createElement('div')
  includeTip.className = 'flysmart-tip'
  includeTip.textContent =
    '为空=扫描整个库；非空=只扫描这些目录前缀。可与“排除目录”同时使用（排除优先）。支持中文；输入 /随笔 或 随笔 均可。'
  rowInclude.appendChild(includeLabel)
  rowInclude.appendChild(textareaInclude)
  rowInclude.appendChild(includeTip)

  const rowExclude = document.createElement('div')
  rowExclude.className = 'flysmart-row'
  const exclLabel = document.createElement('div')
  exclLabel.style.fontWeight = '600'
  exclLabel.textContent = '排除目录（目录前缀，一行一个）'
  const textareaExclude = document.createElement('textarea')
  textareaExclude.className = 'flysmart-textarea'
  textareaExclude.placeholder = '例如：\nassets/\n_private/\n.git/'
  textareaExclude.value = (cfg.excludeDirs || []).join('\n')
  const exclTip = document.createElement('div')
  exclTip.className = 'flysmart-tip'
  exclTip.textContent =
    '相对库根目录，统一用 /；匹配规则：dir 或 dir/ 开头均会被跳过（遍历阶段直接跳过）。'
  rowExclude.appendChild(exclLabel)
  rowExclude.appendChild(textareaExclude)
  rowExclude.appendChild(exclTip)

  const rowActions = document.createElement('div')
  rowActions.className = 'flysmart-row'
  rowActions.style.display = 'flex'
  rowActions.style.gap = '10px'
  rowActions.style.flexWrap = 'wrap'

  const btnSave = document.createElement('button')
  btnSave.className = 'flysmart-btn primary'
  btnSave.textContent = '保存设置'

  const btnIndex = document.createElement('button')
  btnIndex.className = 'flysmart-btn'
  btnIndex.textContent = '重建索引'

  const btnClearIndex = document.createElement('button')
  btnClearIndex.className = 'flysmart-btn danger'
  btnClearIndex.textContent = '删除索引'

  const statusEl = document.createElement('div')
  statusEl.className = 'flysmart-tip'
  statusEl.style.marginTop = '6px'

  function refreshStatus() {
    const s = FLYSMART_STATUS || {}
    const t = s.lastIndexedAt
      ? new Date(s.lastIndexedAt).toLocaleString()
      : '未构建'
    const err = s.lastError ? `；错误：${s.lastError}` : ''
    const phase = s.phase ? `/${s.phase}` : ''
    const pf = typeof s.processedFiles === 'number' ? s.processedFiles : 0
    const tf = typeof s.totalFiles === 'number' ? s.totalFiles : 0
    const pc = typeof s.processedChunks === 'number' ? s.processedChunks : 0
    const tc = typeof s.totalChunks === 'number' ? s.totalChunks : 0
    const bd = typeof s.batchesDone === 'number' ? s.batchesDone : 0
    const bt = typeof s.batchesTotal === 'number' ? s.batchesTotal : 0
    const btxt = bt ? `；batch：${bd}/${bt}` : ''
    const cur = s.currentFile ? `；当前：${String(s.currentFile).slice(-60)}` : ''
    statusEl.textContent =
      `状态：${s.state || 'idle'}${phase}；文件：${pf}/${tf}；chunks：${pc}/${tc}${btxt}${cur}；上次：${t}${err}`
  }
  refreshStatus()

  btnSave.onclick = async () => {
    btnSave.disabled = true
    try {
      const embProvider = String(selectProvider.value || 'reuse-ai-assistant').trim()
      const embPatch = {
        provider: embProvider,
        model: String(inputModel.value || '').trim(),
      }
      if (embProvider === 'custom') {
        embPatch.baseUrl = String(inputEmbedBaseUrl.value || '').trim()
        embPatch.apiKey = String(inputEmbedApiKey.value || '').trim()
      }
      const next = await saveConfig(runtime, {
        enabled: !!inputEnabled.checked,
        includeDirs: String(textareaInclude.value || '')
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean),
        excludeDirs: String(textareaExclude.value || '')
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean),
        embedding: embPatch,
      })
      cfg = next
      // 设置变更后，立刻刷新增量监听（includeDirs/enabled 会影响监控范围）
      try { void refreshIncrementalWatch(runtime, cfg) } catch {}
      uiNotice(settingsCtx, 'flymd-RAG 设置已保存', 'ok', 1400)
    } catch (e) {
      uiNotice(settingsCtx, e && e.message ? e.message : '保存失败', 'err', 2400)
    } finally {
      btnSave.disabled = false
    }
  }

  btnIndex.onclick = async () => {
    btnIndex.disabled = true
    try {
      await btnSave.onclick()
      await buildIndex(runtime)
      uiNotice(settingsCtx, '索引重建完成', 'ok', 1600)
    } catch (e) {
      uiNotice(settingsCtx, e && e.message ? e.message : '索引失败', 'err', 2600)
    } finally {
      btnIndex.disabled = false
      refreshStatus()
    }
  }

  rowActions.appendChild(btnSave)
  rowActions.appendChild(btnIndex)
  rowActions.appendChild(btnClearIndex)

  btnClearIndex.onclick = async () => {
    btnClearIndex.disabled = true
    try {
      let ok = true
      if (settingsCtx && settingsCtx.ui && typeof settingsCtx.ui.confirm === 'function') {
        ok = await settingsCtx.ui.confirm(
          '确定删除索引？这会清空已构建的向量文件，之后检索无结果，需要重新构建。',
        )
      } else {
        ok = confirm('确定删除索引？这会清空已构建的向量文件，之后需要重新构建。')
      }
      if (!ok) return
      await clearIndex(runtime)
    } catch (e) {
      uiNotice(settingsCtx, e && e.message ? e.message : '删除索引失败', 'err', 2600)
    } finally {
      btnClearIndex.disabled = false
      refreshStatus()
    }
  }

  const rowDebug = document.createElement('details')
  rowDebug.className = 'flysmart-row'
  const sum = document.createElement('summary')
  sum.textContent = '索引日志'
  sum.style.cursor = 'pointer'
  sum.style.fontWeight = '600'
  const debugTip = document.createElement('div')
  debugTip.className = 'flysmart-tip'
  debugTip.textContent = FLYSMART_LOG.filePath ? `日志文件：${FLYSMART_LOG.filePath}` : '日志文件：未生成'
  const logBox = document.createElement('textarea')
  logBox.className = 'flysmart-textarea'
  logBox.readOnly = true
  logBox.style.minHeight = '140px'
  logBox.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  logBox.value = (FLYSMART_LOG.lines || []).join('\n')
  const debugActions = document.createElement('div')
  debugActions.style.display = 'flex'
  debugActions.style.gap = '10px'
  debugActions.style.flexWrap = 'wrap'
  debugActions.style.marginTop = '8px'

  const btnCopyLog = document.createElement('button')
  btnCopyLog.className = 'flysmart-btn'
  btnCopyLog.textContent = '复制日志'
  btnCopyLog.onclick = async () => {
    try {
      const text = String(logBox.value || '')
      if (!text.trim()) {
        uiNotice(settingsCtx, '日志为空', 'err', 1600)
        return
      }
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
      } else {
        logBox.focus()
        logBox.select()
        document.execCommand('copy')
      }
      uiNotice(settingsCtx, '日志已复制', 'ok', 1200)
    } catch (e) {
      uiNotice(settingsCtx, e && e.message ? e.message : '复制失败', 'err', 2000)
    }
  }

  const btnClearLog = document.createElement('button')
  btnClearLog.className = 'flysmart-btn'
  btnClearLog.textContent = '清空日志'
  btnClearLog.onclick = async () => {
    try {
      FLYSMART_LOG.lines = []
      FLYSMART_LOG.pending = []
      logBox.value = ''
      if (FLYSMART_LOG.filePath && runtime && typeof runtime.writeTextFile === 'function') {
        await runtime.writeTextFile(FLYSMART_LOG.filePath, '')
      }
      uiNotice(settingsCtx, '日志已清空', 'ok', 1200)
    } catch (e) {
      uiNotice(settingsCtx, e && e.message ? e.message : '清空失败', 'err', 2000)
    }
  }

  debugActions.appendChild(btnCopyLog)
  debugActions.appendChild(btnClearLog)

  rowDebug.appendChild(sum)
  rowDebug.appendChild(debugTip)
  rowDebug.appendChild(logBox)
  rowDebug.appendChild(debugActions)

  FLYSMART_LOG_HOOK = (x) => {
    try {
      if (!x) return
      if (x.filePath) debugTip.textContent = `日志文件：${x.filePath}`
      logBox.value = String(x.text || '')
      logBox.scrollTop = logBox.scrollHeight
    } catch {}
  }

  const rowSearch = document.createElement('div')
  rowSearch.className = 'flysmart-row'

  const searchLabel = document.createElement('div')
  searchLabel.style.fontWeight = '600'
  searchLabel.textContent = '语义检索（测试）'

  const searchBar = document.createElement('div')
  searchBar.style.display = 'flex'
  searchBar.style.gap = '10px'

  const inputQ = document.createElement('input')
  inputQ.className = 'flysmart-input'
  inputQ.placeholder = '输入问题/关键词，回车或点击搜索'
  inputQ.style.flex = '1'

  const btnSearch = document.createElement('button')
  btnSearch.className = 'flysmart-btn'
  btnSearch.textContent = '搜索'

  searchBar.appendChild(inputQ)
  searchBar.appendChild(btnSearch)

  const results = document.createElement('div')
  results.className = 'flysmart-results'
  results.style.display = 'none'

  async function doSearch() {
    const q = String(inputQ.value || '').trim()
    if (!q) return
    btnSearch.disabled = true
    results.style.display = 'none'
    results.innerHTML = ''
    try {
      const hits = await searchIndex(runtime, q, {})
      if (!hits || !hits.length) {
        uiNotice(settingsCtx, '无结果（或未启用/未构建索引）', 'err', 1800)
        return
      }
      results.style.display = 'block'
      for (const h of hits) {
        const item = document.createElement('div')
        item.className = 'flysmart-item'

        const t = document.createElement('div')
        t.className = 't'
        const score =
          typeof h.score === 'number' ? h.score.toFixed(4) : String(h.score || '')
        t.textContent =
          `${score}  ${h.relative}:${h.startLine}-${h.endLine}` +
          (h.heading ? `  # ${h.heading}` : '')

        const s = document.createElement('div')
        s.className = 's'
        s.textContent = String(h.snippet || '')

        item.appendChild(t)
        item.appendChild(s)
        item.onclick = async () => {
          try {
            if (typeof runtime.openFileByPath === 'function') {
              await runtime.openFileByPath(h.filePath)
            }
          } catch {}
        }
        results.appendChild(item)
      }
    } catch (e) {
      uiNotice(settingsCtx, e && e.message ? e.message : '搜索失败', 'err', 2400)
    } finally {
      btnSearch.disabled = false
    }
  }

  btnSearch.onclick = doSearch
  inputQ.addEventListener('keydown', (ev) => {
    if (ev && ev.key === 'Enter') {
      ev.preventDefault()
      void doSearch()
    }
  })

  rowSearch.appendChild(searchLabel)
  rowSearch.appendChild(searchBar)
  rowSearch.appendChild(results)

  body.appendChild(rowEnabled)
  body.appendChild(grid)
  body.appendChild(rowCustomConn)
  body.appendChild(rowInclude)
  body.appendChild(rowExclude)
  body.appendChild(rowActions)
  body.appendChild(statusEl)
  body.appendChild(rowDebug)
  body.appendChild(rowSearch)

  dialog.appendChild(head)
  dialog.appendChild(body)
  overlay.appendChild(dialog)

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeDialog()
  })

  document.body.appendChild(overlay)
  FLYSMART_DIALOG = overlay
  FLYSMART_STATUS_HOOK = () => refreshStatus()
}


export function activate(context) {
  FLYSMART_CTX = context

  try {
    if (context && typeof context.registerAPI === 'function') {
      const api = {
        getStatus: async () => ({ ...FLYSMART_STATUS }),
        getConfig: async () => await loadConfig(context),
        setConfig: async (patch) => await saveConfig(context, patch || {}),
        reindex: async () => await buildIndex(context),
        clearIndex: async () => await clearIndex(context),
        search: async (query, opt) => await searchIndex(context, query, opt || {}),
        explain: async (hitId) => await explainHit(context, String(hitId || '')),
      }
      // 新名字 + 旧名字：兼容已发布的对接代码，避免无谓破坏
      context.registerAPI('flymdRAG', api)
      context.registerAPI('flySmart', api)
    }
  } catch (e) {
    console.error('[flymd-RAG] registerAPI 失败', e)
  }

  try {
    if (context && typeof context.addMenuItem === 'function') {
      context.addMenuItem({
        label: '知识库检索',
        title: 'flymd-RAG：语义检索（需要先构建索引）',
        onClick: async () => {
          try {
            const cfg = await loadConfig(context)
            if (!cfg.enabled) {
              uiNotice(context, '知识库索引未启用，请先在设置中开启', 'err', 2000)
              return
            }
            const q = prompt('输入检索内容（flymd-RAG）') || ''
            if (!String(q).trim()) return
            const hits = await searchIndex(context, q, { topK: 5 })
            if (!hits.length) {
              uiNotice(context, '无结果', 'err', 1600)
              return
            }
            const top = hits[0]
            uiNotice(
              context,
              `Top1：${top.relative}:${top.startLine}-${top.endLine}（${top.score.toFixed(4)}）`,
              'ok',
              2400,
            )
            if (top.filePath && typeof context.openFileByPath === 'function') {
              await context.openFileByPath(top.filePath)
            }
          } catch (e) {
            uiNotice(context, e && e.message ? e.message : '检索失败', 'err', 2400)
          }
        },
      })
    }
  } catch {}
}

export async function openSettings(context) {
  await openSettingsDialog(context)
}

export function deactivate() {
  closeDialog()
  stopIncrementalWatch()
  try {
    FLYSMART_INCR_QUEUE = []
    FLYSMART_INCR_SET = new Set()
    if (FLYSMART_INCR_TIMER) {
      try { clearTimeout(FLYSMART_INCR_TIMER) } catch {}
      FLYSMART_INCR_TIMER = 0
    }
    FLYSMART_INCR_RUNNING = false
  } catch {}
  FLYSMART_CTX = null
  FLYSMART_BUSY = false
  FLYSMART_CACHE = { libraryKey: '', meta: null, vectors: null }
  setStatus({ state: 'idle', lastError: '' })
}

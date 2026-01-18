// AI 写作助手（OpenAI 兼容路径）
// 说明：
// - 仅实现 OpenAI 兼容接口（/v1/chat/completions）
// - 浮动窗口、基本对话、快捷动作（续写/润色/纠错/提纲）
// - 设置项：baseUrl、apiKey、model、上下文截断长度
// - 默认不写回文档，需用户点击“插入文末”

// ========== 配置与状态 ==========
const CFG_KEY = 'ai.config'
const SES_KEY = 'ai.session.default'

const FREE_MODEL_OPTIONS = {
  qwen: { label: 'Qwen', id: 'Qwen/Qwen3-8B' },
  gemini: { label: 'Gemini Vision', id: 'gemini-2.5-flash', vision: true },
  glm: { label: 'GLM', id: 'THUDM/glm-4-9b-chat' }
}
const DEFAULT_FREE_MODEL_KEY = 'qwen'

// 默认上下文截断长度（按字符数裁剪文档尾部）
const DEFAULT_MAX_CTX_CHARS = 128000

const DEFAULT_CFG = {
  provider: 'free', // 默认使用免费模式
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  visionEnabled: false, // 视觉模式（默认关闭）
  win: { x: 60, y: 60, w: 400, h: 440 },
  dock: 'left', // 'left'=左侧停靠；'right'=右侧停靠；'bottom'=底部停靠；false=浮动窗口
  limits: { maxCtxChars: DEFAULT_MAX_CTX_CHARS },
  kb: { enabled: false, topK: 5, maxChars: 2000 }, // 知识库检索（RAG），默认关闭
  theme: 'auto',
  freeModel: DEFAULT_FREE_MODEL_KEY,
  alwaysUseFreeTrans: false // 翻译功能始终使用免费模型
}

// ========== 轻量级多语言：跟随宿主 ==========
const AI_LOCALE_LS_KEY = 'flymd.locale'
function aiDetectSystemLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav['userLanguage'])) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function aiGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(AI_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return aiDetectSystemLocale()
}
function aiText(zh, en) {
  return aiGetLocale() === 'en' ? en : zh
}

// 会话只做最小持久化（可选），首版以内存为主
let __AI_SESSION__ = { id: '', name: '默认会话', messages: [], docHash: '', docTitle: '' }
let __AI_DB__ = null // { byDoc: { [hash]: { title, activeId, items:[{id,name,created,updated,messages:[]}] } } }
let __AI_SENDING__ = false
let __AI_LAST_REPLY__ = ''
let __AI_TOGGLE_LOCK__ = false
let __AI_MQ_BOUND__ = false
let __AI_MENU_ITEM__ = null // 保存菜单项引用，用于卸载时清理
let __AI_CTX_MENU_DISPOSER__ = null // 保存右键菜单清理函数
let __AI_IS_FREE_MODE__ = false // 缓存免费模式状态，供右键菜单 condition 同步读取
let __AI_LAST_DOC_HASH__ = '' // 缓存上次渲染时的文档哈希，避免不必要的重新渲染
let __AI_FN_DEBOUNCE_TIMER__ = null // 文档名观察者防抖定时器
let __AI_CONTEXT__ = null // 保存插件 context，供消息操作按钮使用
let __AI_PENDING_ACTION__ = null // 标记待办/提醒快捷模式
let __AI_PENDING_IMAGES__ = [] // 待发送的图片（来自对话框粘贴）
let __AI_AGENT__ = {
  enabled: false,
  target: 'auto', // 'auto' | 'selection' | 'document'
  source: '', // 当前选用的来源：selection/document
  selection: null, // {start,end,text}
  original: '',
  base: '', // 最近一次修订的输入
  current: '', // 当前修订草稿
  lastStats: null,
  showDel: true,
  busy: false,
  overlayOpen: false,
  overlayEscHandler: null,
  review: null, // { ops:[], hunks:[], map:[], finalText:'' }
  armedAt: 0,
  armedText: ''
}
let __AI_MD__ = null // Markdown 渲染器实例
let __AI_KATEX__ = null // KaTeX 渲染器实例（可选）
let __AI_KATEX_LOADING__ = null // KaTeX 加载中 Promise（避免并发加载）
let __AI_HLJS__ = null // highlight.js 实例
let __AI_MD_WARNED__ = false // Markdown 渲染失败仅提示一次
let __AI_DOCK_PANEL__ = null // 布局句柄（宿主统一管理推挤间距）
let __AI_LAYOUT_UNSUB__ = null // 布局变更回调注销函数
let __AI_DOCK_SYNC_CLEANUP__ = null // 自动同步 dock 布局的注销函数
let __AI_DOCK_SYNC_SCHEDULED__ = false // 防止 resize 时重复触发同步
let __AI_ONE_SHOT_DOC_CTX__ = null // 一次性上下文覆盖：用于“咨询”等入口（发送一次后自动清空）
let __AI_LAST_POINTER__ = { x: 0, y: 0, ts: 0 } // 记录最近一次指针位置（用于“咨询”输入框定位）
let __AI_POINTER_TRACKER_BOUND__ = false // 避免重复绑定指针监听

function setOneShotDocContext(text, label) {
  const t = String(text || '').trim()
  if (!t) { __AI_ONE_SHOT_DOC_CTX__ = null; return }
  __AI_ONE_SHOT_DOC_CTX__ = { text: t, label: String(label || '').trim() }
}

function consumeOneShotDocContext() {
  const v = __AI_ONE_SHOT_DOC_CTX__
  __AI_ONE_SHOT_DOC_CTX__ = null
  return v && v.text ? v : null
}

async function resolveConsultContext(context, ctx) {
  try {
    const snap = String(snapshotSelectedTextFromCtx(ctx) || '').trim()
    if (snap) return { text: snap, label: aiText('选中内容', 'Selected text') }
  } catch {}
  try {
    const sel = await context.getSelection?.()
    const t = String(sel?.text || '').trim()
    if (t) return { text: t, label: aiText('选中内容', 'Selected text') }
  } catch {}
  try {
    const doc = String(context.getEditorValue() || '').trim()
    if (doc) return { text: doc, label: aiText('文档内容', 'Document') }
  } catch {}
  return null
}

function bindPointerTrackerOnce() {
  if (__AI_POINTER_TRACKER_BOUND__) return
  __AI_POINTER_TRACKER_BOUND__ = true
  try {
    const win = WIN()
    const handler = (e) => {
      try {
        const evt = e || {}
        const x = Number(evt.clientX)
        const y = Number(evt.clientY)
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        __AI_LAST_POINTER__ = { x, y, ts: Date.now() }
      } catch {}
    }
    // 右键菜单触发前的坐标最靠谱
    win.addEventListener('contextmenu', handler, true)
    // 兜底：某些宿主会拦截 contextmenu
    win.addEventListener('mousedown', handler, true)
  } catch {}
}

function getSelectionAnchorRect() {
  try {
    const win = WIN()
    const sel = win && win.getSelection ? win.getSelection() : null
    if (!sel || sel.rangeCount <= 0) return null
    const r = sel.getRangeAt(0)
    if (!r) return null
    const rects = r.getClientRects ? r.getClientRects() : null
    const rect = rects && rects.length ? rects[0] : (r.getBoundingClientRect ? r.getBoundingClientRect() : null)
    if (!rect) return null
    const w = Number(rect.width || 0)
    const h = Number(rect.height || 0)
    const left = Number(rect.left)
    const top = Number(rect.top)
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null
    // 没有可见矩形（比如选区为空/不可见）
    if (w <= 0 && h <= 0) return null
    return rect
  } catch {}
  return null
}

function clampNumber(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function openConsultInputOverlay(context, ctx) {
  bindPointerTrackerOnce()
  try {
    const existed = DOC().getElementById('ai-consult-overlay')
    if (existed) existed.remove()
  } catch {}

  const overlay = DOC().createElement('div')
  overlay.id = 'ai-consult-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', aiText('咨询输入框', 'Consult input'))

  const isDark = (() => {
    try {
      const body = WIN().document.body
      return !!(body && body.classList && body.classList.contains('dark-mode'))
    } catch {}
    return false
  })()

  try {
    overlay.style.position = 'fixed'
    overlay.style.zIndex = '100000'
    overlay.style.background = 'transparent'
    overlay.style.padding = '0'
  } catch {}

  const input = DOC().createElement('input')
  input.id = 'ai-consult-input'
  input.type = 'text'
  input.autocomplete = 'off'
  input.placeholder = '咨询AI'
  try {
    input.style.width = '100%'
    input.style.boxSizing = 'border-box'
    input.style.border = isDark ? '1px solid rgba(148,163,184,.55)' : '1px solid rgba(15,23,42,.18)'
    input.style.background = isDark ? '#0f172a' : '#ffffff'
    input.style.color = isDark ? '#e5e7eb' : '#0f172a'
    input.style.borderRadius = '12px'
    input.style.height = '46px'
    input.style.padding = '0 14px'
    input.style.fontSize = '14px'
    input.style.outline = 'none'
    input.style.boxShadow = isDark ? '0 10px 26px rgba(0,0,0,.45)' : '0 10px 26px rgba(0,0,0,.10)'
  } catch {}

  overlay.appendChild(input)
  DOC().body.appendChild(overlay)

  // 定位：优先贴近选区高度；否则贴近指针高度；再否则居中靠上
  try {
    const win = WIN()
    const vw = Number(win.innerWidth || 0) || 1280
    const vh = Number(win.innerHeight || 0) || 720
    const pad = 12
    const w = Math.min(560, Math.max(260, vw - pad * 2))
    const boxH = 56

    let anchorX = vw / 2
    let anchorY = 24

    const selRect = getSelectionAnchorRect()
    if (selRect) {
      anchorX = Number(selRect.left + (selRect.width || 0) / 2)
      anchorY = Number(selRect.bottom)
    } else if (__AI_LAST_POINTER__ && __AI_LAST_POINTER__.ts && (Date.now() - __AI_LAST_POINTER__.ts) < 3000) {
      anchorX = Number(__AI_LAST_POINTER__.x)
      anchorY = Number(__AI_LAST_POINTER__.y)
    }

    const left = clampNumber(anchorX - w / 2, pad, vw - w - pad)
    let top = anchorY + 10
    if (top + boxH > vh - pad) top = Math.max(pad, anchorY - boxH - 10)

    overlay.style.left = left + 'px'
    overlay.style.top = clampNumber(top, pad, vh - boxH - pad) + 'px'
    overlay.style.width = w + 'px'
  } catch {}

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { WIN().removeEventListener('mousedown', onMouseDown, true) } catch {}
    try { WIN().removeEventListener('keydown', onGlobalKeyDown, true) } catch {}
    try { overlay.remove() } catch {}
  }

  const onMouseDown = (e) => {
    try {
      if (!overlay.contains(e.target)) close()
    } catch {}
  }

  const onGlobalKeyDown = (e) => {
    try {
      if (e.key === 'Escape') { e.preventDefault(); close() }
    } catch {}
  }

  WIN().addEventListener('mousedown', onMouseDown, true)
  WIN().addEventListener('keydown', onGlobalKeyDown, true)

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const q = String(input.value || '').trim()
      if (!q) return
      close()
      try { await sendConsultMessage(context, ctx, q) } catch {}
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })

  try { setTimeout(() => { try { input.focus() } catch {} }, 0) } catch {}
}

async function sendConsultMessage(context, ctx, question) {
  if (__AI_SENDING__) {
    try { context.ui.notice(aiText('请等待当前 AI 响应完成', 'Please wait for the current response'), 'warn', 1800) } catch {}
    return
  }

  const q = String(question || '').trim()
  if (!q) return

  let ctxInfo = null
  try { ctxInfo = await resolveConsultContext(context, ctx) } catch {}

  try {
    await ensureWindow(context)
    try {
      const w = el('ai-assist-win')
      if (w) w.style.display = 'block'
    } catch {}
    try { setDockPush(true) } catch {}

    if (ctxInfo && ctxInfo.text) {
      setOneShotDocContext(ctxInfo.text, ctxInfo.label || '文档上下文')
    }

    try {
      const actionSelect = el('ai-quick-action')
      if (actionSelect) actionSelect.value = ''
    } catch {}

    try {
      const ta = el('ai-text')
      if (ta) {
        ta.value = q
        try { ta.focus() } catch {}
      }
    } catch {}

    await sendFromInput(context)
  } catch (e) {
    // 避免一次性上下文在异常情况下“泄漏”到下一次发送
    try { consumeOneShotDocContext() } catch {}
    throw e
  }
}

function computeWorkspaceBounds() {
  try {
    // 优先使用宿主提供的工作区边界（已考虑库侧栏和所有插件 Panel）
    if (__AI_CONTEXT__ && __AI_CONTEXT__.layout && typeof __AI_CONTEXT__.layout.getWorkspaceBounds === 'function') {
      const b = __AI_CONTEXT__.layout.getWorkspaceBounds()
      if (b && typeof b === 'object') {
        const left = Number(b.left) || 0
        const right = Number(b.right) || 0
        const width = Number(b.width) || Math.max(0, (WIN().innerWidth || 1280) - left - right)
        const top = Number(b.top) || 0
        const height = Number(b.height) || (WIN().innerHeight || 720)
        return { left, right, width, top, height }
      }
    }

    // 回退：仅基于容器 + 库侧栏估算
    const doc = DOC()
    const container = doc.querySelector('.container')
    const lib = doc.getElementById('library')
    const viewportWidth = WIN().innerWidth || 1280
    const viewportHeight = WIN().innerHeight || 720
    let leftGap = 0
    let rightGap = 0
    let top = 0
    let height = viewportHeight
    if (container && container.getBoundingClientRect) {
      const contRect = container.getBoundingClientRect()
      leftGap = contRect.left
      rightGap = viewportWidth - contRect.right
      top = contRect.top
      height = contRect.height || viewportHeight
      if (lib && !lib.classList.contains('hidden') && lib.getBoundingClientRect) {
        const libRect = lib.getBoundingClientRect()
        if (container.classList.contains('with-library-left')) {
          const deltaLeft = Math.max(0, libRect.right - contRect.left)
          leftGap += deltaLeft
        }
        if (container.classList.contains('with-library-right')) {
          const deltaRight = Math.max(0, contRect.right - libRect.left)
          rightGap += deltaRight
        }
      }
    }
    if (!Number.isFinite(leftGap) || leftGap < 0) leftGap = 0
    if (!Number.isFinite(rightGap) || rightGap < 0) rightGap = 0
    return { left: leftGap, right: rightGap, width: Math.max(0, viewportWidth - leftGap - rightGap), top, height }
  } catch {
    const viewportWidth = WIN().innerWidth || 1280
    const viewportHeight = WIN().innerHeight || 720
    return { left: 0, right: 0, width: viewportWidth, top: 0, height: viewportHeight }
  }
}

// 根据工作区边界，统一设置左右停靠时的垂直位置，避免遮挡标题栏/标签栏
function applyDockVerticalBounds(winEl, boundsFromCaller) {
  if (!winEl) return
  try {
    const bounds = boundsFromCaller || computeWorkspaceBounds()
    const winH = WIN().innerHeight || 720
    let top = Number(bounds && bounds.top)
    let height = Number(bounds && bounds.height)
    if (!Number.isFinite(top) || top < 0) top = 0
    if (!Number.isFinite(height) || height <= 0) height = Math.max(0, winH - top)

    // 兼容旧环境：如果没有容器信息，则至少让出菜单栏高度
    if (top === 0) {
      try {
        const bar = DOC().querySelector('.menubar')
        const barH = (bar && bar.clientHeight) || 0
        if (barH > 0) {
          top = barH
          height = Math.max(0, winH - top)
        }
      } catch {}
    }

    winEl.style.top = top + 'px'
    winEl.style.bottom = 'auto'
    winEl.style.height = (height > 0 ? height : Math.max(0, winH - top)) + 'px'
  } catch {
    try {
      const bar = DOC().querySelector('.menubar')
      const topH = ((bar && bar.clientHeight) || 0)
      winEl.style.top = topH + 'px'
      winEl.style.bottom = 'auto'
      winEl.style.height = 'calc(100vh - ' + topH + 'px)'
    } catch {
      winEl.style.top = '0px'
      winEl.style.bottom = 'auto'
      winEl.style.height = '100vh'
    }
  }
}

function syncDockedWindowWithWorkspace() {
  try {
    const winEl = el('ai-assist-win')
    if (!winEl) return
    // 窗口隐藏时不应重新设置推挤
    if (winEl.style.display === 'none' || winEl.classList.contains('ai-win-hidden')) return
    const dockLeft = winEl.classList.contains('dock-left')
    const dockRight = winEl.classList.contains('dock-right')
    const dockBottom = winEl.classList.contains('dock-bottom')
    if (!dockLeft && !dockRight && !dockBottom) return
    const bounds = computeWorkspaceBounds()
    const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
    if (dockLeft) {
      const currentWidth = parseInt(winEl.style.width) || MIN_WIDTH
      const panelWidth = Math.max(MIN_WIDTH, Math.min(currentWidth, workspaceWidth || MIN_WIDTH))
      applyDockVerticalBounds(winEl, bounds)
      winEl.style.left = bounds.left + 'px'
      winEl.style.right = 'auto'
      winEl.style.width = panelWidth + 'px'
      setDockPush('left', panelWidth)
      return
    }
    if (dockRight) {
      const currentWidth = parseInt(winEl.style.width) || MIN_WIDTH
      const panelWidth = Math.max(MIN_WIDTH, Math.min(currentWidth, workspaceWidth || MIN_WIDTH))
      applyDockVerticalBounds(winEl, bounds)
      winEl.style.right = bounds.right + 'px'
      winEl.style.left = 'auto'
      winEl.style.width = panelWidth + 'px'
      setDockPush('right', panelWidth)
      return
    }
    if (dockBottom) {
      const currentHeight = parseInt(winEl.style.height) || 440
      winEl.style.top = 'auto'
      winEl.style.bottom = '0px'
      winEl.style.left = bounds.left + 'px'
      winEl.style.right = bounds.right + 'px'
      winEl.style.width = 'auto'
      setDockPush('bottom', currentHeight)
    }
  } catch {}
}

function scheduleDockedWindowSync() {
  try {
    if (__AI_DOCK_SYNC_SCHEDULED__) return
    __AI_DOCK_SYNC_SCHEDULED__ = true
    const win = WIN()
    const run = () => {
      __AI_DOCK_SYNC_SCHEDULED__ = false
      try { syncDockedWindowWithWorkspace() } catch {}
    }
    if (win && typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(run)
    else setTimeout(run, 16)
  } catch {
    try {
      __AI_DOCK_SYNC_SCHEDULED__ = false
      syncDockedWindowWithWorkspace()
    } catch {}
  }
}

function bindAutoDockSync() {
  try {
    if (__AI_DOCK_SYNC_CLEANUP__) return
    const win = WIN()
    const doc = DOC()
    const onResize = () => { try { scheduleDockedWindowSync() } catch {} }
    win.addEventListener('resize', onResize)

    // 宿主窗口尺寸变化不一定等于工作区尺寸变化（库侧栏/插件面板也会挤压），用 RO 兜底
    let ro = null
    try {
      const RO = win.ResizeObserver || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null)
      if (typeof RO === 'function') {
        ro = new RO(() => { try { scheduleDockedWindowSync() } catch {} })
        const container = doc.querySelector('.container')
        const lib = doc.getElementById('library')
        if (container) { try { ro.observe(container) } catch {} }
        if (lib) { try { ro.observe(lib) } catch {} }
      }
    } catch {}

    __AI_DOCK_SYNC_CLEANUP__ = () => {
      try { win.removeEventListener('resize', onResize) } catch {}
      try { ro && ro.disconnect() } catch {}
      __AI_DOCK_SYNC_CLEANUP__ = null
    }
  } catch {}
}

// ========== 工具函数 ==========
async function loadCfg(context) {
  try {
    const s = await context.storage.get(CFG_KEY)
    const cfg = { ...DEFAULT_CFG, ...(s || {}) }
    // 兼容旧配置：将 dock: true 转换为 'left'
    if (cfg.dock === true) cfg.dock = 'left'
    cfg.freeModel = normalizeFreeModelKey(cfg.freeModel)
    // 知识库配置：确保子对象合并与数值归一化
    try {
      const raw = cfg.kb && typeof cfg.kb === 'object' ? cfg.kb : {}
      const kb = { ...(DEFAULT_CFG.kb || {}), ...(raw || {}) }
      kb.enabled = !!kb.enabled
      kb.topK = Math.max(1, Math.min(20, parseInt(String(kb.topK ?? 5), 10) || 5))
      kb.maxChars = Math.max(200, Math.min(8000, parseInt(String(kb.maxChars ?? 2000), 10) || 2000))
      cfg.kb = kb
    } catch { cfg.kb = { ...(DEFAULT_CFG.kb || {}) } }
    // 更新免费模式缓存
    __AI_IS_FREE_MODE__ = cfg.provider === 'free'
    return cfg
  } catch { return { ...DEFAULT_CFG } }
}
async function saveCfg(context, cfg) { try { await context.storage.set(CFG_KEY, cfg); __AI_IS_FREE_MODE__ = cfg.provider === 'free' } catch {} }
async function loadSession(context) { try { const s = await context.storage.get(SES_KEY); return s && typeof s === 'object' ? s : { messages: [] } } catch { return { messages: [] } } }
async function saveSession(context, ses) { try { await context.storage.set(SES_KEY, ses) } catch {} }

async function loadSessionsDB(context) {
  try { const db = await context.storage.get('ai.sessions'); if (db && typeof db === 'object') { __AI_DB__ = db; return __AI_DB__ } } catch {}
  __AI_DB__ = { byDoc: {} }
  return __AI_DB__
}
async function saveSessionsDB(context) { try { await context.storage.set('ai.sessions', __AI_DB__ || { byDoc: {} }) } catch {} }

function gid(){ return 's_' + Math.random().toString(36).slice(2,10) }

function clampCtx(s, n) { const t = String(s || ''); return t.length > n ? t.slice(t.length - n) : t }

// 最小宽度常量
const MIN_WIDTH = 400

const AI_AVATAR_FALLBACK_URL = 'https://flymd.llingfei.com/Flymdnew.png'

// 避免固定字符串被滥用
const FLYMD_TOKEN_SECRET = 'flymd-rolling-secret-v1' // 与后端 ai_proxy.php 保持一致
const FLYMD_TOKEN_WINDOW_MS = 120000 // 2 分钟一个窗口

function fnv1aHex(str){
  let hash = 0x811c9dc5
  const prime = 0x01000193
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, prime)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function buildRollingClientToken(now = Date.now()){
  if (!FLYMD_TOKEN_SECRET) return 'flymd-client-legacy'
  const slice = Math.floor(now / FLYMD_TOKEN_WINDOW_MS)
  const base = `${FLYMD_TOKEN_SECRET}:${slice}:2pai`
  const partA = fnv1aHex(base)
  const partB = fnv1aHex(base + ':' + (slice % 97))
  return `flymd-${partA}${partB}`
}

function DOC(){ return (window.__AI_DOC__ || document) }
function WIN(){ return (window.__AI_WIN__ || window) }
function el(id) { return DOC().getElementById(id) }
function lastUserMsg() { try { const arr = __AI_SESSION__.messages; for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].role === 'user') return String(arr[i].content || '') } } catch {} return '' }
function shorten(s, n){ const t = String(s||'').trim(); return t.length>n? (t.slice(0,n)+'…') : t }
function resolvePluginAsset(rel){
  let clean = String(rel || '').trim()
  if (!clean) return ''
  clean = clean.replace(/^[/\\]+/, '').replace(/[\\/]+/g, '/')
  try {
    if (__AI_CONTEXT__ && typeof __AI_CONTEXT__.getAssetUrl === 'function') {
      const url = __AI_CONTEXT__.getAssetUrl(clean)
      if (url) return url
    }
  } catch {}
  return `plugins/ai-assistant/${clean}`
}
function isFreeProvider(cfg){ return !!cfg && cfg.provider === 'free' }

// 本地图片大小上限（字节）：默认 1MB，用于视觉模式和对话框粘贴图片
const MAX_LOCAL_IMAGE_BYTES = 1024 * 1024

function estimateDataUrlBytes(dataUrl){
  try {
    const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:[^;]+;base64,(.+)$/) : null
    if (!m || !m[1]) return 0
    const b64 = m[1]
    const len = b64.length
    if (!len) return 0
    return Math.floor(len * 3 / 4)
  } catch { return 0 }
}

function isLocalImageTooLargeDataUrl(dataUrl){
  if (!MAX_LOCAL_IMAGE_BYTES || MAX_LOCAL_IMAGE_BYTES <= 0) return false
  const bytes = estimateDataUrlBytes(dataUrl)
  return bytes > MAX_LOCAL_IMAGE_BYTES
}

// 长耗时操作的通知：支持新旧宿主，避免进度提示长时间悬挂
function showLongRunningNotice(context, message){
  try {
    if (context && context.ui && typeof context.ui.showNotification === 'function') {
      return context.ui.showNotification(message, { type: 'info', duration: 0 })
    }
    if (context && context.ui && typeof context.ui.notice === 'function') {
      context.ui.notice(message, 'ok', 2000)
    }
  } catch {}
  return null
}

function hideLongRunningNotice(context, id){
  if (!id) return
  try {
    if (context && context.ui && typeof context.ui.hideNotification === 'function') {
      context.ui.hideNotification(id)
    }
  } catch {}
}

  // Markdown 渲染器（内置轻量实现，避免外部依赖）
  async function ensureMarkdownRenderer() {
    if (__AI_MD__) return __AI_MD__
    try {
      // 使用内置的简单 Markdown 渲染器，避免运行时动态加载第三方库
      __AI_MD__ = { render: aiRenderSimpleMarkdown }
      return __AI_MD__
    } catch (e) {
      if (!__AI_MD_WARNED__) {
        __AI_MD_WARNED__ = true
        try { console.warn('[AI助手] Markdown 渲染器初始化失败，将降级为纯文本显示') } catch {}
      }
      return null
    }
}

// 渲染 Markdown 文本为 HTML
async function renderMarkdownText(text) {
  const md = await ensureMarkdownRenderer()
  if (!md) return escapeHtml(text) // 降级为纯文本
  try {
    return md.render(text)
  } catch {
    return escapeHtml(text)
  }
}

  // HTML 转义
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch] || ch))
  }

  function aiLooksLikeMath(s) {
    const t = String(s || '').trim()
    if (!t) return false
    // 经验规则：避免把 `$5$` 这种“看起来像钱”的内容误判为数学
    if (/^[0-9.,]+$/.test(t)) return false
    return /[\\^_{}=+\-*/()\[\]|<>]/.test(t) || /[a-zA-Z]/.test(t)
  }

  function aiFindClosingDelim(src, start, delimChar) {
    const s = String(src || '')
    for (let i = start; i < s.length; i++) {
      if (s[i] !== delimChar) continue
      // 处理转义：奇数个反斜杠表示被转义
      let bs = 0
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) bs++
      if ((bs & 1) === 1) continue
      return i
    }
    return -1
  }

  function aiTokenizeInline(src) {
    const s = String(src || '')
    const out = []
    let i = 0
    let buf = ''

    function flushText() {
      if (!buf) return
      out.push({ type: 'text', value: buf })
      buf = ''
    }

    while (i < s.length) {
      const ch = s[i]

      // code span：`...`
      if (ch === '`') {
        const end = aiFindClosingDelim(s, i + 1, '`')
        if (end >= 0) {
          flushText()
          out.push({ type: 'code', value: s.slice(i + 1, end) })
          i = end + 1
          continue
        }
      }

      // inline math：$...$（不处理 $$，避免和块级冲突）
      if (ch === '$') {
        // 跳过 $$
        if (i + 1 < s.length && s[i + 1] === '$') {
          buf += '$$'
          i += 2
          continue
        }
        // 跳过被转义的 $
        if (i > 0 && s[i - 1] === '\\') {
          buf += '$'
          i++
          continue
        }
        const end = (() => {
          for (let j = i + 1; j < s.length; j++) {
            if (s[j] !== '$') continue
            if (j + 1 < s.length && s[j + 1] === '$') { j++; continue }
            let bs = 0
            for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) bs++
            if ((bs & 1) === 1) continue
            return j
          }
          return -1
        })()
        if (end > i + 1) {
          const content = s.slice(i + 1, end)
          if (aiLooksLikeMath(content)) {
            flushText()
            out.push({ type: 'math', value: content })
            i = end + 1
            continue
          }
        }
      }

      buf += ch
      i++
    }

    flushText()
    return out
  }

  function aiRenderInlineMarkdownText(text) {
    if (!text) return ''
    let html = escapeHtml(String(text))
    html = html.replace(/\*\*([^*]+)\*\*/g, (m, strong) => `<strong>${strong}</strong>`)
    html = html.replace(/\*([^*]+)\*/g, (m, em) => `<em>${em}</em>`)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
      const safeHref = String(href || '').replace(/"/g, '&quot;')
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    return html
  }

  // 内联 Markdown 渲染（粗粒度支持：KaTeX、`code`、*em*、**strong**、[text](url)）
  function aiRenderInlineMarkdown(text) {
    const tokens = aiTokenizeInline(text)
    if (!tokens.length) return ''
    return tokens.map(t => {
      if (t.type === 'code') return `<code>${escapeHtml(t.value)}</code>`
      if (t.type === 'math') return `<span class="md-math-inline" data-math="${escapeHtml(t.value)}"></span>`
      return aiRenderInlineMarkdownText(t.value)
    }).join('')
  }

  // 简单 Markdown 渲染器：支持标题、列表、引用、代码块
  function aiRenderSimpleMarkdown(src) {
    const lines = String(src || '').split(/\r?\n/)
    const out = []
    let inCode = false
    let codeLang = ''
    let codeLines = []
    let inMath = false
    let mathLines = []
    let listType = ''
    let listItems = []
    let paragraph = []
    let inBlockquote = false
    let blockquoteLines = []

    function flushParagraph() {
      if (!paragraph.length) return
      out.push(`<p>${aiRenderInlineMarkdown(paragraph.join(' '))}</p>`)
      paragraph = []
    }

    function flushList() {
      if (!listItems.length) return
      const tag = listType === 'ol' ? 'ol' : 'ul'
      out.push(`<${tag}>`)
      listItems.forEach(item => {
        out.push(`<li>${aiRenderInlineMarkdown(item)}</li>`)
      })
      out.push(`</${tag}>`)
      listItems = []
      listType = ''
    }

    function flushCode() {
      if (!inCode) return
      const code = codeLines.join('\n')
      const lang = codeLang.trim().toLowerCase()
      const cls = lang ? `language-${lang}` : ''
      const classAttr = cls ? ` class="${cls}"` : ''
      out.push(`<pre><code${classAttr}>${escapeHtml(code)}</code></pre>`)
      inCode = false
      codeLang = ''
      codeLines = []
    }

    function flushMath() {
      if (!inMath) return
      const raw = mathLines.join('\n')
      out.push(`<div class="md-math-block" data-math="${escapeHtml(raw)}"></div>`)
      inMath = false
      mathLines = []
    }

    function flushBlockquote() {
      if (!inBlockquote) return
      const inner = aiRenderSimpleMarkdown(blockquoteLines.join('\n'))
      out.push(`<blockquote>${inner}</blockquote>`)
      inBlockquote = false
      blockquoteLines = []
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const line = raw.replace(/\s+$/, '')

      if (inCode) {
        if (/^```/.test(line)) {
          flushCode()
          continue
        }
        codeLines.push(raw)
        continue
      }

      if (inMath) {
        if (/^\s*\$\$\s*$/.test(line)) {
          flushMath()
          continue
        }
        mathLines.push(raw)
        continue
      }

      // 代码块围栏
      {
        const fenceMatch = line.match(/^```(\s*\w+)?\s*$/)
        if (fenceMatch) {
          flushParagraph()
          flushList()
          flushBlockquote()
          flushMath()
          inCode = true
          codeLang = fenceMatch[1] ? fenceMatch[1].trim() : ''
          codeLines = []
          continue
        }
      }

      // 数学块：支持单行 $$...$$ 或围栏 $$\n...\n$$
      {
        const oneLine = line.match(/^\s*\$\$(.+?)\$\$\s*$/)
        if (oneLine && aiLooksLikeMath(oneLine[1])) {
          flushParagraph()
          flushList()
          flushBlockquote()
          out.push(
            `<div class="md-math-block" data-math="${escapeHtml(oneLine[1])}"></div>`,
          )
          continue
        }
        if (/^\s*\$\$\s*$/.test(line)) {
          flushParagraph()
          flushList()
          flushBlockquote()
          inMath = true
          mathLines = []
          continue
        }
      }

      const bqMatch = line.match(/^>\s?(.*)$/)
      if (bqMatch) {
        flushParagraph()
        flushList()
        inBlockquote = true
        blockquoteLines.push(bqMatch[1] || '')
        continue
      }
      if (inBlockquote) {
        if (!line.trim()) {
          blockquoteLines.push('')
          continue
        }
        flushBlockquote()
      }

      if (!line.trim()) {
        flushParagraph()
        flushList()
        flushMath()
        continue
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
      if (headingMatch) {
        flushParagraph()
        flushList()
        flushBlockquote()
        flushMath()
        const level = headingMatch[1].length
        const content = headingMatch[2] || ''
        out.push(`<h${level}>${aiRenderInlineMarkdown(content)}</h${level}>`)
        continue
      }

        const olMatch = line.match(/^(\d+)\.\s+(.*)$/)
        const ulMatch = line.match(/^[-+*]\s+(.*)$/)
        if (olMatch || ulMatch) {
          flushParagraph()
          const curType = olMatch ? 'ol' : 'ul'
          const text = olMatch ? (olMatch[2] || '') : (ulMatch[1] || '')
        if (!listType) {
          listType = curType
          listItems = []
        } else if (listType !== curType) {
          flushList()
          listType = curType
        }
        listItems.push(text)
        continue
      }

      flushBlockquote()
      flushMath()
      paragraph.push(line.trim())
    }

    flushCode()
    flushMath()
    flushBlockquote()
    flushParagraph()
    flushList()

    return out.join('\n')
  }

function ensureKatexCssOnce(href) {
  try {
    if (!href) return
    if (DOC().getElementById('ai-assist-katex-css')) return
    const link = DOC().createElement('link')
    link.id = 'ai-assist-katex-css'
    link.rel = 'stylesheet'
    link.href = String(href)
    DOC().head.appendChild(link)
  } catch {}
}

async function ensureKatexRuntime(context) {
  try {
    if (__AI_KATEX__) return __AI_KATEX__
    if (__AI_KATEX_LOADING__) return await __AI_KATEX_LOADING__

    __AI_KATEX_LOADING__ = (async () => {
      // 先尝试宿主是否已暴露 katex（有则复用，零侵入）
      try {
        const g = typeof window !== 'undefined' ? window : globalThis
        const k = g && (g.katex || g.KaTeX)
        if (k && typeof k.render === 'function') {
          __AI_KATEX__ = k
          return __AI_KATEX__
        }
      } catch {}

      // 再尝试插件内置资源；最后才走 CDN（加载失败不报错，保留原始公式文本）
      let modUrl = ''
      let cssUrl = ''
      try {
        if (context && typeof context.getAssetUrl === 'function') {
          const u1 = context.getAssetUrl('vendor/katex/katex.mjs')
          const u2 = context.getAssetUrl('vendor/katex/katex.min.css')
          if (u1 && u2) {
            modUrl = u1
            cssUrl = u2
          }
        }
      } catch {}
      if (!modUrl) {
        modUrl = 'https://unpkg.com/katex@0.16.25/dist/katex.mjs'
        cssUrl = 'https://unpkg.com/katex@0.16.25/dist/katex.min.css'
      }

      ensureKatexCssOnce(cssUrl)
      const mod = await import(/* @vite-ignore */ modUrl)
      const katex = (mod && (mod.default || mod)) || null
      if (katex && typeof katex.render === 'function') {
        __AI_KATEX__ = katex
        return __AI_KATEX__
      }
      return null
    })()

    return await __AI_KATEX_LOADING__
  } catch {
    return null
  } finally {
    __AI_KATEX_LOADING__ = null
  }
}

async function decorateAIMath(container, context) {
  try {
    const nodes = container
      ? container.querySelectorAll('.md-math-inline, .md-math-block')
      : null
    if (!nodes || nodes.length === 0) return

    const katex = await ensureKatexRuntime(context)
    if (!katex) return

    nodes.forEach(el => {
      try {
        if (el.dataset && el.dataset.aiKatexDone) return
        if (el.dataset) el.dataset.aiKatexDone = '1'
        const value = el.getAttribute('data-math') || ''
        const displayMode = el.classList.contains('md-math-block')
        el.innerHTML = ''
        katex.render(value, el, { throwOnError: false, displayMode })
      } catch {
        try { el.textContent = el.getAttribute('data-math') || '' } catch {}
      }
    })
  } catch {}
}

// 网络请求重试机制（支持 5xx 服务器错误自动重试）
function _aiPickTauriHttpFetch(){
  try {
    const tauri = (globalThis && globalThis.__TAURI__) ? globalThis.__TAURI__ : null
    if (!tauri) return null
    // Tauri v2：插件 API
    if (tauri.plugin && tauri.plugin.http && typeof tauri.plugin.http.fetch === 'function') return tauri.plugin.http.fetch
    // 少数环境挂在 __TAURI__.http 上
    if (tauri.http && typeof tauri.http.fetch === 'function') return tauri.http.fetch
    return null
  } catch {
    return null
  }
}

function _aiTryParseJsonLoose(raw){
  try {
    const s = String(raw || '').trim()
    if (!s) return null
    // 1) 标准 JSON
    try { return JSON.parse(s) } catch {}

    // 2) SSE：data: {...}\n\n（取最后一个可解析的 payload）
    try {
      const lines = s.split(/\r?\n/)
      const payloads = []
      for (const line of lines) {
        const m = String(line || '').match(/^\s*data:\s*(.*)\s*$/)
        if (!m) continue
        const p = String(m[1] || '').trim()
        if (!p || p === '[DONE]') continue
        payloads.push(p)
      }
      for (let i = payloads.length - 1; i >= 0; i--) {
        try { return JSON.parse(payloads[i]) } catch {}
      }
    } catch {}

    // 3) NDJSON：一行一个 JSON（取最后一个可解析的行）
    try {
      const lines = s.split(/\r?\n/).map(x => String(x || '').trim()).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]) } catch {}
      }
    } catch {}

    // 4) 宽松提取：截取第一段 {...}
    try {
      const a = s.indexOf('{')
      const b = s.lastIndexOf('}')
      if (a >= 0 && b > a) {
        const sub = s.slice(a, b + 1)
        try { return JSON.parse(sub) } catch {}
      }
    } catch {}

    return null
  } catch {
    return null
  }
}

async function _aiFetch(url, options){
  const tf = _aiPickTauriHttpFetch()
  if (tf) {
    // 目标：优先用宿主侧 http（绕过 WebView CORS/预检）。失败再回退到原生 fetch。
    try {
      const opt = (options && typeof options === 'object') ? { ...options } : {}
      // AbortSignal 无法跨 IPC 序列化
      try { if (opt && opt.signal) delete opt.signal } catch {}
      return await tf(url, opt)
    } catch {}
  }
  return await fetch(url, options)
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await _aiFetch(url, options)
      // 5xx 服务器错误 - 重试
      if (res.status >= 500 && attempt < maxRetries - 1) {
        const waitMs = 1000 * (attempt + 1)
        console.warn(`[AI助手] 服务器错误(${res.status})，${waitMs}ms 后重试...`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      return res
    } catch (e) {
      lastError = e
      console.warn(`[AI助手] 请求失败(尝试 ${attempt + 1}/${maxRetries})：`, e.message || e)
      if (attempt < maxRetries - 1) {
        const waitMs = 1000 * (attempt + 1)
        await new Promise(r => setTimeout(r, waitMs))
      }
    }
  }
  throw lastError || new Error('请求失败，已重试 ' + maxRetries + ' 次')
}

// 为代码块添加复制按钮
function decorateAICodeBlocks(container) {
  const pres = container.querySelectorAll('pre')
  pres.forEach(pre => {
    if (pre.dataset.aiDecorated) return
    pre.dataset.aiDecorated = '1'
    pre.style.position = 'relative'

    // 提取语言标签
    const code = pre.querySelector('code')
    const langClass = code ? Array.from(code.classList).find(c => c.startsWith('language-') || c.startsWith('hljs')) : null
    const lang = langClass ? langClass.replace(/^(language-|hljs\s*)/, '').toUpperCase() : ''

    // 创建复制按钮
    const btn = DOC().createElement('button')
    btn.className = 'ai-code-copy'
    btn.textContent = '复制'
    btn.title = '复制代码'
    btn.onclick = (e) => {
      e.stopPropagation()
      const codeText = code?.textContent || pre.textContent || ''
      try {
        navigator.clipboard?.writeText(codeText)
        btn.textContent = '已复制'
        btn.classList.add('copied')
        setTimeout(() => {
          btn.textContent = '复制'
          btn.classList.remove('copied')
        }, 1500)
      } catch {}
    }

    // 如果有语言标签，添加语言角标
    if (lang && lang !== 'HLJS') {
      const langLabel = DOC().createElement('span')
      langLabel.className = 'ai-code-lang'
      langLabel.textContent = lang
      pre.appendChild(langLabel)
    }

    pre.appendChild(btn)
  })
}
function normalizeFreeModelKey(key){
  const raw = String(key || '').trim().toLowerCase()
  if (raw && Object.prototype.hasOwnProperty.call(FREE_MODEL_OPTIONS, raw)) return raw
  return DEFAULT_FREE_MODEL_KEY
}
function resolveModelId(cfg){
  if (isFreeProvider(cfg)) {
    const key = normalizeFreeModelKey(cfg?.freeModel)
    return FREE_MODEL_OPTIONS[key].id
  }
  const custom = String(cfg?.model || '').trim()
  return custom || DEFAULT_CFG.model
}
function buildApiUrl(cfg){
  // 免费代理模式：使用硬编码的代理地址，保留用户的自定义配置
  if (isFreeProvider(cfg)) return 'https://flymd.llingfei.com/ai/ai_proxy.php'
  const base = String((cfg && cfg.baseUrl) || 'https://api.siliconflow.cn/v1').trim()
  const clean = base.replace(/\/+$/, '')
  // 兼容：用户直接填完整的 OpenAI 兼容路径
  if (/\/chat\/completions$/i.test(clean)) return clean
  return clean + '/chat/completions'
}
function buildApiHeaders(cfg){
    const headers = { 'Content-Type':'application/json' }
    // 免费代理模式：由后端持有真实 Key，这里不再下发
    if (!isFreeProvider(cfg) && cfg && cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey
    // 为免费代理模式增加一个简单令牌，提高滥用成本（仅飞速MarkDown客户端约定使用）
    if (isFreeProvider(cfg)) headers['X-Flymd-Token'] = buildRollingClientToken()
    return headers
  }

function mergeConfig(baseCfg, overrides = {}){
  if (!overrides || !Object.keys(overrides).length) return baseCfg
  const merged = { ...baseCfg, ...overrides }
  merged.limits = { ...(baseCfg?.limits || {}), ...(overrides?.limits || {}) }
  merged.win = { ...(baseCfg?.win || {}), ...(overrides?.win || {}) }
  merged.kb = { ...(baseCfg?.kb || {}), ...(overrides?.kb || {}) }
  return merged
}

async function ensureApiConfig(context, overrides = {}){
  const baseCfg = await loadCfg(context)
  const finalCfg = overrides ? mergeConfig(baseCfg, overrides) : baseCfg
  const isFree = isFreeProvider(finalCfg)
  if (!finalCfg.apiKey && !isFree) throw new Error('AI Key 未配置')
  return finalCfg
}

async function performAIRequest(cfg, bodyObj, context){
  // 不是“提示词”能解决的事：先在本地硬拦截，避免请求打到模型侧。
  try { aiGuardAssertAllowed(context, cfg, bodyObj && bodyObj.messages ? bodyObj.messages : null) } catch (e) { throw e }
  const url = buildApiUrl(cfg)
  const headers = buildApiHeaders(cfg)
  const response = await _aiFetch(url, { method:'POST', headers, body: JSON.stringify(bodyObj) })
  if (!response.ok) {
    let message = 'API 调用失败：' + response.status
    try {
      const text = await response.text()
      if (text) message = text
    } catch {}
    throw new Error(message)
  }
  let data = null
  try { data = await response.json() } catch {}
  const text = String(data?.choices?.[0]?.message?.content || '').trim()
  return { text, data }
}

// 处理免费模型调用时的错误响应（包括速率限制与每日上限）
async function handleFreeApiError(context, res){
  try {
    if (!res) {
      if (context && context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice('AI 调用失败：网络异常，请稍后重试', 'err', 4000)
      }
      return
    }
    let raw = ''
    try { raw = await res.text() } catch {}
    let data = null
    if (raw) {
      try { data = JSON.parse(raw) } catch {}
    }
    const status = res.status
    const reason = data && typeof data.reason === 'string' ? data.reason : ''

    // 速率限制：rpm/tpm
    if (status === 429 && (reason === 'rpm' || reason === 'tpm')) {
      const retry = Number(data && data.retry_after != null ? data.retry_after : 0)
      let msg = '已超过免费速率限制，请稍后再试'
      if (retry > 0 && Number.isFinite(retry)) {
        msg += `（建议等待约 ${Math.ceil(retry)} 秒）`
      }
      if (context && context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice(msg, 'warn', 5000)
      }
      return
    }

    // 每日请求上限（薄荷公益）
    if (status === 429 && reason === 'daily_request_limit') {
      const msg = (data && data.error)
        ? String(data.error)
        : '今日免费调用次数已用完，请明天再试'
      if (context && context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice(msg, 'warn', 6000)
      }
      return
    }

    // 其它错误：尽量展示后端返回的 error 文本
    const baseMsg = (data && data.error)
      ? String(data.error)
      : (raw || ('HTTP ' + status))
    if (context && context.ui && typeof context.ui.notice === 'function') {
      context.ui.notice('AI 调用失败：' + baseMsg, 'err', 4000)
    }
  } catch (e) {
    if (context && context.ui && typeof context.ui.notice === 'function') {
      context.ui.notice('AI 调用失败，请稍后重试', 'err', 4000)
    }
  }
}

function buildTodoPrompt(content){
  const now = new Date()
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const weekday = weekdays[now.getDay()]
  const timeContext = `今天是 ${currentDate} ${weekday} ${currentTime}`
  const system = '你是专业的任务管理助手。基于用户提供的文章内容，提取其中的可执行任务，并生成待办事项列表。'
  const docSnippet = content.length > 4000 ? content.slice(0, 4000) + '...' : content
  const prompt = `${timeContext}

请仔细阅读以下文章内容，提取其中提到的或隐含的可执行任务，生成待办事项列表。

文章内容：
${docSnippet}

要求：
1. 每个待办事项必须是明确的、可执行的任务
2. 格式严格遵守：- [ ] 任务描述 @时间
3. 【重要】时间必须精确到小时，严禁使用"上午"、"下午"、"晚上"等模糊时段词，只能使用以下格式：
   - @YYYY-MM-DD HH:mm （如 @${currentDate} 14:00）
   - @明天 14:00 或 @明天 下午2点（必须带具体小时）
   - @后天 10:00 或 @后天 上午10点（必须带具体小时）
   - @X小时后 或 @X分钟后（如 @2小时后）
4. 【关键】必须根据文章内容中的时间语境安排日期：
   - 如果文章提到"明天要做某事"，则该任务的日期应该是明天
   - 如果文章提到"下周"、"周末"等，要计算出对应的实际日期
   - 准备性任务（如"准备行李"）应安排在事件发生前
5. 今天是 ${currentDate} ${weekday}，以此为基准计算所有日期
6. 只输出待办事项列表，每行一个，不要其他说明文字
7. 如果文章中没有明确的任务，可以根据文章主题提取3-5个相关的行动项

示例（假设文章提到"明天出发旅游"）：
- [ ] 准备行李和证件 @${currentDate} 20:00
- [ ] 检查车辆状况 @${currentDate} 21:00
- [ ] 出发前往目的地 @明天 08:00`
  return { system, prompt }
}

function extractTodos(todos){
  return String(todos || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- [ ]') || line.startsWith('- [x]'))
}

// 根据配置判断是否启用视觉能力（当前仅自定义模型允许）
function isVisionEnabledForConfig(cfg){
  if (!cfg) return false
  if (isFreeProvider(cfg)) {
    const key = normalizeFreeModelKey(cfg.freeModel)
    const info = FREE_MODEL_OPTIONS[key]
    if (!info || !info.vision) return false
  }
  return !!cfg.visionEnabled
}

function isRagEnabledForConfig(cfg){
  try {
    return !!normalizeKbCfgForAi(cfg).enabled
  } catch {
    return false
  }
}

// 更新视觉按钮上的图片计数标记
function updateVisionAttachmentIndicator(){
  try {
    const visionBtn = el('ai-vision-toggle')
    if (!visionBtn) return
    const count = Array.isArray(__AI_PENDING_IMAGES__) ? __AI_PENDING_IMAGES__.length : 0
    if (count > 0) {
      visionBtn.setAttribute('data-count', String(count))
    } else {
      visionBtn.removeAttribute('data-count')
    }
  } catch {}
}

function aiAgentEscapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function aiAgentDiffNormEol(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function aiAgentDiffIsBreakChar(ch) {
  return ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';' || ch === '…'
}

function aiAgentDiffTokenize(text, maxChunkLen) {
  const s = aiAgentDiffNormEol(text)
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
    if (aiAgentDiffIsBreakChar(ch)) lastBreak = buf.length
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

function aiAgentDiffLcsOps(aTokens, bTokens) {
  const a = Array.isArray(aTokens) ? aTokens : []
  const b = Array.isArray(bTokens) ? bTokens : []
  const n = a.length
  const m = b.length

  // 防止 DP 爆内存：极端大文本直接退化成“整段替换”（仍可审阅，但不会细粒度分块）
  try {
    const cells = (n + 1) * (m + 1)
    if (cells > 12000000) {
      const aAll = a.join('')
      const bAll = b.join('')
      if (aAll === bAll) return [{ t: 'eq', s: aAll }]
      return [{ t: 'del', s: aAll }, { t: 'ins', s: bAll }]
    }
  } catch {}

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

function aiAgentDiffStats(ops) {
  const arr = Array.isArray(ops) ? ops : []
  let insChars = 0
  let delChars = 0
  let insSegs = 0
  let delSegs = 0
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i]
    const t0 = it && it.t ? String(it.t) : ''
    const s0 = String(it && it.s ? it.s : '')
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

function aiAgentDiffRenderHtml(ops, mode) {
  const arr = Array.isArray(ops) ? ops : []
  const m = String(mode || 'new')
  let html = ''
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {}
    const t0 = String(it.t || '')
    const s0 = aiAgentEscapeHtml(it.s)
    if (t0 === 'eq') html += s0
    else if (t0 === 'ins') html += `<mark>${s0}</mark>`
    else if (t0 === 'del' && m === 'combined') html += `<del>${s0}</del>`
  }
  return html
}

function aiAgentBuildReview(ops) {
  const arr = Array.isArray(ops) ? ops : []
  const hunks = []
  const map = new Int32Array(arr.length)
  for (let i = 0; i < map.length; i++) map[i] = -1

  const allowEqGap = 1 // 两个改动之间夹 1 个 eq 片段仍算同一块
  const ctxEq = 1 // 前后各带 1 个 eq 片段做上下文

  let i = 0
  while (i < arr.length) {
    if (!arr[i] || arr[i].t === 'eq') { i++; continue }
    let start = i
    let end = i

    // 扩展到本块最后一个非 eq（允许中间夹少量 eq）
    while (end + 1 < arr.length) {
      if (arr[end + 1] && arr[end + 1].t !== 'eq') { end++; continue }
      // 允许少量 eq gap 后继续合并
      let j = end + 1
      let gap = 0
      while (j < arr.length && arr[j] && arr[j].t === 'eq' && gap < allowEqGap) { gap++; j++ }
      if (j < arr.length && arr[j] && arr[j].t !== 'eq') {
        end = j
        continue
      }
      break
    }

    // 加一点上下文
    const viewStart = Math.max(0, start - ctxEq)
    const viewEnd = Math.min(arr.length - 1, end + ctxEq)

    const id = hunks.length
    hunks.push({ id, viewStart, viewEnd, accepted: true })
    for (let k = viewStart; k <= viewEnd; k++) {
      const it = arr[k]
      if (it && it.t !== 'eq') map[k] = id
    }

    i = end + 1
  }

  return { ops: arr, hunks, map, base: '', cur: '', chunkLen: 0, finalText: '' }
}

function aiAgentComposeFromReview(review) {
  const r = review && typeof review === 'object' ? review : null
  const ops = r && Array.isArray(r.ops) ? r.ops : []
  const hunks = r && Array.isArray(r.hunks) ? r.hunks : []
  const map = r && r.map && typeof r.map.length === 'number' ? r.map : null

  const hAcc = (id) => {
    const h = (id >= 0 && id < hunks.length) ? hunks[id] : null
    return !!(h && h.accepted)
  }

  let out = ''
  for (let i = 0; i < ops.length; i++) {
    const it = ops[i]
    if (!it) continue
    if (it.t === 'eq') { out += it.s; continue }
    const id = map ? (map[i] | 0) : -1
    const accept = hAcc(id)
    if (it.t === 'ins') { if (accept) out += it.s }
    else if (it.t === 'del') { if (!accept) out += it.s }
  }
  return out
}

function aiAgentArmDangerButton(btn, secondText, windowMs) {
  try {
    const b = btn
    if (!b) return false
    const now = Date.now()
    const win = Math.max(600, (windowMs | 0) || 1800)
    const prevAt = __AI_AGENT__.armedAt | 0
    if (prevAt && (now - prevAt) <= win) return true
    __AI_AGENT__.armedAt = now
    __AI_AGENT__.armedText = String(b.textContent || '')
    b.textContent = String(secondText || aiText('再次点击确认', 'Click again to confirm'))
    try { b.classList.add('danger-armed') } catch {}
    setTimeout(() => {
      try {
        if (!__AI_AGENT__ || (__AI_AGENT__.armedAt | 0) !== (now | 0)) return
        __AI_AGENT__.armedAt = 0
        const t0 = __AI_AGENT__.armedText
        if (t0) b.textContent = t0
        try { b.classList.remove('danger-armed') } catch {}
      } catch {}
    }, win + 40)
    return false
  } catch {}
  return false
}

function aiAgentResetState() {
  __AI_AGENT__.source = ''
  __AI_AGENT__.selection = null
  __AI_AGENT__.original = ''
  __AI_AGENT__.base = ''
  __AI_AGENT__.current = ''
  __AI_AGENT__.lastStats = null
  __AI_AGENT__.review = null
  __AI_AGENT__.busy = false
  try { aiAgentCloseOverlay() } catch {}
  __AI_AGENT__.armedAt = 0
  __AI_AGENT__.armedText = ''
}

function aiAgentRenderOverlay(context) {
  const overlay = DOC().getElementById('ai-agent-overlay')
  if (!overlay) return
  const diff = overlay.querySelector('#ai-agent-overlay-diff')
  const meta = overlay.querySelector('#ai-agent-overlay-meta')
  const cb = overlay.querySelector('#ai-agent-overlay-show-del')
  const list = overlay.querySelector('#ai-agent-overlay-list')
  const btnApply = overlay.querySelector('#ai-agent-overlay-apply')
  const btnAllOn = overlay.querySelector('#ai-agent-overlay-all-on')
  const btnAllOff = overlay.querySelector('#ai-agent-overlay-all-off')
  if (!diff || !meta) return

  if (cb) cb.checked = !!__AI_AGENT__.showDel

  const base = String(__AI_AGENT__.base || '')
  const cur = String(__AI_AGENT__.current || '')
  if (!base || !cur) {
    meta.textContent = aiText('暂无审阅：先生成一次修订草稿。', 'No review: generate a revision draft first.')
    diff.textContent = aiText('审阅面板会显示在这里。', 'Review will appear here.')
    if (list) list.innerHTML = ''
    if (btnApply) btnApply.setAttribute('disabled', 'true')
    return
  }
  const chunkLen = Math.max(40, Math.min(160, Math.round(Math.max(base.length, cur.length) / 80) || 80))

  // 生成/复用审阅结构：关键点是“不要每次 render 都重建 ops”，否则勾选会被重置（看起来像没反应）
  let review = __AI_AGENT__.review
  if (!review || review.base !== base || review.cur !== cur || (review.chunkLen | 0) !== (chunkLen | 0)) {
    const ops = aiAgentDiffLcsOps(aiAgentDiffTokenize(base, chunkLen), aiAgentDiffTokenize(cur, chunkLen))
    review = aiAgentBuildReview(ops)
    review.base = base
    review.cur = cur
    review.chunkLen = chunkLen | 0
    __AI_AGENT__.review = review
  }

  const ops = review && Array.isArray(review.ops) ? review.ops : []
  const st = aiAgentDiffStats(ops)
  __AI_AGENT__.lastStats = st

  const ins = st ? (st.insChars | 0) : 0
  const del = st ? (st.delChars | 0) : 0
  const hTotal = review && review.hunks ? review.hunks.length : 0
  const hOn = review && review.hunks ? review.hunks.filter((h) => !!h.accepted).length : 0
  meta.textContent = aiText(`改动：+${ins} -${del}；采用 ${hOn}/${hTotal} 处。`, `Changes: +${ins} -${del}; accept ${hOn}/${hTotal}.`)

  // 顶部整体预览：用“当前勾选”拼装出最终稿
  try {
    const finalText = aiAgentComposeFromReview(review)
    review.finalText = finalText
    diff.innerHTML = aiAgentDiffRenderHtml(aiAgentDiffLcsOps(aiAgentDiffTokenize(base, chunkLen), aiAgentDiffTokenize(finalText, chunkLen)), __AI_AGENT__.showDel ? 'combined' : 'new')
  } catch {
    diff.innerHTML = aiAgentDiffRenderHtml(ops, __AI_AGENT__.showDel ? 'combined' : 'new')
  }

  // 分块审阅列表
  if (list) {
    const hunks = review && Array.isArray(review.hunks) ? review.hunks : []
    const html = []
    for (const h of hunks) {
      const slice = ops.slice(h.viewStart, h.viewEnd + 1)
      const body = aiAgentDiffRenderHtml(slice, __AI_AGENT__.showDel ? 'combined' : 'new')
      html.push(
        '<div class="ai-agent-hunk" data-hunk="' + h.id + '">',
        ' <div class="ai-agent-hunk-head">',
        '  <label class="ai-agent-check"><input class="ai-agent-hunk-toggle" type="checkbox"' + (h.accepted ? ' checked' : '') + '/> ' + aiText('采用', 'Accept') + '</label>',
        '  <button class="ai-agent-btn gray ai-agent-hunk-apply">' + aiText('写回本条', 'Apply this') + '</button>',
        '  <div class="ai-agent-hunk-id">#' + (h.id + 1) + '</div>',
        ' </div>',
        ' <div class="ai-agent-hunk-body">' + body + '</div>',
        '</div>',
      )
    }
    list.innerHTML = html.join('')

    // 绑定每块的勾选
    list.querySelectorAll('.ai-agent-hunk-toggle').forEach((el2) => {
      el2.addEventListener('change', (e) => {
        try {
          const node = e && e.target ? e.target : null
          const wrap = node && node.closest ? node.closest('.ai-agent-hunk') : null
          const hid = wrap ? (wrap.getAttribute('data-hunk') || '') : ''
          const id = parseInt(hid, 10)
          if (!Number.isFinite(id) || !review || !review.hunks || !review.hunks[id]) return
          review.hunks[id].accepted = !!(node && node.checked)
          aiAgentRenderOverlay(context)
          aiAgentRenderPanel(context)
        } catch {}
      })
    })

    list.querySelectorAll('.ai-agent-hunk-apply').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        try {
          const b = e && e.target ? e.target : null
          const wrap = b && b.closest ? b.closest('.ai-agent-hunk') : null
          const hid = wrap ? (wrap.getAttribute('data-hunk') || '') : ''
          const id = parseInt(hid, 10)
          if (!Number.isFinite(id) || !review || !review.hunks || !review.hunks[id]) return

          // 仅写回“本条”：临时覆盖 accepted 状态生成 partial，然后恢复
          const old = review.hunks.map((h) => !!h.accepted)
          try {
            for (let i = 0; i < review.hunks.length; i++) review.hunks[i].accepted = (i === id)
            const partial = aiAgentComposeFromReview(review)
            const out = String(partial || '')
            if (!out.trim()) throw new Error(aiText('本条写回结果为空', 'Empty result'))

            // 写回：优先按“开始时捕获的选区范围”写回；失败再回退到当前选区
            if (__AI_AGENT__.source === 'selection') {
              const s0 = __AI_AGENT__.selection
              if (s0 && typeof context.replaceRange === 'function' && typeof s0.start === 'number' && typeof s0.end === 'number' && s0.end > s0.start) {
                await context.replaceRange(s0.start, s0.end, out)
                __AI_AGENT__.selection = { start: s0.start, end: s0.start + out.length, text: out }
                try { context.ui.notice(aiText('已写回本条到选区', 'Applied this to selection'), 'ok', 1400) } catch {}
              } else {
                const sel = await context.getSelection?.()
                if (sel && typeof context.replaceRange === 'function' && typeof sel.start === 'number' && typeof sel.end === 'number' && sel.end > sel.start) {
                  await context.replaceRange(sel.start, sel.end, out)
                  __AI_AGENT__.selection = { start: sel.start, end: sel.start + out.length, text: out }
                  __AI_AGENT__.source = 'selection'
                  try { context.ui.notice(aiText('已写回本条到当前选区', 'Applied this to current selection'), 'ok', 1400) } catch {}
                } else {
                  throw new Error(aiText('未找到可替换的选区：请重新选中要替换的文本', 'No selection to replace: please reselect the text'))
                }
              }
            } else {
              if (typeof context.setEditorValue !== 'function') throw new Error(aiText('当前环境不支持写回全文', 'setEditorValue not available'))
              context.setEditorValue(out)
              try { context.ui.notice(aiText('已写回本条到全文', 'Applied this to whole document'), 'ok', 1400) } catch {}
            }

            // 本条写回后：更新基线为当前文档，让剩余改动继续可审阅
            __AI_AGENT__.base = out
            __AI_AGENT__.original = out
            __AI_AGENT__.review = null
            __AI_AGENT__.lastStats = null
            aiAgentRenderPanel(context)
            aiAgentRenderOverlay(context)
          } finally {
            // 恢复原勾选（避免用户勾选状态被破坏）
            try {
              for (let i = 0; i < old.length && i < review.hunks.length; i++) review.hunks[i].accepted = old[i]
            } catch {}
          }
        } catch (err) {
          try { context.ui.notice(aiText('写回本条失败：', 'Apply this failed: ') + (err && err.message ? err.message : String(err)), 'err', 2600) } catch {}
        }
      })
    })
  }

  if (btnApply) {
    const hasHunk = review && review.hunks && review.hunks.length > 0
    if (hasHunk) btnApply.removeAttribute('disabled')
    else btnApply.setAttribute('disabled', 'true')
  }

  // 全选/全不选
  try {
    if (btnAllOn) btnAllOn.onclick = () => {
      try {
        if (!review || !review.hunks) return
        for (const h of review.hunks) h.accepted = true
        aiAgentRenderOverlay(context)
        aiAgentRenderPanel(context)
      } catch {}
    }
    if (btnAllOff) btnAllOff.onclick = () => {
      try {
        if (!review || !review.hunks) return
        for (const h of review.hunks) h.accepted = false
        aiAgentRenderOverlay(context)
        aiAgentRenderPanel(context)
      } catch {}
    }
  } catch {}
}

function aiAgentCloseOverlay() {
  try {
    try {
      const onEsc = __AI_AGENT__ && __AI_AGENT__.overlayEscHandler
      if (typeof onEsc === 'function') {
        try { WIN().removeEventListener('keydown', onEsc) } catch {}
      }
      if (__AI_AGENT__) __AI_AGENT__.overlayEscHandler = null
    } catch {}
    const overlay = DOC().getElementById('ai-agent-overlay')
    if (overlay) overlay.remove()
  } catch {}
  __AI_AGENT__.overlayOpen = false
}

function aiAgentOpenOverlay(context) {
  if (__AI_AGENT__.overlayOpen) {
    aiAgentRenderOverlay(context)
    return
  }
  __AI_AGENT__.overlayOpen = true
  const overlay = DOC().createElement('div')
  overlay.id = 'ai-agent-overlay'
  try {
    const winEl = DOC().getElementById('ai-assist-win')
    let isDark = !!(winEl && winEl.classList && winEl.classList.contains('dark'))
    if (!isDark) {
      try {
        const body = WIN().document && WIN().document.body
        isDark = !!(body && body.classList && body.classList.contains('dark-mode'))
      } catch {}
    }
    if (!isDark) {
      try { isDark = !!(WIN().matchMedia && WIN().matchMedia('(prefers-color-scheme: dark)').matches) } catch {}
    }
    if (isDark) overlay.classList.add('dark')
  } catch {}
  overlay.innerHTML = [
    '<div class="ai-agent-overlay-card">',
    ' <div class="ai-agent-overlay-head">',
    `  <div class="ai-agent-overlay-title">${aiText('Agent 审阅', 'Agent Review')}</div>`,
    '  <div class="ai-agent-overlay-actions">',
    `   <label class="ai-agent-check"><input id="ai-agent-overlay-show-del" type="checkbox"/> ${aiText('显示删除', 'Show deletions')}</label>`,
    `   <button id="ai-agent-overlay-all-on" class="ai-agent-btn gray">${aiText('全选', 'All')}</button>`,
    `   <button id="ai-agent-overlay-all-off" class="ai-agent-btn gray">${aiText('全不选', 'None')}</button>`,
    `   <button id="ai-agent-overlay-copy" class="ai-agent-btn gray">${aiText('复制', 'Copy')}</button>`,
    `   <button id="ai-agent-overlay-apply" class="ai-agent-btn">${aiText('写回', 'Apply')}</button>`,
    `   <button id="ai-agent-overlay-close" class="ai-agent-btn gray">${aiText('关闭', 'Close')}</button>`,
    '  </div>',
    ' </div>',
    ' <div id="ai-agent-overlay-meta" class="ai-agent-overlay-meta"></div>',
    ' <div id="ai-agent-overlay-diff" class="ai-agent-overlay-diff"></div>',
    ' <div id="ai-agent-overlay-list" class="ai-agent-overlay-list"></div>',
    '</div>',
  ].join('')
  DOC().body.appendChild(overlay)

  overlay.addEventListener('click', (e) => {
    if (e && e.target === overlay) aiAgentCloseOverlay()
  })
  overlay.querySelector('#ai-agent-overlay-close')?.addEventListener('click', () => aiAgentCloseOverlay())
  overlay.querySelector('#ai-agent-overlay-show-del')?.addEventListener('change', (e) => {
    __AI_AGENT__.showDel = !!(e && e.target && e.target.checked)
    aiAgentRenderPanel(context)
    aiAgentRenderOverlay(context)
  })
  overlay.querySelector('#ai-agent-overlay-copy')?.addEventListener('click', async () => {
    try {
      const t0 = (__AI_AGENT__.review && __AI_AGENT__.review.finalText != null)
        ? String(__AI_AGENT__.review.finalText || '')
        : String(__AI_AGENT__.current || '')
      if (!t0.trim()) throw new Error(aiText('修订草稿为空', 'Draft is empty'))
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t0)
        try { context.ui.notice(aiText('已复制修订稿', 'Draft copied'), 'ok', 1400) } catch {}
      } else {
        throw new Error(aiText('当前环境不支持剪贴板', 'Clipboard not available'))
      }
    } catch (err) {
      try { context.ui.notice(aiText('复制失败：', 'Copy failed: ') + (err && err.message ? err.message : String(err)), 'err', 2200) } catch {}
    }
  })

  overlay.querySelector('#ai-agent-overlay-apply')?.addEventListener('click', async (e) => {
    try {
      const review = __AI_AGENT__.review
      const out = review && review.finalText != null ? String(review.finalText || '') : ''
      if (!out.trim()) throw new Error(aiText('审阅结果为空', 'Review result is empty'))

      // 写回策略：沿用面板的逻辑（选区优先，其次全文）
      if (__AI_AGENT__.source === 'selection') {
        const s0 = __AI_AGENT__.selection
        if (s0 && typeof context.replaceRange === 'function' && typeof s0.start === 'number' && typeof s0.end === 'number' && s0.end > s0.start) {
          await context.replaceRange(s0.start, s0.end, out)
          try { context.ui.notice(aiText('已写回选区', 'Applied to selection'), 'ok', 1400) } catch {}
        } else {
          const sel = await context.getSelection?.()
          if (sel && typeof context.replaceRange === 'function' && typeof sel.start === 'number' && typeof sel.end === 'number' && sel.end > sel.start) {
            await context.replaceRange(sel.start, sel.end, out)
            try { context.ui.notice(aiText('已写回当前选区', 'Applied to current selection'), 'ok', 1400) } catch {}
          } else {
            throw new Error(aiText('未找到可替换的选区：请重新选中要替换的文本', 'No selection to replace: please reselect the text'))
          }
        }
      } else {
        if (typeof context.setEditorValue !== 'function') throw new Error(aiText('当前环境不支持写回全文', 'setEditorValue not available'))
        context.setEditorValue(out)
        try { context.ui.notice(aiText('已写回全文', 'Applied to whole document'), 'ok', 1400) } catch {}
      }

      // 写回后：把“当前草稿”变成新基线
      __AI_AGENT__.original = out
      __AI_AGENT__.base = out
      __AI_AGENT__.current = out
      __AI_AGENT__.review = null
      __AI_AGENT__.selection = null
      __AI_AGENT__.source = ''
      __AI_AGENT__.lastStats = null
      aiAgentRenderPanel(context)
      aiAgentRenderOverlay(context)
    } catch (err) {
      try { context.ui.notice(aiText('写回失败：', 'Apply failed: ') + (err && err.message ? err.message : String(err)), 'err', 2600) } catch {}
    }
  })

  try {
    const onEsc = (e) => {
      if (e && e.key === 'Escape') {
        aiAgentCloseOverlay()
      }
    }
    __AI_AGENT__.overlayEscHandler = onEsc
    WIN().addEventListener('keydown', onEsc)
  } catch {}

  aiAgentRenderOverlay(context)
}

async function aiAgentPickSource(context, prefer) {
  const pref = String(prefer || __AI_AGENT__.target || 'auto')
  let sel = null
  try { sel = await context.getSelection?.() } catch {}
  const selText = sel && sel.text != null ? String(sel.text || '') : ''
  const hasSel = !!selText.trim()
  const doc = String(context.getEditorValue ? (context.getEditorValue() || '') : '')

  if (pref === 'selection' || (pref === 'auto' && hasSel)) {
    if (hasSel) {
      __AI_AGENT__.source = 'selection'
      __AI_AGENT__.selection = sel && typeof sel === 'object' ? { start: sel.start, end: sel.end, text: selText } : { start: 0, end: 0, text: selText }
      if (!__AI_AGENT__.original) __AI_AGENT__.original = selText
      if (!__AI_AGENT__.current) __AI_AGENT__.current = selText
      return
    }
  }
  __AI_AGENT__.source = 'document'
  __AI_AGENT__.selection = null
  if (!__AI_AGENT__.original) __AI_AGENT__.original = doc
  if (!__AI_AGENT__.current) __AI_AGENT__.current = doc
}

function aiAgentEnsurePanelDom(rootEl) {
  const root = rootEl || DOC()
  const panel = root.querySelector('#ai-agent-panel')
  if (!panel) return null
  if (panel.getAttribute('data-inited') === '1') return panel
  panel.setAttribute('data-inited', '1')
  panel.innerHTML = [
    '<div class="ai-agent-head">',
    ` <div class="ai-agent-title">${aiText('Agent模式', 'Agent')}</div>`,
    ' <div class="ai-agent-head-right">',
    `  <select id="ai-agent-target" class="ai-agent-target" title="${aiText('作用范围：选区/全文', 'Target: selection or whole doc')}">`,
    `   <option value="auto">${aiText('自动', 'Auto (prefer selection)')}</option>`,
    `   <option value="selection">${aiText('选区', 'Selection')}</option>`,
    `   <option value="document">${aiText('全文', 'Whole doc')}</option>`,
    '  </select>',
    `  <button id="ai-agent-clear" class="ai-agent-btn gray" title="${aiText('清空草稿', 'Clear draft')}">${aiText('清空', 'Clear')}</button>`,
    ' </div>',
    '</div>',
    ` <div class="ai-agent-meta" id="ai-agent-meta">${aiText('可用 /问 或 /修改 前缀强制指定模式。', 'Use /chat or /edit prefix to force mode.')}</div>`,
    '<div class="ai-agent-tools">',
    ' <label class="ai-agent-check"><input id="ai-agent-show-del" type="checkbox"/> ' + aiText('显示删除', 'Show deletions') + '</label>',
    ` <button id="ai-agent-open-diff" class="ai-agent-btn gray">${aiText('对比', 'Diff')}</button>`,
    ' <div class="ai-agent-spacer"></div>',
    ` <button id="ai-agent-apply" class="ai-agent-btn">${aiText('写回', 'Apply')}</button>`,
    ` <button id="ai-agent-close" class="ai-agent-btn gray">${aiText('关闭', 'Close')}</button>`,
    '</div>'
  ].join('')
  return panel
}

function aiAgentRenderPanel(context) {
  const winEl = el('ai-assist-win')
  if (!winEl) return
  const panel = aiAgentEnsurePanelDom(winEl)
  if (!panel) return

  panel.style.display = __AI_AGENT__.enabled ? 'block' : 'none'
  const btnToggle = winEl.querySelector('#ai-agent-toggle')
  if (btnToggle) btnToggle.classList.toggle('on', !!__AI_AGENT__.enabled)

  const sel = panel.querySelector('#ai-agent-target')
  if (sel) {
    try { sel.value = String(__AI_AGENT__.target || 'auto') } catch {}
  }

  const meta = panel.querySelector('#ai-agent-meta')
  const cb = panel.querySelector('#ai-agent-show-del')
  const btnApply = panel.querySelector('#ai-agent-apply')

  if (cb) cb.checked = !!__AI_AGENT__.showDel

  const srcLabel = __AI_AGENT__.source === 'selection'
    ? aiText('选区', 'Selection')
    : (__AI_AGENT__.source === 'document' ? aiText('全文', 'Whole doc') : aiText('未选择', 'None'))
  const st = __AI_AGENT__.lastStats && typeof __AI_AGENT__.lastStats === 'object' ? __AI_AGENT__.lastStats : null
  const ins = st ? (st.insChars | 0) : 0
  const del = st ? (st.delChars | 0) : 0
  const hasDraft = !!String(__AI_AGENT__.current || '').trim()
  const hasBase = !!String(__AI_AGENT__.base || '').trim()
  const busy = !!__AI_AGENT__.busy

  if (meta) {
    if (!__AI_AGENT__.enabled) meta.textContent = ''
    else if (busy) meta.textContent = aiText(`生成中… 作用范围：${srcLabel}`, `Working… target: ${srcLabel}`)
    else if (!hasDraft) meta.textContent = aiText(`未开始 作用范围：${srcLabel}`, `Not started target: ${srcLabel}`)
    else if (hasBase) meta.textContent = aiText(`作用范围：${srcLabel} 新增 ${ins} 字 删除 ${del} 字`, `Draft ready target: ${srcLabel}; +${ins}, -${del}`)
    else meta.textContent = aiText(`作用范围：${srcLabel}`, `Draft ready target: ${srcLabel}`)
  }

  if (btnApply) btnApply.disabled = busy || !hasDraft
}

function aiAgentBindPanelEvents(context) {
  const winEl = el('ai-assist-win')
  if (!winEl) return
  const panel = aiAgentEnsurePanelDom(winEl)
  if (!panel) return
  if (panel.getAttribute('data-events') === '1') return
  panel.setAttribute('data-events', '1')
  if (panel.getAttribute('data-bound') === '1') return
  panel.setAttribute('data-bound', '1')

  panel.querySelector('#ai-agent-target')?.addEventListener('change', (e) => {
    try { __AI_AGENT__.target = String(e.target.value || 'auto') } catch {}
    aiAgentResetState()
    aiAgentRenderPanel(context)
  })

  panel.querySelector('#ai-agent-clear')?.addEventListener('click', () => {
    aiAgentResetState()
    aiAgentRenderPanel(context)
    try { context.ui.notice(aiText('已清空 Agent 草稿', 'Agent draft cleared'), 'ok', 1200) } catch {}
  })

  panel.querySelector('#ai-agent-close')?.addEventListener('click', () => {
    __AI_AGENT__.enabled = false
    aiAgentResetState()
    aiAgentRenderPanel(context)
    try { context.ui.notice(aiText('Agent 模式已关闭', 'Agent mode disabled'), 'ok', 1200) } catch {}
  })

  panel.querySelector('#ai-agent-show-del')?.addEventListener('change', (e) => {
    __AI_AGENT__.showDel = !!(e && e.target && e.target.checked)
    aiAgentRenderPanel(context)
    aiAgentRenderOverlay(context)
  })

  panel.querySelector('#ai-agent-open-diff')?.addEventListener('click', () => {
    try {
      aiAgentRenderPanel(context)
      aiAgentOpenOverlay(context)
    } catch (e) {
      try { context.ui.notice(aiText('打开对比失败：', 'Open diff failed: ') + (e && e.message ? e.message : String(e)), 'err', 2200) } catch {}
    }
  })

  panel.querySelector('#ai-agent-apply')?.addEventListener('click', async (e) => {
    try {
      if (__AI_AGENT__.busy) return
      const out = String(__AI_AGENT__.current || '')
      if (!out.trim()) throw new Error(aiText('修订草稿为空', 'Draft is empty'))

      // 写回策略：优先按“开始时捕获的选区范围”写回；失败再回退到当前选区
      if (__AI_AGENT__.source === 'selection') {
        const s0 = __AI_AGENT__.selection
        if (s0 && typeof context.replaceRange === 'function' && typeof s0.start === 'number' && typeof s0.end === 'number' && s0.end > s0.start) {
          await context.replaceRange(s0.start, s0.end, out)
          try { context.ui.notice(aiText('已写回选区', 'Applied to selection'), 'ok', 1400) } catch {}
        } else {
          const sel = await context.getSelection?.()
          if (sel && typeof context.replaceRange === 'function' && typeof sel.start === 'number' && typeof sel.end === 'number' && sel.end > sel.start) {
            await context.replaceRange(sel.start, sel.end, out)
            try { context.ui.notice(aiText('已写回当前选区', 'Applied to current selection'), 'ok', 1400) } catch {}
          } else {
            throw new Error(aiText('未找到可替换的选区：请重新选中要替换的文本', 'No selection to replace: please reselect the text'))
          }
        }
      } else {
        if (typeof context.setEditorValue !== 'function') throw new Error(aiText('当前环境不支持写回全文', 'setEditorValue not available'))
        context.setEditorValue(out)
        try { context.ui.notice(aiText('已写回全文', 'Applied to whole document'), 'ok', 1400) } catch {}
      }

      // 写回后：把“当前草稿”变成新基线，方便继续对话式微调
      __AI_AGENT__.original = out
      __AI_AGENT__.base = out
      __AI_AGENT__.current = out
      __AI_AGENT__.review = null
      __AI_AGENT__.selection = null
      __AI_AGENT__.source = ''
      __AI_AGENT__.lastStats = null
      aiAgentRenderPanel(context)
      aiAgentRenderOverlay(context)
    } catch (err) {
      try { context.ui.notice(aiText('写回失败：', 'Apply failed: ') + (err && err.message ? err.message : String(err)), 'err', 2600) } catch {}
    }
  })
}

function aiAgentBuildMessages(baseText, instruction) {
  const locale = aiGetLocale()
  const sys = locale === 'en'
    ? [
        'You are a text editing agent.',
        'Rewrite the given text according to user requests.',
        'Output ONLY the rewritten full text. No explanations. No markdown. No bullet list.',
        'Keep the original formatting as much as possible (line breaks, punctuation).',
        'If the request is small, do minimal changes.',
      ].join('\n')
    : [
        '你是一个“文本编辑Agent”。',
        '根据用户的修改要求，重写给定文本。',
        '只输出“修订后的全文”，不要解释、不要清单、不要Markdown、不要代码块。',
        '尽量保持原始排版（换行、标点、段落）。',
        '改动很小就少改，别自作主张扩写。',
      ].join('\n')

  const u = [
    locale === 'en' ? 'ORIGINAL TEXT:' : '【原文】',
    String(baseText || ''),
    '',
    locale === 'en' ? 'EDIT REQUEST:' : '【修改要求】',
    String(instruction || '').trim(),
    '',
    locale === 'en' ? 'Remember: output only the rewritten full text.' : '再次强调：只输出修订后的全文。',
  ].join('\n')

  return [
    { role: 'system', content: sys },
    { role: 'user', content: u }
  ]
}

function aiAgentAddThinking(context) {
  try {
    const chatEl = el('ai-chat')
    if (!chatEl) return () => {}
    const wrap = DOC().createElement('div')
    wrap.className = 'msg-wrapper'
    wrap.id = 'ai-agent-thinking'
    const bubble = DOC().createElement('div')
    bubble.className = 'msg a ai-thinking'
    bubble.innerHTML = '<span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span>'
    wrap.appendChild(bubble)
    chatEl.appendChild(wrap)
    chatEl.scrollTop = chatEl.scrollHeight
    return () => { try { wrap.remove() } catch {} }
  } catch {
    return () => {}
  }
}

async function sendFromInputAgent(context) {
  const ta = el('ai-text')
  const text = String((ta && ta.value) || '').trim()
  if (!text) return
  if (__AI_SENDING__) {
    try { context.ui.notice(aiText('请等待当前 AI 响应完成', 'Please wait for the current response'), 'warn', 1800) } catch {}
    return
  }
  if (ta) ta.value = ''
  await ensureSessionForDoc(context)
  pushMsg('user', text)
  try { await syncCurrentSessionToDB(context) } catch {}
  renderMsgs(el('ai-chat'))

  __AI_SENDING__ = true
  __AI_AGENT__.busy = true
  aiAgentBindPanelEvents(context)
  aiAgentRenderPanel(context)
  const removeThinking = aiAgentAddThinking(context)
  try {
    // 强制重新获取当前文档内容（避免切换文档后上下文过期）
    __AI_AGENT__.original = ''
    __AI_AGENT__.current = ''
    await aiAgentPickSource(context, __AI_AGENT__.target)
    const base = String(__AI_AGENT__.current || '')
    __AI_AGENT__.base = base
    aiAgentRenderPanel(context)

    const cfg = await ensureApiConfig(context)
    const messages = aiAgentBuildMessages(base, text)
    const body = { model: resolveModelId(cfg), messages, stream: false }
    const res = await performAIRequest(cfg, body, context)
    const next = String(res && res.text != null ? res.text : '').trim()
    if (!next) throw new Error(aiText('AI 返回为空', 'Empty AI response'))
    __AI_AGENT__.current = next
    __AI_AGENT__.busy = false
    aiAgentRenderPanel(context)

    try { aiAgentOpenOverlay(context) } catch {}
    pushMsg('assistant', aiText('Agent：已生成修订草稿，请审阅', 'Agent: draft ready. Please review.'))
    __AI_LAST_REPLY__ = 'Agent draft ready'
    renderMsgs(el('ai-chat'))
    try { await syncCurrentSessionToDB(context) } catch {}
  } catch (err) {
    __AI_AGENT__.busy = false
    aiAgentRenderPanel(context)
    pushMsg('assistant', aiText('Agent失败：', 'Agent failed: ') + (err && err.message ? err.message : String(err)))
    __AI_LAST_REPLY__ = 'Agent failed'
    renderMsgs(el('ai-chat'))
    try { await syncCurrentSessionToDB(context) } catch {}
  } finally {
    try { removeThinking() } catch {}
    __AI_SENDING__ = false
    __AI_AGENT__.busy = false
    aiAgentRenderPanel(context)
    aiAgentRenderOverlay(context)
  }
}

async function callAIForPlugins(context, prompt, options = {}){
  const text = String(prompt || '').trim()
  if (!text) throw new Error('Prompt 不能为空')
  const cfg = await ensureApiConfig(context, options.cfgOverride)
  const systemMsg = options.system || '你是一个专业助手'
  const messages = options.messages || [
    { role: 'system', content: systemMsg },
    { role: 'user', content: text }
  ]
  const body = { model: resolveModelId(cfg), messages, stream: false }
  const result = await performAIRequest(cfg, body, context)
  return result.text
}

async function translateForPlugins(context, text){
  const content = String(text || '').trim()
  if (!content) throw new Error('翻译内容不能为空')
  const cfg = await loadCfg(context)
  const override = cfg.alwaysUseFreeTrans ? { provider: 'free' } : {}
  const finalCfg = await ensureApiConfig(context, override)
  const prompt = buildPromptPrefix('翻译') + '\n\n' + content
  const body = {
    model: resolveModelId(finalCfg),
    messages: [
      { role: 'system', content: '你是专业的翻译助手。' },
      { role: 'user', content: prompt }
    ],
    stream: false
  }
  const result = await performAIRequest(finalCfg, body, context)
  return result.text
}

async function quickActionForPlugins(context, content, action){
  const doc = String(content || '').trim()
  if (!doc) throw new Error('文档内容为空')
  const prefix = buildPromptPrefix(action)
  const prompt = `文档上下文：\n\n${doc}\n\n${prefix}`
  return await callAIForPlugins(context, prompt, {
    system: '你是专业的中文写作助手，回答要简洁、实用、可直接落地。'
  })
}

async function generateTodosForPlugins(context, content){
  const doc = String(content || '').trim()
  if (!doc) throw new Error('文档内容为空')
  const cfg = await ensureApiConfig(context)
  const { system, prompt } = buildTodoPrompt(doc)
  const body = {
    model: resolveModelId(cfg),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    stream: false
  }
  const result = await performAIRequest(cfg, body, context)
  const todos = extractTodos(result.text)
  return { raw: result.text, todos }
}

async function isAIConfiguredForPlugins(context){
  const cfg = await loadCfg(context)
  return !!(cfg.apiKey || isFreeProvider(cfg))
}

async function getAIConfigSnapshot(context){
  const cfg = await loadCfg(context)
  try { return JSON.parse(JSON.stringify(cfg)) } catch { return { ...cfg } }
}

// ========== TODO 便签辅助函数 ==========
async function ensureDesktopWithSticky(context){
  if (!context.createStickyNote) throw new Error('当前环境不支持便签功能')
}

function buildTodoFileNameBase(now){
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `TODO-${y}${m}${d}`
}

async function generateTodoFilePathFromCurrent(ctx){
  const input = ctx && typeof ctx === 'object' ? ctx : {}
  const src = typeof input.filePath === 'string' && input.filePath
    ? input.filePath
    : null
  if (!src) {
    throw new Error('当前文档尚未保存，无法生成 TODO 便签')
  }
  const parts = src.split(/[/\\]/)
  parts.pop()
  const dir = parts.join(parts.length ? (src.includes('\\') ? '\\' : '/') : '')
  const now = new Date()
  const base = buildTodoFileNameBase(now)
  const ext = '.md'
  let name = base + ext
  let full = (dir ? (dir + (src.includes('\\') ? '\\' : '/')) : '') + name
  // 这里不做真实 exists 检测，由于插件侧暂未暴露文件存在检查 API，交给底层覆盖/创建
  return full
}

async function createTodoStickyFromContent(context, content, fileCtx){
  let generatingNoticeId = null
  try {
    generatingNoticeId = showLongRunningNotice(context, '正在生成 TODO 便签...')
    await ensureDesktopWithSticky(context)

    const doc = String(content || '').trim()
    if (!doc) {
      context.ui.notice('内容为空，无法生成 TODO 便签', 'err', 2000)
      return
    }

    let todosResult
    try {
      todosResult = await generateTodosForPlugins(context, doc)
    } catch (err) {
      context.ui.notice('生成待办失败：' + (err && err.message ? err.message : '未知错误'), 'err', 3000)
      return
    }
    const todoText = (() => {
      const t = todosResult && Array.isArray(todosResult.todos) && todosResult.todos.length
        ? todosResult.todos.join('\n')
        : String(todosResult && todosResult.raw || '').trim()
      return t || ''
    })()
    if (!todoText) {
      context.ui.notice('AI 未生成有效的待办内容', 'err', 2500)
      return
    }

    let targetPath
    try {
      const ctx = fileCtx && typeof fileCtx === 'object' ? fileCtx : {}
      targetPath = await generateTodoFilePathFromCurrent(ctx)
    } catch (err) {
      context.ui.notice(err && err.message ? err.message : '无法确定 TODO 文件路径', 'err', 2600)
      return
    }

    let existingText = ''
    try {
      if (typeof context.invoke === 'function') {
        try {
          existingText = String(await context.invoke('read_text_file_any', { path: targetPath }) || '')
        } catch (err) {
          const msg = String((err && err.message) || err || '')
          if (!/path not found/i.test(msg)) throw err
          existingText = ''
        }
      }
    } catch (err) {
      context.ui.notice('读取 TODO 文件失败：' + (err && err.message ? err.message : '未知错误'), 'err', 3000)
      return
    }

    const base = String(existingText || '').trim()
    const finalContent = (base ? (base + '\n\n') : '') + todoText + '\n'

    try {
      if (typeof context.invoke === 'function') {
        await context.invoke('write_text_file_any', { path: targetPath, content: finalContent })
      } else {
        await context.openFileByPath(targetPath)
        context.setEditorValue(finalContent)
      }
    } catch (err) {
      context.ui.notice('写入 TODO 文件失败：' + (err && err.message ? err.message : '未知错误'), 'err', 3000)
      return
    }

    try {
      await context.openFileByPath(targetPath)
    } catch (err) {
      context.ui.notice('打开 TODO 文件失败：' + (err && err.message ? err.message : '未知错误'), 'err', 2800)
      return
    }

    context.ui.notice('TODO 内容已写入：' + targetPath, 'ok', 2200)

    try {
      await context.createStickyNote(targetPath)
      context.ui.notice('TODO 便签已创建', 'ok', 2200)
    } catch (err) {
      context.ui.notice('创建便签失败：' + (err && err.message ? err.message : '未知错误'), 'err', 2800)
    }
  } finally {
    hideLongRunningNotice(context, generatingNoticeId)
  }
}

// 追加一段样式，使用独立命名空间，避免污染宿主
function ensureCss() {
  if (DOC().getElementById('ai-assist-style')) return
  const css = DOC().createElement('style')
  css.id = 'ai-assist-style'
  css.textContent = [
    // 容器（浅色友好 UI）；默认走 dock-left 模式（伪装侧栏）
    '#ai-assist-win{position:fixed;z-index:30;background:#ffffff;color:#0f172a;',
    'border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.15);overflow:hidden}',
    '#ai-assist-win.dock-left{left:0; top:0; height:100vh; width:400px; border-radius:0; border-left:none; border-top:none; border-bottom:none; box-shadow:none; border-right:1px solid #e5e7eb}',
    '#ai-assist-win.dock-right{right:0; top:0; height:100vh; width:400px; border-radius:0; border-right:none; border-top:none; border-bottom:none; box-shadow:none; border-left:1px solid #e5e7eb}',
    '#ai-assist-win.dock-bottom{left:0; right:0; bottom:0; width:100%; height:320px; border-radius:0; border-bottom:none; box-shadow:none; border-top:1px solid #e5e7eb}',
    // 头部与标题
    '#ai-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:move;background:#fff}',
    '#ai-title{font-weight:600;color:#111827;font-size:14px}',
    // 主体、工具栏
    '#ai-body{display:flex;flex-direction:column;height:calc(100% - 44px)}',
    '#ai-toolbar{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border-bottom:1px solid #e5e7eb;background:#fff}',
    '.ai-toolbar-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
    '.ai-toolbar-meta{justify-content:space-between}',
    '.ai-toolbar-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.ai-toolbar-actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px;width:100%}',
    '#ai-chat{flex:1;overflow:auto;padding:16px 18px;background:#fff;display:flex;flex-direction:column}',
    '.msg-wrapper{display:flex;margin:8px 0;max-width:100%;gap:8px}',
    '.msg-wrapper:has(.msg.u){margin-left:auto;flex-direction:row-reverse;max-width:88%}',
    '.msg-wrapper:has(.msg.a){margin-right:auto;flex-direction:row;max-width:100%}',
    '.msg-wrapper .ai-avatar{width:36px;height:36px;border-radius:50%;flex-shrink:0;object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,0.1)}',
    '.msg-wrapper .msg-content-wrapper{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}',
    '.msg-wrapper .ai-nickname{font-size:12px;color:#6b7280;padding-left:4px}',
    '.msg{white-space:pre-wrap;line-height:1.55;border-radius:16px;padding:12px 14px;box-shadow:0 6px 16px rgba(15,23,42,.08);position:relative;font-size:14px;max-width:100%;word-wrap:break-word}',
    '.msg-wrapper:has(.msg.a) .msg{flex:1}',
    '.msg.u{background:linear-gradient(135deg,#e0f2ff,#f0f7ff);border:1px solid rgba(59,130,246,.3)}',
    '.msg.a{background:#fefefe;border:1px solid #e5e7eb}',
    '.msg.u::before{content:"";display:none}',
    '.msg.a::before{content:"";display:none}',
    '.msg-actions{display:flex;gap:12px;margin-top:8px;flex-wrap:wrap}',
    '.msg-action-btn{padding:0;border:none;background:none;color:#64748b;font-size:12px;cursor:pointer;text-decoration:none;transition:color .2s}',
    '.msg-action-btn:hover{color:#0f172a;text-decoration:underline}',
    // RAG 引用列表：展示“引用到的笔记标题”，点击打开对应笔记
    '.ai-kb-refs{margin-top:8px;padding:10px 12px;border:1px dashed rgba(148,163,184,.75);border-radius:12px;background:rgba(248,250,252,.9)}',
    '.ai-kb-refs-title{font-size:12px;color:#64748b;margin-bottom:6px}',
    '.ai-kb-refs-list{display:flex;flex-direction:column;gap:6px}',
    '.ai-kb-ref{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:10px;border:1px solid rgba(226,232,240,.9);background:#fff;color:#1e40af;text-decoration:none;font-size:12px;cursor:pointer;max-width:100%}',
    '.ai-kb-ref:hover{background:rgba(239,246,255,.9);border-color:rgba(147,197,253,.9);text-decoration:none}',
    '.ai-kb-ref-meta{color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '#ai-assist-win.dark .ai-kb-refs{border-color:rgba(71,85,105,.9);background:rgba(17,24,39,.35)}',
    '#ai-assist-win.dark .ai-kb-refs-title{color:#9ca3af}',
    '#ai-assist-win.dark .ai-kb-ref{background:#111827;border-color:rgba(55,65,81,.9);color:#93c5fd}',
    '#ai-assist-win.dark .ai-kb-ref:hover{background:rgba(30,41,59,.9);border-color:rgba(59,130,246,.6)}',
    '#ai-assist-win.dark .ai-kb-ref-meta{color:#9ca3af}',
    '#ai-input{position:relative;padding:6px 8px;border-top:1px solid #e5e7eb;background:#fafafa}',
    '#ai-vresizer{position:absolute;right:0;top:0;width:8px;height:100%;cursor:ew-resize;background:transparent;z-index:10}',
    '#ai-vresizer:hover{background:rgba(59,130,246,0.15)}',
    '#ai-resizer{position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:nwse-resize;background:transparent}',
    '#ai-selects select,#ai-selects input{background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:8px;padding:6px 8px}',
    '#ai-selects{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;flex:0 1 auto}',
    '#ai-selects label{font-size:13px;color:#6b7280;white-space:nowrap}',
    '.ai-session-picker{display:flex;flex-wrap:wrap;align-items:center;gap:6px;justify-content:flex-end}',
    '.ai-session-label{font-size:15px;font-weight:600;color:#0f172a}',
    '.ai-mode-switch{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;flex-shrink:0}',
    '.ai-mode-switch .mode-label{font-size:13px;color:#6b7280;white-space:nowrap;transition:all .2s}',
    '.ai-mode-switch .mode-label.active{color:#2563eb;font-weight:600}',
    '#ai-toolbar .btn{padding:7px 12px;border-radius:8px;border:1px solid #d1d5db;background:#ffffff;color:#0f172a;display:inline-flex;align-items:center;justify-content:center;font-weight:500;gap:4px;min-height:34px}',
    '#ai-toolbar .btn:hover{background:#f3f4f6}',
    '#ai-toolbar .btn.session-btn{padding:0;border:none;background:none;color:#64748b;font-size:14px;cursor:pointer;text-decoration:none;transition:color .2s;width:auto;min-height:auto}',
    '#ai-toolbar .btn.session-btn:hover{color:#0f172a;text-decoration:underline;background:none}',
    '#ai-toolbar .btn.action{padding:0;border:none;background:none;color:#64748b;font-size:14px;cursor:pointer;text-decoration:none;transition:color .2s;width:auto;min-height:auto}',
    '#ai-toolbar .btn.action:hover{color:#0f172a;text-decoration:underline;background:none}',
    '.small{font-size:12px;opacity:.85}',
    '#ai-assist-win.dock-left #ai-resizer{display:none}',
    '#ai-assist-win.dock-right #ai-resizer{display:none}',
    '#ai-assist-win.dock-bottom #ai-resizer{display:none}',
    '#ai-assist-win:not(.dock-left):not(.dock-right) #ai-vresizer{display:none}',
    // 设置面板（内置模态）
    '#ai-set-overlay{position:absolute;inset:0;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:100}',
    '#ai-set-dialog{width:520px;max-width:92vw;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.18);overflow:hidden}',
    '#ai-set-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb}',
    '#ai-set-title{font-weight:600}',
    '#ai-set-body{padding:12px}',
    '.set-row{display:flex;align-items:center;gap:10px;margin:8px 0}',
    '.set-row label{width:110px;color:#334155}',
    '.set-row input{flex:1;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:8px;padding:8px 10px}',
    '.set-row select{flex:0 0 100px;max-width:100px;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:8px;padding:8px 10px}',
    '.set-row.set-link-row a{font-size:10px}',
    '#ai-set-actions{display:flex;gap:10px;justify-content:flex-end;padding:10px 12px;border-top:1px solid #e5e7eb;background:#fafafa}',
    '#ai-set-actions button{padding:8px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#ffffff;color:#0f172a}',
    '#ai-set-actions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    // 设置面板暗黑模式
    '#ai-assist-win.dark #ai-set-dialog{background:#1a1b1e;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-set-head{background:#1a1b1e;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-set-title{color:#e5e7eb}',
    '#ai-assist-win.dark #ai-set-head button{background:#1a1b1e;border-color:#374151;color:#e5e7eb}',
    '#ai-assist-win.dark #ai-set-body{color:#e5e7eb}',
    '#ai-assist-win.dark .set-row label{color:#9ca3af}',
    '#ai-assist-win.dark .set-row input{background:#1a1b1e;border-color:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark .set-row select{background:#1a1b1e;border-color:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark .free-warning{background:#1a1b1e;border-color:#d97706;color:#fef3c7}',
    '#ai-assist-win.dark #ai-set-actions{background:#1a1b1e;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-set-actions button{background:#1a1b1e;border-color:#374151;color:#e5e7eb}',
    '#ai-assist-win.dark #ai-set-actions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    '#ai-assist-win.dark #ai-set-actions button:hover{background:#374151}',
    '#ai-assist-win.dark #ai-set-actions button.primary:hover{background:#1d4ed8}',
    // 暗黑模式样式
    '#ai-assist-win.dark{background:#1a1b1e;color:#e5e7eb;border-color:#1f2937}',
    '#ai-assist-win.dark.dock-left{border-right-color:#1f2937}',
    '#ai-assist-win.dark.dock-right{border-left-color:#1f2937}',
    '#ai-assist-win.dark #ai-head{background:#1a1b1e}',
    '#ai-assist-win.dark #ai-title{color:#e5e7eb}',
    '#ai-assist-win.dark #ai-toolbar{background:#1a1b1e;border-bottom:1px solid #1f2937}',
    '#ai-assist-win.dark #ai-chat{background:#1a1b1e}',
    '#ai-assist-win.dark .msg.u{background:#1a1b1e;border:1px solid #1d4ed8}',
    '#ai-assist-win.dark .msg.a{background:#1a1b1e;border:1px solid #1f2937}',
    '#ai-assist-win.dark .ai-nickname{color:#9ca3af}',
    '#ai-assist-win.dark .msg-action-btn{color:#9ca3af}',
    '#ai-assist-win.dark .msg-action-btn:hover{color:#e5e7eb}',
    '#ai-assist-win.dark #ai-input{background:#1a1b1e;border-top:1px solid #1f2937}',
    '#ai-assist-win.dark #ai-toolbar select,#ai-assist-win.dark #ai-toolbar input{background:#1a1b1e;border:1px solid #1f2937;color:#e5e7eb}',
    '#ai-free-model{background:#fff;border:1px solid #e5e7eb;color:#0f172a}',
    '#ai-assist-win.dark #ai-free-model{background:#1a1b1e;border-color:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark #ai-selects label{color:#9ca3af}',
    '#ai-assist-win.dark #ai-vresizer:hover{background:rgba(96,165,250,0.2)}',
    '#ai-assist-win.dark .ai-mode-switch{background:#1a1b1e;border:1px solid #1f2937}',
    '#ai-assist-win.dark .ai-mode-switch .mode-label{color:#9ca3af}',
    '#ai-assist-win.dark .ai-mode-switch .mode-label.active{color:#60a5fa}',
    // 极窄宽度优化（<300px）
    '@media (max-width: 320px) { #ai-input button { font-size: 11px; padding: 5px 6px; } }',
    // toggle 开关样式
    '.toggle-switch{position:relative;display:inline-block;width:44px;min-width:44px;max-width:44px;height:22px;margin:0 8px;vertical-align:middle;flex-shrink:0}',
    '.toggle-switch input{opacity:0;width:0;height:0;position:absolute}',
    '.toggle-slider{position:absolute;cursor:pointer;top:0;left:0;width:44px;height:22px;background:#d1d5db;transition:.3s;border-radius:22px}',
    '.toggle-slider:before{position:absolute;content:"";height:16px;width:16px;left:3px;top:3px;background:#fff;transition:.3s;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.2)}',
    'input:checked + .toggle-slider{background:#2563eb}',
    'input:checked + .toggle-slider:before{left:25px}',
    '#ai-assist-win.dark .toggle-slider{background:#4b5563}',
    '#ai-assist-win.dark input:checked + .toggle-slider{background:#3b82f6}',
    // 免费模式警告样式
    '.free-warning{display:none;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;margin:8px 0;color:#92400e;font-size:12px;line-height:1.5}',
    '#ai-assist-win.dark .free-warning{background:#1a1b1e;border-color:#d97706;color:#fef3c7}',
    // 模式切换行样式
    '.set-row.mode-row{display:flex;align-items:center;gap:10px;margin:8px 0}',
    '.set-row.mode-row label{width:110px;color:#334155}',
    '.mode-label{font-size:13px;color:#6b7280}',
    '.mode-label.active{color:#2563eb;font-weight:500}',
    '#ai-assist-win.dark .mode-label{color:#9ca3af}',
    '#ai-assist-win.dark .mode-label.active{color:#60a5fa}',
    // 新增：头部操作按钮组（图标样式）
    '.ai-head-actions{display:flex;align-items:center;gap:2px}',
    '.ai-icon-btn{width:24px;height:24px;padding:0;border:none;background:transparent;color:#9ca3af;font-size:14px;cursor:pointer;border-radius:4px;transition:all .15s;display:flex;align-items:center;justify-content:center}',
    '.ai-icon-btn:hover{color:#374151;background:rgba(0,0,0,.06)}',
    '.ai-icon-btn.close-btn{font-size:16px}',
    '#ai-assist-win.dark .ai-icon-btn{color:#6b7280}',
    '#ai-assist-win.dark .ai-icon-btn:hover{color:#e5e7eb;background:rgba(255,255,255,.1)}',
    // 新增：更多菜单
    '.ai-more-menu-wrap{position:relative}',
    '.ai-dropdown-menu{position:absolute;top:100%;right:0;min-width:120px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);display:none;z-index:100;overflow:hidden}',
    '.ai-dropdown-menu.show{display:block}',
    '.ai-menu-item{padding:8px 12px;font-size:13px;color:#374151;cursor:pointer;transition:background .15s}',
    '.ai-menu-item:hover{background:#f3f4f6}',
    '#ai-assist-win.dark .ai-dropdown-menu{background:#1a1b1e;border-color:#374151}',
    '#ai-assist-win.dark .ai-menu-item{color:#e5e7eb}',
    '#ai-assist-win.dark .ai-menu-item:hover{background:#1a1b1e}',
    // 新增：会话历史下拉面板
    '#ai-history-panel{position:absolute;top:48px;left:0;right:0;background:#fff;border-bottom:1px solid #e5e7eb;padding:8px 12px;display:none;z-index:50}',
    '#ai-history-panel.show{display:block}',
    '#ai-history-panel select{width:100%;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:6px;padding:6px 8px;font-size:13px}',
    '#ai-assist-win.dark #ai-history-panel{background:#1a1b1e;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-history-panel select{background:#1a1b1e;border-color:#1f2937;color:#e5e7eb}',
    // 历史会话列表样式
    '.ai-session-list{max-height:200px;overflow-y:auto;margin:0;padding:0;list-style:none}',
    '.ai-session-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;cursor:pointer;border-radius:4px;transition:background .15s}',
    '.ai-session-item:hover{background:#f3f4f6}',
    '.ai-session-item.active{background:#e0f2fe;color:#0369a1}',
    '.ai-session-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
    '.ai-session-item-del{width:18px;height:18px;padding:0;border:none;background:transparent;color:#9ca3af;font-size:14px;cursor:pointer;border-radius:3px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:6px;opacity:0;transition:all .15s}',
    '.ai-session-item:hover .ai-session-item-del{opacity:1}',
    '.ai-session-item-del:hover{color:#ef4444;background:rgba(239,68,68,.1)}',
    '#ai-assist-win.dark .ai-session-item:hover{background:#1a1b1e}',
    '#ai-assist-win.dark .ai-session-item.active{background:#1a1b1e;color:#60a5fa}',
    '#ai-assist-win.dark .ai-session-item-del{color:#6b7280}',
    '#ai-assist-win.dark .ai-session-item-del:hover{color:#f87171;background:rgba(248,113,113,.15)}',
    // 新增：迷你开关样式（无边框简洁版）
    '.ai-mode-switch-mini{display:flex;align-items:center;gap:4px;flex-shrink:0}',
    '.ai-mode-switch-mini .mode-label{font-size:12px;color:#9ca3af;white-space:nowrap;transition:all .2s}',
    '.ai-mode-switch-mini .mode-label.active{color:#3b82f6;font-weight:500}',
    '.toggle-switch-mini{position:relative;display:inline-block;width:32px;min-width:32px;max-width:32px;height:16px;margin:0 4px;vertical-align:middle;flex-shrink:0}',
    '.toggle-switch-mini input{opacity:0;width:0;height:0;position:absolute}',
    '.toggle-slider-mini{position:absolute;cursor:pointer;top:0;left:0;width:32px;height:16px;background:#d1d5db;transition:.3s;border-radius:16px}',
    '.toggle-slider-mini:before{position:absolute;content:"";height:12px;width:12px;left:2px;top:2px;background:#fff;transition:.3s;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
    'input:checked + .toggle-slider-mini{background:#2563eb}',
    'input:checked + .toggle-slider-mini:before{left:18px}',
    '#ai-assist-win.dark .ai-mode-switch-mini .mode-label{color:#6b7280}',
    '#ai-assist-win.dark .ai-mode-switch-mini .mode-label.active{color:#60a5fa}',
    '#ai-assist-win.dark .toggle-slider-mini{background:#4b5563}',
    '#ai-assist-win.dark input:checked + .toggle-slider-mini{background:#3b82f6}',
    // 新增：输入框区域样式
    '.ai-input-wrap{position:relative;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}',
    // 底部按钮行会覆盖输入内容：加大 padding-bottom 预留空间
    '.ai-input-wrap textarea{width:100%;min-height:72px;background:transparent;border:none;color:#0f172a;padding:10px 40px 70px 10px;resize:none;font-family:inherit;font-size:13px;box-sizing:border-box;outline:none}',
    '.ai-input-wrap:focus-within{border-color:#3b82f6}',
    '.ai-quick-action-wrap{position:absolute;left:10px;bottom:8px;display:flex;align-items:center;gap:4px}',
    '.ai-quick-action-wrap select{background:transparent;border:none;color:#6b7280;font-size:13px;cursor:pointer;padding:4px 2px;outline:none}',
    '.ai-quick-action-wrap select option{padding:8px 12px;font-size:13px}',
    '.ai-vision-toggle{min-width:26px;height:24px;padding:0 8px;border-radius:999px;border:1px solid #d1d5db;background:rgba(255,255,255,.95);color:#6b7280;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}',
    '.ai-vision-toggle.active{border-color:#2563eb;background:#dbeafe;color:#1d4ed8;box-shadow:0 0 0 1px rgba(37,99,235,.15)}',
    '.ai-vision-toggle.disabled{opacity:.45;cursor:not-allowed;box-shadow:none}',
    '.ai-vision-toggle[data-count]:after{content:attr(data-count);position:absolute;right:-2px;top:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;line-height:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #fff;}',
    '.ai-rag-toggle{min-width:26px;height:24px;padding:0 8px;border-radius:999px;border:1px solid #d1d5db;background:rgba(255,255,255,.95);color:#6b7280;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}',
    '.ai-rag-toggle.active{border-color:#16a34a;background:#dcfce7;color:#166534;box-shadow:0 0 0 1px rgba(22,163,74,.15)}',
    '.ai-agent-toggle{min-width:26px;height:24px;padding:0 8px;border-radius:999px;border:1px solid #d1d5db;background:rgba(255,255,255,.95);color:#6b7280;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}',
    '.ai-agent-toggle.on{border-color:rgba(37,99,235,.45);background:rgba(37,99,235,.12);color:#1d4ed8;box-shadow:0 0 0 1px rgba(37,99,235,.10)}',
    '#ai-assist-win.dark .ai-rag-toggle{background:#2a2b2f;border-color:#4b5563;color:#9ca3af}',
    '#ai-assist-win.dark .ai-rag-toggle:not(.disabled):hover{background:#34353a;border-color:#6b7280}',
    '#ai-assist-win.dark .ai-rag-toggle.active{background:#166534;border-color:#22c55e;color:#ffffff;box-shadow:0 0 0 2px rgba(34,197,94,0.20)}',
    '#ai-assist-win.dark .ai-rag-toggle.active:not(.disabled):hover{background:#16a34a}',
    '#ai-assist-win.dark .ai-agent-toggle{background:#2a2b2f;border-color:#4b5563;color:#9ca3af}',
    '#ai-assist-win.dark .ai-agent-toggle:not(.disabled):hover{background:#34353a;border-color:#6b7280}',
    '#ai-assist-win.dark .ai-agent-toggle.on{background:#1e40af;border-color:#3b82f6;color:#ffffff;box-shadow:0 0 0 2px rgba(59,130,246,0.25)}',
    '#ai-assist-win.dark .ai-agent-toggle.on:not(.disabled):hover{background:#2563eb}',
    '#ai-assist-win.dark .ai-input-wrap{background:#1a1b1e;border-color:#1f2937}',
    '#ai-assist-win.dark .ai-input-wrap textarea{color:#e5e7eb}',
    '#ai-assist-win.dark .ai-input-wrap:focus-within{border-color:#3b82f6}',
    '#ai-assist-win.dark .ai-quick-action-wrap select{color:#9ca3af;background:transparent}',
    '#ai-assist-win.dark .ai-quick-action-wrap select option{background:#1a1b1e;color:#e5e7eb}',
    '#ai-assist-win.dark .ai-quick-action-wrap::after{color:#6b7280}',
    '#ai-assist-win.dark .ai-vision-toggle{background:#2a2b2f;border-color:#4b5563;color:#9ca3af}',
    '#ai-assist-win.dark .ai-vision-toggle:not(.disabled):hover{background:#34353a;border-color:#6b7280}',
    '#ai-assist-win.dark .ai-vision-toggle.active{background:#1e40af;border-color:#3b82f6;color:#ffffff;box-shadow:0 0 0 2px rgba(59,130,246,0.25)}',
    '#ai-assist-win.dark .ai-vision-toggle.active:not(.disabled):hover{background:#2563eb}',
    // 快捷操作下拉框夜间模式
    '#ai-quick-action{background:transparent;border:none;color:#6b7280;font-size:13px;cursor:pointer;padding:4px 2px;outline:none}',
    '#ai-quick-action option{background:#fff;color:#0f172a;padding:8px 12px}',
    '#ai-assist-win.dark #ai-quick-action{color:#9ca3af}',
    '#ai-assist-win.dark #ai-quick-action option{background:#1a1b1e;color:#e5e7eb}',
    '#ai-send{position:absolute;right:10px;bottom:8px;padding:0;border:none;background:transparent;color:#9ca3af;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .15s}',
    '#ai-send:hover{color:#3b82f6}',
    '#ai-assist-win.dark #ai-send{color:#6b7280}',
    '#ai-assist-win.dark #ai-send:hover{color:#60a5fa}',
    // Agent 模式面板
    '#ai-agent-panel{display:none;border-top:1px solid #e5e7eb;background:rgba(255,255,255,.96);padding:10px 10px 12px 10px}',
    '#ai-assist-win.dark #ai-agent-panel{border-top:1px solid #1f2937;background:rgba(26,27,30,.96)}',
    '.ai-agent-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
    '.ai-agent-title{font-size:13px;font-weight:700;color:#0f172a}',
    '#ai-assist-win.dark .ai-agent-title{color:#e5e7eb}',
    '.ai-agent-head-right{display:flex;align-items:center;gap:8px}',
    '.ai-agent-target{font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid #e5e7eb;background:#fff;color:#334155}',
    '#ai-assist-win.dark .ai-agent-target{border-color:#374151;background:#1a1b1e;color:#e5e7eb}',
    '.ai-agent-tip{margin-top:6px;font-size:12px;color:#64748b;line-height:1.35}',
    '#ai-assist-win.dark .ai-agent-tip{color:#9ca3af}',
    '.ai-agent-row{display:flex;align-items:center;gap:10px;margin-top:8px}',
    '.ai-agent-meta{font-size:12px;color:#475569;flex:1}',
    '#ai-assist-win.dark .ai-agent-meta{color:#9ca3af}',
    '.ai-agent-tools{display:flex;align-items:center;gap:10px;margin-top:8px}',
    '.ai-agent-check{font-size:12px;color:#64748b;display:flex;align-items:center;gap:6px;user-select:none}',
    '#ai-assist-win.dark .ai-agent-check{color:#9ca3af}',
    '.ai-agent-btn{height:26px;padding:0 10px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#334155;font-size:12px;cursor:pointer;transition:all .15s}',
    '.ai-agent-btn:hover{border-color:#93c5fd}',
    '.ai-agent-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.ai-agent-btn.gray{background:transparent;color:#64748b}',
    '#ai-assist-win.dark .ai-agent-btn{border-color:#374151;background:#1a1b1e;color:#e5e7eb}',
    '#ai-assist-win.dark .ai-agent-btn.gray{background:#1a1b1e;color:#9ca3af}',
    '.ai-agent-btn.danger-armed{border-color:#ef4444;color:#ef4444}',
    '.ai-agent-spacer{flex:1}',
    // Agent 审阅弹窗（宿主全局）
    '#ai-agent-overlay{position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,.35);display:flex;align-items:center;justify-content:center;padding:18px}',
    '.ai-agent-overlay-card{width:min(980px,calc(100vw - 24px));height:min(78vh,860px);background:#ffffff;color:#0f172a;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 16px 46px rgba(0,0,0,.20);display:flex;flex-direction:column;overflow:hidden}',
    '#ai-agent-overlay.dark{background:rgba(0,0,0,.55)}',
    '#ai-agent-overlay.dark .ai-agent-overlay-card{background:#1a1b1e;color:#e5e7eb;border-color:#1f2937}',
    '.ai-agent-overlay-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid #e5e7eb}',
    '#ai-agent-overlay.dark .ai-agent-overlay-head{border-bottom-color:#1f2937}',
    '.ai-agent-overlay-title{font-size:14px;font-weight:700}',
    '.ai-agent-overlay-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.ai-agent-overlay-meta{padding:10px 12px 0 12px;font-size:12px;color:#475569}',
    '#ai-agent-overlay.dark .ai-agent-overlay-meta{color:#9ca3af}',
    '.ai-agent-overlay-diff{flex:0 0 auto;max-height:22vh;overflow:auto;padding:10px 12px 10px 12px;white-space:pre-wrap;word-break:break-word;line-height:1.55;font-size:13px;border-bottom:1px solid rgba(226,232,240,.9)}',
    '#ai-agent-overlay.dark .ai-agent-overlay-diff{border-bottom-color:#1f2937}',
    '.ai-agent-overlay-diff mark{background:rgba(34,197,94,.22);color:inherit;padding:0 .1em;border-radius:3px}',
    '.ai-agent-overlay-diff del{background:rgba(239,68,68,.12);color:inherit;text-decoration:line-through;padding:0 .1em;border-radius:3px}',
    '.ai-agent-overlay-list{flex:1;overflow:auto;padding:10px 12px 14px 12px}',
    '.ai-agent-hunk{border:1px solid rgba(226,232,240,.9);border-radius:10px;background:#fff;margin-bottom:10px;overflow:hidden}',
    '#ai-agent-overlay.dark .ai-agent-hunk{border-color:#1f2937;background:#0b1220}',
    '.ai-agent-hunk-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:rgba(241,245,249,.75)}',
    '#ai-agent-overlay.dark .ai-agent-hunk-head{background:rgba(17,24,39,.75)}',
    '.ai-agent-hunk-id{font-size:12px;color:#64748b}',
    '#ai-agent-overlay.dark .ai-agent-hunk-id{color:#9ca3af}',
    '.ai-agent-hunk-body{padding:10px 10px 12px 10px;white-space:pre-wrap;word-break:break-word;line-height:1.55;font-size:13px}',
    '.ai-agent-hunk-body mark{background:rgba(34,197,94,.22);color:inherit;padding:0 .1em;border-radius:3px}',
    '.ai-agent-hunk-body del{background:rgba(239,68,68,.12);color:inherit;text-decoration:line-through;padding:0 .1em;border-radius:3px}',
    // ========== 新增：动画效果 ==========
    // 消息入场动画
    '@keyframes ai-msg-slide-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}',
    '.msg-wrapper{animation:ai-msg-slide-in 250ms cubic-bezier(0.4,0,0.2,1)}',
    // 窗口过渡动画
    '#ai-assist-win{transition:opacity 200ms ease-out,transform 200ms ease-out}',
    '#ai-assist-win.ai-win-hidden{opacity:0;transform:scale(0.96);pointer-events:none}',
    // 思考中动画（三点脉冲）
    '.ai-thinking{display:flex;align-items:center;gap:6px;padding:12px 14px}',
    '.ai-thinking-dot{width:8px;height:8px;background:var(--muted,#9ca3af);border-radius:50%;animation:ai-dot-pulse 1.4s ease-in-out infinite}',
    '.ai-thinking-dot:nth-child(2){animation-delay:0.2s}',
    '.ai-thinking-dot:nth-child(3){animation-delay:0.4s}',
    '@keyframes ai-dot-pulse{0%,80%,100%{transform:scale(0.6);opacity:0.5}40%{transform:scale(1);opacity:1}}',
    '#ai-assist-win.dark .ai-thinking-dot{background:var(--muted,#6b7280)}',
    // ========== 新增：Markdown 内容样式 ==========
    '.msg.a .ai-md-content{white-space:normal;line-height:1.6}',
    '.msg.a .ai-md-content p{margin:0 0 0.8em 0}',
    '.msg.a .ai-md-content p:last-child{margin-bottom:0}',
    '.msg.a .ai-md-content ul,.msg.a .ai-md-content ol{margin:0.5em 0;padding-left:1.5em}',
    '.msg.a .ai-md-content li{margin:0.3em 0}',
    '.msg.a .ai-md-content h1,.msg.a .ai-md-content h2,.msg.a .ai-md-content h3,.msg.a .ai-md-content h4{margin:0.8em 0 0.4em 0;font-weight:600}',
    '.msg.a .ai-md-content h1{font-size:1.3em}',
    '.msg.a .ai-md-content h2{font-size:1.2em}',
    '.msg.a .ai-md-content h3{font-size:1.1em}',
    // 数学公式（KaTeX：通过占位符 data-math 渲染）
    '.msg.a .ai-md-content .md-math-inline{display:inline-block}',
    '.msg.a .ai-md-content .md-math-block{margin:0.6em 0}',
    '.msg.a .ai-md-content .katex-display{margin:0.5em 0}',
    '.msg.a .ai-md-content blockquote{margin:0.5em 0;padding:0.5em 1em;border-left:3px solid var(--border,#e5e7eb);background:var(--panel-bg,#f3f4f6);border-radius:4px}',
    '#ai-assist-win.dark .msg.a .ai-md-content blockquote{border-left-color:var(--border,#374151);background:var(--panel-bg,#1a1b1e)}',
    '.msg.a .ai-md-content a{color:#2563eb;text-decoration:none}',
    '.msg.a .ai-md-content a:hover{text-decoration:underline}',
    '#ai-assist-win.dark .msg.a .ai-md-content a{color:#60a5fa}',
    '.msg.a .ai-md-content code{background:var(--code-bg,#f6f8fa);padding:0.15em 0.4em;border-radius:4px;font-size:0.9em;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace)}',
    '#ai-assist-win.dark .msg.a .ai-md-content code{background:var(--code-bg,#1a1b1e)}',
    '.msg.a .ai-md-content hr{border:none;border-top:1px solid var(--border,#e5e7eb);margin:1em 0}',
    '#ai-assist-win.dark .msg.a .ai-md-content hr{border-top-color:var(--border,#374151)}',
    // ========== 新增：代码块样式 ==========
    '.msg.a .ai-md-content pre{position:relative;background:var(--code-bg,#f6f8fa);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:12px 14px;margin:0.8em 0;overflow-x:auto}',
    '.msg.a .ai-md-content pre code{background:transparent;padding:0;font-size:13px;line-height:1.5}',
    '#ai-assist-win.dark .msg.a .ai-md-content pre{background:var(--code-bg,#1a1b1e);border-color:var(--border,#374151)}',
    // 代码块复制按钮
    '.ai-code-copy{position:absolute;top:8px;right:8px;padding:4px 8px;font-size:11px;color:var(--muted,#6b7280);background:var(--bg,#fff);border:1px solid var(--border,#e5e7eb);border-radius:4px;cursor:pointer;opacity:0;transition:all 0.15s}',
    '.msg.a .ai-md-content pre:hover .ai-code-copy{opacity:1}',
    '.ai-code-copy:hover{color:var(--fg,#0f172a);background:var(--panel-bg,#f3f4f6)}',
    '.ai-code-copy.copied{color:#10b981;border-color:#10b981}',
    '#ai-assist-win.dark .ai-code-copy{background:var(--bg,#1a1b1e);border-color:var(--border,#374151);color:var(--muted,#9ca3af)}',
    '#ai-assist-win.dark .ai-code-copy:hover{color:var(--fg,#e5e7eb);background:var(--panel-bg,#1a1b1e)}',
    // 代码块语言标签
    '.ai-code-lang{position:absolute;top:8px;left:12px;font-size:10px;color:var(--muted,#9ca3af);text-transform:uppercase;letter-spacing:0.5px}',
    '#ai-assist-win.dark .ai-code-lang{color:var(--muted,#6b7280)}',
    // highlight.js 主题适配
    '.msg.a .ai-md-content .hljs{color:var(--fg,#24292e)}',
    '.msg.a .ai-md-content .hljs-comment,.msg.a .ai-md-content .hljs-quote{color:#6a737d}',
    '.msg.a .ai-md-content .hljs-keyword,.msg.a .ai-md-content .hljs-selector-tag{color:#d73a49}',
    '.msg.a .ai-md-content .hljs-string,.msg.a .ai-md-content .hljs-addition{color:#22863a}',
    '.msg.a .ai-md-content .hljs-number,.msg.a .ai-md-content .hljs-literal{color:#005cc5}',
    '.msg.a .ai-md-content .hljs-built_in,.msg.a .ai-md-content .hljs-type{color:#6f42c1}',
    '.msg.a .ai-md-content .hljs-attr,.msg.a .ai-md-content .hljs-variable{color:#e36209}',
    '.msg.a .ai-md-content .hljs-title,.msg.a .ai-md-content .hljs-function{color:#6f42c1}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs{color:#e5e7eb}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-comment,#ai-assist-win.dark .msg.a .ai-md-content .hljs-quote{color:#8b949e}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-keyword,#ai-assist-win.dark .msg.a .ai-md-content .hljs-selector-tag{color:#ff7b72}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-string,#ai-assist-win.dark .msg.a .ai-md-content .hljs-addition{color:#7ee787}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-number,#ai-assist-win.dark .msg.a .ai-md-content .hljs-literal{color:#79c0ff}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-built_in,#ai-assist-win.dark .msg.a .ai-md-content .hljs-type{color:#d2a8ff}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-attr,#ai-assist-win.dark .msg.a .ai-md-content .hljs-variable{color:#ffa657}',
    '#ai-assist-win.dark .msg.a .ai-md-content .hljs-title,#ai-assist-win.dark .msg.a .ai-md-content .hljs-function{color:#d2a8ff}',
  ].join('\n')
  DOC().head.appendChild(css)
}

function pushMsg(role, content, extra) {
  const msg = { role, content }
  if (extra && typeof extra === 'object') {
    try { Object.assign(msg, extra) } catch {}
  }
  __AI_SESSION__.messages.push(msg)
}

function sanitizeChatMessageForAPI(m){
  try {
    if (!m || typeof m !== 'object') return null
    const role = String(m.role || '').trim()
    if (!role) return null
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null
    return { role, content: m.content }
  } catch {}
  return null
}

function renderMsgs(root) {
  const msgs = __AI_SESSION__.messages
  // 优化：检查是否需要重新渲染（对比消息数量和最后一条消息内容）
  const existingMsgs = root.querySelectorAll('.msg-wrapper')
  const needRerender = (() => {
    if (existingMsgs.length !== msgs.length) return true
    if (msgs.length === 0) return false
    // 检查最后一条消息内容是否一致
    const lastMsg = msgs[msgs.length - 1]
    const lastWrapper = existingMsgs[existingMsgs.length - 1]
    if (!lastWrapper) return true
    const lastMsgDiv = lastWrapper.querySelector('.msg')
    if (!lastMsgDiv) return true
    const lastRole = lastMsg.role === 'user' ? 'u' : 'a'
    if (!lastMsgDiv.classList.contains(lastRole)) return true
    if (lastMsgDiv.textContent !== String(lastMsg.content || '')) return true
    return false
  })()

  if (!needRerender) {
    // 消息未变化，仅滚动到底部
    root.scrollTop = root.scrollHeight
    return
  }

  // 需要重新渲染
  root.innerHTML = ''
  msgs.forEach((m, idx) => {
    // 创建消息容器
    const wrapper = DOC().createElement('div')
    wrapper.className = 'msg-wrapper'

    // 如果是 AI 消息，添加头像
    if (m.role === 'assistant') {
      const avatar = DOC().createElement('img')
      avatar.className = 'ai-avatar'
      const localAvatar = resolvePluginAsset('Flymdnew.png')
      const fallbackAvatar = AI_AVATAR_FALLBACK_URL
      if (localAvatar) {
        if (fallbackAvatar) {
          avatar.onerror = () => {
            avatar.onerror = null
            avatar.src = fallbackAvatar
          }
        }
        avatar.src = localAvatar
      } else if (fallbackAvatar) {
        avatar.src = fallbackAvatar
      }
      avatar.alt = 'AI'
      wrapper.appendChild(avatar)
    }

    // 创建内容容器（昵称+消息+操作按钮）
    const contentWrapper = DOC().createElement('div')
    contentWrapper.className = 'msg-content-wrapper'

    // 如果是 AI 消息，添加昵称
    if (m.role === 'assistant') {
      const nickname = DOC().createElement('div')
      nickname.className = 'ai-nickname'
      nickname.textContent = 'AI'
      contentWrapper.appendChild(nickname)
    }

    // 创建消息气泡
    const d = DOC().createElement('div')
    d.className = 'msg ' + (m.role === 'user' ? 'u' : 'a')

    // AI 消息使用 Markdown 渲染
    if (m.role === 'assistant' && m.content) {
      // 先显示纯文本（防止闪烁）
      d.textContent = String(m.content || '')
      // 异步渲染 Markdown
      ;(async () => {
        try {
          const html = await renderMarkdownText(String(m.content || ''))
          if (html) {
            const mdWrapper = DOC().createElement('div')
            mdWrapper.className = 'ai-md-content'
            mdWrapper.innerHTML = html
            d.textContent = ''
            d.appendChild(mdWrapper)
            // 装饰代码块（添加复制按钮）
            try { decorateAICodeBlocks(d) } catch {}
            // 渲染 KaTeX（可选：加载失败则保留原始公式）
            try { decorateAIMath(d, __AI_CONTEXT__).catch(() => {}) } catch {}
          }
        } catch {}
      })()
    } else {
      d.textContent = String(m.content || '')
    }
    contentWrapper.appendChild(d)

    // RAG 引用：显示“笔记标题”，并支持点击打开对应笔记
    if (m.role === 'assistant' && m.kbRefs && Array.isArray(m.kbRefs) && m.kbRefs.length) {
      const refsWrap = DOC().createElement('div')
      refsWrap.className = 'ai-kb-refs'

      const refsTitle = DOC().createElement('div')
      refsTitle.className = 'ai-kb-refs-title'
      refsTitle.textContent = aiText('引用笔记', 'Sources')
      refsWrap.appendChild(refsTitle)

      const list = DOC().createElement('div')
      list.className = 'ai-kb-refs-list'

      for (const ref of m.kbRefs) {
        const a = DOC().createElement('a')
        a.className = 'ai-kb-ref'
        a.href = '#'

        const filePath = String(ref && ref.filePath ? ref.filePath : '').trim()
        const relative = String(ref && ref.relative ? ref.relative : '').trim()
        const title = String(ref && ref.title ? ref.title : '').trim()
        const heading = String(ref && ref.heading ? ref.heading : '').trim()
        const startLine = Number(ref && ref.startLine ? ref.startLine : 0) || 0
        const endLine = Number(ref && ref.endLine ? ref.endLine : 0) || 0
        const n = Number(ref && ref.n ? ref.n : 0) || 0

        const mainText = `[${n || ''}] ${title || relative || filePath || aiText('未命名笔记', 'Untitled')}`.trim()
        const mainSpan = DOC().createElement('span')
        mainSpan.textContent = mainText
        a.appendChild(mainSpan)

        const meta = DOC().createElement('span')
        meta.className = 'ai-kb-ref-meta'
        meta.textContent =
          (heading ? ` · ${heading}` : '') +
          ((relative || filePath) ? ` · ${(relative || filePath)}${startLine ? `:${startLine}-${endLine || startLine}` : ''}` : '')
        a.appendChild(meta)

        a.title = (relative || filePath || '') + (startLine ? `:${startLine}-${endLine || startLine}` : '')
        a.addEventListener('click', async (e) => {
          try { e.preventDefault(); e.stopPropagation() } catch {}
          if (!filePath) return
          if (!__AI_CONTEXT__ || typeof __AI_CONTEXT__.openFileByPath !== 'function') return
          try { await __AI_CONTEXT__.openFileByPath(filePath) } catch {}
        })

        list.appendChild(a)
      }

      refsWrap.appendChild(list)
      contentWrapper.appendChild(refsWrap)
    }

    wrapper.appendChild(contentWrapper)

    // 为 AI 回复添加操作按钮
    if (m.role === 'assistant' && m.content) {
      const btnGroup = DOC().createElement('div')
      btnGroup.className = 'msg-actions'

      const btnCopy = DOC().createElement('button')
      btnCopy.className = 'msg-action-btn'
      btnCopy.textContent = '复制'
      btnCopy.title = '复制此回复'
      btnCopy.addEventListener('click', () => {
        try { navigator.clipboard?.writeText(String(m.content || '')) } catch {}
      })

      const btnInsert = DOC().createElement('button')
      btnInsert.className = 'msg-action-btn'
      btnInsert.textContent = '光标插入'
      btnInsert.title = '在光标处插入此回复'
      btnInsert.addEventListener('click', async () => {
        const s = String(m.content || '').trim()
        if (!s) return
        if (!__AI_CONTEXT__) return
        try { await __AI_CONTEXT__.insertAtCursor('\n' + s + '\n') } catch {
          try { const cur = String(__AI_CONTEXT__.getEditorValue()||''); __AI_CONTEXT__.setEditorValue(cur + (cur.endsWith('\n')?'':'\n') + s + '\n') } catch {}
        }
        try { __AI_CONTEXT__.ui.notice('已在光标处插入', 'ok', 1400) } catch {}
      })

      const btnReplace = DOC().createElement('button')
      btnReplace.className = 'msg-action-btn'
      btnReplace.textContent = '替换选区'
      btnReplace.title = '用此回复替换选中内容'
      btnReplace.addEventListener('click', async () => {
        const s = String(m.content || '').trim()
        if (!s) return
        if (!__AI_CONTEXT__) return
        try {
          const sel = await __AI_CONTEXT__.getSelection?.()
          if (sel && sel.end > sel.start) {
            await __AI_CONTEXT__.replaceRange(sel.start, sel.end, s)
            __AI_CONTEXT__.ui.notice(aiText('已替换选区', 'Selection replaced'), 'ok', 1400)
            return
          }
        } catch {}
        __AI_CONTEXT__.ui.notice(aiText('没有选区，已改为光标处插入', 'No selection, inserted at cursor'), 'ok', 1400)
        try { await __AI_CONTEXT__.insertAtCursor('\n' + s + '\n') } catch {
          try { const cur = String(__AI_CONTEXT__.getEditorValue()||''); __AI_CONTEXT__.setEditorValue(cur + (cur.endsWith('\n')?'':'\n') + s + '\n') } catch {}
        }
      })

      const btnTodo = DOC().createElement('button')
      btnTodo.className = 'msg-action-btn'
      btnTodo.textContent = '生成便签'
      btnTodo.title = '基于此回复生成 TODO 便签'
      btnTodo.addEventListener('click', async () => {
        const s = String(m.content || '').trim()
        if (!s) return
        if (!__AI_CONTEXT__) return
        let fileCtx = null
        try {
          if (typeof window !== 'undefined' && typeof window.flymdGetCurrentFilePath === 'function') {
            const path = window.flymdGetCurrentFilePath() || null
            if (path) fileCtx = { filePath: path }
          }
        } catch {}
        await createTodoStickyFromContent(__AI_CONTEXT__, s, fileCtx)
      })

      btnGroup.appendChild(btnCopy)
      btnGroup.appendChild(btnInsert)
      btnGroup.appendChild(btnReplace)
      btnGroup.appendChild(btnTodo)
      contentWrapper.appendChild(btnGroup)
    }

    root.appendChild(wrapper)
  })
  root.scrollTop = root.scrollHeight
}

function setDockPush(side, width){
  try {
    const ctx = __AI_CONTEXT__
    const hasLayout = !!(ctx && ctx.layout && typeof ctx.layout.registerPanel === 'function')
    const cont = DOC().querySelector('.container')
    const winEl = el('ai-assist-win')
    const detectSide = () => {
      if (side === true) {
        if (winEl?.classList?.contains('dock-left')) return 'left'
        if (winEl?.classList?.contains('dock-right')) return 'right'
        if (winEl?.classList?.contains('dock-bottom')) return 'bottom'
        return false
      }
      return side
    }
    const actual = detectSide()
    const rawSize = (() => {
      if (typeof width === 'number' && Number.isFinite(width)) return width
      if (!winEl) return 0
      if (actual === 'bottom') {
        const inlineH = parseInt(winEl.style.height)
        if (Number.isFinite(inlineH)) return inlineH
        const rect = winEl.getBoundingClientRect()
        if (rect && rect.height) return rect.height
        return 0
      }
      const inlineW = parseInt(winEl.style.width)
      if (Number.isFinite(inlineW)) return inlineW
      const rect = winEl.getBoundingClientRect()
      if (rect && rect.width) return rect.width
      return 0
    })()
    const fallbackSize = (actual === 'bottom') ? 300 : MIN_WIDTH
    const resolvedSize = Math.max(0, rawSize || fallbackSize)

    // 优先走宿主提供的布局 API，由宿主统一负责推挤编辑区
    if (hasLayout) {
      try {
        if (!__AI_DOCK_PANEL__ && actual && resolvedSize > 0) {
          __AI_DOCK_PANEL__ = ctx.layout.registerPanel('main', {
            side: actual,
            size: resolvedSize,
            visible: true
          })
        } else if (__AI_DOCK_PANEL__) {
          if (!actual || !resolvedSize) {
            __AI_DOCK_PANEL__.setSize(resolvedSize)
            __AI_DOCK_PANEL__.setVisible(false)
          } else {
            __AI_DOCK_PANEL__.update({ side: actual, size: resolvedSize, visible: true })
          }
        }
      } catch {}
      return
    }

    // 向后兼容：旧宿主没有 layout API 时，退回到直接操作容器 CSS 变量的逻辑
    if (!cont) return
    const fallbackW = MIN_WIDTH
    const useWidth = (actual === 'bottom') ? 0 : (resolvedSize || fallbackW)
    cont.classList.remove('with-ai-left', 'with-ai-right')
    if (actual === 'left') {
      cont.classList.add('with-ai-left')
      cont.style.setProperty('--ai-left', (useWidth || fallbackW) + 'px')
      cont.style.setProperty('--ai-right', '0px')
    } else if (actual === 'right') {
      cont.classList.add('with-ai-right')
      cont.style.setProperty('--ai-right', (useWidth || fallbackW) + 'px')
      cont.style.setProperty('--ai-left', '0px')
    } else {
      cont.style.setProperty('--ai-left', '0px')
      cont.style.setProperty('--ai-right', '0px')
      cont.style.setProperty('--dock-left-gap', '0px')
      cont.style.setProperty('--dock-right-gap', '0px')
    }
  } catch {}
}

function bindDockResize(context, el) {
  try {
    const rz = el.querySelector('#ai-vresizer')
    if (!rz) return
    let sx = 0, sw = 0, doing = false
    rz.addEventListener('mousedown', (e) => { doing = true; sx = e.clientX; sw = parseInt(el.style.width)||MIN_WIDTH; e.preventDefault() })
    WIN().addEventListener('mousemove', (e) => {
      if (!doing) return
      // 右侧停靠时，拖动方向相反
      const isRight = el.classList.contains('dock-right')
      const delta = isRight ? (sx - e.clientX) : (e.clientX - sx)
      const w = Math.max(MIN_WIDTH, sw + delta)
      el.style.width = w + 'px'
      // 根据当前停靠位置更新推挤
      const dockSide = el.classList.contains('dock-left') ? 'left' : (el.classList.contains('dock-right') ? 'right' : false)
      if (dockSide) setDockPush(dockSide, w)
    })
    WIN().addEventListener('mouseup', async () => { if (!doing) return; doing = false; try { const cfg = await loadCfg(context); cfg.win = cfg.win || {}; cfg.win.w = parseInt(el.style.width)||MIN_WIDTH; await saveCfg(context, cfg) } catch {} })
  } catch {}
}

function bindFloatDragResize(context, el){
  try {
    const rz = el.querySelector('#ai-resizer')
    const head = el.querySelector('#ai-head')
    let sx=0, sy=0, sw=0, sh=0, mx=0, my=0, dragging=false, resizing=false, mayUndock=false, undockSide=null
    head?.addEventListener('mousedown', (e)=>{
      // 底部停靠模式下禁用拖动，避免误触导致窗口飘走
      if (el.classList.contains('dock-bottom')) return
      sx=e.clientX; sy=e.clientY; mx=parseInt(el.style.left)||60; my=parseInt(el.style.top)||60; e.preventDefault()
      if (el.classList.contains('dock-left')) { mayUndock = true; undockSide = 'left' }
      else if (el.classList.contains('dock-right')) { mayUndock = true; undockSide = 'right' }
      else { dragging=true }
    })
    rz?.addEventListener('mousedown', (e)=>{
      // 左右/底部停靠时不允许角拖动；仅在浮窗模式允许自由缩放
      if (el.classList.contains('dock-left') || el.classList.contains('dock-right') || el.classList.contains('dock-bottom')) return
      resizing = true
      sx = e.clientX
      sy = e.clientY
      sw = parseInt(el.style.width) || 520
      sh = parseInt(el.style.height) || 440
      e.preventDefault()
    })
    WIN().addEventListener('mousemove', (e)=>{
      if (mayUndock) {
        const dx = e.clientX - sx
        // 左侧停靠：向右拖超过 24px 解除；右侧停靠：向左拖超过 24px 解除
        const shouldUndock = (undockSide === 'left' && dx > 24) || (undockSide === 'right' && dx < -24)
        if (shouldUndock) {
          // 解除停靠，转为浮窗
          mayUndock = false
          try { el.classList.remove('dock-left', 'dock-right') } catch {}
          setDockPush(false)
          const w = parseInt(el.style.width)||MIN_WIDTH
          el.style.width = Math.max(MIN_WIDTH, w) + 'px'
          el.style.height = '440px'
          // 以当前位置为起点
          el.style.left = (e.clientX - 20) + 'px'
          el.style.right = 'auto'
          // 顶部维持当前 top
          dragging = true
          undockSide = null
          ;(async () => { try { const cfg = await loadCfg(context); cfg.dock = false; cfg.win = cfg.win||{}; cfg.win.x = parseInt(el.style.left)||60; cfg.win.y = parseInt(el.style.top)||60; cfg.win.w = parseInt(el.style.width)||520; cfg.win.h = parseInt(el.style.height)||440; await saveCfg(context,cfg); await refreshHeader(context) } catch {} })()
        }
      }
      if (dragging){ el.style.left = (mx + e.clientX - sx) + 'px'; el.style.top = (my + e.clientY - sy) + 'px' }
      if (resizing){
        el.style.width = Math.max(MIN_WIDTH, sw + e.clientX - sx) + 'px'
        el.style.height = Math.max(300, sh + e.clientY - sy) + 'px'
      }
    })
    WIN().addEventListener('mouseup', async ()=>{
      if (mayUndock) { mayUndock = false; undockSide = null }
      if (dragging||resizing){
        // 吸附：靠左边缘或右边缘自动停靠
        const left = parseInt(el.style.left)||0
        const width = parseInt(el.style.width)||300
        const winWidth = WIN().innerWidth
        const right = winWidth - left - width

        if (!el.classList.contains('dock-left') && !el.classList.contains('dock-right') && !el.classList.contains('dock-bottom') && left <= 16) {
          // 左边缘吸附
          try { el.classList.add('dock-left') } catch {}
          const bounds = computeWorkspaceBounds()
          const viewportWidth = WIN().innerWidth || 1280
          const workspaceWidth = Math.max(0, viewportWidth - bounds.left - bounds.right)
          applyDockVerticalBounds(el, bounds)
          el.style.left = bounds.left + 'px'
          el.style.right = 'auto'
          const w = Math.max(MIN_WIDTH, Math.min(parseInt(el.style.width)||300, workspaceWidth || MIN_WIDTH))
          el.style.width = w + 'px'
          setDockPush('left', w)
          try { const cfg = await loadCfg(context); cfg.dock = 'left'; cfg.win = cfg.win||{}; cfg.win.w = w; await saveCfg(context,cfg); await refreshHeader(context) } catch {}
        } else if (!el.classList.contains('dock-left') && !el.classList.contains('dock-right') && !el.classList.contains('dock-bottom') && right <= 16) {
          // 右边缘吸附
          try { el.classList.add('dock-right') } catch {}
          const bounds = computeWorkspaceBounds()
          const viewportWidth = WIN().innerWidth || 1280
          const workspaceWidth = Math.max(0, viewportWidth - bounds.left - bounds.right)
          applyDockVerticalBounds(el, bounds)
          el.style.right = bounds.right + 'px'
          el.style.left = 'auto'
          const w = Math.max(MIN_WIDTH, Math.min(parseInt(el.style.width)||300, workspaceWidth || MIN_WIDTH))
          el.style.width = w + 'px'
          setDockPush('right', w)
          try { const cfg = await loadCfg(context); cfg.dock = 'right'; cfg.win = cfg.win||{}; cfg.win.w = w; await saveCfg(context,cfg); await refreshHeader(context) } catch {}
        } else {
          // 边界检查：确保窗口在可见范围内
          const winWidth = WIN().innerWidth
          const winHeight = WIN().innerHeight
          let posX = parseInt(el.style.left) || 60
          let posY = parseInt(el.style.top) || 60
          const elWidth = parseInt(el.style.width) || 520
          const elHeight = parseInt(el.style.height) || 440
          // 至少保留 100px 在屏幕内
          const minVisible = 100
          if (posX < -elWidth + minVisible) posX = -elWidth + minVisible
          if (posX > winWidth - minVisible) posX = winWidth - minVisible
          if (posY < 0) posY = 0
          if (posY > winHeight - minVisible) posY = winHeight - minVisible
          el.style.left = posX + 'px'
          el.style.top = posY + 'px'
          // 保存浮动窗口位置
          const cfg = await loadCfg(context); cfg.win = cfg.win||{}; cfg.win.x = posX; cfg.win.y = posY; cfg.win.w = elWidth; cfg.win.h = elHeight;
          cfg.dock = el.classList.contains('dock-left') ? 'left' : (el.classList.contains('dock-right') ? 'right' : false);
          await saveCfg(context,cfg)
        }
        dragging=false; resizing=false
      }
    })
  } catch {}
}

// 提取文档标题与哈希（用于会话隔离与标题显示）
function getDocMetaFromContent(context, content) {
  const text = String(content || '')
  // 1) 优先：文件全路径（来自 #filename 的 title 属性）作为稳定 ID
  let fullPath = ''
  try { const el = DOC().getElementById('filename'); if (el) fullPath = String(el.getAttribute('title') || '').trim() } catch {}
  // 2) 显示标题优先文件名
  let display = ''
  try {
    const label = (DOC().getElementById('filename') || {}).textContent || ''
    const name = String(label).replace(/\s*\*\s*$/, '').trim()
    if (name && name !== '未命名') display = name
  } catch {}
  if (!display) {
    const m = text.match(/^\s*#+\s*(.+)\s*$/m)
    if (m && m[1]) display = m[1].trim()
  }
  if (!display) {
    const plain = text.replace(/^[\s\n]+/, '')
    display = plain.slice(0, 20) || '未命名'
  }
  // 文档哈希：优先用 fullPath，其次用 display（避免因内容变化导致会话重置）
  const key = fullPath || display || 'untitled'
  let h = 5381 >>> 0; for (let i = 0; i < key.length; i++) { h = (((h << 5) + h) + key.charCodeAt(i)) >>> 0 }
  const hash = h.toString(16)
  return { title: display, hash }
}

async function ensureSessionForDoc(context) {
  const content = String(context.getEditorValue() || '')
  const { title, hash } = getDocMetaFromContent(context, content)
  // 加载会话库
  if (!__AI_DB__) await loadSessionsDB(context)
  if (!__AI_DB__.byDoc[hash]) {
    __AI_DB__.byDoc[hash] = { title, activeId: '', items: [] }
  } else {
    __AI_DB__.byDoc[hash].title = title
  }
  const bucket = __AI_DB__.byDoc[hash]
  if (!bucket.activeId || !bucket.items.find(it => it.id === bucket.activeId)) {
    const s = { id: gid(), name: '默认会话', created: Date.now(), updated: Date.now(), messages: [] }
    bucket.items.unshift(s)
    bucket.activeId = s.id
  }
  const cur = bucket.items.find(it => it.id === bucket.activeId)
  __AI_SESSION__ = { id: cur.id, name: cur.name, messages: cur.messages.slice(), docHash: hash, docTitle: title }
  // 更新哈希缓存
  __AI_LAST_DOC_HASH__ = hash
  await saveSessionsDB(context)
}

async function syncCurrentSessionToDB(context){
  try {
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    if (!bucket) return
    const it = bucket.items.find(x => x.id === bucket.activeId)
    if (!it) return
    it.messages = __AI_SESSION__.messages.slice()
    it.updated = Date.now()
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
  } catch {}
}

function isDefaultSessionName(name){
  const s = String(name||'').trim()
  if (!s) return true
  if (s === '默认会话' || s === '默认' || s === '未命名') return true
  if (/^会话\s*\d+$/i.test(s)) return true
  if (/^新建?会话$/i.test(s)) return true
  return false
}

  async function maybeNameCurrentSession(context, cfg, assistantText){
  try {
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const it = bucket && bucket.items.find(x => x.id === bucket.activeId)
    if (!it || !isDefaultSessionName(it.name)) return
    // 构造命名提示：优先基于文件名/文档标题/最后一次用户输入
    const base = __AI_SESSION__.docTitle || ''
    const lastQ = lastUserMsg()
    const sample = shorten(lastQ || assistantText || '', 80)
    const sys = '你是命名助手。任务：基于上下文，为对话生成一个简短的中文名称。要求：5-12个中文字符以内，不要标点、不要引号、不要编号。只输出名称本身。'
    const prompt = `文件/标题：${base}\n线索：${sample}`
      const url = buildApiUrl(cfg)
      const headers = buildApiHeaders(cfg)
    const body = JSON.stringify({ model: resolveModelId(cfg), stream: false, messages: [ { role:'system', content: sys }, { role:'user', content: prompt } ] })
    let name = ''
    try {
      const r = await _aiFetch(url, { method:'POST', headers, body })
      const t = await r.text()
      const j = _aiTryParseJsonLoose(t)
      name = shorten(j?.choices?.[0]?.message?.content || '', 12).replace(/[\s\n]+/g,'').replace(/[「」\[\]\(\)\{\}\"\'\.,，。!！?？:：;；]/g,'')
    } catch {}
    if (!name) return
    it.name = name
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
    try { context.ui.notice(aiText('会话已命名：', 'Session renamed: ') + name, 'ok', 1600) } catch {}
  } catch {}
}

  async function updateWindowTitle(context) {
    try {
      const head = DOC().getElementById('ai-title')
      if (!head) return
      await ensureSessionForDoc(context)
      head.textContent = __AI_SESSION__.docTitle || aiText('未命名', 'Untitled')
    } catch {}
  }

async function ensureWindow(context) {
  let el = elById('ai-assist-win')
  if (el && el.__mounted) return el
  return await mountWindow(context)
}

function elById(id) { return DOC().getElementById(id) }

async function refreshHeader(context){
  const cfg = await loadCfg(context)
  const selP = el('ai-model')
  if (selP) selP.value = cfg.model || ''
  await updateWindowTitle(context)
  await refreshSessionSelect(context)
  // 更新更多菜单中的主题文本
  try {
    // 更新夜间模式菜单文本
    const menuTheme = el('ai-menu-theme')
    const mainWin = el('ai-assist-win')
    if (menuTheme && mainWin) {
      const isDark = mainWin.classList.contains('dark')
      menuTheme.textContent = isDark ? '日间模式' : '夜间模式'
    }
  } catch {}
  // 免费模式下隐藏模型输入框，显示 Powered by 图片
  try {
    const isFree = isFreeProvider(cfg)
    const modelLabel = el('ai-model-label')
    const modelInput = el('ai-model')
    const modelPowered = el('ai-model-powered')
    const modelPoweredImg = el('ai-model-powered-img')
    const modelPoweredText = el('ai-model-powered-text')
    const freeModelLabel = el('ai-free-model-label')
    const freeModelSelect = el('ai-free-model')
    const freeKey = normalizeFreeModelKey(cfg.freeModel)
    const isGemini = isFree && freeKey === 'gemini'
    if (modelLabel) modelLabel.style.display = isFree ? 'none' : ''
    if (modelInput) modelInput.style.display = isFree ? 'none' : ''
    if (freeModelLabel) freeModelLabel.style.display = isFree ? 'inline-block' : 'none'
    if (freeModelSelect) {
      freeModelSelect.style.display = isFree ? 'inline-block' : 'none'
      if (isFree) freeModelSelect.value = normalizeFreeModelKey(cfg.freeModel)
    }
    if (modelPowered) {
      modelPowered.style.display = isFree ? 'inline-block' : 'none'
      if (isFree) {
        const mainWin = el('ai-assist-win')
        let isDark = false
        if (mainWin && mainWin.classList.contains('dark')) {
          isDark = true
        } else {
          try {
            const mainBody = WIN().document.body
            isDark = mainBody && mainBody.classList.contains('dark-mode')
          } catch {}
          if (!isDark) {
            isDark = !!(WIN().matchMedia && WIN().matchMedia('(prefers-color-scheme: dark)').matches)
          }
        }
        if (isGemini) {
          modelPowered.href = 'https://x666.me/register?aff=yUSz'
          if (modelPoweredText) {
            modelPoweredText.textContent = '薄荷公益'
            modelPoweredText.style.display = 'inline-block'
          }
          if (modelPoweredImg) {
            modelPoweredImg.style.display = 'none'
          }
        } else {
          modelPowered.href = 'https://cloud.siliconflow.cn/i/X96CT74a'
          if (modelPoweredText) {
            modelPoweredText.textContent = ''
            modelPoweredText.style.display = 'none'
          }
          if (modelPoweredImg) {
            modelPoweredImg.style.display = 'inline-block'
            modelPoweredImg.src = resolvePluginAsset(isDark ? 'Powered-by-dark.png' : 'Powered-by-light.png')
          }
        }
      }
    }
  } catch {}
  // 更新工具栏模式切换开关
  try {
    const isFree = isFreeProvider(cfg)
    const providerToggle = el('ai-provider-toggle')
    const modeLabelCustom = el('mode-label-custom-toolbar')
    const modeLabelFree = el('mode-label-free-toolbar')
    if (providerToggle) providerToggle.checked = isFree
    if (modeLabelCustom) {
      if (isFree) modeLabelCustom.classList.remove('active')
      else modeLabelCustom.classList.add('active')
    }
    if (modeLabelFree) {
      if (isFree) modeLabelFree.classList.add('active')
      else modeLabelFree.classList.remove('active')
    }
  } catch {}
  // 更新视觉模式开关
  try {
    const visionBtn = el('ai-vision-toggle')
    if (visionBtn) {
      const isFree = isFreeProvider(cfg)
      let supported = !isFree
      if (isFree) {
        const key = normalizeFreeModelKey(cfg.freeModel)
        const info = FREE_MODEL_OPTIONS[key]
        supported = !!(info && info.vision)
      }
      const active = !!cfg.visionEnabled && supported
      visionBtn.disabled = !supported
      visionBtn.classList.toggle('disabled', !supported)
      visionBtn.classList.toggle('active', active)
      if (!supported) {
        visionBtn.title = '当前模型暂不支持视觉能力'
      } else if (active) {
        visionBtn.title = '视觉模式已开启，将尝试读取文档中的图片'
      } else {
        visionBtn.title = '视觉模式：点击开启，让 AI 读取文档中的图片'
      }
      // 刷新图片计数展示
      updateVisionAttachmentIndicator()
    }
  } catch {}

  // 更新 RAG 开关
  try {
    const ragBtn = el('ai-rag-toggle')
    if (ragBtn) {
      const active = isRagEnabledForConfig(cfg)
      ragBtn.classList.toggle('active', active)
      ragBtn.title = active
        ? 'RAG 已开启：发送前会追加知识库引用'
        : '知识库检索：点击开启/关闭（与设置联动）'
    }
  } catch {}
}

// 收集文档中的图片并构造视觉模型可用的 content 片段
async function buildVisionContentBlocks(context, docCtx){
  const blocks = [{ type: 'text', text: '文档上下文：\n\n' + docCtx }]
  let root = null
  let skippedLocalImage = false
  // 优先尝试从预览 DOM 中收集图片（阅读模式）
  if (context && typeof context.getPreviewElement === 'function') {
    try {
      root = context.getPreviewElement()
    } catch {}
  }
  let used = 0
  try {
    if (root) {
      const imgs = root.querySelectorAll('img')
      const maxImages = 4
      for (const elImg of imgs) {
        if (used >= maxImages) break
        try {
          const img = elImg
          const srcAttr = img.getAttribute('src') || ''
          const rawSrc = img.getAttribute('data-raw-src') || srcAttr
          const absPath = img.getAttribute('data-abs-path') || ''
          let url = ''
          const isAssetUrl = /asset\.localhost/i.test(srcAttr) || /asset\.localhost/i.test(rawSrc)
          // 1) 如果是 Tauri 的 asset.localhost 预览 URL，优先用绝对路径读取为 base64
          if (isAssetUrl && absPath && typeof context.readImageAsDataUrl === 'function') {
            try {
              const dataUrl = await context.readImageAsDataUrl(absPath)
              if (dataUrl && !isLocalImageTooLargeDataUrl(dataUrl)) {
                url = dataUrl
              } else if (dataUrl && isLocalImageTooLargeDataUrl(dataUrl)) {
                skippedLocalImage = true
              }
            } catch {}
          }
          // 2) 其它情况保持原有顺序
          if (!url) {
            if (/^data:image\//i.test(srcAttr) || /^data:image\//i.test(rawSrc)) {
              url = srcAttr || rawSrc
            } else if (/^https?:\/\//i.test(srcAttr) || /^https?:\/\//i.test(rawSrc)) {
              url = srcAttr || rawSrc
            } else if (absPath && typeof context.readImageAsDataUrl === 'function') {
              try {
                const dataUrl = await context.readImageAsDataUrl(absPath)
                if (dataUrl && !isLocalImageTooLargeDataUrl(dataUrl)) {
                  url = dataUrl
                } else if (dataUrl && isLocalImageTooLargeDataUrl(dataUrl)) {
                  skippedLocalImage = true
                }
              } catch {}
            }
          }
          if (!url) continue
          const alt = img.getAttribute('alt') || ''
          const label = alt ? `图片 ${used + 1}：${alt}` : `图片 ${used + 1}`
          blocks.push({ type: 'text', text: '\n\n' + label })
          blocks.push({ type: 'image_url', image_url: { url } })
          used++
        } catch {}
      }
    }
  } catch {
    // 忽略预览图片收集错误
  }
  // 若预览中没有可用图片，再从 Markdown 源码中解析（源码模式兜底）
  if (used === 0) {
    try {
      const md = String(docCtx || '')
      const imgRe = /!\[([^\]]*)]\(([^)]+)\)/g
      let m
      // 计算当前文档所在目录，用于还原相对路径
      let baseDir = ''
      try {
        if (typeof window !== 'undefined' && typeof window.flymdGetCurrentFilePath === 'function') {
          const curPath = window.flymdGetCurrentFilePath() || ''
          if (curPath) {
            const parts = curPath.split(/[\\/]+/)
            parts.pop()
            const sep = curPath.includes('\\') ? '\\' : '/'
            baseDir = parts.join(sep)
          }
        }
      } catch {}
      const maxImages = 4
      while ((m = imgRe.exec(md)) && used < maxImages) {
        try {
          const alt = m[1] || ''
          let target = (m[2] || '').trim()
          if (!target) continue
          // 去掉尖括号包裹
          if (target.startsWith('<') && target.endsWith('>')) {
            target = target.slice(1, -1).trim()
          }
          // 去掉标题部分（按空格分割，只取第一个片段）
          const spaceIdx = target.search(/\s/)
          if (spaceIdx > 0) target = target.slice(0, spaceIdx)
          // 去掉成对引号包裹
          if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
            target = target.slice(1, -1)
          }
          if (!target) continue
          let url = ''
          if (/^data:image\//i.test(target) || /^https?:\/\//i.test(target)) {
            url = target
          } else {
            // 处理本地路径：相对路径 + 绝对路径
            let abs = target
            const isWinAbs = /^[a-zA-Z]:[\\/]/.test(target)
            const isUnixAbs = target.startsWith('/')
            const isUNC = target.startsWith('\\\\')
            if (!isWinAbs && !isUnixAbs && !isUNC && baseDir) {
              const sep = baseDir.includes('\\') ? '\\' : '/'
              abs = baseDir + sep + target.replace(/[\\/]+/g, sep)
            }
            if (typeof context.readImageAsDataUrl === 'function') {
              try {
                const dataUrl = await context.readImageAsDataUrl(abs)
                if (dataUrl && !isLocalImageTooLargeDataUrl(dataUrl)) {
                  url = dataUrl
                } else if (dataUrl && isLocalImageTooLargeDataUrl(dataUrl)) {
                  skippedLocalImage = true
                }
              } catch {}
            }
          }
          if (!url) continue
          const label = alt ? `图片 ${used + 1}：${alt}` : `图片 ${used + 1}`
          blocks.push({ type: 'text', text: '\n\n' + label })
          blocks.push({ type: 'image_url', image_url: { url } })
          used++
        } catch {}
      }
    } catch {}
  }
  // 追加附件图片（来自对话框粘贴）
  try {
    const pending = Array.isArray(__AI_PENDING_IMAGES__) ? __AI_PENDING_IMAGES__ : []
    if (pending.length) {
      const maxAttach = 4
      let usedAttach = 0
      for (const img of pending) {
        if (usedAttach >= maxAttach) break
        if (!img || !img.url) continue
        // 粘贴附件图片同样按照本地大小上限进行过滤
        if (isLocalImageTooLargeDataUrl(img.url)) {
          skippedLocalImage = true
          continue
        }
        const label = img.name
          ? `附件图片 ${usedAttach + 1}：${img.name}`
          : `附件图片 ${usedAttach + 1}`
        blocks.push({ type: 'text', text: '\n\n' + label })
        blocks.push({ type: 'image_url', image_url: { url: img.url } })
        usedAttach++
      }
    }
  } catch {}
  if (skippedLocalImage) {
    try {
      if (context && context.ui && typeof context.ui.notice === 'function') {
        context.ui.notice('不支持1MB以上的本地图片，已从本次视觉请求中跳过。建议使用图床后再开启视觉模式。', 'warn', 4200)
      }
    } catch {}
  }
  return blocks
}

// 将消息中的 HTTP 图片 URL 尝试转换为 base64 DataURL，以便在远端无法拉取外链图片时退回本地拉取
async function fetchImageAsDataUrlForVision(url){
  try {
    if (!url || typeof url !== 'string') return ''
    const res = await fetch(url)
    if (!res.ok) return ''
    const blob = await res.blob()
    return await new Promise((resolve) => {
      try {
        const reader = new FileReader()
        reader.onerror = () => resolve('')
        reader.onload = () => {
          try {
            resolve(String(reader.result || ''))
          } catch {
            resolve('')
          }
        }
        reader.readAsDataURL(blob)
      } catch {
        resolve('')
      }
    })
  } catch {
    return ''
  }
}

async function convertHttpImageUrlsToDataUrl(messages){
  // 浏览器环境下跨域受限，统一交给后端处理；仅在非 http(s) 协议（如 Tauri）下尝试本地转码
  try {
    if (typeof window !== 'undefined') {
      const proto = String(window.location.protocol || '').toLowerCase()
      if (proto === 'http:' || proto === 'https:') return null
    }
  } catch {}
  if (!Array.isArray(messages) || !messages.length) return null
  let cloned
  try {
    cloned = JSON.parse(JSON.stringify(messages))
  } catch {
    return null
  }
  let converted = 0
  for (const msg of cloned) {
    if (!msg || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (!part || part.type !== 'image_url') continue
      const obj = part.image_url || part.imageUrl
      if (!obj || typeof obj.url !== 'string') continue
      const raw = obj.url.trim()
      if (!/^https?:\/\//i.test(raw)) continue
      const dataUrl = await fetchImageAsDataUrlForVision(raw)
      if (dataUrl) {
        obj.url = dataUrl
        converted++
      }
    }
  }
  return converted > 0 ? cloned : null
}

async function refreshSessionSelect(context) {
  try {
    const listEl = document.getElementById('ai-session-list')
    if (!listEl) return
    await ensureSessionForDoc(context)
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    listEl.innerHTML = ''
    for (const it of bucket.items) {
      const li = document.createElement('li')
      li.className = 'ai-session-item' + (it.id === bucket.activeId ? ' active' : '')
      li.dataset.id = it.id

      const nameSpan = document.createElement('span')
      nameSpan.className = 'ai-session-item-name'
      nameSpan.textContent = it.name
      nameSpan.title = it.name

      const delBtn = document.createElement('button')
      delBtn.className = 'ai-session-item-del'
      delBtn.textContent = '×'
      delBtn.title = '删除此会话'
      delBtn.dataset.id = it.id

      li.appendChild(nameSpan)
      li.appendChild(delBtn)
      listEl.appendChild(li)
    }
  } catch {}
}

async function switchSessionById(context, id) {
  try {
    if (!id) return
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const it = bucket.items.find(x => x.id === id)
    if (!it) return
    bucket.activeId = id
    __AI_SESSION__ = { id: it.id, name: it.name, messages: it.messages.slice(), docHash: __AI_SESSION__.docHash, docTitle: __AI_SESSION__.docTitle }
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
    const chat = document.getElementById('ai-chat'); if (chat) renderMsgs(chat)
  } catch {}
}

async function deleteSessionById(context, id) {
  try {
    if (!id) return
    await ensureSessionForDoc(context)
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const idx = bucket.items.findIndex(x => x.id === id)
    if (idx < 0) return
    const wasActive = bucket.activeId === id
    bucket.items.splice(idx, 1)
    // 如果删除的是当前会话，切换到其他会话
    if (wasActive) {
      if (bucket.items.length === 0) {
        const s = { id: gid(), name: '默认会话', created: Date.now(), updated: Date.now(), messages: [] }
        bucket.items.push(s)
        bucket.activeId = s.id
      } else {
        bucket.activeId = bucket.items[0].id
      }
      const it = bucket.items.find(x => x.id === bucket.activeId)
      __AI_SESSION__ = { id: it.id, name: it.name, messages: it.messages.slice(), docHash: __AI_SESSION__.docHash, docTitle: __AI_SESSION__.docTitle }
    }
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
    if (wasActive) {
      const chat = document.getElementById('ai-chat'); if (chat) renderMsgs(chat)
    }
    context.ui.notice('会话已删除', 'ok', 1400)
  } catch {}
}

async function createNewSession(context) {
  try {
    await ensureSessionForDoc(context)
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const s = { id: gid(), name: '会话' + (bucket.items.length + 1), created: Date.now(), updated: Date.now(), messages: [] }
    bucket.items.unshift(s)
    bucket.activeId = s.id
    __AI_SESSION__ = { id: s.id, name: s.name, messages: [], docHash: __AI_SESSION__.docHash, docTitle: __AI_SESSION__.docTitle }
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
    const chat = document.getElementById('ai-chat'); if (chat) renderMsgs(chat)
  } catch {}
}

async function deleteCurrentSession(context) {
  try {
    await ensureSessionForDoc(context)
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const idx = bucket.items.findIndex(x => x.id === bucket.activeId)
    if (idx < 0) return
    bucket.items.splice(idx, 1)
    if (bucket.items.length === 0) {
      const s = { id: gid(), name: '默认会话', created: Date.now(), updated: Date.now(), messages: [] }
      bucket.items.push(s); bucket.activeId = s.id
    } else {
      bucket.activeId = bucket.items[0].id
    }
    const it = bucket.items.find(x => x.id === bucket.activeId)
    __AI_SESSION__ = { id: it.id, name: it.name, messages: it.messages.slice(), docHash: __AI_SESSION__.docHash, docTitle: __AI_SESSION__.docTitle }
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
    const chat = document.getElementById('ai-chat'); if (chat) renderMsgs(chat)
  } catch {}
}

async function mountWindow(context){
  ensureCss()
  const cfg = await loadCfg(context)
  const el = DOC().createElement('div'); el.id='ai-assist-win';
  const dockWidth = Math.max(MIN_WIDTH, Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH))
  const dockHeight = Math.max(300, Number((cfg && cfg.win && cfg.win.h) || 440))
  if (cfg && cfg.dock === 'left') {
    // 左侧停靠：紧挨库侧栏右侧
    el.classList.add('dock-left')
    const bounds = computeWorkspaceBounds()
    const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
    const panelWidth = Math.min(dockWidth, workspaceWidth || dockWidth)
    applyDockVerticalBounds(el, bounds)
    el.style.left = bounds.left + 'px'
    el.style.right = 'auto'
    el.style.width = panelWidth + 'px'
  } else if (cfg && cfg.dock === 'right') {
    // 右侧停靠：紧挨工作区右边缘（预留右侧可能的库）
    el.classList.add('dock-right')
    const bounds = computeWorkspaceBounds()
    const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
    const panelWidth = Math.min(dockWidth, workspaceWidth || dockWidth)
    applyDockVerticalBounds(el, bounds)
    el.style.right = bounds.right + 'px'
    el.style.left = 'auto'
    el.style.width = panelWidth + 'px'
  } else if (cfg && cfg.dock === 'bottom') {
    // 底部停靠：宽度对齐工作区（不覆盖库侧栏）
    el.classList.add('dock-bottom')
    const bounds = computeWorkspaceBounds()
    el.style.top = 'auto'
    el.style.bottom = '0px'
    el.style.left = bounds.left + 'px'
    el.style.right = bounds.right + 'px'
    el.style.width = 'auto'
    el.style.height = dockHeight + 'px'
  } else {
    // 浮动窗口 - 带边界检查
    const winWidth = WIN().innerWidth
    const winHeight = WIN().innerHeight
    let posX = (cfg && cfg.win && cfg.win.x) || 60
    let posY = (cfg && cfg.win && cfg.win.y) || 60
    const elWidth = (cfg && cfg.win && cfg.win.w) || 520
    const elHeight = (cfg && cfg.win && cfg.win.h) || 440
    const minVisible = 100
    // 确保窗口在可见范围内
    if (posX < -elWidth + minVisible) posX = 60
    if (posX > winWidth - minVisible) posX = Math.max(60, winWidth - elWidth - 20)
    if (posY < 0) posY = 60
    if (posY > winHeight - minVisible) posY = Math.max(60, winHeight - elHeight - 20)
    el.style.top = posY + 'px'
    el.style.left = posX + 'px'
    el.style.width = elWidth + 'px'
    el.style.height = elHeight + 'px'
  }
  el.innerHTML = [
    // 头部：标题 + 会话历史 + 新建会话 + 更多菜单 + 关闭
    '<div id="ai-head">',
    '  <div id="ai-title">' + aiText('AI 写作助手', 'AI Assistant') + '</div>',
    '  <div class="ai-head-actions">',
    '    <button id="ai-btn-history" class="ai-icon-btn" title="' + aiText('会话历史', 'History') + '">⏱</button>',
    '    <button id="ai-s-new" class="ai-icon-btn" title="' + aiText('新建会话', 'New session') + '">+</button>',
    '    <div class="ai-more-menu-wrap">',
    '      <button id="ai-btn-more" class="ai-icon-btn" title="' + aiText('更多', 'More') + '">⋮</button>',
    '      <div id="ai-more-menu" class="ai-dropdown-menu">',
    '        <div class="ai-menu-item" id="ai-menu-settings">' + aiText('插件设置', 'Plugin settings') + '</div>',
    '        <div class="ai-menu-item" id="ai-menu-theme">' + aiText('夜间模式', 'Dark mode') + '</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-left">' + aiText('切换左侧', 'Dock left') + '</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-right">' + aiText('切换右侧', 'Dock right') + '</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-bottom">' + aiText('切换下方', 'Dock bottom') + '</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-float">' + aiText('切换浮窗', 'Floating window') + '</div>',
    '        <div class="ai-menu-item" id="ai-menu-del-session">' + aiText('删除会话', 'Delete session') + '</div>',
    '      </div>',
    '    </div>',
    '    <button id="ai-btn-close" class="ai-icon-btn close-btn" title="' + aiText('关闭', 'Close') + '">×</button>',
    '  </div>',
    '</div>',
    // 会话历史下拉面板
    '<div id="ai-history-panel" class="ai-dropdown-panel">',
    '  <ul id="ai-session-list" class="ai-session-list"></ul>',
    '</div>',
    '<div id="ai-body">',
    // 工具栏：简化版
    ' <div id="ai-toolbar">',
    '  <div class="ai-toolbar-row ai-toolbar-meta">',
    '   <div class="ai-mode-switch-mini">',
    '    <span class="mode-label" id="mode-label-custom-toolbar">' + aiText('自定义', 'Custom') + '</span>',
    '    <label class="toggle-switch-mini"><input type="checkbox" id="ai-provider-toggle"/><span class="toggle-slider-mini"></span></label>',
    '    <span class="mode-label" id="mode-label-free-toolbar">' + aiText('免费', 'Free') + '</span>',
    '   </div>',
    '   <label id="ai-free-model-label" style="display:none;font-size:12px;color:#6b7280;white-space:nowrap;margin-left:6px;">' + aiText('模型', 'Model') + '</label>',
    '   <select id="ai-free-model" title="' + aiText('选择免费模型', 'Choose free model') + '" style="display:none;width:80px;border-radius:6px;padding:4px 6px;font-size:12px;"><option value="qwen">Qwen</option><option value="gemini">Gemini Vision</option><option value="glm">GLM</option></select>',
    '   <div id="ai-selects">',
    '    <label id="ai-model-label" style="font-size:12px;">' + aiText('模型', 'Model') + '</label>',
    '    <input id="ai-model" placeholder="' + aiText('如 gpt-4o-mini', 'e.g. gpt-4o-mini') + '" style="width:120px;font-size:12px;padding:4px 6px;"/>',
    '   </div>',
    '   <a id="ai-model-powered" href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer" style="display:none;border:none;outline:none;margin-left:auto;white-space:nowrap;line-height:22px;height:22px;">',
    '    <span id="ai-model-powered-text" style="display:none;font-size:13px;color:#6b7280;margin-right:6px;height:22px;line-height:22px;vertical-align:middle;"></span>',
    '    <img id="ai-model-powered-img" src="" alt="Powered by" style="height:22px;width:auto;border:none;outline:none;vertical-align:middle;"/>',
    '   </a>',
    '  </div>',
    ' </div>',
    ' <div id="ai-chat"></div>',
    ' <div id="ai-agent-panel"></div>',
    // 输入框区域：左下角快捷操作下拉
     ' <div id="ai-input">',
      '  <div class="ai-input-wrap">',
       '   <textarea id="ai-text" placeholder="' + aiText('输入与 AI 对话...', 'Talk with AI...') + '"></textarea>',
       '   <div class="ai-quick-action-wrap">',
     '    <select id="ai-quick-action" title="' + aiText('快捷操作', 'Quick actions') + '">',
     '     <option value="">' + aiText('智能问答', 'Ask AI') + '</option>',
     '     <option value="续写">' + aiText('续写', 'Continue writing') + '</option>',
     '     <option value="润色">' + aiText('润色', 'Polish') + '</option>',
     '     <option value="纠错">' + aiText('纠错', 'Correct') + '</option>',
     '     <option value="提纲">' + aiText('提纲', 'Outline') + '</option>',
     '     <option value="待办">' + aiText('待办', 'Todo') + '</option>',
     '     <option value="提醒">' + aiText('提醒', 'Reminder') + '</option>',
      '    </select>',
      '    <button id="ai-vision-toggle" class="ai-vision-toggle" title="' + aiText('视觉模式：点击开启，让 AI 读取文档中的图片', 'Vision mode: let AI read images from the document') + '">Vision</button>',
      '    <button id="ai-rag-toggle" class="ai-rag-toggle" title="' + aiText('知识库检索：点击开启/关闭（与设置联动）', 'RAG: toggle knowledge search (sync with settings)') + '">RAG</button>',
      '    <button id="ai-agent-toggle" class="ai-agent-toggle" title="' + aiText('Agent模式：把你的修改要求应用到选区或全文', 'Agent mode: apply your edit requests to selection or doc') + '">Agent</button>',
      '   </div>',
      '   <button id="ai-send" title="' + aiText('发送消息', 'Send message') + '">↵</button>',
      '  </div>',
     ' </div>',
    '</div><div id="ai-vresizer" title="拖动调整宽度"></div><div id="ai-resizer" title="拖动调整尺寸"></div>'
  ].join('')
  DOC().body.appendChild(el)
  if (cfg && (cfg.dock === 'left' || cfg.dock === 'right')) setDockPush(cfg.dock, dockWidth)
  else if (cfg && cfg.dock === 'bottom') setDockPush('bottom', dockHeight)
  // 绑定拖拽/调整
  try { bindDockResize(context, el) } catch {}
  try { bindFloatDragResize(context, el) } catch {}
  // 关闭按钮
  el.querySelector('#ai-btn-close').addEventListener('click',()=>{ el.style.display='none'; setDockPush(false) })

  // 会话历史按钮 - 切换下拉面板
  try {
    const btnHistory = el.querySelector('#ai-btn-history')
    const historyPanel = el.querySelector('#ai-history-panel')
    btnHistory?.addEventListener('click', (e) => {
      e.stopPropagation()
      historyPanel?.classList.toggle('show')
      // 关闭更多菜单
      el.querySelector('#ai-more-menu')?.classList.remove('show')
    })
  } catch {}

  // 新建会话按钮
  el.querySelector('#ai-s-new')?.addEventListener('click',()=>{ createNewSession(context) })

  // 更多菜单按钮
  try {
    const btnMore = el.querySelector('#ai-btn-more')
    const moreMenu = el.querySelector('#ai-more-menu')
    btnMore?.addEventListener('click', (e) => {
      e.stopPropagation()
      moreMenu?.classList.toggle('show')
      // 关闭会话历史面板
      el.querySelector('#ai-history-panel')?.classList.remove('show')
    })
  } catch {}

  // 更多菜单项
  el.querySelector('#ai-menu-settings')?.addEventListener('click', () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    openSettings(context)
  })
  el.querySelector('#ai-menu-theme')?.addEventListener('click', () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    toggleTheme(context, el)
  })
  el.querySelector('#ai-menu-dock-left')?.addEventListener('click', async () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    await setDockMode(context, el, 'left', { resetDockSize: true })
  })
  el.querySelector('#ai-menu-dock-right')?.addEventListener('click', async () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    await setDockMode(context, el, 'right', { resetDockSize: true })
  })
  el.querySelector('#ai-menu-dock-bottom')?.addEventListener('click', async () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    await setDockMode(context, el, 'bottom', { resetDockSize: true })
  })
  el.querySelector('#ai-menu-dock-float')?.addEventListener('click', async () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    await setDockMode(context, el, false)
  })
  el.querySelector('#ai-menu-del-session')?.addEventListener('click', () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    deleteCurrentSession(context)
  })

  // 点击其他区域关闭下拉菜单
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.ai-more-menu-wrap')) {
      el.querySelector('#ai-more-menu')?.classList.remove('show')
    }
    if (!e.target.closest('#ai-btn-history') && !e.target.closest('#ai-history-panel')) {
      el.querySelector('#ai-history-panel')?.classList.remove('show')
    }
  })

  // 模型输入变更即保存
  try {
    const modelInput = el.querySelector('#ai-model')
    modelInput?.addEventListener('change', async (ev) => {
      const cfg = await loadCfg(context)
      cfg.model = String(modelInput.value || '').trim()
      await saveCfg(context, cfg)
    })
  } catch {}
  try {
    const freeModelSelect = el.querySelector('#ai-free-model')
    freeModelSelect?.addEventListener('change', async () => {
      const cfg = await loadCfg(context)
      const nextKey = normalizeFreeModelKey(freeModelSelect.value)
      cfg.freeModel = nextKey
      const info = FREE_MODEL_OPTIONS[nextKey]
      if (info && info.vision) {
        cfg.visionEnabled = true
      }
      await saveCfg(context, cfg)
      await refreshHeader(context)
    })
  } catch {}

  // 工具栏模式切换
  try {
    const providerToggle = el.querySelector('#ai-provider-toggle')
    providerToggle?.addEventListener('change', async () => {
      const cfg = await loadCfg(context)
      cfg.provider = providerToggle.checked ? 'free' : 'openai'
      await saveCfg(context, cfg)
      await refreshHeader(context)
      context.ui.notice(providerToggle.checked ? '已切换到免费模式' : '已切换到自定义模式', 'ok', 1600)
    })
  } catch {}
  // 视觉模式开关
  try {
    const visionBtn = el.querySelector('#ai-vision-toggle')
    if (visionBtn) {
      visionBtn.addEventListener('click', async () => {
        try {
          const cfg = await loadCfg(context)
          let supported = true
          if (isFreeProvider(cfg)) {
            const key = normalizeFreeModelKey(cfg.freeModel)
            const info = FREE_MODEL_OPTIONS[key]
            supported = !!(info && info.vision)
          }
          if (!supported) {
            try { context.ui.notice('当前模型暂不支持视觉能力', 'warn', 2000) } catch {}
            return
          }
          cfg.visionEnabled = !cfg.visionEnabled
          await saveCfg(context, cfg)
          await refreshHeader(context)
          try {
            context.ui.notice(cfg.visionEnabled ? '视觉模式已开启，将尝试读取文档中的图片' : '视觉模式已关闭，将仅使用文本上下文', 'ok', 2200)
          } catch {}
        } catch (e) {
          console.error('切换视觉模式失败：', e)
        }
      })
    }
  } catch {}
  // RAG 开关（与设置联动）
  try {
    const ragBtn = el.querySelector('#ai-rag-toggle')
    if (ragBtn) {
      ragBtn.addEventListener('click', async () => {
        try {
          const cfg = await loadCfg(context)
          if (!cfg.kb || typeof cfg.kb !== 'object') cfg.kb = {}
          cfg.kb.enabled = !cfg.kb.enabled
          await saveCfg(context, cfg)
          await refreshHeader(context)
          try {
            const elKb = DOC().querySelector('#set-kb-enabled')
            if (elKb) elKb.checked = !!cfg.kb.enabled
          } catch {}
          if (cfg.kb.enabled) {
            try {
              const api = context && typeof context.getPluginAPI === 'function'
                ? context.getPluginAPI('flymdRAG')
                : null
              if (!api || typeof api.search !== 'function') {
                context.ui.notice('RAG 已开启，但未检测到 flymd-RAG 插件（或未启用），检索不会生效。', 'warn', 2600)
              } else {
                context.ui.notice('RAG 已开启：发送前会追加知识库引用。', 'ok', 1800)
              }
            } catch {
              try { context.ui.notice('RAG 已开启：发送前会追加知识库引用。', 'ok', 1800) } catch {}
            }
          } else {
            try { context.ui.notice('RAG 已关闭：仅使用文档上下文与对话历史。', 'ok', 1800) } catch {}
          }
        } catch (e) {
          console.error('切换 RAG 失败：', e)
        }
      })
    }
  } catch {}

  // Agent 模式开关：对话式改文（写回需二次确认）
  try {
    const agentBtn = el.querySelector('#ai-agent-toggle')
    if (agentBtn) {
      agentBtn.addEventListener('click', async () => {
        try {
          if (__AI_SENDING__) {
            try { context.ui.notice(aiText('请等待当前 AI 响应完成', 'Please wait for the current response'), 'warn', 1800) } catch {}
            return
          }
          __AI_AGENT__.enabled = !__AI_AGENT__.enabled
          if (!__AI_AGENT__.enabled) {
            aiAgentResetState()
            aiAgentRenderPanel(context)
            try { context.ui.notice(aiText('Agent 模式已关闭', 'Agent mode disabled'), 'ok', 1200) } catch {}
            return
          }
          aiAgentBindPanelEvents(context)
          // 开启 Agent 时重置状态，确保使用当前文档内容
          aiAgentResetState()
          await aiAgentPickSource(context, __AI_AGENT__.target)
          aiAgentRenderPanel(context)
          try {
            context.ui.notice(
              aiText(
                'Agent 已开启',
                'Agent enabled: AI intent detection. Use /chat or /edit prefix to force mode.'
              ),
              'ok',
              3500
            )
          } catch {}
          try { const ta = el.querySelector('#ai-text'); if (ta) ta.focus() } catch {}
        } catch (e) {
          console.error('切换 Agent 模式失败：', e)
        }
      })
    }
  } catch {}

  // 初始渲染（窗口创建后立即同步一次）
  try { aiAgentBindPanelEvents(context); aiAgentRenderPanel(context) } catch {}

  // 发送按钮和回车发送
  el.querySelector('#ai-send').addEventListener('click',()=>{ sendFromInputWithAction(context) })
  try {
    const ta = el.querySelector('#ai-text')
    ta?.addEventListener('keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); try { sendFromInputWithAction(context) } catch {} } })
    // 对话框内粘贴图片支持
    ta?.addEventListener('paste', (e) => {
      try {
        const evt = e
        const dt = evt.clipboardData || window.clipboardData
        if (!dt || !dt.items || !dt.items.length) return
        const items = Array.from(dt.items)
        const imgItems = items.filter(it => it.kind === 'file' && it.type && /^image\//i.test(it.type))
        if (!imgItems.length) return
        imgItems.forEach(it => {
          try {
            const file = it.getAsFile()
            if (!file) return
            // 限制本地粘贴图片的大小，避免视觉模式负载过高
            if (MAX_LOCAL_IMAGE_BYTES > 0 && file.size && file.size > MAX_LOCAL_IMAGE_BYTES) {
              try {
                if (context && context.ui && typeof context.ui.notice === 'function') {
                  context.ui.notice('不支持1MB以上的本地图片，已从本次视觉请求中跳过。建议使用图床后再开启视觉模式。', 'warn', 4200)
                }
              } catch {}
              return
            }
            const fr = new FileReader()
            fr.onerror = () => {}
            fr.onload = () => {
              try {
                const url = String(fr.result || '')
                if (!url.startsWith('data:image/')) return
                if (!Array.isArray(__AI_PENDING_IMAGES__)) __AI_PENDING_IMAGES__ = []
                __AI_PENDING_IMAGES__.push({ url, name: file.name || '', mime: file.type || '' })
                updateVisionAttachmentIndicator()
              } catch {}
            }
            fr.readAsDataURL(file)
          } catch {}
        })
      } catch {}
    })
  } catch {}

  // 快捷操作选择即发送
  try {
    const actionSelect = el.querySelector('#ai-quick-action')
    actionSelect?.addEventListener('change', async () => {
      const action = String(actionSelect.value || '').trim()
      if (!action) {
        clearPendingAction(false)
        return
      }
      if (action === '待办') {
        await promptPendingQuickAction(context, 'todo')
        return
      }
      if (action === '提醒') {
        await promptPendingQuickAction(context, 'reminder')
        return
      }
      clearPendingAction(false)
      actionSelect.value = '' // 重置为智能问答
      if (['续写', '润色', '纠错', '提纲'].includes(action)) {
        await quick(context, action)
      }
    })
  } catch {}

  // 会话列表事件委托
  const sessionList = el.querySelector('#ai-session-list')
  sessionList?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('.ai-session-item-del')
    if (delBtn) {
      e.stopPropagation()
      const id = delBtn.dataset.id
      if (id) await deleteSessionById(context, id)
      return
    }
    const item = e.target.closest('.ai-session-item')
    if (item) {
      const id = item.dataset.id
      if (id) {
        await switchSessionById(context, id)
        el.querySelector('#ai-history-panel')?.classList.remove('show')
      }
    }
  })
  el.__mounted = true
  // 头部双击：大小切换（小↔大）
  try {
    const head = el.querySelector('#ai-head')
    head?.addEventListener('dblclick', () => toggleWinSizePreset(context, el))
  } catch {}
  try { startFilenameObserver(context) } catch {}
  await applyWinTheme(context, el)
  await refreshHeader(context)
  try { __AI_SESSION__ = await loadSession(context) } catch {}
  await ensureSessionForDoc(context)
  renderMsgs(el.querySelector('#ai-chat'))
  return el
}

async function toggleWindow(context){
  if (__AI_TOGGLE_LOCK__) return
  __AI_TOGGLE_LOCK__ = true; setTimeout(() => { __AI_TOGGLE_LOCK__ = false }, 300)
  let el = elById('ai-assist-win')
  if (!el) {
    // 首次创建窗口：先隐藏，然后显示（带动画）
    el = await mountWindow(context)
    el.style.display = 'block'
    el.classList.add('ai-win-hidden')
    // 强制重绘以触发动画
    void el.offsetHeight
    el.classList.remove('ai-win-hidden')
    setDockPush(true)
    await ensureSessionForDoc(context)
    await refreshHeader(context)
    return
  }
  const isHidden = el.classList.contains('ai-win-hidden') || el.style.display === 'none'
  if (isHidden) {
    // 显示窗口（带动画）
    el.style.display = 'block'
    el.classList.add('ai-win-hidden')
    void el.offsetHeight
    el.classList.remove('ai-win-hidden')
    setDockPush(true)
    await ensureSessionForDoc(context)
    await refreshHeader(context)
  } else {
    // 隐藏窗口（带动画）
    el.classList.add('ai-win-hidden')
    setDockPush(false)
    // 动画结束后隐藏元素
    setTimeout(() => {
      if (el.classList.contains('ai-win-hidden')) {
        el.style.display = 'none'
      }
    }, 200)
  }
}

async function toggleWinSizePreset(context, el){
  try {
    if (el.classList.contains('dock-left')) {
      const cfg = await loadCfg(context); const w = parseInt(el.style.width)||300; cfg.win = cfg.win||{}; cfg.win.w = w; await saveCfg(context, cfg); return
    }
    const w = parseInt(el.style.width)||520
    const isSmall = w < 700
    if (isSmall) { el.style.width = Math.floor(WIN().innerWidth * 0.62) + 'px'; el.style.height = Math.floor(WIN().innerHeight * 0.66) + 'px' }
    else { el.style.width = '520px'; el.style.height = '440px' }
  } catch {}
}

function autoFitWindow(context, el){
  try {
    // dock-left 模式不需要垂直自适应
  } catch {}
}

let __AI_FN_OB__ = null
function startFilenameObserver(context){
  try {
    if (__AI_FN_OB__) { try { __AI_FN_OB__.disconnect() } catch {} }
    const target = DOC().getElementById('filename')
    if (!target) return
    __AI_FN_OB__ = new MutationObserver(async () => {
      // 防抖：延迟 300ms 执行，避免频繁触发
      if (__AI_FN_DEBOUNCE_TIMER__) clearTimeout(__AI_FN_DEBOUNCE_TIMER__)
      __AI_FN_DEBOUNCE_TIMER__ = setTimeout(async () => {
        try {
          const content = String(context.getEditorValue() || '')
          const { hash } = getDocMetaFromContent(context, content)
          // 只在文档哈希真正改变时才重新渲染（避免因未保存标记等引起的闪烁）
          if (hash !== __AI_LAST_DOC_HASH__) {
            __AI_LAST_DOC_HASH__ = hash
            await ensureSessionForDoc(context)
            await updateWindowTitle(context)
            await refreshSessionSelect(context) // 刷新会话下拉框
            const chat = el('ai-chat')
            if (chat) renderMsgs(chat)
          } else {
            // 哈希未变，仅更新标题
            await updateWindowTitle(context)
          }
        } catch {}
      }, 300)
    })
    __AI_FN_OB__.observe(target, { characterData: true, childList: true, subtree: true })
  } catch {}
}

async function toggleDockMode(context, el){
  try {
    const cfg = await loadCfg(context)
    // 循环：'left' → 'right' → 'bottom' → false → 'left'
    let nextDock
    if (cfg.dock === 'left') nextDock = 'right'
    else if (cfg.dock === 'right') nextDock = 'bottom'
    else if (cfg.dock === 'bottom') nextDock = false
    else nextDock = 'left'

    cfg.dock = nextDock
    await saveCfg(context, cfg)

    // 移除所有停靠类
    el.classList.remove('dock-left', 'dock-right', 'dock-bottom')

    if (nextDock === 'left') {
      // 左侧停靠
      el.classList.add('dock-left')
      const bounds = computeWorkspaceBounds()
      const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
      const panelWidth = Math.max(MIN_WIDTH, Math.min(Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH), workspaceWidth || MIN_WIDTH))
      applyDockVerticalBounds(el, bounds)
      el.style.left = bounds.left + 'px'
      el.style.right = 'auto'
      el.style.width = panelWidth + 'px'
      setDockPush('left', panelWidth)
    } else if (nextDock === 'right') {
      // 右侧停靠
      el.classList.add('dock-right')
      const bounds = computeWorkspaceBounds()
      const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
      const panelWidth = Math.max(MIN_WIDTH, Math.min(Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH), workspaceWidth || MIN_WIDTH))
      applyDockVerticalBounds(el, bounds)
      el.style.right = bounds.right + 'px'
      el.style.left = 'auto'
      el.style.width = panelWidth + 'px'
      setDockPush('right', panelWidth)
    } else if (nextDock === 'bottom') {
      // 底部停靠
      el.classList.add('dock-bottom')
      const h = Math.max(300, Number((cfg && cfg.win && cfg.win.h) || 440))
      const bounds = computeWorkspaceBounds()
      el.style.top = 'auto'
      el.style.bottom = '0px'
      el.style.left = bounds.left + 'px'
      el.style.right = bounds.right + 'px'
      el.style.width = 'auto'
      el.style.height = h + 'px'
      setDockPush('bottom', h)
    } else {
      // 浮动窗口
      el.style.top = ((cfg && cfg.win && cfg.win.y) || 60) + 'px'
      el.style.left = ((cfg && cfg.win && cfg.win.x) || 60) + 'px'
      el.style.width = ((cfg && cfg.win && cfg.win.w) || 520) + 'px'
      el.style.height = ((cfg && cfg.win && cfg.win.h) || 440) + 'px'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
      setDockPush(false)
    }
    await refreshHeader(context)
  } catch {}
}

// 直接设置停靠模式
async function setDockMode(context, el, dockMode, opts){
  try {
    const cfg = await loadCfg(context)
    const resetDockSize = !!(opts && opts.resetDockSize)
    if (resetDockSize) {
      cfg.win = cfg.win || {}
      if (dockMode === 'left' || dockMode === 'right') cfg.win.w = MIN_WIDTH
      else if (dockMode === 'bottom') cfg.win.h = 400
    }
    cfg.dock = dockMode
    await saveCfg(context, cfg)

    // 移除所有停靠类
    el.classList.remove('dock-left', 'dock-right', 'dock-bottom')

    if (dockMode === 'left') {
      el.classList.add('dock-left')
      const bounds = computeWorkspaceBounds()
      const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
      const panelWidth = Math.max(MIN_WIDTH, Math.min(Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH), workspaceWidth || MIN_WIDTH))
      applyDockVerticalBounds(el, bounds)
      el.style.left = bounds.left + 'px'
      el.style.right = 'auto'
      el.style.width = panelWidth + 'px'
      setDockPush('left', panelWidth)
    } else if (dockMode === 'right') {
      el.classList.add('dock-right')
      const bounds = computeWorkspaceBounds()
      const workspaceWidth = bounds.width || (WIN().innerWidth || 1280)
      const panelWidth = Math.max(MIN_WIDTH, Math.min(Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH), workspaceWidth || MIN_WIDTH))
      applyDockVerticalBounds(el, bounds)
      el.style.right = bounds.right + 'px'
      el.style.left = 'auto'
      el.style.width = panelWidth + 'px'
      setDockPush('right', panelWidth)
    } else if (dockMode === 'bottom') {
      el.classList.add('dock-bottom')
      const h = Math.max(300, Number((cfg && cfg.win && cfg.win.h) || 440))
      const bounds = computeWorkspaceBounds()
      el.style.top = 'auto'
      el.style.bottom = '0px'
      el.style.left = bounds.left + 'px'
      el.style.right = bounds.right + 'px'
      el.style.width = 'auto'
      el.style.height = h + 'px'
      setDockPush('bottom', h)
    } else {
      // 浮动窗口
      el.style.top = ((cfg && cfg.win && cfg.win.y) || 60) + 'px'
      el.style.left = ((cfg && cfg.win && cfg.win.x) || 60) + 'px'
      el.style.width = ((cfg && cfg.win && cfg.win.w) || 520) + 'px'
      el.style.height = ((cfg && cfg.win && cfg.win.h) || 440) + 'px'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
      setDockPush(false)
    }
    await refreshHeader(context)
  } catch {}
}

async function detachToSystemWindow(context){
  try {
    if (typeof context.openAiWindow === 'function') { await context.openAiWindow(); return }
    context.ui.notice('当前环境不支持原生多窗口（已尝试）', 'err', 2500)
  } catch (e) {
    console.error('detachToSystemWindow 失败', e)
    context.ui.notice('独立窗口创建失败', 'err', 2000)
  }
}

function buildPromptPrefix(kind){
  switch(kind){
    case '续写': return '基于文档上下文，继续自然连贯地续写。'
    case '润色': return '基于文档上下文，润色并提升表达的清晰度与逻辑性，仅输出修改后的结果。'
    case '纠错': return '基于文档上下文，找出并修正错别字、语法问题，仅输出修订后的结果。'
    case '提纲': return '阅读文档上下文，输出一份结构化提纲（分级列表）。'
    case '翻译': return '将以下内容翻译成中文，保持原文格式和结构，译文要自然流畅、符合中文表达习惯。只输出翻译结果，不要添加任何解释。'
    case '解疑': return aiText(
      '你是严谨的助手。请对用户选中的内容进行“解疑”：解释它在说什么、关键概念/结论/前提；如果存在歧义，列出并给出可能解释；必要时给出简短例子帮助理解。用中文回答，使用 Markdown 排版。',
      'You are a rigorous assistant. Please answer questions about the selected text: explain what it says, key concepts/conclusions/assumptions; list ambiguities and possible interpretations; add short examples if helpful. Reply in English and format with Markdown.'
    )
    default: return ''
  }
}

function getDomSelectionText(){
  try {
    const doc = DOC()
    const win = WIN()

    // 优先：如果焦点在 iframe（例如 PDF/嵌入预览），尝试从 iframe 拿选区
    const ae = doc && doc.activeElement
    if (ae && String(ae.tagName || '').toUpperCase() === 'IFRAME') {
      try {
        const ifr = ae
        const cw = ifr && ifr.contentWindow
        const sel = cw && cw.getSelection ? cw.getSelection() : null
        const t = sel ? String(sel.toString() || '') : ''
        const s = String(t || '').trim()
        if (s) return s
      } catch {}
    }

    const sel = win && win.getSelection ? win.getSelection() : null
    const t = sel ? String(sel.toString() || '') : ''
    return String(t || '').trim()
  } catch {}
  return ''
}

function snapshotSelectedTextFromCtx(ctx){
  try {
    const mode = ctx && typeof ctx === 'object' ? String(ctx.mode || '') : ''
    const fromCtx = String(ctx && ctx.selectedText ? ctx.selectedText : '').trim()
    const dom = getDomSelectionText()

    // 阅读/预览模式：ctx.selectedText 可能来自源码编辑器，优先用 DOM 选区
    if (mode === 'preview') return dom || fromCtx
    return fromCtx || dom
  } catch {}
  return ''
}

async function getSelectedTextSmart(context, ctx, presetText){
  const preset = String(presetText || '').trim()
  if (preset) return preset
  const snap = snapshotSelectedTextFromCtx(ctx)
  if (snap) return snap
  try {
    const sel = await context.getSelection?.()
    const t = String(sel?.text || '').trim()
    if (t) return t
  } catch {}
  return ''
}

async function quick(context, kind, options = {}){
  const inp = el('ai-text')
  const prefix = buildPromptPrefix(kind)
  let finalPrompt = prefix

  // 选区策略：解疑必须有选区；续写/润色/纠错优先选区；其它不关心选区
  const selectionPolicy = (kind === '解疑')
    ? 'required'
    : (['续写', '润色', '纠错'].includes(kind) ? 'prefer' : 'none')

  const ctx = options && typeof options === 'object' ? options.ctx : null
  const selected = await getSelectedTextSmart(context, ctx, options.selectedText)

  if (selectionPolicy === 'required' && !selected) {
    context.ui.notice(aiText('请先选中一段文本再使用“解疑”', 'Please select some text before using “Explain”'), 'err', 2200)
    return
  }

  if (selected && selectionPolicy !== 'none') {
    const tail = (kind === '解疑')
      ? aiText('请仅围绕这段选中内容进行解疑，不要扩展到文档里未选中的其它内容。', 'Please focus only on the selected text; do not expand to other parts of the document.')
      : `请仅针对这段选中内容进行${kind}，不要处理文档中未选中的部分。`

    finalPrompt = [
      prefix,
      '',
      aiText('当前选中内容：', 'Selected text:'),
      '',
      selected,
      '',
      tail
    ].join('\n')
  }

  inp.value = finalPrompt
  await sendFromInput(context)
}

// 翻译功能：检测选中文本或整篇文档进行翻译
async function translateText(context) {
  let translatingNoticeId = null
  try {
    const cfg = await loadCfg(context)
    // 如果开启了"翻译始终使用免费模型"，则强制使用免费模式
    const useFreeTrans = !!cfg.alwaysUseFreeTrans
    const isFree = useFreeTrans || isFreeProvider(cfg)
    if (!cfg.apiKey && !isFree) {
      context.ui.notice(aiText('请先在\"设置\"中配置 API Key', 'Please configure API Key in Settings first'), 'err', 3000)
      return
    }

    // 检测是否有选中文本
    let textToTranslate = ''
    let hasSelection = false
    let selectionInfo = null

    try {
      selectionInfo = await context.getSelection?.()
      if (selectionInfo && selectionInfo.text && selectionInfo.text.trim()) {
        textToTranslate = selectionInfo.text.trim()
        hasSelection = true
      }
    } catch {}

    // 如果没有选中文本，翻译整篇文档
    if (!hasSelection) {
      textToTranslate = String(context.getEditorValue() || '').trim()
    }

    if (!textToTranslate) {
      context.ui.notice(aiText('没有可翻译的内容', 'Nothing to translate'), 'err', 2000)
      return
    }

    translatingNoticeId = showLongRunningNotice(context, aiText('正在翻译...', 'Translating...'))

    // 构造翻译请求
    const system = aiText('你是专业的翻译助手。', 'You are a professional translation assistant.')
    const prompt = buildPromptPrefix(aiText('翻译', 'Translate')) + '\n\n' + textToTranslate

    // 构造临时配置对象用于翻译调用
    const transCfg = useFreeTrans ? { ...cfg, provider: 'free' } : cfg
    const url = buildApiUrl(transCfg)
    const headers = buildApiHeaders(transCfg)
    const body = JSON.stringify({
      model: resolveModelId(transCfg),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      stream: false
    })

    const response = await _aiFetch(url, { method: 'POST', headers, body })
    if (!response.ok) {
      throw new Error('API 调用失败：' + response.status)
    }
    const data = _aiTryParseJsonLoose(await response.text())
    const translation = String(data?.choices?.[0]?.message?.content || '').trim()

    if (!translation) {
      context.ui.notice('翻译失败：未获取到结果', 'err', 3000)
      return
    }

    // 格式化并插入翻译结果
    const currentContent = String(context.getEditorValue() || '')

    if (hasSelection) {
      // 选中文本翻译：在选中位置后插入翻译（引用格式）
      const translationBlock = '\n\n> 📝 **翻译**\n> \n' + translation.split('\n').map(line => '> ' + line).join('\n') + '\n'

      try {
        // 在选区末尾插入
        if (selectionInfo && typeof selectionInfo.end === 'number') {
          await context.replaceRange(selectionInfo.end, selectionInfo.end, translationBlock)
        } else {
          // 降级：插入到光标位置
          await context.insertAtCursor(translationBlock)
        }
      } catch {
        // 再降级：追加到文档末尾
        context.setEditorValue(currentContent + translationBlock)
      }
      context.ui.notice('翻译完成', 'ok', 1600)
    } else {
      // 整篇文档翻译：追加到文档末尾
      const translationSection = '\n\n---\n\n## 📝 中文翻译\n\n' + translation + '\n'
      context.setEditorValue(currentContent + translationSection)
      context.ui.notice('整篇文档翻译完成', 'ok', 1600)
    }
  } catch (error) {
    console.error('翻译失败：', error)
    context.ui.notice('翻译失败：' + (error?.message || '未知错误'), 'err', 4000)
  } finally {
    hideLongRunningNotice(context, translatingNoticeId)
  }
}

  async function generateTodosAndPush(context) {
  const GENERATING_MARKER = '[正在生成待办并创建提醒]\n\n'
  let generatingNoticeId = null
  let selectionInfo = null
  let hasSelection = false
  try {
      const cfg = await loadCfg(context)
      const isFree = isFreeProvider(cfg)
      if (!cfg.apiKey && !isFree) {
        context.ui.notice(aiText('请先在\"设置\"中配置 API Key', 'Please configure API Key in Settings first'), 'err', 3000)
        return
      }
      if (!cfg.model && !isFree) {
        context.ui.notice(aiText('请先选择模型', 'Please choose a model first'), 'err', 2000)
        return
    }

    // 检查 xxtui-todo-push 插件是否可用
    const xxtuiAPI = context.getPluginAPI('xxtui-todo-push')
    if (!xxtuiAPI || !xxtuiAPI.parseAndCreateReminders) {
      context.ui.notice('xxtui-todo-push 插件未安装或版本过低', 'err', 3000)
      return
    }

    // 检查是否有选中文字
    try {
      selectionInfo = await context.getSelection?.()
      if (selectionInfo && selectionInfo.text && selectionInfo.text.trim()) {
        hasSelection = true
      }
    } catch {}

    // 获取文档内容（如果有选区，使用选区内容；否则使用整个文档）
    const content = hasSelection ? String(selectionInfo.text || '').trim() : String(context.getEditorValue() || '').trim()
    if (!content) {
      context.ui.notice(hasSelection ? aiText('选中内容为空', 'Selected content is empty') : aiText('文档内容为空', 'Document content is empty'), 'err', 2000)
      return
    }

    // 在文档顶部显示生成提示（仅在没有选区时）
    if (!hasSelection) {
      context.setEditorValue(GENERATING_MARKER + context.getEditorValue())
    }
    generatingNoticeId = showLongRunningNotice(context, aiText('正在分析文章生成待办事项并创建提醒...', 'Analyzing document and creating reminders...'))

    const { system, prompt } = buildTodoPrompt(content)

      const url = buildApiUrl(cfg)
      const headers = buildApiHeaders(cfg)
    const body = JSON.stringify({
      model: resolveModelId(cfg),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      stream: false
    })

    const response = await _aiFetch(url, { method: 'POST', headers, body })
    if (!response.ok) {
      throw new Error('API 调用失败：' + response.status)
    }
    const data = _aiTryParseJsonLoose(await response.text())
    const todos = String(data?.choices?.[0]?.message?.content || '').trim()

    if (!todos) {
      // 恢复原内容（删除生成提示）
      if (!hasSelection) {
        const currentContent = String(context.getEditorValue() || '')
        if (currentContent.startsWith(GENERATING_MARKER)) {
          context.setEditorValue(currentContent.replace(GENERATING_MARKER, ''))
        }
      }
      context.ui.notice('AI 未能生成待办事项', 'err', 3000)
      return
    }

    // 提取有效的待办事项行
    const lines = todos.split('\n')
    const validTodos = lines.filter(line => {
      const trimmed = line.trim()
      return trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]')
    })

    if (validTodos.length === 0) {
      // 恢复原内容（删除生成提示）
      if (!hasSelection) {
        const currentContent = String(context.getEditorValue() || '')
        if (currentContent.startsWith(GENERATING_MARKER)) {
          context.setEditorValue(currentContent.replace(GENERATING_MARKER, ''))
        }
      }
      context.ui.notice('未能提取有效的待办事项格式', 'err', 3000)
      return
    }

    // 生成待办事项文本
    const todoSection = validTodos.join('\n') + '\n\n'

    // 先插入待办事项到文档
    if (hasSelection && selectionInfo) {
      // 如果有选区，替换选区内容
      try {
        await context.replaceRange(selectionInfo.start, selectionInfo.end, todoSection.trim())
      } catch (err) {
        console.error('替换选区失败：', err)
        // 降级：在选区后插入
        try {
          await context.insertAtCursor('\n' + todoSection)
        } catch {
          // 再降级：插入到文档开头
          const fullContent = String(context.getEditorValue() || '')
          context.setEditorValue(todoSection + fullContent)
        }
      }
    } else {
      // 没有选区，插入到文档开头（替换生成提示）
      const fullContent = String(context.getEditorValue() || '')
      const newContent = fullContent.startsWith(GENERATING_MARKER)
        ? todoSection + fullContent.replace(GENERATING_MARKER, '')
        : todoSection + fullContent
      context.setEditorValue(newContent)
    }

    // 调用 xxtui API 批量创建提醒
    try {
      const result = await xxtuiAPI.parseAndCreateReminders(todoSection)
      const { success = 0, failed = 0 } = result || {}
      const total = validTodos.length

      let msg = `成功生成 ${total} 条待办事项`
      if (hasSelection) {
        msg += '（已替换选区）'
      }
      if (success > 0) {
        msg += `，已创建 ${success} 条提醒`
      }
      if (failed > 0) {
        msg += `（${failed} 条创建失败）`
      }

      context.ui.notice(msg, success > 0 ? 'ok' : 'warn', 3500)
    } catch (err) {
      console.error('创建提醒失败：', err)
      const prefix = hasSelection ? '成功生成并替换选区，' : '成功生成 '
      context.ui.notice(`${prefix}${validTodos.length} 条待办事项，但创建提醒失败：${err.message || '未知错误'}`, 'warn', 4000)
    }
  } catch (error) {
    console.error('生成待办事项失败：', error)
    try {
      const currentContent = String(context.getEditorValue() || '')
      if (currentContent.startsWith(GENERATING_MARKER)) {
        context.setEditorValue(currentContent.replace(GENERATING_MARKER, ''))
      }
    } catch {}
    context.ui.notice('生成待办事项失败：' + (error?.message || '未知错误'), 'err', 4000)
  } finally {
    hideLongRunningNotice(context, generatingNoticeId)
  }
}

async function generateTodos(context){
  const GENERATING_MARKER = '[正在生成待办]\n\n'
  let generatingNoticeId = null
  let selectionInfo = null
  let hasSelection = false
  try {
      const cfg = await loadCfg(context)
      const isFree = isFreeProvider(cfg)
      if (!cfg.apiKey && !isFree) {
        context.ui.notice(aiText('请先在\"设置\"中配置 API Key', 'Please configure API Key in Settings first'), 'err', 3000)
        return
      }
      if (!cfg.model && !isFree) {
        context.ui.notice(aiText('请先选择模型', 'Please choose a model first'), 'err', 2000)
        return
    }

    // 检查是否有选中文字
    try {
      selectionInfo = await context.getSelection?.()
      if (selectionInfo && selectionInfo.text && selectionInfo.text.trim()) {
        hasSelection = true
      }
    } catch {}

    // 获取文档内容（如果有选区，使用选区内容；否则使用整个文档）
    const content = hasSelection ? String(selectionInfo.text || '').trim() : String(context.getEditorValue() || '').trim()
    if (!content) {
      context.ui.notice(hasSelection ? aiText('选中内容为空', 'Selected content is empty') : aiText('文档内容为空', 'Document content is empty'), 'err', 2000)
      return
    }

    // 在文档顶部显示生成提示（仅在没有选区时）
    if (!hasSelection) {
      context.setEditorValue(GENERATING_MARKER + context.getEditorValue())
    }
    generatingNoticeId = showLongRunningNotice(context, aiText('正在分析文章生成待办事项...', 'Analyzing document and generating todos...'))

    const { system, prompt } = buildTodoPrompt(content)

      const url = buildApiUrl(cfg)
      const headers = buildApiHeaders(cfg)
    const body = JSON.stringify({
      model: resolveModelId(cfg),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      stream: false
    })

    const response = await _aiFetch(url, { method: 'POST', headers, body })
    if (!response.ok) {
      throw new Error('API 调用失败：' + response.status)
    }

    const data = _aiTryParseJsonLoose(await response.text())
    const todos = String(data?.choices?.[0]?.message?.content || '').trim()

    if (!todos) {
      // 恢复原内容（删除生成提示）
      if (!hasSelection) {
        const currentContent = String(context.getEditorValue() || '')
        if (currentContent.startsWith(GENERATING_MARKER)) {
          context.setEditorValue(currentContent.replace(GENERATING_MARKER, ''))
        }
      }
      context.ui.notice(aiText('AI 未能生成待办事项', 'AI did not generate any todos'), 'err', 3000)
      return
    }

    // 提取有效的待办事项行（以 - [ ] 开头）
    const lines = todos.split('\n')
    const validTodos = lines.filter(line => {
      const trimmed = line.trim()
      return trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]')
    })

    if (validTodos.length === 0) {
      // 恢复原内容（删除生成提示）
      if (!hasSelection) {
        const currentContent = String(context.getEditorValue() || '')
        if (currentContent.startsWith(GENERATING_MARKER)) {
          context.setEditorValue(currentContent.replace(GENERATING_MARKER, ''))
        }
      }
      context.ui.notice('未能提取有效的待办事项格式', 'err', 3000)
      return
    }

    // 生成待办事项文本
    const todoSection = validTodos.join('\n') + '\n\n'

    if (hasSelection && selectionInfo) {
      // 如果有选区，替换选区内容
      try {
        await context.replaceRange(selectionInfo.start, selectionInfo.end, todoSection.trim())
        context.ui.notice(`成功生成 ${validTodos.length} 条待办事项（已替换选区）`, 'ok', 2500)
      } catch (err) {
        console.error('替换选区失败：', err)
        // 降级：在选区后插入
        try {
          await context.insertAtCursor('\n' + todoSection)
          context.ui.notice(`成功生成 ${validTodos.length} 条待办事项（已插入光标处）`, 'ok', 2500)
        } catch {
          // 再降级：插入到文档开头
          const fullContent = String(context.getEditorValue() || '')
          context.setEditorValue(todoSection + fullContent)
          context.ui.notice(`成功生成 ${validTodos.length} 条待办事项（已插入文档开头）`, 'ok', 2500)
        }
      }
    } else {
      // 没有选区，插入到文档开头（替换生成提示）
      const fullContent = String(context.getEditorValue() || '')
      const newContent = fullContent.startsWith(GENERATING_MARKER)
        ? todoSection + fullContent.replace(GENERATING_MARKER, '')
        : todoSection + fullContent
      context.setEditorValue(newContent)
      context.ui.notice(`成功生成 ${validTodos.length} 条待办事项`, 'ok', 2500)
    }
  } catch (error) {
    console.error('生成待办事项失败：', error)
    // 恢复原内容（删除生成提示）
    try {
      const currentContent = String(context.getEditorValue() || '')
      if (currentContent.startsWith(GENERATING_MARKER)) {
        context.setEditorValue(currentContent.replace(GENERATING_MARKER, ''))
      }
    } catch {}
    context.ui.notice('生成待办事项失败：' + (error?.message || '未知错误'), 'err', 4000)
  } finally {
    hideLongRunningNotice(context, generatingNoticeId)
  }
}

function clearPendingAction(resetSelect = true){
  __AI_PENDING_ACTION__ = null
  if (!resetSelect) return
  try {
    const select = el('ai-quick-action')
    if (select) select.value = ''
  } catch {}
}

async function promptPendingQuickAction(context, type){
  if (__AI_SENDING__) {
    context.ui.notice('请等待当前 AI 响应完成', 'warn', 2000)
    clearPendingAction()
    return
  }
  await ensureSessionForDoc(context)
  __AI_PENDING_ACTION__ = type
  const select = el('ai-quick-action')
  if (select) select.value = type === 'reminder' ? '提醒' : '待办'
  const tip = type === 'reminder'
    ? '请告诉我需要处理的事项内容，我会为您生成待办清单并创建XXTUI提醒。'
    : '请告诉我需要处理的事项内容，我会为您生成待办清单。'
  pushMsg('assistant', tip)
  __AI_LAST_REPLY__ = tip
  const chat = el('ai-chat')
  if (chat) renderMsgs(chat)
  try { await syncCurrentSessionToDB(context) } catch {}
  try { const elw = el('ai-assist-win'); if (elw) autoFitWindow(context, elw) } catch {}
  const ta = el('ai-text')
  if (ta) ta.focus()
}

async function handlePendingQuickActionInput(context, type, text){
  if (__AI_SENDING__) {
    context.ui.notice('AI 正在处理中，请稍候', 'warn', 2000)
    return
  }
  await ensureSessionForDoc(context)
  pushMsg('user', text)
  const chat = el('ai-chat')
  if (chat) renderMsgs(chat)
  try { await syncCurrentSessionToDB(context) } catch {}
  await processPendingQuickAction(context, type, text)
}

async function processPendingQuickAction(context, type, userText){
  __AI_SENDING__ = true
  const chat = el('ai-chat')
  let finalMsg = ''
  let noticeInfo = null
  try {
    const { todos = [] } = await generateTodosForPlugins(context, userText)
    if (!todos.length) {
      finalMsg = 'AI 未能生成有效的待办事项，请提供更具体的描述。'
      noticeInfo = { text: '未能生成有效的待办事项', type: 'warn', duration: 3000 }
    } else {
      const todoText = todos.join('\n')
      if (type === 'reminder') {
        const api = context.getPluginAPI('xxtui-todo-push')
        if (!api || !api.parseAndCreateReminders) {
          finalMsg = `以下是生成的待办清单：\n${todoText}\n\n未检测到 xxtui-todo-push 插件，无法创建提醒。`
          noticeInfo = { text: '未检测到 xxtui-todo-push 插件，无法创建提醒', type: 'warn', duration: 3500 }
        } else {
          try {
            const payload = todoText + '\n\n'
            const result = await api.parseAndCreateReminders(payload)
            const { success = 0, failed = 0 } = result || {}
            let summary = `提醒创建结果：已创建 ${success} 条提醒`
            let noticeText = summary
            let noticeType = 'ok'
            if (failed > 0) {
              summary += `，${failed} 条失败`
              noticeText = `已创建 ${success} 条提醒，${failed} 条失败`
              noticeType = 'warn'
            }
            finalMsg = `以下是生成的待办清单：\n${todoText}\n\n${summary}`
            noticeInfo = { text: noticeText, type: noticeType, duration: 3500 }
          } catch (err) {
            const errMsg = '提醒创建失败：' + (err?.message || '未知错误')
            console.error('创建提醒失败：', err)
            finalMsg = `以下是生成的待办清单：\n${todoText}\n\n${errMsg}`
            noticeInfo = { text: errMsg, type: 'err', duration: 4000 }
          }
        }
      } else {
        finalMsg = `以下是生成的待办清单：\n${todoText}`
        noticeInfo = { text: `成功生成 ${todos.length} 条待办事项`, type: 'ok', duration: 2500 }
      }
    }
  } catch (error) {
    console.error('对话待办生成失败：', error)
    finalMsg = '生成待办清单失败：' + (error?.message || '未知错误')
    noticeInfo = { text: finalMsg, type: 'err', duration: 4000 }
  } finally {
    __AI_SENDING__ = false
    clearPendingAction()
  }
  if (noticeInfo) {
    try { context.ui.notice(noticeInfo.text, noticeInfo.type, noticeInfo.duration || 3000) } catch {}
  }
  if (!finalMsg) return
  pushMsg('assistant', finalMsg)
  __AI_LAST_REPLY__ = finalMsg
  if (chat) renderMsgs(chat)
  try { await syncCurrentSessionToDB(context) } catch {}
  try {
    const cfg = await loadCfg(context)
    await maybeNameCurrentSession(context, cfg, finalMsg)
  } catch {}
  try { const elw = el('ai-assist-win'); if (elw) autoFitWindow(context, elw) } catch {}
}

async function sendFromInput(context){
  const ta = el('ai-text')
  const text = String(ta.value || '').trim()
  if (!text) return
  ta.value = ''
  await ensureSessionForDoc(context)
  pushMsg('user', text)
  await syncCurrentSessionToDB(context)
  renderMsgs(el('ai-chat'))
  await doSend(context)
}

function normalizeKbCfgForAi(cfg){
  try {
    const raw = (cfg && cfg.kb && typeof cfg.kb === 'object') ? cfg.kb : {}
    const enabled = !!raw.enabled
    const topK = Math.max(1, Math.min(20, parseInt(String(raw.topK ?? 5), 10) || 5))
    const maxChars = Math.max(200, Math.min(8000, parseInt(String(raw.maxChars ?? 2000), 10) || 2000))
    return { enabled, topK, maxChars }
  } catch {
    return { enabled: false, topK: 5, maxChars: 2000 }
  }
}

function extractPlainTextFromChatMessage(msg){
  try {
    if (!msg) return ''
    const c = msg.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map(b => (b && b.type === 'text') ? String(b.text || '') : '').join('')
    }
  } catch {}
  return ''
}

function aiGuardExtractTextFromMessages(messages){
  try {
    const arr = Array.isArray(messages) ? messages : []
    let out = ''
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i]
      if (!m || typeof m !== 'object') continue
      const role = String(m.role || '').trim()
      // 只看用户/助手内容：system 也许包含安全提示，不应该触发拦截
      if (role !== 'user' && role !== 'assistant') continue
      const t = String(extractPlainTextFromChatMessage(m) || '').trim()
      if (!t) continue
      out += t + '\n'
    }
    return out
  } catch { return '' }
}

function aiGuardCheckText(text){
  const t = String(text || '').trim()
  if (!t) return null

  // 内容拦截：只做本地硬规则（不做配置 UI）。
  // 你的要求：强规则命中 >=2 才拒绝；弱规则命中 >=4 才拒绝。
  const strongRules = [
    // 强规则：每个词/模式出现一次，只算一次命中（同一个词重复出现不叠加）。
    /口交/i,
    /肛交/i,
    /轮奸/i,
    /兽交/i,
    /乱伦/i,
    /亂倫/i,
    /幼女/i,
    /未成年.*性/i,
    /肉棒/i,
    /约炮/i,
    /援交/i,
    /卖淫/i,
    /嫖娼/i,
    /性骚扰/i,
    /猥亵/i,
    /性虐待/i,
    /sm虐待/i,
    /恋童/i,
    /幼齿/i,
    /淫秽/i,
    /黄色/i,
    /\brape\b/i,
    /\bincest\b/i,
    /\bbestiality\b/i,
    /\bcumshot\b/i,
    /\bblowjob\b/i,
    /\bhandjob\b/i,
    /\bmasturbat(?:e|ion)?\b/i,
    /\bchild\s*sex(?:ual)?\b/i
  ]
  let strongHits = 0
  for (const re of strongRules) {
    try { if (re.test(t)) strongHits++ } catch {}
  }
  if (strongHits >= 2) return { reason: '强规则命中' }

  const weakRules = [
    /(阴茎|龟头|睾丸|阴道|乳头|裸体|裸露|性交|做爱|高潮|成人视频|A片|勃起|性暗示|情色|色情|性器官|私处|欲望|性欲|按摩|特殊服务|一夜情|炮友|性玩具|阴毛|体毛|抚摸|挑逗)/,
    /(手淫|自慰|射精|精液)/,
    /(强奸|迷奸|奸淫)/,
    /(操我)/,
    /\b(porn|penis|vagina|nude)\b/i,
    /\b(anal\s*sex)\b/i
  ]
  let weakHits = 0
  for (const re of weakRules) {
    try { if (re.test(t)) weakHits++ } catch {}
  }
  if (weakHits >= 4) return { reason: '弱规则命中' }

  return null
}

function aiGuardCheckMessages(cfg, messages){
  try {
    // 你的要求：自定义 AI（非免费代理模式）不做拦截
    if (!isFreeProvider(cfg)) return null
    const text = aiGuardExtractTextFromMessages(messages)
    return aiGuardCheckText(text)
  } catch { return null }
}

function aiGuardAssertAllowed(context, cfg, messages){
  const hit = aiGuardCheckMessages(cfg, messages)
  if (!hit) return true
  const msg = aiText('检测到露骨色情/性暴力内容，AI 助手已拒绝处理。', 'Detected explicit sexual content. The AI assistant refused.')
  try { console.warn('[AI助手] 已拒绝请求：', hit && hit.reason ? hit.reason : '命中规则') } catch {}
  try {
    if (context && context.ui && typeof context.ui.notice === 'function') {
      context.ui.notice(msg, 'warn', 4500)
    }
  } catch {}
  const err = new Error(msg)
  err.code = 'AI_GUARD_BLOCKED'
  throw err
}

function getLastUserTextFromMsgs(msgs){
  try {
    const arr = Array.isArray(msgs) ? msgs : []
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]
      if (m && m.role === 'user') {
        const t = String(extractPlainTextFromChatMessage(m) || '').trim()
        if (t) return t
      }
    }
  } catch {}
  return ''
}

function buildKnowledgeContextText(hits, maxChars){
  const locale = aiGetLocale()
  const head = locale === 'en' ? 'Knowledge base excerpts:' : '知识库引用：'
  const tail = locale === 'en'
    ? '\nUse [n] citations when you refer to these excerpts.'
    : '\n引用这些内容时请用 [n] 标注来源。'
  let out = head + '\n'
  const limit = Math.max(200, maxChars | 0)
  const add = (s) => {
    if (!s) return
    if (out.length >= limit) return
    const remain = limit - out.length
    out += s.length > remain ? s.slice(0, remain) : s
  }

  const arr = Array.isArray(hits) ? hits : []
  for (let i = 0; i < arr.length; i++) {
    const h = arr[i] || {}
    const rel = String(h.relative || '').trim()
    const line = `${rel || (h.filePath || '')}:${h.startLine || ''}-${h.endLine || ''}`
    const heading = String(h.heading || '').trim()
    const score = (typeof h.score === 'number' && Number.isFinite(h.score)) ? h.score : null
    const title = `[${i + 1}] ${line}` + (heading ? ` # ${heading}` : '') + (score != null ? ` (${score.toFixed(4)})` : '')
    const snip = String(h.snippet || '').trim()
    add(title + '\n')
    if (snip) add(snip + '\n\n')
    if (out.length >= limit) break
  }
  add(tail)
  return out.trim()
}

function deriveNoteTitleFromPath(p){
  try {
    const s = String(p || '').replace(/[\\]+/g, '/').trim()
    const base = (s.split('/').pop() || '').trim()
    if (!base) return ''
    return base.replace(/\.[^/.]+$/, '') || base
  } catch {}
  return ''
}

function buildKbRefsFromHits(hits){
  const arr = Array.isArray(hits) ? hits : []
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const h = arr[i] || {}
    const filePath = String(h.filePath || '').trim()
    const relative = String(h.relative || '').trim()
    const title = deriveNoteTitleFromPath(relative) || deriveNoteTitleFromPath(filePath) || (relative || filePath || '')
    out.push({
      n: i + 1,
      title,
      heading: String(h.heading || '').trim(),
      relative,
      filePath,
      startLine: Number(h.startLine || 0) || 0,
      endLine: Number(h.endLine || 0) || 0,
      score: (typeof h.score === 'number' && Number.isFinite(h.score)) ? h.score : null,
    })
  }
  return out
}

async function maybeInjectKnowledgeContext(context, cfg, userMsgs, finalMsgs, textOnlyMsgs){
  const kb = normalizeKbCfgForAi(cfg)
  if (!kb.enabled) return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }
  if (!context || typeof context.getPluginAPI !== 'function') return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }

  const query = getLastUserTextFromMsgs(userMsgs)
  if (!query) return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }

  const api = context.getPluginAPI('flymdRAG')
  if (!api || typeof api.search !== 'function') return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }

  try {
    if (typeof api.getConfig === 'function') {
      const vcfg = await api.getConfig()
      if (vcfg && vcfg.enabled === false) return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }
    }
  } catch {}

  let hits = []
  try {
    hits = await api.search(query, { topK: kb.topK })
  } catch (e) {
    console.warn('flymd-RAG 检索失败：', e)
    return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }
  }
  if (!hits || !hits.length) return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }

  const content = buildKnowledgeContextText(hits, kb.maxChars)
  if (!content) return { finalMsgs, textOnlyMsgs, injected: false, hits: [] }
  const sysMsg = { role: 'system', content }
  const inject = (arr) => {
    const a = Array.isArray(arr) ? arr : []
    if (!a.length) return [sysMsg]
    if (a[0] && a[0].role === 'system') return [a[0], sysMsg, ...a.slice(1)]
    return [sysMsg, ...a]
  }
  return { finalMsgs: inject(finalMsgs), textOnlyMsgs: inject(textOnlyMsgs), injected: true, hits }
}

// 带快捷操作的发送函数
async function sendFromInputWithAction(context){
  const pendingAction = __AI_PENDING_ACTION__
  if (pendingAction) {
    const ta = el('ai-text')
    const text = String((ta && ta.value) || '').trim()
    if (!text) return
    if (ta) ta.value = ''
    await handlePendingQuickActionInput(context, pendingAction, text)
    return
  }

  const actionSelect = el('ai-quick-action')
  const action = actionSelect ? String(actionSelect.value || '').trim() : ''

  if (action === '待办') {
    await promptPendingQuickAction(context, 'todo')
    return
  }
  if (action === '提醒') {
    await promptPendingQuickAction(context, 'reminder')
    return
  }

  if (action && ['续写', '润色', '纠错', '提纲'].includes(action)) {
    actionSelect.value = '' // 重置选择
    await quick(context, action)
    return
  }

  // Agent 模式：智能判断用户意图（对话 vs 修改）
  if (__AI_AGENT__ && __AI_AGENT__.enabled) {
    const ta = el('ai-text')
    const rawText = String((ta && ta.value) || '').trim()

    // 快捷前缀：强制指定模式
    if (rawText.startsWith('/问') || rawText.startsWith('/chat')) {
      // 强制普通对话模式
      ta.value = rawText.replace(/^\/[问chat]\s*/, '')
      await sendFromInput(context)
      return
    }

    if (rawText.startsWith('/修改') || rawText.startsWith('/edit')) {
      // 强制 Agent 修改模式
      ta.value = rawText.replace(/^\/[修改edit]\s*/, '')
      await sendFromInputAgent(context)
      return
    }

    // AI 智能判断用户意图
    try {
      const cfg = await ensureApiConfig(context)
      const intentPrompt = [
        {
          role: 'system',
          content: aiText(
            '你是意图判断助手。用户在使用文档编辑器，判断用户是想【修改文档】还是【普通对话】。\n\n' +
            '【修改文档】：用户明确要求修改、编辑、润色、删除、添加、翻译当前文档内容。\n' +
            '【普通对话】：用户在询问问题、请教方法、讨论内容，或只是包含修改相关词汇但不是要修改当前文档。\n\n' +
            '只回答 "edit" 或 "chat"，不要解释。',
            'You are an intent classifier. The user is in a document editor. Determine if they want to [edit document] or [normal chat].\n\n' +
            '[edit document]: User explicitly requests to modify, edit, polish, delete, add, or translate the current document content.\n' +
            '[normal chat]: User is asking questions, seeking advice, discussing content, or mentions edit-related words but not requesting to edit the current document.\n\n' +
            'Only reply "edit" or "chat", no explanation.'
          )
        },
        {
          role: 'user',
          content: rawText
        }
      ]

      const intentBody = {
        model: resolveModelId(cfg),
        messages: intentPrompt,
        stream: false,
        max_tokens: 10,
        temperature: 0
      }

      // 显示判断中提示
      const thinkingEl = DOC().createElement('div')
      thinkingEl.className = 'ai-msg ai-msg-assistant'
      thinkingEl.innerHTML = `<div class="ai-msg-content">${aiText('🤔 思考中...', '🤔 Think...')}</div>`
      const chatEl = el('ai-chat')
      if (chatEl) chatEl.appendChild(thinkingEl)
      chatEl?.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' })

      const intentRes = await performAIRequest(cfg, intentBody, context)
      const intent = String(intentRes && intentRes.text != null ? intentRes.text : '').trim().toLowerCase()

      // 移除判断提示
      if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl)

      if (intent.includes('edit')) {
        // AI 判断为修改意图 → Agent 修改模式
        await sendFromInputAgent(context)
      } else {
        // AI 判断为对话意图 → 普通对话
        await sendFromInput(context)
      }
    } catch (err) {
      // AI 判断失败，回退到关键词检测
      console.warn('AI 意图判断失败，使用关键词检测:', err)

      const editKeywords = [
        '修改', '改写', '改成', '改为', '更改', '替换', '调整', '变成',
        '润色', '优化', '美化', '精简', '扩写', '缩写', '改进', '提升',
        '删除', '去掉', '移除', '删掉', '拿掉',
        '添加', '加上', '插入', '增加',
        '格式化', '排版', '缩进', '对齐',
        '翻译', '译成', '译为',
        'modify', 'change', 'edit', 'rewrite', 'replace', 'update',
        'polish', 'optimize', 'improve', 'refine',
        'delete', 'remove', 'add', 'insert'
      ]

      const hasEditIntent = editKeywords.some(keyword => rawText.includes(keyword))

      if (hasEditIntent) {
        await sendFromInputAgent(context)
      } else {
        await sendFromInput(context)
      }
    }
    return
  }

  await sendFromInput(context)
}

  async function doSend(context){
    if (__AI_SENDING__) return
    const cfg = await loadCfg(context)
    const isFree = isFreeProvider(cfg)
    if (!cfg.apiKey && !isFree) { context.ui.notice(aiText('请先在“设置”中配置 OpenAI API Key', 'Please configure OpenAI API Key in Settings first'), 'err', 3000); return }
    if (!cfg.model && !isFree) { context.ui.notice(aiText('请先选择模型', 'Please choose a model first'), 'err', 2000); return }
    __AI_SENDING__ = true
    try {
      await ensureSessionForDoc(context)
      const oneShotCtx = consumeOneShotDocContext()
      const doc = String((oneShotCtx && oneShotCtx.text != null) ? oneShotCtx.text : (context.getEditorValue() || ''))
      const kbCfg = normalizeKbCfgForAi(cfg)
      const baseLimit = Number(cfg.limits?.maxCtxChars || DEFAULT_MAX_CTX_CHARS)
      // RAG 开启时给“知识库引用”留出空间，避免把上下文窗口撑爆
      const docLimit = kbCfg.enabled
        ? Math.max(1200, baseLimit - Math.min(4000, Number(kbCfg.maxChars || 2000)) - 600)
        : baseLimit
      const docCtx = clampCtx(doc, docLimit)

      // 添加当前时间上下文
      const now = new Date()
      const weekdays = aiGetLocale() === 'en'
        ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        : ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
      const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const weekday = weekdays[now.getDay()]
      const timeContext = aiGetLocale() === 'en'
        ? `Today is ${currentDate} ${weekday} ${currentTime}`
        : `今天是 ${currentDate} ${weekday} ${currentTime}`

      const system = aiGetLocale() === 'en'
        ? `You are a professional writing assistant. Answer concisely and practically, with suggestions that can be directly applied. Current time: ${timeContext}`
        : `你是专业的中文写作助手，回答要简洁、实用、可直接落地。当前时间：${timeContext}`
      const sessionMsgs = __AI_SESSION__.messages
      const sessionApiMsgs = (Array.isArray(sessionMsgs) ? sessionMsgs : [])
        .map(sanitizeChatMessageForAPI)
        .filter(Boolean)

      const visionOn = isVisionEnabledForConfig(cfg)
      let userMsg
      let visionBlocks = null
      let usedVision = false
      let downgradedFromVision = false
      if (visionOn) {
        try {
          const blocks = await buildVisionContentBlocks(context, docCtx)
          if (blocks && Array.isArray(blocks) && blocks.length && blocks.some(b => b && b.type === 'image_url')) {
            userMsg = { role: 'user', content: blocks }
            visionBlocks = blocks
            usedVision = true
          }
        } catch (e) {
          console.error('构造视觉上下文失败：', e)
        }
      }
      if (!userMsg) {
        const label = (oneShotCtx && oneShotCtx.label)
          ? String(oneShotCtx.label || '').trim()
          : '文档上下文'
        userMsg = { role: 'user', content: (label || '文档上下文') + '：\n\n' + docCtx }
      }

      let finalMsgs = [{ role: 'system', content: system }, userMsg]
      sessionApiMsgs.forEach(m => finalMsgs.push(m))

      // 纯文本降级版本：保留图片的文字说明，去掉 image_url 结构
      let textOnlyMsgs = finalMsgs
      if (usedVision && visionBlocks && Array.isArray(visionBlocks)) {
        try {
          const mergedText = visionBlocks.map(b => (b && b.type === 'text') ? String(b.text || '') : '').join('')
          const textUserMsg = { role: 'user', content: mergedText || ('文档上下文：\n\n' + docCtx) }
          textOnlyMsgs = [{ role: 'system', content: system }, textUserMsg]
          sessionApiMsgs.forEach(m => textOnlyMsgs.push(m))
        } catch {}
      }

      // RAG：可选追加知识库引用（默认关闭；未安装/未启用 flymd-RAG 时不影响现有行为）
      let kbRefs = []
      try {
        const r = await maybeInjectKnowledgeContext(context, cfg, sessionApiMsgs, finalMsgs, textOnlyMsgs)
        finalMsgs = r.finalMsgs
        textOnlyMsgs = r.textOnlyMsgs
        if (r && r.injected && r.hits && r.hits.length) {
          kbRefs = buildKbRefsFromHits(r.hits)
        }
      } catch (e) {
        console.warn('知识库联动失败：', e)
      }

      // 内容防滥用：在本地直接拒绝，不让请求打到模型侧
      const guardHit = aiGuardCheckMessages(cfg, finalMsgs)
      if (guardHit) {
        const refuse = aiText('检测到露骨色情/性暴力内容，AI 助手已拒绝处理。', 'Detected explicit sexual content. The AI assistant refused.')
        pushMsg('assistant', refuse)
        renderMsgs(el('ai-chat'))
        try { await syncCurrentSessionToDB(context) } catch {}
        return
      }

      const url = buildApiUrl(cfg)
      const modelId = resolveModelId(cfg)
      const headers = buildApiHeaders(cfg)

      const chatEl = el('ai-chat')

      // 显示思考中动画
      const thinkingWrapper = document.createElement('div')
      thinkingWrapper.className = 'msg-wrapper'
      thinkingWrapper.id = 'ai-thinking-indicator'
      const thinkingBubble = document.createElement('div')
      thinkingBubble.className = 'msg a ai-thinking'
      thinkingBubble.innerHTML = '<span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span>'
      thinkingWrapper.appendChild(thinkingBubble)
      chatEl.appendChild(thinkingWrapper)
      chatEl.scrollTop = chatEl.scrollHeight

      // 创建回复草稿元素（初始隐藏）
      const draft = document.createElement('div'); draft.className = 'msg a'; draft.textContent = ''; draft.style.display = 'none'
      chatEl.appendChild(draft)

      let finalText = ''
      // 移除思考中动画的辅助函数
      const removeThinking = () => {
        const indicator = el('ai-thinking-indicator')
        if (indicator) indicator.remove()
        draft.style.display = ''
      }

      if (isFree) {
        // 免费代理模式：直接走非流式一次性请求，由后端持有真实 Key
        let r = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: finalMsgs, stream: false }) })
        // 如果带图请求被拒绝且启用了视觉，则优先尝试将 HTTP 图片 URL 转为 base64 再重试，失败后再降级为纯文本
        if (usedVision && r && !r.ok && r.status >= 400) {
          let retriedWithBase64 = false
          try {
            const base64Msgs = await convertHttpImageUrlsToDataUrl(finalMsgs)
            if (base64Msgs) {
              retriedWithBase64 = true
              r = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: base64Msgs, stream: false }) })
            }
          } catch {}
          if (!retriedWithBase64 || (r && !r.ok && r.status >= 400)) {
            try {
              downgradedFromVision = true
              r = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: textOnlyMsgs, stream: false }) })
            } catch {}
          }
        }
        // 免费模型：如果最终仍然失败，则给出明确提示（包括速率限制等），并退出
        if (!r || !r.ok) {
          removeThinking()
          await handleFreeApiError(context, r)
          return
        }
        removeThinking()
        const text = await r.text()
        const data = _aiTryParseJsonLoose(text)
        finalText = data?.choices?.[0]?.message?.content || ''
        draft.textContent = finalText
      } else {
        // 首选用原生 fetch 进行流式解析（SSE）
        const body = JSON.stringify({ model: modelId, messages: finalMsgs, stream: true })
        let firstChunkReceived = false
        try {
          const r2 = await fetchWithRetry(url, { method: 'POST', headers, body })
          if (!r2.ok || !r2.body) { throw new Error('HTTP ' + r2.status) }
          const reader = r2.body.getReader()
          const decoder = new TextDecoder('utf-8')
          let buf = ''
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const parts = buf.split('\n\n')
            buf = parts.pop() || ''
            for (const p of parts) {
              const line = p.trim()
              if (!line) continue
              const rows = line.split('\n').filter(Boolean)
              for (const row of rows) {
                const m = row.match(/^data:\s*(.*)$/)
                if (!m) continue
                const payload = m[1]
                if (payload === '[DONE]') continue
                try {
                  const j = JSON.parse(payload)
                  const delta = j?.choices?.[0]?.delta?.content || ''
                  if (delta) {
                    // 收到第一个内容时移除思考中动画
                    if (!firstChunkReceived) {
                      firstChunkReceived = true
                      removeThinking()
                    }
                    finalText += delta; draft.textContent = finalText; chatEl.scrollTop = chatEl.scrollHeight
                  }
                } catch {}
              }
            }
          }
        } catch (e) {
          // 流式失败兜底：先尝试非流式带图请求，再视情况降级为纯文本
          try {
            let r3 = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: finalMsgs, stream: false }) })
            if (usedVision && r3 && !r3.ok && r3.status >= 400 && r3.status < 500) {
              try {
                downgradedFromVision = true
                r3 = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: textOnlyMsgs, stream: false }) })
              } catch {}
            }
            removeThinking()
            const text = await r3.text()
            const data = _aiTryParseJsonLoose(text)
            const ctt = data?.choices?.[0]?.message?.content || ''
            finalText = ctt
            draft.textContent = finalText
          } catch (e2) {
            removeThinking() // 确保错误时也移除
            throw e2
          }
        }
      }

      __AI_LAST_REPLY__ = finalText || ''
      pushMsg('assistant', __AI_LAST_REPLY__ || '[空响应]', kbRefs && kbRefs.length ? { kbRefs } : null)
      renderMsgs(el('ai-chat'))
      // 同步会话库：写回当前文档的 active 会话
      try {
        await syncCurrentSessionToDB(context)
      } catch {}
      try { await maybeNameCurrentSession(context, cfg, finalText) } catch {}
      try { const elw = el('ai-assist-win'); if (elw) autoFitWindow(context, elw) } catch {}
      // 若发生视觉降级，提示用户考虑开启图床以获得稳定的视觉能力
      if (downgradedFromVision) {
        try {
          if (context && context.ui && typeof context.ui.notice === 'function') {
            context.ui.notice('未开启视觉或模型不支持，已降级为文字描述。纯本地图片可能会因过大引起此报错，建议开启图床功能获得更加体验。', 'warn', 4200)
          }
        } catch {}
      }
    } catch (e) {
      console.error(e)
      context.ui.notice('AI 调用失败：' + (e && e.message ? e.message : '未知错误'), 'err', 4000)
    } finally {
      __AI_SENDING__ = false
      // 每次请求结束后清空待发送图片
      __AI_PENDING_IMAGES__ = []
      updateVisionAttachmentIndicator()
    }
  }

async function applyLastToDoc(context){
  const s = String(__AI_LAST_REPLY__||'').trim()
  if (!s) { context.ui.notice(aiText('没有可插入的内容', 'No content to insert'), 'err', 2000); return }
  const cur = String(context.getEditorValue() || '')
  const next = cur + (cur.endsWith('\n')?'':'\n') + '\n' + s + '\n'
  context.setEditorValue(next)
  context.ui.notice(aiText('已插入文末', 'Inserted at document end'), 'ok', 1600)
}

async function applyLastAtCursor(context){
  const s = String(__AI_LAST_REPLY__||'').trim()
  if (!s) { context.ui.notice(aiText('没有可插入的内容', 'No content to insert'), 'err', 2000); return }
  try { await context.insertAtCursor('\n' + s + '\n') } catch { try { const cur = String(context.getEditorValue()||''); context.setEditorValue(cur + (cur.endsWith('\n')?'':'\n') + s + '\n') } catch {} }
  context.ui.notice(aiText('已在光标处插入', 'Inserted at cursor'), 'ok', 1400)
}

async function replaceSelectionWithLast(context){
  const s = String(__AI_LAST_REPLY__||'').trim()
  if (!s) { context.ui.notice(aiText('没有可插入的内容', 'No content to insert'), 'err', 2000); return }
  try {
    const sel = await context.getSelection?.()
    if (sel && sel.end > sel.start) { await context.replaceRange(sel.start, sel.end, s) ; context.ui.notice(aiText('已替换选区', 'Selection replaced'), 'ok', 1400); return }
  } catch {}
  context.ui.notice(aiText('没有选区，已改为光标处插入', 'No selection, inserted at cursor'), 'ok', 1400)
  await applyLastAtCursor(context)
}

function copyLast(){ try { const s = String(__AI_LAST_REPLY__||''); if(!s) return; navigator.clipboard?.writeText(s) } catch {} }

export async function openSettings(context){
  ensureCss()
  const cfg = await loadCfg(context)
  let overlay = document.getElementById('ai-set-overlay')
  if (overlay) { overlay.remove() }
  overlay = document.createElement('div')
  overlay.id = 'ai-set-overlay'
  overlay.innerHTML = [
    '<div id="ai-set-dialog">',
    ' <div id="ai-set-head"><div id="ai-set-title">' + aiText('AI 设置', 'AI Settings') + '</div><button id="ai-set-close" title="' + aiText('关闭', 'Close') + '">×</button></div>',
    ' <div id="ai-set-body">',
    '  <div class="set-row mode-row"><label>' + aiText('模式', 'Mode') + '</label><span class="mode-label" id="mode-label-custom">' + aiText('自定义', 'Custom') + '</span><label class="toggle-switch"><input type="checkbox" id="set-provider-toggle"/><span class="toggle-slider"></span></label><span class="mode-label" id="mode-label-free">' + aiText('免费模型', 'Free model') + '</span></div>',
    '  <div class="set-row mode-row"><label>' + aiText('翻译免费', 'Free translation') + '</label><span style="font-size:12px;color:#6b7280;">' + aiText('翻译功能始终使用免费模型', 'Always use free model for translation') + '</span><label class="toggle-switch"><input type="checkbox" id="set-trans-free-toggle"/><span class="toggle-slider"></span></label></div>',
    '  <div class="free-warning" id="free-warning">' + aiText('免费模型由硅基流动提供，', 'Free models are provided by SiliconFlow, ') + '<a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">' + aiText('推荐注册硅基流动账号获得顶级模型体验', 'we recommend registering a SiliconFlow account for top-tier models') + '</a></div>',
    '  <div class="set-row custom-only"><label>Base URL</label><select id="set-base-select"><option value="https://api.siliconflow.cn/v1">' + aiText('硅基流动', 'SiliconFlow') + '</option><option value="https://api.openai.com/v1">OpenAI</option><option value="https://apic1.ohmycdn.com/api/v1/ai/openai/cc-omg/v1">' + aiText('OMG资源包', 'OMG pack') + '</option><option value="custom">' + aiText('自定义', 'Custom') + '</option></select><input id="set-base" type="text" placeholder="https://api.siliconflow.cn/v1（或完整 …/chat/completions）"/></div>',
    '  <div class="set-row custom-only"><label>API Key</label><input id="set-key" type="password" placeholder="sk-..."/></div>',
    '  <div class="set-row custom-only"><label>' + aiText('模型', 'Model') + '</label><input id="set-model" type="text" placeholder="gpt-4o-mini"/></div>',
    '  <div class="set-row"><label>' + aiText('侧栏宽度(px)', 'Sidebar width (px)') + '</label><input id="set-sidew" type="number" min="400" step="10" placeholder="400"/></div>',
    '  <div class="set-row"><label>' + aiText('上下文截断', 'Context limit') + '</label><input id="set-max" type="number" min="1000" step="500" placeholder="' + DEFAULT_MAX_CTX_CHARS + '"/></div>',
    '  <div class="set-row"><label>' + aiText('知识库(RAG)', 'Knowledge (RAG)') + '</label><label class="toggle-switch"><input type="checkbox" id="set-kb-enabled"/><span class="toggle-slider"></span></label></div>',
    '  <div class="set-row"><label>TopK</label><input id="set-kb-topk" type="number" min="1" max="20" step="1" placeholder="5"/></div>',
    '  <div class="set-row"><label>' + aiText('引用字数', 'Max chars') + '</label><input id="set-kb-maxchars" type="number" min="200" step="200" placeholder="2000"/></div>',
    '  <div class="set-row"><span style="font-size:12px;color:#6b7280;line-height:1.4;">' + aiText('开启后会在发送前调用 flymd-RAG 检索并追加引用上下文；未安装/未启用 flymd-RAG 时不影响现有行为。', 'When enabled, AI Assistant will call flymd-RAG search before sending and append cited context; if flymd-RAG is not installed/enabled, behavior stays unchanged.') + '</span></div>',
    '  <div class="set-row set-link-row custom-only"><a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer">' + aiText('点此注册硅基流动得2000万免费Token', 'Click to register at SiliconFlow to get 20M free tokens') + '</a></div>',
    '  <div class="set-row set-link-row custom-only"><a href="https://x.dogenet.win/i/dXCKvZ6Q" target="_blank" rel="noopener noreferrer">' + aiText('点此注册OMG获得20美元Claude资源包', 'Click to register OMG to get 20 USD Claude credits') + '</a></div>',
    '  <div class="powered-by-img" id="powered-by-container" style="display:none;text-align:center;margin:12px 0 4px 0;"><a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer" style="border:none;outline:none;"><img id="powered-by-img" src="" alt="Powered by" style="max-width:180px;height:auto;cursor:pointer;border:none;outline:none;"/></a></div>',
    ' </div>',
    ' <div id="ai-set-actions"><button id="ai-set-cancel">' + aiText('取消', 'Cancel') + '</button><button class="primary" id="ai-set-ok">' + aiText('保存', 'Save') + '</button></div>',
    '</div>'
  ].join('')
  // 检查 AI 窗口是否存在且可见
  const aiWin = document.getElementById('ai-assist-win')
  const isWinVisible = aiWin && window.getComputedStyle(aiWin).display !== 'none'
  const host = isWinVisible ? aiWin : document.body
  host.appendChild(overlay)
  // 若挂到 body：用固定定位覆盖全局
  if (host === document.body) {
    try { overlay.style.position = 'fixed'; overlay.style.inset = '0'; overlay.style.zIndex = '100000' } catch {}
  }
  // 赋初值
  const elProviderToggle = overlay.querySelector('#set-provider-toggle')
  const elTransFreeToggle = overlay.querySelector('#set-trans-free-toggle')
  const elBase = overlay.querySelector('#set-base')
  const elBaseSel = overlay.querySelector('#set-base-select')
  const elKey = overlay.querySelector('#set-key')
  const elModel = overlay.querySelector('#set-model')
  const elMax = overlay.querySelector('#set-max')
  const elSideW = overlay.querySelector('#set-sidew')
  const elKbEnabled = overlay.querySelector('#set-kb-enabled')
  const elKbTopK = overlay.querySelector('#set-kb-topk')
  const elKbMaxChars = overlay.querySelector('#set-kb-maxchars')
  const elFreeWarning = overlay.querySelector('#free-warning')
  const elCustomOnlyRows = overlay.querySelectorAll('.custom-only')
  const elModeLabelCustom = overlay.querySelector('#mode-label-custom')
  const elModeLabelFree = overlay.querySelector('#mode-label-free')
  const FREE_PROXY_URL = 'https://flymd.llingfei.com/ai/ai_proxy.php'
  if (elProviderToggle) elProviderToggle.checked = cfg.provider === 'free'
  if (elTransFreeToggle) elTransFreeToggle.checked = !!cfg.alwaysUseFreeTrans
  // 始终显示用户保存的自定义配置值（不因免费模式而清空）
  elBase.value = cfg.baseUrl || 'https://api.siliconflow.cn/v1'
  elKey.value = cfg.apiKey || ''
  elModel.value = cfg.model || 'gpt-4o-mini'
  elMax.value = String((cfg.limits?.maxCtxChars) || DEFAULT_MAX_CTX_CHARS)
  elSideW.value = String((cfg.win?.w) || MIN_WIDTH)
  if (elKbEnabled) elKbEnabled.checked = !!(cfg.kb && cfg.kb.enabled)
  if (elKbTopK) elKbTopK.value = String((cfg.kb && cfg.kb.topK) || 5)
  if (elKbMaxChars) elKbMaxChars.value = String((cfg.kb && cfg.kb.maxChars) || 2000)
  if (elBaseSel) {
    const cur = String(cfg.baseUrl || '').trim()
    if (!cur || cur === 'https://api.siliconflow.cn/v1') elBaseSel.value = 'https://api.siliconflow.cn/v1'
    else if (cur === 'https://api.openai.com/v1') elBaseSel.value = 'https://api.openai.com/v1'
    else if (cur === 'https://apic1.ohmycdn.com/api/v1/ai/openai/cc-omg/v1') elBaseSel.value = 'https://apic1.ohmycdn.com/api/v1/ai/openai/cc-omg/v1'
    else elBaseSel.value = 'custom'
      elBaseSel.addEventListener('change', () => {
        const val = elBaseSel.value
        if (val && val !== 'custom') elBase.value = val
      })
  }
  const applyProviderUI = () => {
    const isFree = elProviderToggle && elProviderToggle.checked
    // 控制自定义设置行的显示/隐藏
    elCustomOnlyRows.forEach(row => {
      row.style.display = isFree ? 'none' : 'flex'
    })
    // 控制警告文字的显示/隐藏
    if (elFreeWarning) {
      elFreeWarning.style.display = isFree ? 'block' : 'none'
    }
    // 控制模式标签的高亮
    if (elModeLabelCustom) {
      elModeLabelCustom.classList.toggle('active', !isFree)
    }
    if (elModeLabelFree) {
      elModeLabelFree.classList.toggle('active', isFree)
    }
    // 控制 Powered by 图片的显示/隐藏（仅在免费模式下显示）
    const elPoweredByContainer = overlay.querySelector('#powered-by-container')
    const elPoweredByImg = overlay.querySelector('#powered-by-img')
    if (elPoweredByContainer && elPoweredByImg) {
      elPoweredByContainer.style.display = isFree ? 'block' : 'none'
      if (isFree) {
        // 根据主题选择图片：检查主窗口是否有 dark 类
        const mainWin = document.getElementById('ai-assist-win')
        let isDark = false
        if (mainWin && mainWin.classList.contains('dark')) {
          isDark = true
        } else {
          try {
            const mainBody = WIN().document.body
            isDark = mainBody && mainBody.classList.contains('dark-mode')
          } catch {}
          if (!isDark) {
            isDark = !!(WIN().matchMedia && WIN().matchMedia('(prefers-color-scheme: dark)').matches)
          }
        }
        elPoweredByImg.src = resolvePluginAsset(isDark ? 'Powered-by-dark.png' : 'Powered-by-light.png')
      }
    }
  }
  if (elProviderToggle) {
    applyProviderUI()
    elProviderToggle.addEventListener('change', applyProviderUI)
  }
  // 交互
  const close = () => { try { overlay.remove() } catch {} }
  overlay.querySelector('#ai-set-close')?.addEventListener('click', close)
  overlay.querySelector('#ai-set-cancel')?.addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  WIN().addEventListener('keydown', function onEsc(e){ if (e.key === 'Escape') { close(); WIN().removeEventListener('keydown', onEsc) } })
  overlay.querySelector('#ai-set-ok')?.addEventListener('click', async () => {
    const provider = elProviderToggle && elProviderToggle.checked ? 'free' : 'openai'
    const alwaysUseFreeTrans = elTransFreeToggle && elTransFreeToggle.checked
    // 始终保存用户输入的自定义配置值，不因免费模式而清空
    const baseUrl = String(elBase.value || '').trim() || 'https://api.siliconflow.cn/v1'
    const apiKey = String(elKey.value || '').trim()
    const model = String(elModel.value || '').trim() || 'gpt-4o-mini'
    const n = Math.max(1000, parseInt(String(elMax.value || DEFAULT_MAX_CTX_CHARS),10) || DEFAULT_MAX_CTX_CHARS)
    const sidew = Math.max(MIN_WIDTH, parseInt(String(elSideW.value || MIN_WIDTH),10) || MIN_WIDTH)
    const kbEnabled = !!(elKbEnabled && elKbEnabled.checked)
    const kbTopK = Math.max(1, Math.min(20, parseInt(String((elKbTopK && elKbTopK.value) || '5'), 10) || 5))
    const kbMaxChars = Math.max(200, Math.min(8000, parseInt(String((elKbMaxChars && elKbMaxChars.value) || '2000'), 10) || 2000))
    const next = { ...cfg, provider, alwaysUseFreeTrans, baseUrl, apiKey, model, limits: { maxCtxChars: n }, kb: { ...(cfg.kb || {}), enabled: kbEnabled, topK: kbTopK, maxChars: kbMaxChars }, win: { ...(cfg.win||{}), w: sidew, x: cfg.win?.x||60, y: cfg.win?.y||60, h: cfg.win?.h||440 } }
    await saveCfg(context, next)
    const m = el('ai-model'); if (m) m.value = model
    context.ui.notice(aiText('设置已保存', 'Settings saved'), 'ok', 1600)
    try {
      const pane = el('ai-assist-win')
      if (pane) {
        const dockSide = pane.classList.contains('dock-left') ? 'left' : (pane.classList.contains('dock-right') ? 'right' : false)
        if (dockSide) {
          pane.style.width = sidew + 'px'
          setDockPush(dockSide, sidew)
        }
      }
    } catch {}
    // 刷新界面显示（免费模式切换等）
    await refreshHeader(context)
    close()
  })
}

// ========== 插件主入口 ==========
export async function activate(context) {
  // 保存 context 供消息操作按钮使用
  __AI_CONTEXT__ = context
  // 预加载配置（在注册菜单前，以便 condition 能正确读取免费模式状态）
  try { const cfg = await loadCfg(context); await saveCfg(context, cfg) } catch {}
  try { __AI_SESSION__ = await loadSession(context) } catch {}

  // 菜单：AI 助手（显示/隐藏）
  __AI_MENU_ITEM__ = context.addMenuItem({
    label: aiText('AI 助手', 'AI Assistant'),
    title: aiText('打开 AI 写作助手', 'Open AI Assistant'),
    onClick: async () => { await toggleWindow(context) }
  })

  // 订阅宿主工作区布局变更（库侧栏开关等），保持 dock 模式下的位置与宽度同步
  try {
    const winObj = WIN()
    const prev = winObj.__onWorkspaceLayoutChanged
    const handler = () => { try { syncDockedWindowWithWorkspace() } catch {} }
    if (typeof prev === 'function') {
      winObj.__onWorkspaceLayoutChanged = () => { try { prev() } catch {} ; handler() }
      __AI_LAYOUT_UNSUB__ = () => { try { winObj.__onWorkspaceLayoutChanged = prev } catch {} }
    } else {
      winObj.__onWorkspaceLayoutChanged = handler
      __AI_LAYOUT_UNSUB__ = () => { try { if (winObj.__onWorkspaceLayoutChanged === handler) winObj.__onWorkspaceLayoutChanged = null } catch {} }
    }
  } catch {}

  // 监听宿主窗口/工作区变化，避免停靠窗口“只在点菜单后才刷新”的问题
  try { bindAutoDockSync(); scheduleDockedWindowSync() } catch {}

  // 右键菜单：AI 助手快捷操作
  if (context.addContextMenuItem) {
    try {
      const disposers = []

      // 一级菜单：咨询（尽量排在最前）
      try {
        const d0 = context.addContextMenuItem({
          label: aiText('问AI', 'Consult'),
          icon: '💡',
          onClick: async (ctx) => {
            try { openConsultInputOverlay(context, ctx) } catch {}
          }
        })
        if (typeof d0 === 'function') disposers.push(d0)
      } catch {}

      const d1 = context.addContextMenuItem({
        label: aiText('AI 助手', 'AI Assistant'),
        icon: '🤖',
        children: [
          {
            label: aiText('打开 AI 助手', 'Open AI Assistant'),
            icon: '💬',
            onClick: async () => {
              await toggleWindow(context)
            }
          },
          { type: 'divider' },
          {
            type: 'group',
            label: aiText('快捷操作', 'Quick actions')
          },
          {
            label: aiText('续写', 'Continue writing'),
            icon: '✍️',
            onClick: async (ctx) => {
              const selectedText = snapshotSelectedTextFromCtx(ctx)
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '续写', { ctx, selectedText })
            }
          },
          {
            label: aiText('润色', 'Polish'),
            icon: '✨',
            onClick: async (ctx) => {
              const selectedText = snapshotSelectedTextFromCtx(ctx)
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '润色', { ctx, selectedText })
            }
          },
          {
            label: aiText('纠错', 'Correct'),
            icon: '✅',
            onClick: async (ctx) => {
              const selectedText = snapshotSelectedTextFromCtx(ctx)
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '纠错', { ctx, selectedText })
            }
          },
          {
            label: aiText('提纲', 'Outline'),
            icon: '📋',
            onClick: async (ctx) => {
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '提纲', { ctx })
            }
          },
          {
            label: aiText('解疑', 'Explain'),
            icon: '❓',
            onClick: async (ctx) => {
              const selectedText = snapshotSelectedTextFromCtx(ctx)
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '解疑', { ctx, selectedText })
            }
          },
          {
            label: aiText('待办', 'Todo'),
            icon: '📝',
            children: [
              {
                label: aiText('生成待办', 'Generate todos'),
                onClick: async () => {
                  await generateTodos(context)
                }
              },
              {
                label: aiText('生成并创建提醒', 'Generate and create reminders'),
                onClick: async () => {
                  await generateTodosAndPush(context)
                }
              },
              {
                label: aiText('生成 TODO 便签', 'Generate TODO sticky note'),
                onClick: async (ctx) => {
                  // 1. 取文本：选区优先，其次整篇文档
                  let selectionInfo = null
                  let hasSelection = false
                  try {
                    selectionInfo = await context.getSelection?.()
                    if (selectionInfo && selectionInfo.text && selectionInfo.text.trim()) {
                      hasSelection = true
                    }
                  } catch {}
                  const content = hasSelection
                    ? String(selectionInfo.text || '').trim()
                    : String(context.getEditorValue() || '').trim()
                  if (!content) {
                    context.ui.notice(hasSelection ? aiText('选中内容为空', 'Selected content is empty') : aiText('文档内容为空', 'Document content is empty'), 'err', 2000)
                    return
                  }

                  await createTodoStickyFromContent(
                    context,
                    content,
                    ctx && typeof ctx === 'object' ? ctx : null
                  )
                }
              }
            ]
          },
          {
            label: aiText('翻译', 'Translate'),
            icon: '🌐',
            onClick: async () => {
              await translateText(context)
            }
          },
          { type: 'divider' },
          {
            label: 'Powered by SiliconFlow',
            icon: '⚡',
            condition: () => __AI_IS_FREE_MODE__,
            onClick: () => {
              window.open('https://cloud.siliconflow.cn/i/X96CT74a', '_blank')
            }
          }
        ]
      })
      if (typeof d1 === 'function') disposers.push(d1)
      __AI_CTX_MENU_DISPOSER__ = () => {
        disposers.forEach(fn => { try { if (typeof fn === 'function') fn() } catch {} })
      }
    } catch (e) {
      console.error('AI 助手右键菜单注册失败：', e)
    }
  }

  try {
    context.registerAPI('ai-assistant', {
      callAI: (prompt, options = {}) => callAIForPlugins(context, prompt, options),
      translate: (text) => translateForPlugins(context, text),
      quickAction: (content, action) => quickActionForPlugins(context, content, action),
      generateTodos: (content) => generateTodosForPlugins(context, content),
      isConfigured: () => isAIConfiguredForPlugins(context),
      getConfig: () => getAIConfigSnapshot(context)
    })
  } catch (e) {
    console.error('AI 助手 API 注册失败：', e)
  }
}

export function deactivate(){
  // 清理菜单项
  try {
    if (__AI_MENU_ITEM__ && typeof __AI_MENU_ITEM__ === 'function') {
      __AI_MENU_ITEM__()
    }
  } catch {}
  // 清理右键菜单
  try {
    if (__AI_CTX_MENU_DISPOSER__ && typeof __AI_CTX_MENU_DISPOSER__ === 'function') {
      __AI_CTX_MENU_DISPOSER__()
    }
  } catch {}
  // 清理防抖定时器
  try {
    if (__AI_FN_DEBOUNCE_TIMER__) {
      clearTimeout(__AI_FN_DEBOUNCE_TIMER__)
      __AI_FN_DEBOUNCE_TIMER__ = null
    }
  } catch {}
  // 取消布局变更订阅
  try {
    if (__AI_LAYOUT_UNSUB__ && typeof __AI_LAYOUT_UNSUB__ === 'function') {
      __AI_LAYOUT_UNSUB__()
    }
  } catch {}
  __AI_LAYOUT_UNSUB__ = null
  // 取消 dock 自动同步监听
  try {
    if (__AI_DOCK_SYNC_CLEANUP__ && typeof __AI_DOCK_SYNC_CLEANUP__ === 'function') {
      __AI_DOCK_SYNC_CLEANUP__()
    }
  } catch {}
  __AI_DOCK_SYNC_CLEANUP__ = null
  // 清理窗口
  try {
    const win = DOC().getElementById('ai-assist-win')
    if (win) {
      setDockPush(false) // 恢复编辑区域
      win.remove()
    }
  } catch {}
  // 清理布局句柄
  try {
    if (__AI_DOCK_PANEL__ && typeof __AI_DOCK_PANEL__.dispose === 'function') {
      __AI_DOCK_PANEL__.dispose()
    }
  } catch {}
  __AI_DOCK_PANEL__ = null
  // 清理样式
  try {
    const style = DOC().getElementById('ai-assist-style')
    if (style) style.remove()
  } catch {}
  // 重置全局状态
  __AI_MENU_ITEM__ = null
  __AI_CTX_MENU_DISPOSER__ = null
  __AI_SESSION__ = { id: '', name: '默认会话', messages: [], docHash: '', docTitle: '' }
  __AI_DB__ = null
  __AI_SENDING__ = false
  __AI_LAST_REPLY__ = ''
  __AI_TOGGLE_LOCK__ = false
  __AI_MQ_BOUND__ = false
  __AI_LAST_DOC_HASH__ = ''
  __AI_FN_DEBOUNCE_TIMER__ = null
  __AI_CONTEXT__ = null
}

// 独立窗口入口：直接挂载 AI 浮窗
export async function standalone(context){
  try { await mountWindow(context); await refreshHeader(context) } catch (e) { console.error('standalone 启动失败', e) }
}

// ========== 其它动作 ==========
async function clearConversation(context) {
  try {
    await ensureSessionForDoc(context)
    __AI_SESSION__.messages = []
    // 同步到 DB
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const it = bucket.items.find(x => x.id === bucket.activeId)
    if (it) { it.messages = [] ; it.updated = Date.now() }
    await saveSessionsDB(context)
    const chat = el('ai-chat'); if (chat) renderMsgs(chat)
    context.ui.notice(aiText('会话已清空（仅当前文档）', 'Conversation cleared (current document only)'), 'ok', 1400)
  } catch {}
}

// 应用/切换主题：容器挂 .dark 类，配置持久化
async function applyWinTheme(context, rootEl){
  try{
    const cfg = await loadCfg(context)
    const mode = cfg.theme || 'auto'
    let isDark = false

    // 优先检查主应用的主题状态
    try {
      const mainBody = WIN().document.body
      if (mainBody && mainBody.classList.contains('dark-mode')) {
        // 主应用是夜间模式，AI 助手跟随
        isDark = true
      } else {
        // 主应用是日间模式，根据 AI 助手自己的配置
        if (mode === 'dark') isDark = true
        else if (mode === 'light') isDark = false
        else if (mode === 'auto') {
          isDark = !!(WIN().matchMedia && WIN().matchMedia('(prefers-color-scheme: dark)').matches)
        }
      }
    } catch {
      // 无法检测主应用，使用 AI 助手自己的配置
      if (mode === 'dark') isDark = true
      else if (mode === 'light') isDark = false
      else if (mode === 'auto') {
        isDark = !!(WIN().matchMedia && WIN().matchMedia('(prefers-color-scheme: dark)').matches)
      }
    }

    if (isDark) rootEl.classList.add('dark'); else rootEl.classList.remove('dark')
    // 更新更多菜单中的主题文本
    const menuTheme = rootEl.querySelector('#ai-menu-theme')
    if (menuTheme) menuTheme.textContent = isDark ? '日间模式' : '夜间模式'
    // 主题变化时刷新头部展示（包含免费模型徽标/薄荷公益文案）
    try { await refreshHeader(context) } catch {}
    if (!__AI_MQ_BOUND__){
      try {
        // 监听主应用的夜间模式切换事件（始终监听）
        WIN().addEventListener('flymd:darkmode:changed', () => {
          try { applyWinTheme(context, rootEl) } catch {}
        })
        // 监听系统主题偏好变化
        if (WIN().matchMedia) {
          const mq = WIN().matchMedia('(prefers-color-scheme: dark)')
          mq.addEventListener('change', () => { try { applyWinTheme(context, rootEl) } catch {} })
        }
        __AI_MQ_BOUND__ = true
      } catch {}
    }
  } catch {}
}

async function toggleTheme(context, rootEl){
  try{
    const isDark = rootEl.classList.contains('dark')
    const cfg = await loadCfg(context)
    cfg.theme = isDark ? 'light' : 'dark'
    await saveCfg(context, cfg)
    await applyWinTheme(context, rootEl)
  } catch {}
}

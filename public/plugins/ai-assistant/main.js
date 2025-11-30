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
  glm: { label: 'GLM', id: 'THUDM/glm-4-9b-chat' }
}
const DEFAULT_FREE_MODEL_KEY = 'qwen'

const DEFAULT_CFG = {
  provider: 'free', // 默认使用免费模式
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  visionEnabled: false, // 视觉模式（默认关闭）
  win: { x: 60, y: 60, w: 400, h: 440 },
  dock: 'left', // 'left'=左侧停靠；'right'=右侧停靠；false=浮动窗口
  limits: { maxCtxChars: 6000 },
  theme: 'auto',
  freeModel: DEFAULT_FREE_MODEL_KEY,
  alwaysUseFreeTrans: false // 翻译功能始终使用免费模型
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
let __AI_MD__ = null // Markdown 渲染器实例
let __AI_HLJS__ = null // highlight.js 实例
let __AI_MD_WARNED__ = false // Markdown 渲染失败仅提示一次

// ========== 工具函数 ==========
async function loadCfg(context) {
  try {
    const s = await context.storage.get(CFG_KEY)
    const cfg = { ...DEFAULT_CFG, ...(s || {}) }
    // 兼容旧配置：将 dock: true 转换为 'left'
    if (cfg.dock === true) cfg.dock = 'left'
    cfg.freeModel = normalizeFreeModelKey(cfg.freeModel)
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

// Markdown 渲染器（动态加载 markdown-it + highlight.js）
async function ensureMarkdownRenderer() {
  if (__AI_MD__) return __AI_MD__
  try {
    const [{ default: MarkdownIt }, hljs] = await Promise.all([
      import('markdown-it'),
      import('highlight.js')
    ])
    __AI_HLJS__ = hljs.default
    __AI_MD__ = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      highlight(code, lang) {
        if (lang && __AI_HLJS__.getLanguage(lang)) {
          try {
            return __AI_HLJS__.highlight(code, { language: lang, ignoreIllegals: true }).value
          } catch {}
        }
        // 转义 HTML 字符
        return code.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch] || ch))
      }
    })
    return __AI_MD__
  } catch (e) {
    if (!__AI_MD_WARNED__) {
      __AI_MD_WARNED__ = true
      try { console.warn('[AI助手] Markdown 渲染器加载失败，将降级为纯文本显示') } catch {}
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

// 网络请求重试机制（支持 429 限流和 5xx 服务器错误自动重试）
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options)
      // 429 限流 - 等待后重试
      if (res.status === 429) {
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 10000)
        console.warn(`[AI助手] 请求被限流(429)，${waitMs}ms 后重试...`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
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
  return base.replace(/\/$/, '') + '/chat/completions'
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
  return merged
}

async function ensureApiConfig(context, overrides = {}){
  const baseCfg = await loadCfg(context)
  const finalCfg = overrides ? mergeConfig(baseCfg, overrides) : baseCfg
  const isFree = isFreeProvider(finalCfg)
  if (!finalCfg.apiKey && !isFree) throw new Error('AI Key 未配置')
  return finalCfg
}

async function performAIRequest(cfg, bodyObj){
  const url = buildApiUrl(cfg)
  const headers = buildApiHeaders(cfg)
  const response = await fetch(url, { method:'POST', headers, body: JSON.stringify(bodyObj) })
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
  if (isFreeProvider(cfg)) return false
  return !!cfg.visionEnabled
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
  const result = await performAIRequest(cfg, body)
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
  const result = await performAIRequest(finalCfg, body)
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
  const result = await performAIRequest(cfg, body)
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
    '.msg-wrapper{display:flex;margin:8px 0;max-width:88%;gap:8px}',
    '.msg-wrapper:has(.msg.u){margin-left:auto;flex-direction:row-reverse}',
    '.msg-wrapper:has(.msg.a){margin-right:auto;flex-direction:row}',
    '.msg-wrapper .ai-avatar{width:36px;height:36px;border-radius:50%;flex-shrink:0;object-fit:cover;box-shadow:0 2px 8px rgba(0,0,0,0.1)}',
    '.msg-wrapper .msg-content-wrapper{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}',
    '.msg-wrapper .ai-nickname{font-size:12px;color:#6b7280;padding-left:4px}',
    '.msg{white-space:pre-wrap;line-height:1.55;border-radius:16px;padding:12px 14px;box-shadow:0 6px 16px rgba(15,23,42,.08);position:relative;font-size:14px;max-width:100%;word-wrap:break-word}',
    '.msg.u{background:linear-gradient(135deg,#e0f2ff,#f0f7ff);border:1px solid rgba(59,130,246,.3)}',
    '.msg.a{background:#fefefe;border:1px solid #e5e7eb}',
    '.msg.u::before{content:"";display:none}',
    '.msg.a::before{content:"";display:none}',
    '.msg-actions{display:flex;gap:12px;margin-top:8px;flex-wrap:wrap}',
    '.msg-action-btn{padding:0;border:none;background:none;color:#64748b;font-size:12px;cursor:pointer;text-decoration:none;transition:color .2s}',
    '.msg-action-btn:hover{color:#0f172a;text-decoration:underline}',
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
    '#ai-assist-win.dark #ai-set-dialog{background:#0f172a;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-set-head{background:#111827;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-set-title{color:#e5e7eb}',
    '#ai-assist-win.dark #ai-set-head button{background:#1f2937;border-color:#374151;color:#e5e7eb}',
    '#ai-assist-win.dark #ai-set-body{color:#e5e7eb}',
    '#ai-assist-win.dark .set-row label{color:#9ca3af}',
    '#ai-assist-win.dark .set-row input{background:#0b1220;border-color:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark .set-row select{background:#0b1220;border-color:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark .free-warning{background:#78350f;border-color:#d97706;color:#fef3c7}',
    '#ai-assist-win.dark #ai-set-actions{background:#111827;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-set-actions button{background:#1f2937;border-color:#374151;color:#e5e7eb}',
    '#ai-assist-win.dark #ai-set-actions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
    '#ai-assist-win.dark #ai-set-actions button:hover{background:#374151}',
    '#ai-assist-win.dark #ai-set-actions button.primary:hover{background:#1d4ed8}',
    // 暗黑模式样式
    '#ai-assist-win.dark{background:#0b1220;color:#e5e7eb;border-color:#1f2937}',
    '#ai-assist-win.dark.dock-left{border-right-color:#1f2937}',
    '#ai-assist-win.dark.dock-right{border-left-color:#1f2937}',
    '#ai-assist-win.dark #ai-head{background:#0b1220}',
    '#ai-assist-win.dark #ai-title{color:#e5e7eb}',
    '#ai-assist-win.dark #ai-toolbar{background:#0b1220;border-bottom:1px solid #1f2937}',
    '#ai-assist-win.dark #ai-chat{background:#0b1220}',
    '#ai-assist-win.dark .msg.u{background:linear-gradient(135deg,#1f3352,#0f172a);border:1px solid #1d4ed8}',
    '#ai-assist-win.dark .msg.a{background:#111827;border:1px solid #1f2937}',
    '#ai-assist-win.dark .ai-nickname{color:#9ca3af}',
    '#ai-assist-win.dark .msg-action-btn{color:#9ca3af}',
    '#ai-assist-win.dark .msg-action-btn:hover{color:#e5e7eb}',
    '#ai-assist-win.dark #ai-input{background:#0f172a;border-top:1px solid #1f2937}',
    '#ai-assist-win.dark #ai-toolbar select,#ai-assist-win.dark #ai-toolbar input{background:#0b1220;border:1px solid #1f2937;color:#e5e7eb}',
    '#ai-free-model{background:#fff;border:1px solid #e5e7eb;color:#0f172a}',
    '#ai-assist-win.dark #ai-free-model{background:#0b1220;border-color:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark #ai-selects label{color:#9ca3af}',
    '#ai-assist-win.dark #ai-vresizer:hover{background:rgba(96,165,250,0.2)}',
    '#ai-assist-win.dark .ai-mode-switch{background:#0b1220;border:1px solid #1f2937}',
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
    '#ai-assist-win.dark .free-warning{background:#78350f;border-color:#d97706;color:#fef3c7}',
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
    '#ai-assist-win.dark .ai-dropdown-menu{background:#1f2937;border-color:#374151}',
    '#ai-assist-win.dark .ai-menu-item{color:#e5e7eb}',
    '#ai-assist-win.dark .ai-menu-item:hover{background:#374151}',
    // 新增：会话历史下拉面板
    '#ai-history-panel{position:absolute;top:48px;left:0;right:0;background:#fff;border-bottom:1px solid #e5e7eb;padding:8px 12px;display:none;z-index:50}',
    '#ai-history-panel.show{display:block}',
    '#ai-history-panel select{width:100%;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:6px;padding:6px 8px;font-size:13px}',
    '#ai-assist-win.dark #ai-history-panel{background:#0f172a;border-color:#1f2937}',
    '#ai-assist-win.dark #ai-history-panel select{background:#0b1220;border-color:#1f2937;color:#e5e7eb}',
    // 历史会话列表样式
    '.ai-session-list{max-height:200px;overflow-y:auto;margin:0;padding:0;list-style:none}',
    '.ai-session-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;cursor:pointer;border-radius:4px;transition:background .15s}',
    '.ai-session-item:hover{background:#f3f4f6}',
    '.ai-session-item.active{background:#e0f2fe;color:#0369a1}',
    '.ai-session-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
    '.ai-session-item-del{width:18px;height:18px;padding:0;border:none;background:transparent;color:#9ca3af;font-size:14px;cursor:pointer;border-radius:3px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:6px;opacity:0;transition:all .15s}',
    '.ai-session-item:hover .ai-session-item-del{opacity:1}',
    '.ai-session-item-del:hover{color:#ef4444;background:rgba(239,68,68,.1)}',
    '#ai-assist-win.dark .ai-session-item:hover{background:#1f2937}',
    '#ai-assist-win.dark .ai-session-item.active{background:#1e3a5f;color:#60a5fa}',
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
    '.ai-input-wrap textarea{width:100%;min-height:72px;background:transparent;border:none;color:#0f172a;padding:10px 40px 28px 10px;resize:none;font-family:inherit;font-size:13px;box-sizing:border-box;outline:none}',
    '.ai-input-wrap:focus-within{border-color:#3b82f6}',
    '.ai-quick-action-wrap{position:absolute;left:10px;bottom:8px;display:flex;align-items:center;gap:4px}',
    '.ai-quick-action-wrap select{background:transparent;border:none;color:#6b7280;font-size:13px;cursor:pointer;padding:4px 2px;outline:none}',
    '.ai-quick-action-wrap select option{padding:8px 12px;font-size:13px}',
    '.ai-vision-toggle{min-width:26px;height:24px;padding:0 8px;border-radius:999px;border:1px solid #d1d5db;background:rgba(255,255,255,.95);color:#6b7280;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}',
    '.ai-vision-toggle.active{border-color:#2563eb;background:#dbeafe;color:#1d4ed8;box-shadow:0 0 0 1px rgba(37,99,235,.15)}',
    '.ai-vision-toggle.disabled{opacity:.45;cursor:not-allowed;box-shadow:none}',
    '.ai-vision-toggle[data-count]:after{content:attr(data-count);position:absolute;right:-2px;top:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;line-height:14px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px #fff;}',
    '#ai-assist-win.dark .ai-input-wrap{background:#0b1220;border-color:#1f2937}',
    '#ai-assist-win.dark .ai-input-wrap textarea{color:#e5e7eb}',
    '#ai-assist-win.dark .ai-input-wrap:focus-within{border-color:#3b82f6}',
    '#ai-assist-win.dark .ai-quick-action-wrap select{color:#9ca3af;background:transparent}',
    '#ai-assist-win.dark .ai-quick-action-wrap select option{background:#1f2937;color:#e5e7eb}',
    '#ai-assist-win.dark .ai-quick-action-wrap::after{color:#6b7280}',
    '#ai-assist-win.dark .ai-vision-toggle{background:rgba(15,23,42,.95);border-color:#374151;color:#9ca3af}',
    '#ai-assist-win.dark .ai-vision-toggle.active{background:#1e3a8a;border-color:#3b82f6;color:#bfdbfe}',
    // 快捷操作下拉框夜间模式
    '#ai-quick-action{background:transparent;border:none;color:#6b7280;font-size:13px;cursor:pointer;padding:4px 2px;outline:none}',
    '#ai-quick-action option{background:#fff;color:#0f172a;padding:8px 12px}',
    '#ai-assist-win.dark #ai-quick-action{color:#9ca3af}',
    '#ai-assist-win.dark #ai-quick-action option{background:#1f2937;color:#e5e7eb}',
    '#ai-send{position:absolute;right:10px;bottom:8px;padding:0;border:none;background:transparent;color:#9ca3af;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .15s}',
    '#ai-send:hover{color:#3b82f6}',
    '#ai-assist-win.dark #ai-send{color:#6b7280}',
    '#ai-assist-win.dark #ai-send:hover{color:#60a5fa}',
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
    '.msg.a .ai-md-content blockquote{margin:0.5em 0;padding:0.5em 1em;border-left:3px solid var(--border,#e5e7eb);background:var(--panel-bg,#f3f4f6);border-radius:4px}',
    '#ai-assist-win.dark .msg.a .ai-md-content blockquote{border-left-color:var(--border,#374151);background:var(--panel-bg,#1f2937)}',
    '.msg.a .ai-md-content a{color:#2563eb;text-decoration:none}',
    '.msg.a .ai-md-content a:hover{text-decoration:underline}',
    '#ai-assist-win.dark .msg.a .ai-md-content a{color:#60a5fa}',
    '.msg.a .ai-md-content code{background:var(--code-bg,#f6f8fa);padding:0.15em 0.4em;border-radius:4px;font-size:0.9em;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}',
    '#ai-assist-win.dark .msg.a .ai-md-content code{background:var(--code-bg,#1f2937)}',
    '.msg.a .ai-md-content hr{border:none;border-top:1px solid var(--border,#e5e7eb);margin:1em 0}',
    '#ai-assist-win.dark .msg.a .ai-md-content hr{border-top-color:var(--border,#374151)}',
    // ========== 新增：代码块样式 ==========
    '.msg.a .ai-md-content pre{position:relative;background:var(--code-bg,#f6f8fa);border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:12px 14px;margin:0.8em 0;overflow-x:auto}',
    '.msg.a .ai-md-content pre code{background:transparent;padding:0;font-size:13px;line-height:1.5}',
    '#ai-assist-win.dark .msg.a .ai-md-content pre{background:var(--code-bg,#111827);border-color:var(--border,#374151)}',
    // 代码块复制按钮
    '.ai-code-copy{position:absolute;top:8px;right:8px;padding:4px 8px;font-size:11px;color:var(--muted,#6b7280);background:var(--bg,#fff);border:1px solid var(--border,#e5e7eb);border-radius:4px;cursor:pointer;opacity:0;transition:all 0.15s}',
    '.msg.a .ai-md-content pre:hover .ai-code-copy{opacity:1}',
    '.ai-code-copy:hover{color:var(--fg,#0f172a);background:var(--panel-bg,#f3f4f6)}',
    '.ai-code-copy.copied{color:#10b981;border-color:#10b981}',
    '#ai-assist-win.dark .ai-code-copy{background:var(--bg,#0f172a);border-color:var(--border,#374151);color:var(--muted,#9ca3af)}',
    '#ai-assist-win.dark .ai-code-copy:hover{color:var(--fg,#e5e7eb);background:var(--panel-bg,#1f2937)}',
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

function pushMsg(role, content) {
  __AI_SESSION__.messages.push({ role, content })
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
            decorateAICodeBlocks(d)
          }
        } catch {}
      })()
    } else {
      d.textContent = String(m.content || '')
    }
    contentWrapper.appendChild(d)

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
            __AI_CONTEXT__.ui.notice('已替换选区', 'ok', 1400)
            return
          }
        } catch {}
        __AI_CONTEXT__.ui.notice('没有选区，已改为光标处插入', 'ok', 1400)
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
    const cont = DOC().querySelector('.container')
    if (!cont) return
    const winEl = el('ai-assist-win')
    const detectSide = () => {
      if (side === true) {
        if (winEl?.classList?.contains('dock-left')) return 'left'
        if (winEl?.classList?.contains('dock-right')) return 'right'
        return false
      }
      return side
    }
    const actual = detectSide()
    const rawWidth = (() => {
      if (typeof width === 'number' && Number.isFinite(width)) return width
      const inline = winEl ? parseInt(winEl.style.width) : NaN
      if (Number.isFinite(inline)) return inline
      const rect = winEl?.getBoundingClientRect()
      if (rect && rect.width) return rect.width
      return 0
    })()
    const resolvedWidth = Math.max(0, rawWidth || 0)
    const fallbackW = MIN_WIDTH
    cont.classList.remove('with-ai-left', 'with-ai-right')
    if (actual === 'left') {
      cont.classList.add('with-ai-left')
      cont.style.setProperty('--ai-left', (resolvedWidth || fallbackW) + 'px')
      cont.style.setProperty('--ai-right', '0px')
    } else if (actual === 'right') {
      cont.classList.add('with-ai-right')
      cont.style.setProperty('--ai-right', (resolvedWidth || fallbackW) + 'px')
      cont.style.setProperty('--ai-left', '0px')
    } else {
      cont.style.setProperty('--ai-left', '0px')
      cont.style.setProperty('--ai-right', '0px')
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
      sx=e.clientX; sy=e.clientY; mx=parseInt(el.style.left)||60; my=parseInt(el.style.top)||60; e.preventDefault()
      if (el.classList.contains('dock-left')) { mayUndock = true; undockSide = 'left' }
      else if (el.classList.contains('dock-right')) { mayUndock = true; undockSide = 'right' }
      else { dragging=true }
    })
    rz?.addEventListener('mousedown', (e)=>{ if (el.classList.contains('dock-left') || el.classList.contains('dock-right')) return; resizing=true; sx=e.clientX; sy=e.clientY; sw=parseInt(el.style.width)||520; sh=parseInt(el.style.height)||440; e.preventDefault() })
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
      if (resizing){ el.style.width = Math.max(MIN_WIDTH, sw + e.clientX - sx) + 'px'; el.style.height = Math.max(300, sh + e.clientY - sy) + 'px' }
    })
    WIN().addEventListener('mouseup', async ()=>{
      if (mayUndock) { mayUndock = false; undockSide = null }
      if (dragging||resizing){
        // 吸附：靠左边缘或右边缘自动停靠
        const left = parseInt(el.style.left)||0
        const width = parseInt(el.style.width)||300
        const winWidth = WIN().innerWidth
        const right = winWidth - left - width

        if (!el.classList.contains('dock-left') && !el.classList.contains('dock-right') && left <= 16) {
          // 左边缘吸附
          try { el.classList.add('dock-left') } catch {}
          const topH = (()=>{ try { const bar = DOC().querySelector('.menubar'); return (bar && bar.clientHeight) || 0 } catch { return 0 } })()
          el.style.top = topH + 'px'; el.style.left = '0px'; el.style.right = 'auto'; el.style.height = 'calc(100vh - ' + topH + 'px)'
          const w = parseInt(el.style.width)||300; el.style.width = w + 'px'
          setDockPush('left', w)
          try { const cfg = await loadCfg(context); cfg.dock = 'left'; cfg.win = cfg.win||{}; cfg.win.w = w; await saveCfg(context,cfg); await refreshHeader(context) } catch {}
        } else if (!el.classList.contains('dock-left') && !el.classList.contains('dock-right') && right <= 16) {
          // 右边缘吸附
          try { el.classList.add('dock-right') } catch {}
          const topH = (()=>{ try { const bar = DOC().querySelector('.menubar'); return (bar && bar.clientHeight) || 0 } catch { return 0 } })()
          el.style.top = topH + 'px'; el.style.right = '0px'; el.style.left = 'auto'; el.style.height = 'calc(100vh - ' + topH + 'px)'
          const w = parseInt(el.style.width)||300; el.style.width = w + 'px'
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
      const r = await fetch(url, { method:'POST', headers, body })
      const t = await r.text()
      const j = t? JSON.parse(t):null
      name = shorten(j?.choices?.[0]?.message?.content || '', 12).replace(/[\s\n]+/g,'').replace(/[「」\[\]\(\)\{\}\"\'\.,，。!！?？:：;；]/g,'')
    } catch {}
    if (!name) return
    it.name = name
    await saveSessionsDB(context)
    await refreshSessionSelect(context)
    try { context.ui.notice('会话已命名：' + name, 'ok', 1600) } catch {}
  } catch {}
}

async function updateWindowTitle(context) {
  try {
    const head = DOC().getElementById('ai-title')
    if (!head) return
    await ensureSessionForDoc(context)
    head.textContent = __AI_SESSION__.docTitle || '未命名'
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
    const freeModelLabel = el('ai-free-model-label')
    const freeModelSelect = el('ai-free-model')
    if (modelLabel) modelLabel.style.display = isFree ? 'none' : ''
    if (modelInput) modelInput.style.display = isFree ? 'none' : ''
    if (freeModelLabel) freeModelLabel.style.display = isFree ? 'inline-block' : 'none'
    if (freeModelSelect) {
      freeModelSelect.style.display = isFree ? 'inline-block' : 'none'
      if (isFree) freeModelSelect.value = normalizeFreeModelKey(cfg.freeModel)
    }
    if (modelPowered && modelPoweredImg) {
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
      modelPoweredImg.src = resolvePluginAsset(isDark ? 'Powered-by-dark.png' : 'Powered-by-light.png')
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
      const supported = !isFreeProvider(cfg)
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
}

// 收集文档中的图片并构造视觉模型可用的 content 片段
async function buildVisionContentBlocks(context, docCtx){
  const blocks = [{ type: 'text', text: '文档上下文：\n\n' + docCtx }]
  let root = null
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
          if (/^data:image\//i.test(srcAttr) || /^data:image\//i.test(rawSrc)) {
            url = srcAttr || rawSrc
          } else if (/^https?:\/\//i.test(srcAttr) || /^https?:\/\//i.test(rawSrc)) {
            url = srcAttr || rawSrc
          } else if (absPath && typeof context.readImageAsDataUrl === 'function') {
            try {
              url = await context.readImageAsDataUrl(absPath)
            } catch {}
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
                url = await context.readImageAsDataUrl(abs)
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
        const label = img.name
          ? `附件图片 ${usedAttach + 1}：${img.name}`
          : `附件图片 ${usedAttach + 1}`
        blocks.push({ type: 'text', text: '\n\n' + label })
        blocks.push({ type: 'image_url', image_url: { url: img.url } })
        usedAttach++
      }
    }
  } catch {}
  return blocks
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
  if (cfg && cfg.dock === 'left') {
    // 左侧停靠
    el.classList.add('dock-left')
    try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
    el.style.left = '0px'; el.style.width = dockWidth + 'px'
  } else if (cfg && cfg.dock === 'right') {
    // 右侧停靠
    el.classList.add('dock-right')
    try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
    el.style.right = '0px'; el.style.width = dockWidth + 'px'
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
    '  <div id="ai-title">AI 写作助手</div>',
    '  <div class="ai-head-actions">',
    '    <button id="ai-btn-history" class="ai-icon-btn" title="会话历史">⏱</button>',
    '    <button id="ai-s-new" class="ai-icon-btn" title="新建会话">+</button>',
    '    <div class="ai-more-menu-wrap">',
    '      <button id="ai-btn-more" class="ai-icon-btn" title="更多">⋮</button>',
    '      <div id="ai-more-menu" class="ai-dropdown-menu">',
    '        <div class="ai-menu-item" id="ai-menu-settings">插件设置</div>',
    '        <div class="ai-menu-item" id="ai-menu-theme">夜间模式</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-left">切换左侧</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-right">切换右侧</div>',
    '        <div class="ai-menu-item" id="ai-menu-dock-float">切换浮窗</div>',
    '        <div class="ai-menu-item" id="ai-menu-del-session">删除会话</div>',
    '      </div>',
    '    </div>',
    '    <button id="ai-btn-close" class="ai-icon-btn close-btn" title="关闭">×</button>',
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
    '    <span class="mode-label" id="mode-label-custom-toolbar">自定义</span>',
    '    <label class="toggle-switch-mini"><input type="checkbox" id="ai-provider-toggle"/><span class="toggle-slider-mini"></span></label>',
    '    <span class="mode-label" id="mode-label-free-toolbar">免费</span>',
    '   </div>',
    '   <label id="ai-free-model-label" style="display:none;font-size:12px;color:#6b7280;white-space:nowrap;margin-left:6px;">模型</label>',
    '   <select id="ai-free-model" title="选择免费模型" style="display:none;width:80px;border-radius:6px;padding:4px 6px;font-size:12px;"><option value="qwen">Qwen</option><option value="glm">GLM</option></select>',
    '   <div id="ai-selects">',
    '    <label id="ai-model-label" style="font-size:12px;">模型</label>',
    '    <input id="ai-model" placeholder="如 gpt-4o-mini" style="width:120px;font-size:12px;padding:4px 6px;"/>',
    '   </div>',
    '   <a id="ai-model-powered" href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer" style="display:none;border:none;outline:none;margin-left:auto;"><img id="ai-model-powered-img" src="" alt="Powered by" style="height:22px;width:auto;border:none;outline:none;vertical-align:middle;"/></a>',
    '  </div>',
    ' </div>',
    ' <div id="ai-chat"></div>',
    // 输入框区域：左下角快捷操作下拉
     ' <div id="ai-input">',
     '  <div class="ai-input-wrap">',
     '   <textarea id="ai-text" placeholder="输入与 AI 对话..."></textarea>',
     '   <div class="ai-quick-action-wrap">',
     '    <select id="ai-quick-action" title="快捷操作">',
     '     <option value="">智能问答</option>',
     '     <option value="续写">续写</option>',
     '     <option value="润色">润色</option>',
     '     <option value="纠错">纠错</option>',
     '     <option value="提纲">提纲</option>',
     '     <option value="待办">待办</option>',
     '     <option value="提醒">提醒</option>',
     '    </select>',
     '    <button id="ai-vision-toggle" class="ai-vision-toggle" title="视觉模式：点击开启，让 AI 读取文档中的图片">👁</button>',
     '   </div>',
     '   <button id="ai-send" title="发送消息">↵</button>',
     '  </div>',
    ' </div>',
    '</div><div id="ai-vresizer" title="拖动调整宽度"></div><div id="ai-resizer" title="拖动调整尺寸"></div>'
  ].join('')
  DOC().body.appendChild(el)
  if (cfg && (cfg.dock === 'left' || cfg.dock === 'right')) setDockPush(cfg.dock, dockWidth)
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
    await setDockMode(context, el, 'left')
  })
  el.querySelector('#ai-menu-dock-right')?.addEventListener('click', async () => {
    el.querySelector('#ai-more-menu')?.classList.remove('show')
    await setDockMode(context, el, 'right')
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
      cfg.freeModel = normalizeFreeModelKey(freeModelSelect.value)
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
          const isFree = isFreeProvider(cfg)
          if (isFree) {
            try { context.ui.notice('当前免费模型暂不支持视觉能力', 'warn', 2000) } catch {}
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
    // 三态循环：'left' → 'right' → false → 'left'
    let nextDock
    if (cfg.dock === 'left') nextDock = 'right'
    else if (cfg.dock === 'right') nextDock = false
    else nextDock = 'left'

    cfg.dock = nextDock
    await saveCfg(context, cfg)

    // 移除所有停靠类
    el.classList.remove('dock-left', 'dock-right')

    if (nextDock === 'left') {
      // 左侧停靠
      el.classList.add('dock-left')
      try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
      const w = Math.max(MIN_WIDTH, Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH))
      el.style.left = '0px'; el.style.width = w + 'px'; el.style.right = 'auto'
      setDockPush('left', w)
    } else if (nextDock === 'right') {
      // 右侧停靠
      el.classList.add('dock-right')
      try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
      const w = Math.max(MIN_WIDTH, Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH))
      el.style.right = '0px'; el.style.width = w + 'px'; el.style.left = 'auto'
      setDockPush('right', w)
    } else {
      // 浮动窗口
      el.style.top = ((cfg && cfg.win && cfg.win.y) || 60) + 'px'
      el.style.left = ((cfg && cfg.win && cfg.win.x) || 60) + 'px'
      el.style.width = ((cfg && cfg.win && cfg.win.w) || 520) + 'px'
      el.style.height = ((cfg && cfg.win && cfg.win.h) || 440) + 'px'
      el.style.right = 'auto'
      setDockPush(false)
    }
    await refreshHeader(context)
  } catch {}
}

// 直接设置停靠模式
async function setDockMode(context, el, dockMode){
  try {
    const cfg = await loadCfg(context)
    cfg.dock = dockMode
    await saveCfg(context, cfg)

    // 移除所有停靠类
    el.classList.remove('dock-left', 'dock-right')

    if (dockMode === 'left') {
      el.classList.add('dock-left')
      try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
      const w = Math.max(MIN_WIDTH, Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH))
      el.style.left = '0px'; el.style.width = w + 'px'; el.style.right = 'auto'
      setDockPush('left', w)
    } else if (dockMode === 'right') {
      el.classList.add('dock-right')
      try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
      const w = Math.max(MIN_WIDTH, Number((cfg && cfg.win && cfg.win.w) || MIN_WIDTH))
      el.style.right = '0px'; el.style.width = w + 'px'; el.style.left = 'auto'
      setDockPush('right', w)
    } else {
      // 浮动窗口
      el.style.top = ((cfg && cfg.win && cfg.win.y) || 60) + 'px'
      el.style.left = ((cfg && cfg.win && cfg.win.x) || 60) + 'px'
      el.style.width = ((cfg && cfg.win && cfg.win.w) || 520) + 'px'
      el.style.height = ((cfg && cfg.win && cfg.win.h) || 440) + 'px'
      el.style.right = 'auto'
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
    default: return ''
  }
}

async function quick(context, kind){
  const inp = el('ai-text')
  const prefix = buildPromptPrefix(kind)
  let finalPrompt = prefix

  // 对续写 / 润色 / 纠错：如果有选中文本，则优先基于选中内容进行处理
  if (['续写', '润色', '纠错'].includes(kind)) {
    try {
      const sel = await context.getSelection?.()
      if (sel && sel.text && sel.text.trim()) {
        const selected = sel.text.trim()
        finalPrompt = [
          prefix,
          '',
          '当前选中内容：',
          '',
          selected,
          '',
          `请仅针对这段选中内容进行${kind}，不要处理文档中未选中的部分。`
        ].join('\n')
      }
    } catch {}
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
      context.ui.notice('请先在"设置"中配置 API Key', 'err', 3000)
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
      context.ui.notice('没有可翻译的内容', 'err', 2000)
      return
    }

    translatingNoticeId = showLongRunningNotice(context, '正在翻译...')

    // 构造翻译请求
    const system = '你是专业的翻译助手。'
    const prompt = buildPromptPrefix('翻译') + '\n\n' + textToTranslate

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

    const response = await fetch(url, { method: 'POST', headers, body })
    if (!response.ok) {
      throw new Error('API 调用失败：' + response.status)
    }

    const data = await response.json()
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
        context.ui.notice('请先在"设置"中配置 API Key', 'err', 3000)
        return
      }
      if (!cfg.model && !isFree) {
        context.ui.notice('请先选择模型', 'err', 2000)
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
      context.ui.notice(hasSelection ? '选中内容为空' : '文档内容为空', 'err', 2000)
      return
    }

    // 在文档顶部显示生成提示（仅在没有选区时）
    if (!hasSelection) {
      context.setEditorValue(GENERATING_MARKER + context.getEditorValue())
    }
    generatingNoticeId = showLongRunningNotice(context, '正在分析文章生成待办事项并创建提醒...')

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

    const response = await fetch(url, { method: 'POST', headers, body })
    if (!response.ok) {
      throw new Error('API 调用失败：' + response.status)
    }

    const data = await response.json()
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
        context.ui.notice('请先在"设置"中配置 API Key', 'err', 3000)
        return
      }
      if (!cfg.model && !isFree) {
        context.ui.notice('请先选择模型', 'err', 2000)
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
      context.ui.notice(hasSelection ? '选中内容为空' : '文档内容为空', 'err', 2000)
      return
    }

    // 在文档顶部显示生成提示（仅在没有选区时）
    if (!hasSelection) {
      context.setEditorValue(GENERATING_MARKER + context.getEditorValue())
    }
    generatingNoticeId = showLongRunningNotice(context, '正在分析文章生成待办事项...')

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

    const response = await fetch(url, { method: 'POST', headers, body })
    if (!response.ok) {
      throw new Error('API 调用失败：' + response.status)
    }

    const data = await response.json()
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

  await sendFromInput(context)
}

  async function doSend(context){
    if (__AI_SENDING__) return
    const cfg = await loadCfg(context)
    const isFree = isFreeProvider(cfg)
    if (!cfg.apiKey && !isFree) { context.ui.notice('请先在“设置”中配置 OpenAI API Key', 'err', 3000); return }
    if (!cfg.model && !isFree) { context.ui.notice('请先选择模型', 'err', 2000); return }
    __AI_SENDING__ = true
    try {
      await ensureSessionForDoc(context)
      const doc = String(context.getEditorValue() || '')
      const docCtx = clampCtx(doc, Number(cfg.limits?.maxCtxChars || 6000))

      // 添加当前时间上下文
      const now = new Date()
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
      const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const weekday = weekdays[now.getDay()]
      const timeContext = `今天是 ${currentDate} ${weekday} ${currentTime}`

      const system = `你是专业的中文写作助手，回答要简洁、实用、可直接落地。当前时间：${timeContext}`
      const userMsgs = __AI_SESSION__.messages

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
        userMsg = { role: 'user', content: '文档上下文：\n\n' + docCtx }
      }

      const finalMsgs = [{ role: 'system', content: system }, userMsg]
      userMsgs.forEach(m => finalMsgs.push(m))

      // 纯文本降级版本：保留图片的文字说明，去掉 image_url 结构
      let textOnlyMsgs = finalMsgs
      if (usedVision && visionBlocks && Array.isArray(visionBlocks)) {
        try {
          const mergedText = visionBlocks.map(b => (b && b.type === 'text') ? String(b.text || '') : '').join('')
          const textUserMsg = { role: 'user', content: mergedText || ('文档上下文：\n\n' + docCtx) }
          textOnlyMsgs = [{ role: 'system', content: system }, textUserMsg]
          userMsgs.forEach(m => textOnlyMsgs.push(m))
        } catch {}
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
        // 如果带图请求被 4xx 拒绝且启用了视觉，则自动降级为纯文本请求
        if (usedVision && r && !r.ok && r.status >= 400 && r.status < 500) {
          try {
            downgradedFromVision = true
            r = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages: textOnlyMsgs, stream: false }) })
          } catch {}
        }
        removeThinking()
        const text = await r.text()
        const data = text ? JSON.parse(text) : null
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
            const data = text ? JSON.parse(text) : null
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
      pushMsg('assistant', __AI_LAST_REPLY__ || '[空响应]')
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
            context.ui.notice('当前接口可能不支持内嵌图片或图片过大，已自动降级为仅使用文字描述。建议开启图床功能后再使用视觉模式。', 'warn', 4200)
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
  if (!s) { context.ui.notice('没有可插入的内容', 'err', 2000); return }
  const cur = String(context.getEditorValue() || '')
  const next = cur + (cur.endsWith('\n')?'':'\n') + '\n' + s + '\n'
  context.setEditorValue(next)
  context.ui.notice('已插入文末', 'ok', 1600)
}

async function applyLastAtCursor(context){
  const s = String(__AI_LAST_REPLY__||'').trim()
  if (!s) { context.ui.notice('没有可插入的内容', 'err', 2000); return }
  try { await context.insertAtCursor('\n' + s + '\n') } catch { try { const cur = String(context.getEditorValue()||''); context.setEditorValue(cur + (cur.endsWith('\n')?'':'\n') + s + '\n') } catch {} }
  context.ui.notice('已在光标处插入', 'ok', 1400)
}

async function replaceSelectionWithLast(context){
  const s = String(__AI_LAST_REPLY__||'').trim()
  if (!s) { context.ui.notice('没有可插入的内容', 'err', 2000); return }
  try {
    const sel = await context.getSelection?.()
    if (sel && sel.end > sel.start) { await context.replaceRange(sel.start, sel.end, s) ; context.ui.notice('已替换选区', 'ok', 1400); return }
  } catch {}
  context.ui.notice('没有选区，已改为光标处插入', 'ok', 1400)
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
    ' <div id="ai-set-head"><div id="ai-set-title">AI 设置</div><button id="ai-set-close" title="关闭">×</button></div>',
    ' <div id="ai-set-body">',
    '  <div class="set-row mode-row"><label>模式</label><span class="mode-label" id="mode-label-custom">自定义</span><label class="toggle-switch"><input type="checkbox" id="set-provider-toggle"/><span class="toggle-slider"></span></label><span class="mode-label" id="mode-label-free">免费模型</span></div>',
    '  <div class="set-row mode-row"><label>翻译免费</label><span style="font-size:12px;color:#6b7280;">翻译功能始终使用免费模型</span><label class="toggle-switch"><input type="checkbox" id="set-trans-free-toggle"/><span class="toggle-slider"></span></label></div>',
    '  <div class="free-warning" id="free-warning">免费模型由硅基流动提供，<a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">推荐注册硅基流动账号获得顶级模型体验</a></div>',
    '  <div class="set-row custom-only"><label>Base URL</label><select id="set-base-select"><option value="https://api.siliconflow.cn/v1">硅基流动</option><option value="https://api.openai.com/v1">OpenAI</option><option value="https://apic1.ohmycdn.com/api/v1/ai/openai/cc-omg/v1">OMG资源包</option><option value="custom">自定义</option></select><input id="set-base" type="text" placeholder="https://api.siliconflow.cn/v1"/></div>',
    '  <div class="set-row custom-only"><label>API Key</label><input id="set-key" type="password" placeholder="sk-..."/></div>',
    '  <div class="set-row custom-only"><label>模型</label><input id="set-model" type="text" placeholder="gpt-4o-mini"/></div>',
    '  <div class="set-row"><label>侧栏宽度(px)</label><input id="set-sidew" type="number" min="400" step="10" placeholder="400"/></div>',
    '  <div class="set-row"><label>上下文截断</label><input id="set-max" type="number" min="1000" step="500" placeholder="6000"/></div>',
    '  <div class="set-row set-link-row custom-only"><a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer">点此注册硅基流动得2000万免费Token</a></div>',
    '  <div class="set-row set-link-row custom-only"><a href="https://x.dogenet.win/i/dXCKvZ6Q" target="_blank" rel="noopener noreferrer">点此注册OMG获得20美元Claude资源包</a></div>',
    '  <div class="powered-by-img" id="powered-by-container" style="display:none;text-align:center;margin:12px 0 4px 0;"><a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank" rel="noopener noreferrer" style="border:none;outline:none;"><img id="powered-by-img" src="" alt="Powered by" style="max-width:180px;height:auto;cursor:pointer;border:none;outline:none;"/></a></div>',
    ' </div>',
    ' <div id="ai-set-actions"><button id="ai-set-cancel">取消</button><button class="primary" id="ai-set-ok">保存</button></div>',
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
  elMax.value = String((cfg.limits?.maxCtxChars) || 6000)
  elSideW.value = String((cfg.win?.w) || MIN_WIDTH)
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
    const n = Math.max(1000, parseInt(String(elMax.value || '6000'),10) || 6000)
    const sidew = Math.max(MIN_WIDTH, parseInt(String(elSideW.value || MIN_WIDTH),10) || MIN_WIDTH)
    const next = { ...cfg, provider, alwaysUseFreeTrans, baseUrl, apiKey, model, limits: { maxCtxChars: n }, win: { ...(cfg.win||{}), w: sidew, x: cfg.win?.x||60, y: cfg.win?.y||60, h: cfg.win?.h||440 } }
    await saveCfg(context, next)
    const m = el('ai-model'); if (m) m.value = model
    context.ui.notice('设置已保存', 'ok', 1600)
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
  __AI_MENU_ITEM__ = context.addMenuItem({ label: 'AI 助手', title: '打开 AI 写作助手', onClick: async () => { await toggleWindow(context) } })

  // 右键菜单：AI 助手快捷操作
  if (context.addContextMenuItem) {
    try {
      __AI_CTX_MENU_DISPOSER__ = context.addContextMenuItem({
        label: 'AI 助手',
        icon: '🤖',
        children: [
          {
            label: '打开 AI 助手',
            icon: '💬',
            onClick: async () => {
              await toggleWindow(context)
            }
          },
          { type: 'divider' },
          {
            type: 'group',
            label: '快捷操作'
          },
          {
            label: '续写',
            icon: '✍️',
            onClick: async () => {
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '续写')
            }
          },
          {
            label: '润色',
            icon: '✨',
            onClick: async () => {
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '润色')
            }
          },
          {
            label: '纠错',
            icon: '✅',
            onClick: async () => {
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '纠错')
            }
          },
          {
            label: '提纲',
            icon: '📋',
            onClick: async () => {
              await ensureWindow(context)
              el('ai-assist-win').style.display = 'block'
              setDockPush(true)
              await quick(context, '提纲')
            }
          },
          {
            label: '待办',
            icon: '📝',
            children: [
              {
                label: '生成待办',
                onClick: async () => {
                  await generateTodos(context)
                }
              },
              {
                label: '生成并创建提醒',
                onClick: async () => {
                  await generateTodosAndPush(context)
                }
              },
              {
                label: '生成 TODO 便签',
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
                    context.ui.notice(hasSelection ? '选中内容为空' : '文档内容为空', 'err', 2000)
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
            label: '翻译',
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
  // 清理窗口
  try {
    const win = DOC().getElementById('ai-assist-win')
    if (win) {
      setDockPush(false) // 恢复编辑区域
      win.remove()
    }
  } catch {}
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
    context.ui.notice('会话已清空（仅当前文档）', 'ok', 1400)
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
    // 更新工具栏中免费模式的图片
    if (isFreeProvider(cfg)) {
      const modelPoweredImg = el('ai-model-powered-img')
      if (modelPoweredImg) {
        modelPoweredImg.src = resolvePluginAsset(isDark ? 'Powered-by-dark.png' : 'Powered-by-light.png')
      }
    }
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

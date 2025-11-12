// AI 写作助手（OpenAI 兼容路径）
// 说明：
// - 仅实现 OpenAI 兼容接口（/v1/chat/completions）
// - 浮动窗口、基本对话、快捷动作（续写/润色/纠错/提纲）
// - 设置项：baseUrl、apiKey、model、上下文截断长度
// - 默认不写回文档，需用户点击“插入文末”

// ========== 配置与状态 ==========
const CFG_KEY = 'ai.config'
const SES_KEY = 'ai.session.default'

const DEFAULT_CFG = {
  provider: 'openai', // 预留字段（仅 openai）
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  win: { x: 60, y: 60, w: 300, h: 440 },
  dock: true, // true=左侧侧栏；false=浮动窗口
  limits: { maxCtxChars: 6000 },
  theme: 'auto'
}

// 会话只做最小持久化（可选），首版以内存为主
let __AI_SESSION__ = { id: '', name: '默认会话', messages: [], docHash: '', docTitle: '' }
let __AI_DB__ = null // { byDoc: { [hash]: { title, activeId, items:[{id,name,created,updated,messages:[]}] } } }
let __AI_SENDING__ = false
let __AI_LAST_REPLY__ = ''
let __AI_TOGGLE_LOCK__ = false
let __AI_MQ_BOUND__ = false

// ========== 工具函数 ==========
async function loadCfg(context) {
  try { const s = await context.storage.get(CFG_KEY); return { ...DEFAULT_CFG, ...(s || {}) } } catch { return { ...DEFAULT_CFG } }
}
async function saveCfg(context, cfg) { try { await context.storage.set(CFG_KEY, cfg) } catch {} }
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

function DOC(){ return (window.__AI_DOC__ || document) }
function WIN(){ return (window.__AI_WIN__ || window) }
function el(id) { return DOC().getElementById(id) }
function lastUserMsg() { try { const arr = __AI_SESSION__.messages; for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].role === 'user') return String(arr[i].content || '') } } catch {} return '' }
function shorten(s, n){ const t = String(s||'').trim(); return t.length>n? (t.slice(0,n)+'…') : t }

// 追加一段样式，使用独立命名空间，避免污染宿主
function ensureCss() {
  if (DOC().getElementById('ai-assist-style')) return
  const css = DOC().createElement('style')
  css.id = 'ai-assist-style'
  css.textContent = [
    // 容器（浅色友好 UI）；默认走 dock-left 模式（伪装侧栏）
    '#ai-assist-win{position:fixed;z-index:99999;background:#ffffff;color:#0f172a;',
    'border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.15);overflow:hidden}',
    '#ai-assist-win.dock-left{left:0; top:0; height:100vh; width:380px; border-radius:0; border-left:none; border-top:none; border-bottom:none; box-shadow:none; border-right:1px solid #e5e7eb}',
    // 头部与标题
    '#ai-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;cursor:move;',
    'background:linear-gradient(180deg,#f8fafc,#f1f5f9);border-bottom:1px solid #e5e7eb}',
    '#ai-title{font-weight:600;color:#111827}',
    // 主体、工具栏
    '#ai-body{display:flex;flex-direction:column;height:calc(100% - 48px)}',
    '#ai-toolbar{display:flex;flex-wrap:wrap;gap:8px;row-gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid #e5e7eb;background:#fafafa}',
    '#ai-chat{flex:1;overflow:auto;padding:10px;background:#fff}',
    '.msg{white-space:pre-wrap;line-height:1.6;border-radius:10px;padding:10px 12px;margin:8px 0;box-shadow:0 1px 0 rgba(0,0,0,.03)}',
    '.msg.u{background:#f3f4f6;border:1px solid #e5e7eb}',
    '.msg.a{background:#f9fafb;border:1px solid #e5e7eb}',
    '#ai-input{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fafafa}',
    '#ai-input textarea{flex:1;min-height:72px;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:10px;padding:10px 12px}',
    '#ai-input button{padding:8px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#ffffff;color:#0f172a}',
    '#ai-input button:hover{background:#f8fafc}',
    '#ai-vresizer{position:absolute;right:0;top:0;width:6px;height:100%;cursor:ew-resize;background:transparent}',
    '#ai-resizer{position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:nwse-resize;background:transparent}',
    '#ai-selects select,#ai-selects input{background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:8px;padding:6px 8px}',
    '#ai-toolbar .btn{padding:6px 10px;border-radius:8px;border:1px solid #e5e7eb;background:#ffffff;color:#0f172a}',
    '#ai-toolbar .btn:hover{background:#f8fafc}',
    '.small{font-size:12px;opacity:.85}',
    // 推挤主编辑区：使用 CSS 变量 --ai-left
    '.container.with-ai-left .editor, .container.with-ai-left .preview{ padding-left:var(--ai-left, 300px) }',
    '.container.with-ai-left #md-wysiwyg-root{ left:var(--ai-left, 300px); width:calc(100% - var(--ai-left, 300px)) }',
    '.container.wysiwyg-v2.with-ai-left #md-wysiwyg-root{ left:0; width:100% }',
    '#ai-assist-win.dock-left #ai-resizer{display:none}',
    '#ai-assist-win:not(.dock-left) #ai-vresizer{display:none}',
    // 设置面板（内置模态）
    '#ai-set-overlay{position:absolute;inset:0;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;z-index:2147483000}',
    '#ai-set-dialog{width:520px;max-width:92vw;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.18);overflow:hidden}',
    '#ai-set-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb}',
    '#ai-set-title{font-weight:600}',
    '#ai-set-body{padding:12px}',
    '.set-row{display:flex;align-items:center;gap:10px;margin:8px 0}',
    '.set-row label{width:110px;color:#334155}',
    '.set-row input{flex:1;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:8px;padding:8px 10px}',
    '#ai-set-actions{display:flex;gap:10px;justify-content:flex-end;padding:10px 12px;border-top:1px solid #e5e7eb;background:#fafafa}',
    '#ai-set-actions button{padding:8px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#ffffff;color:#0f172a}',
    '#ai-set-actions button.primary{background:#2563eb;border-color:#2563eb;color:#fff}',
  ].join('\n')
  DOC().head.appendChild(css)
}

function pushMsg(role, content) {
  __AI_SESSION__.messages.push({ role, content })
}

function renderMsgs(root) {
  const msgs = __AI_SESSION__.messages
  root.innerHTML = ''
  msgs.forEach(m => {
    const d = DOC().createElement('div')
    d.className = 'msg ' + (m.role === 'user' ? 'u' : 'a')
    d.textContent = String(m.content || '')
    root.appendChild(d)
  })
  root.scrollTop = root.scrollHeight
}

function setDockPush(on){
  try {
    const cont = DOC().querySelector('.container')
    if (!cont) return
    if (on) cont.classList.add('with-ai-left')
    else cont.classList.remove('with-ai-left')
  } catch {}
}

function bindDockResize(context, el) {
  try {
    const rz = el.querySelector('#ai-vresizer')
    if (!rz) return
    let sx = 0, sw = 0, doing = false
    rz.addEventListener('mousedown', (e) => { doing = true; sx = e.clientX; sw = parseInt(el.style.width)||300; e.preventDefault() })
    WIN().addEventListener('mousemove', (e) => { if (!doing) return; const w = Math.max(240, sw + e.clientX - sx); el.style.width = w + 'px'; setDockPush(true) })
    WIN().addEventListener('mouseup', async () => { if (!doing) return; doing = false; try { const cfg = await loadCfg(context); cfg.win = cfg.win || {}; cfg.win.w = parseInt(el.style.width)||300; await saveCfg(context, cfg) } catch {} })
  } catch {}
}

function bindFloatDragResize(context, el){
  try {
    const rz = el.querySelector('#ai-resizer')
    const head = el.querySelector('#ai-head')
    let sx=0, sy=0, sw=0, sh=0, mx=0, my=0, dragging=false, resizing=false, mayUndock=false
    head?.addEventListener('mousedown', (e)=>{
      sx=e.clientX; sy=e.clientY; mx=parseInt(el.style.left)||60; my=parseInt(el.style.top)||60; e.preventDefault()
      if (el.classList.contains('dock-left')) { mayUndock = true } else { dragging=true }
    })
    rz?.addEventListener('mousedown', (e)=>{ if (el.classList.contains('dock-left')) return; resizing=true; sx=e.clientX; sy=e.clientY; sw=parseInt(el.style.width)||520; sh=parseInt(el.style.height)||440; e.preventDefault() })
    WIN().addEventListener('mousemove', (e)=>{
      if (mayUndock) {
        const dx = e.clientX - sx
        if (dx > 24) {
          // 解除停靠，转为浮窗
          mayUndock = false
          try { el.classList.remove('dock-left') } catch {}
          setDockPush(false)
          const w = parseInt(el.style.width)||300
          el.style.width = Math.max(300, w) + 'px'
          el.style.height = '440px'
          // 以当前位置为起点
          el.style.left = (e.clientX - 20) + 'px'
          // 顶部维持当前 top
          dragging = true
          ;(async () => { try { const cfg = await loadCfg(context); cfg.dock = false; cfg.win = cfg.win||{}; cfg.win.x = parseInt(el.style.left)||60; cfg.win.y = parseInt(el.style.top)||60; cfg.win.w = parseInt(el.style.width)||520; cfg.win.h = parseInt(el.style.height)||440; await saveCfg(context,cfg); await refreshHeader(context) } catch {} })()
        }
      }
      if (dragging){ el.style.left = (mx + e.clientX - sx) + 'px'; el.style.top = (my + e.clientY - sy) + 'px' }
      if (resizing){ el.style.width = Math.max(380, sw + e.clientX - sx) + 'px'; el.style.height = Math.max(300, sh + e.clientY - sy) + 'px' }
    })
    WIN().addEventListener('mouseup', async ()=>{
      if (mayUndock) { mayUndock = false }
      if (dragging||resizing){
        // 吸附：靠左边缘自动停靠
        const left = parseInt(el.style.left)||0
        if (!el.classList.contains('dock-left') && left <= 16) {
          try { el.classList.add('dock-left') } catch {}
          const topH = (()=>{ try { const bar = DOC().querySelector('.menubar'); return (bar && bar.clientHeight) || 0 } catch { return 0 } })()
          el.style.top = topH + 'px'; el.style.left = '0px'; el.style.height = 'calc(100vh - ' + topH + 'px)'
          const w = parseInt(el.style.width)||300; el.style.width = w + 'px'
          setDockPush(true)
          try { const cfg = await loadCfg(context); cfg.dock = true; cfg.win = cfg.win||{}; cfg.win.w = w; await saveCfg(context,cfg); await refreshHeader(context) } catch {}
        } else {
          const cfg = await loadCfg(context); cfg.win = cfg.win||{}; cfg.win.x = parseInt(el.style.left)||60; cfg.win.y = parseInt(el.style.top)||60; cfg.win.w = parseInt(el.style.width)||520; cfg.win.h = parseInt(el.style.height)||440; cfg.dock = el.classList.contains('dock-left') ? true : false; await saveCfg(context,cfg)
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
    const url = (cfg.baseUrl||'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions'
    const headers = { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + cfg.apiKey }
    const body = JSON.stringify({ model: cfg.model, stream: false, messages: [ { role:'system', content: sys }, { role:'user', content: prompt } ] })
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
    head.textContent = `AI 写作助手 · ${__AI_SESSION__.docTitle || '未命名'}`
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
  try { const b = el('ai-dock-toggle'); if (b) b.textContent = (cfg && cfg.dock) !== false ? '浮动' : '停靠' } catch {}
}

async function refreshSessionSelect(context) {
  try {
    const select = document.getElementById('ai-sel-session')
    if (!select) return
    await ensureSessionForDoc(context)
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    select.innerHTML = ''
    for (const it of bucket.items) {
      const opt = document.createElement('option')
      opt.value = it.id
      opt.textContent = it.name
      if (it.id === bucket.activeId) opt.selected = true
      select.appendChild(opt)
    }
  } catch {}
}

async function switchSessionBySelect(context) {
  try {
    const select = document.getElementById('ai-sel-session')
    if (!select) return
    const id = String(select.value || '')
    if (!id) return
    if (!__AI_DB__) await loadSessionsDB(context)
    const bucket = __AI_DB__.byDoc[__AI_SESSION__.docHash]
    const it = bucket.items.find(x => x.id === id)
    if (!it) return
    bucket.activeId = id
    __AI_SESSION__ = { id: it.id, name: it.name, messages: it.messages.slice(), docHash: __AI_SESSION__.docHash, docTitle: __AI_SESSION__.docTitle }
    await saveSessionsDB(context)
    const chat = document.getElementById('ai-chat'); if (chat) renderMsgs(chat)
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
  if ((cfg && cfg.dock) !== false) {
    el.classList.add('dock-left')
    try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch { el.style.top = '0px'; el.style.height = '100vh' }
    const sideW = Number((cfg && cfg.win && cfg.win.w) || 300)
    el.style.left = '0px'; el.style.width = sideW + 'px'
  } else {
    try { el.classList.remove('dock-left') } catch {}
    el.style.top = ((cfg && cfg.win && cfg.win.y) || 60) + 'px'
    el.style.left = ((cfg && cfg.win && cfg.win.x) || 60) + 'px'
    el.style.width = ((cfg && cfg.win && cfg.win.w) || 520) + 'px'
    el.style.height = ((cfg && cfg.win && cfg.win.h) || 440) + 'px'
  }
  el.innerHTML = [
    '<div id="ai-head"><div id="ai-title">AI 写作助手</div><div> <button id="ai-btn-theme" title="切换深/浅色">🌙</button><button id="ai-btn-set" title="设置">设置</button> <button id="ai-btn-close" title="关闭">×</button></div></div>',
    '<div id="ai-body">',
    ' <div id="ai-toolbar">',
    '  <div id="ai-selects" class="small">',
    '   <label>模型</label> <input id="ai-model" placeholder="如 gpt-4o-mini" style="width:160px"/>',
    '  </div>',
    '  <div style="flex:1"></div>',
    '  <button class="btn" id="ai-dock-toggle" title="在侧栏/浮窗之间切换">浮动</button>',
    '  <label class="small">会话</label> <select id="ai-sel-session" style="max-width:180px"></select>',
    '  <button class="btn" id="ai-s-new" title="新建会话">新建</button>',
    '  <button class="btn" id="ai-s-del" title="删除当前会话">删除</button>',
    '  <button class="btn" id="q-continue">续写</button><button class="btn" id="q-polish">润色</button><button class="btn" id="q-proof">纠错</button><button class="btn" id="q-outline">提纲</button><button class="btn" id="ai-clear" title="清空本篇会话">清空</button>',
    ' </div>',
    ' <div id="ai-chat"></div>',
    ' <div id="ai-input"><textarea id="ai-text" placeholder="输入与 AI 对话…"></textarea><div style="display:flex;flex-direction:column;gap:6px">',
    '  <button id="ai-send">发送</button><button id="ai-apply-cursor">在光标处插入</button><button id="ai-apply-repl">替换选区</button><button id="ai-copy">复制</button>',
    ' </div></div>',
    '</div><div id="ai-vresizer" title="拖动调整宽度"></div><div id="ai-resizer" title="拖动调整尺寸"></div>'
  , '#ai-head button{padding:6px 10px;border-radius:8px;border:1px solid #e5e7eb;background:#ffffff;color:#0f172a}','#ai-head button:hover{background:#f8fafc}','#ai-assist-win.dark{background:#0b1220;color:#e5e7eb;border-color:#1f2937}','#ai-assist-win.dark.dock-left{border-right-color:#1f2937}','#ai-assist-win.dark #ai-head{background:linear-gradient(180deg,#0f172a,#111827);border-bottom:1px solid #1f2937}','#ai-assist-win.dark #ai-title{color:#e5e7eb}','#ai-assist-win.dark #ai-toolbar{background:#0f172a;border-bottom:1px solid #1f2937}','#ai-assist-win.dark #ai-chat{background:#0b1220}','#ai-assist-win.dark .msg.u{background:#111827;border:1px solid #1f2937}','#ai-assist-win.dark .msg.a{background:#0f172a;border:1px solid #1f2937}','#ai-assist-win.dark #ai-input{background:#0f172a;border-top:1px solid #1f2937}','#ai-assist-win.dark #ai-input textarea{background:#0b1220;border:1px solid #1f2937;color:#e5e7eb}','#ai-assist-win.dark #ai-input button{background:#111827;color:#e5e7eb;border:1px solid #1f2937}','#ai-assist-win.dark #ai-input button:hover{background:#0f172a}','#ai-assist-win.dark #ai-toolbar .btn{background:#111827;color:#e5e7eb;border:1px solid #1f2937}','#ai-assist-win.dark #ai-toolbar .btn:hover{background:#0f172a}','#ai-assist-win.dark #ai-head button{background:#111827;color:#e5e7eb;border:1px solid #1f2937}','#ai-assist-win.dark #ai-head button:hover{background:#0f172a}',].join('')
  DOC().body.appendChild(el)
  if ((cfg && cfg.dock) !== false) setDockPush(true)
  // 绑定拖拽/调整
  try { bindDockResize(context, el) } catch {}
  try { bindFloatDragResize(context, el) } catch {}
  el.querySelector('#ai-btn-close').addEventListener('click',()=>{ el.style.display='none'; setDockPush(false) })
  el.querySelector('#ai-btn-set').addEventListener('click',()=>{ openSettings(context) })
  el.querySelector('#ai-btn-theme').addEventListener('click',()=>{ toggleTheme(context, el) })
  // 模型输入变更即保存
  try {
    const modelInput = el.querySelector('#ai-model')
    modelInput?.addEventListener('change', async (ev) => {
      const cfg = await loadCfg(context)
      cfg.model = String(modelInput.value || '').trim()
      await saveCfg(context, cfg)
    })
  } catch {}
  el.querySelector('#ai-send').addEventListener('click',()=>{ sendFromInput(context) })
  try { const ta = el.querySelector('#ai-text'); ta?.addEventListener('keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); try { sendFromInput(context) } catch {} } }) } catch {}
  el.querySelector('#ai-apply-cursor').addEventListener('click',()=>{ applyLastAtCursor(context) })
  el.querySelector('#ai-apply-repl').addEventListener('click',()=>{ replaceSelectionWithLast(context) })
  el.querySelector('#ai-copy').addEventListener('click',()=>{ copyLast() })
  el.querySelector('#ai-clear').addEventListener('click',()=>{ clearConversation(context) })
  el.querySelector('#ai-s-new').addEventListener('click',()=>{ createNewSession(context) })
  el.querySelector('#ai-s-del').addEventListener('click',()=>{ deleteCurrentSession(context) })
  const selSession = el.querySelector('#ai-sel-session')
  selSession?.addEventListener('change',()=>{ switchSessionBySelect(context) })
  const btnDock = el.querySelector('#ai-dock-toggle')
  btnDock?.addEventListener('click', ()=>{ toggleDockMode(context, el) })
  el.querySelector('#q-continue').addEventListener('click',()=>{ quick(context,'续写') })
  el.querySelector('#q-polish').addEventListener('click',()=>{ quick(context,'润色') })
  el.querySelector('#q-proof').addEventListener('click',()=>{ quick(context,'纠错') })
  el.querySelector('#q-outline').addEventListener('click',()=>{ quick(context,'提纲') })
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
  __AI_TOGGLE_LOCK__ = true; setTimeout(() => { __AI_TOGGLE_LOCK__ = false }, 250)
  let el = elById('ai-assist-win')
  if (!el) { el = await mountWindow(context); el.style.display = 'block'; setDockPush(true); await ensureSessionForDoc(context); await refreshHeader(context); return }
  const visible = (() => { try { return WIN().getComputedStyle(el).display !== 'none' } catch { return el.style.display !== 'none' } })()
  el.style.display = visible ? 'none' : 'block'
  if (!visible) { setDockPush(true); await ensureSessionForDoc(context); await refreshHeader(context) } else { setDockPush(false) }
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
      try { await ensureSessionForDoc(context); await updateWindowTitle(context); const chat = el('ai-chat'); if (chat) renderMsgs(chat) } catch {}
    })
    __AI_FN_OB__.observe(target, { characterData: true, childList: true, subtree: true })
  } catch {}
}

async function toggleDockMode(context, el){
  try {
    const cfg = await loadCfg(context)
    const toDock = !(cfg && cfg.dock !== false)
    cfg.dock = toDock
    await saveCfg(context, cfg)
    if (toDock) {
      // 切回侧栏
      el.classList.add('dock-left')
      try { const bar = DOC().querySelector('.menubar'); const topH = ((bar && bar.clientHeight) || 0); el.style.top = topH + 'px'; el.style.height = 'calc(100vh - ' + topH + 'px)'; } catch {}
      const w = Number((cfg && cfg.win && cfg.win.w) || 300)
      el.style.left = '0px'; el.style.width = w + 'px'
      setDockPush(true)
    } else {
      // 浮动
      el.classList.remove('dock-left')
      el.style.top = ((cfg && cfg.win && cfg.win.y) || 60) + 'px'
      el.style.left = ((cfg && cfg.win && cfg.win.x) || 60) + 'px'
      el.style.width = ((cfg && cfg.win && cfg.win.w) || 520) + 'px'
      el.style.height = ((cfg && cfg.win && cfg.win.h) || 440) + 'px'
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
    default: return ''
  }
}

async function quick(context, kind){
  const inp = el('ai-text')
  const prefix = buildPromptPrefix(kind)
  inp.value = prefix
  await sendFromInput(context)
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

async function doSend(context){
  if (__AI_SENDING__) return
  const cfg = await loadCfg(context)
  if (!cfg.apiKey) { context.ui.notice('请先在“设置”中配置 OpenAI API Key', 'err', 3000); return }
  if (!cfg.model) { context.ui.notice('请先选择模型', 'err', 2000); return }
  __AI_SENDING__ = true
  try {
    await ensureSessionForDoc(context)
    const doc = String(context.getEditorValue() || '')
    const docCtx = clampCtx(doc, Number(cfg.limits?.maxCtxChars||6000))
    const system = '你是专业的中文写作助手，回答要简洁、实用、可直接落地。'
    const userMsgs = __AI_SESSION__.messages
    const finalMsgs = [ { role:'system', content: system }, { role:'user', content: '文档上下文：\n\n' + docCtx } ]
    userMsgs.forEach(m => finalMsgs.push(m))

    const url = (cfg.baseUrl||'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions'
    const bodyObj = { model: cfg.model, messages: finalMsgs, stream: true }
    const body = JSON.stringify(bodyObj)
    const headers = { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + cfg.apiKey }

    const chatEl = el('ai-chat')
    const draft = document.createElement('div'); draft.className = 'msg a'; draft.textContent = ''
    chatEl.appendChild(draft); chatEl.scrollTop = chatEl.scrollHeight

    // 首选用原生 fetch 进行流式解析（SSE）
    let finalText = ''
    try {
      const r2 = await fetch(url, { method:'POST', headers, body })
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
              if (delta) { finalText += delta; draft.textContent = finalText; chatEl.scrollTop = chatEl.scrollHeight }
            } catch {}
          }
        }
      }
    } catch (e) {
      // 流式失败兜底：改非流式一次性请求
      try {
        const r3 = await fetch(url, { method:'POST', headers, body: JSON.stringify({ ...bodyObj, stream: false }) })
        const text = await r3.text()
        const data = text ? JSON.parse(text) : null
        const ctt = data?.choices?.[0]?.message?.content || ''
        finalText = ctt
        draft.textContent = finalText
      } catch (e2) { throw e2 }
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
  } catch (e) {
    console.error(e)
    context.ui.notice('AI 调用失败：' + (e && e.message ? e.message : '未知错误'), 'err', 4000)
  } finally { __AI_SENDING__ = false }
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
    '  <div class="set-row"><label>Base URL</label><input id="set-base" type="text" placeholder="https://api.openai.com/v1"/></div>',
    '  <div class="set-row"><label>API Key</label><input id="set-key" type="password" placeholder="sk-..."/></div>',
    '  <div class="set-row"><label>模型</label><input id="set-model" type="text" placeholder="gpt-4o-mini"/></div>',
    '  <div class="set-row"><label>侧栏宽度(px)</label><input id="set-sidew" type="number" min="240" step="10" placeholder="300"/></div>',
    '  <div class="set-row"><label>上下文截断</label><input id="set-max" type="number" min="1000" step="500" placeholder="6000"/></div>',
    ' </div>',
    ' <div id="ai-set-actions"><button id="ai-set-cancel">取消</button><button class="primary" id="ai-set-ok">保存</button></div>',
    '</div>'
  ].join('')
  const host = document.getElementById('ai-assist-win') || document.body
  host.appendChild(overlay)
  // 若没有插件窗口，挂到 body：用固定定位覆盖全局
  if (host === document.body) {
    try { overlay.style.position = 'fixed'; overlay.style.inset = '0'; overlay.style.zIndex = '2147483000' } catch {}
  }
  // 赋初值
  const elBase = overlay.querySelector('#set-base')
  const elKey = overlay.querySelector('#set-key')
  const elModel = overlay.querySelector('#set-model')
  const elMax = overlay.querySelector('#set-max')
  const elSideW = overlay.querySelector('#set-sidew')
  elBase.value = cfg.baseUrl || 'https://api.openai.com/v1'
  elKey.value = cfg.apiKey || ''
  elModel.value = cfg.model || 'gpt-4o-mini'
  elMax.value = String((cfg.limits?.maxCtxChars) || 6000)
  elSideW.value = String((cfg.win?.w) || 300)
  // 交互
  const close = () => { try { overlay.remove() } catch {} }
  overlay.querySelector('#ai-set-close')?.addEventListener('click', close)
  overlay.querySelector('#ai-set-cancel')?.addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  WIN().addEventListener('keydown', function onEsc(e){ if (e.key === 'Escape') { close(); WIN().removeEventListener('keydown', onEsc) } })
  overlay.querySelector('#ai-set-ok')?.addEventListener('click', async () => {
    const baseUrl = String(elBase.value || '').trim() || 'https://api.openai.com/v1'
    const apiKey = String(elKey.value || '').trim()
    const model = String(elModel.value || '').trim() || 'gpt-4o-mini'
    const n = Math.max(1000, parseInt(String(elMax.value || '6000'),10) || 6000)
    const sidew = Math.max(240, parseInt(String(elSideW.value || '300'),10) || 300)
    const next = { ...cfg, baseUrl, apiKey, model, limits: { maxCtxChars: n }, win: { ...(cfg.win||{}), w: sidew, x: cfg.win?.x||60, y: cfg.win?.y||60, h: cfg.win?.h||440 } }
    await saveCfg(context, next)
    const m = el('ai-model'); if (m) m.value = model
    context.ui.notice('设置已保存', 'ok', 1600)
    try {
      const pane = el('ai-assist-win')
      if (pane && pane.classList.contains('dock-left')) { pane.style.width = sidew + 'px'; setDockPush(true) }
    } catch {}
    close()
  })
}

// ========== 插件主入口 ==========
export async function activate(context) {
  // 菜单：AI 助手（显示/隐藏）
  context.addMenuItem({ label: 'AI 助手', title: '打开 AI 写作助手', onClick: async () => { await toggleWindow(context) } })
  // 预加载配置与会话
  try { const cfg = await loadCfg(context); await saveCfg(context, cfg) } catch {}
  try { __AI_SESSION__ = await loadSession(context) } catch {}
}

export function deactivate(){ /* 无状态清理需求 */ }

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
    if (mode === 'dark') isDark = true
    else if (mode === 'light') isDark = false
    else if (mode === 'auto') isDark = !!(WIN().matchMedia && WIN().matchMedia('(prefers-color-scheme: dark)').matches)
    if (isDark) rootEl.classList.add('dark'); else rootEl.classList.remove('dark')
    const btn = rootEl.querySelector('#ai-btn-theme'); if (btn) btn.textContent = isDark ? '☀️' : '🌙'
    if (mode === 'auto' && WIN().matchMedia && !__AI_MQ_BOUND__){
      try {
        const mq = WIN().matchMedia('(prefers-color-scheme: dark)')
        mq.addEventListener('change', () => { try { applyWinTheme(context, rootEl) } catch {} })
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
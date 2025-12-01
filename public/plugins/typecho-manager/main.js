// Typecho Manager for flyMD
// 通过 XML-RPC 从 Typecho 拉取博文并保存为本地 Markdown。

const LS_KEY = 'flymd:typecho-manager:settings'

function createDefaultSettings() {
  return {
    endpoint: '',
    username: '',
    password: '',
    blogId: '0',
    baseUrl: '',
    defaultDownloadDir: '',
    alwaysUseDefaultDir: false
  }
}

async function loadSettings(context) {
  try {
    if (context?.storage?.get) {
      const stored = await context.storage.get('settings')
      if (stored && typeof stored === 'object') {
        return Object.assign(createDefaultSettings(), stored)
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return createDefaultSettings()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return createDefaultSettings()
    return Object.assign(createDefaultSettings(), parsed)
  } catch {
    return createDefaultSettings()
  }
}

async function saveSettings(context, settings) {
  const payload = Object.assign(createDefaultSettings(), settings || {})
  try {
    if (context?.storage?.set) {
      await context.storage.set('settings', payload)
    }
  } catch {}
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload))
  } catch {}
  return payload
}

// ---- XML-RPC & HTTP 工具 ----

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function iso8601ForXml(d) {
  const y = d.getFullYear()
  const m = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const h = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  const s = pad2(d.getSeconds())
  return `${y}${m}${day}T${h}:${mi}:${s}`
}

const httpState = { available: null, checking: null, error: null }

async function ensureHttpAvailable(context, { silent = false } = {}) {
  if (httpState.available === true) return true
  if (!httpState.checking) {
    httpState.checking = (async () => {
      try {
        const http = context?.http
        if (http?.available) {
          const ok = await http.available()
          httpState.available = (ok !== false)
          if (httpState.available) httpState.error = null
        } else {
          httpState.available = !!http?.fetch
          if (!httpState.available) {
            httpState.error = new Error('ctx.http.fetch 不可用')
          }
        }
      } catch (e) {
        httpState.available = false
        httpState.error = e
      } finally {
        httpState.checking = null
      }
      return httpState.available
    })()
  }
  const ok = await httpState.checking
  if (!ok && !silent) {
    try {
      context?.ui?.notice?.('网络层不可用：请在桌面版使用或确保已启用 @tauri-apps/plugin-http', 'err', 4000)
    } catch {}
  }
  return !!ok
}

function responseOk(res) {
  if (!res) return false
  if (typeof res.ok === 'boolean') return res.ok
  const status = typeof res.status === 'number' ? res.status : 0
  return status >= 200 && status < 300
}

async function readResponseText(res) {
  if (!res) return ''
  if (typeof res.text === 'function') {
    try { return await res.text() } catch {}
  }
  if (typeof res.data === 'string') return res.data
  if (res.body && typeof res.body === 'string') return res.body
  return ''
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function xmlEncodeValue(v) {
  if (v === null || v === undefined) return '<nil/>'
  if (Array.isArray(v)) {
    return '<array><data>' + v.map((x) => `<value>${xmlEncodeValue(x)}</value>`).join('') + '</data></array>'
  }
  if (v instanceof Date) return `<dateTime.iso8601>${iso8601ForXml(v)}</dateTime.iso8601>`
  const t = typeof v
  if (t === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`
  if (t === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`
  if (t === 'object') {
    return '<struct>' + Object.entries(v).map(([k, val]) => `<member><name>${xmlEscape(k)}</name><value>${xmlEncodeValue(val)}</value></member>`).join('') + '</struct>'
  }
  return `<string>${xmlEscape(String(v))}</string>`
}

function xmlBuildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>` +
    (params || []).map((p) => `<param><value>${xmlEncodeValue(p)}</value></param>`).join('') +
    `</params></methodCall>`
}

function xmlParseResponse(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const fault = doc.getElementsByTagName('fault')[0]

  const parseVal = (node) => {
    if (!node) return null
    const name = node.nodeName
    if (name === 'value') {
      return node.children.length ? parseVal(node.children[0]) : (node.textContent ?? '')
    }
    if (['string', 'i4', 'int', 'double', 'boolean', 'dateTime.iso8601'].includes(name)) {
      const s = (node.textContent || '').trim()
      if (name === 'boolean') return s === '1'
      if (name === 'int' || name === 'i4') return parseInt(s, 10)
      if (name === 'double') return Number(s)
      return s
    }
    if (name === 'struct') {
      const result = {}
      const members = node.getElementsByTagName('member')
      for (let i = 0; i < members.length; i++) {
        const member = members[i]
        const key = member.getElementsByTagName('name')[0]?.textContent || ''
        const val = parseVal(member.getElementsByTagName('value')[0])
        result[key] = val
      }
      return result
    }
    if (name === 'array') {
      const dataEl = node.getElementsByTagName('data')[0]
      if (!dataEl) return []
      const arr = []
      for (let i = 0; i < dataEl.children.length; i++) {
        if (dataEl.children[i].nodeName === 'value') arr.push(parseVal(dataEl.children[i]))
      }
      return arr
    }
    return node.textContent ?? ''
  }

  if (fault) {
    const valueNode = fault.getElementsByTagName('value')[0]
    const payload = parseVal(valueNode)
    const msg = (payload && (payload.faultString || payload['faultString'])) || 'XML-RPC 错误'
    const code = (payload && (payload.faultCode || payload['faultCode'])) || -1
    const err = new Error(`XML-RPC 错误 ${code}: ${msg}`)
    // @ts-ignore
    err.code = code
    throw err
  }

  const params = doc.getElementsByTagName('params')[0]
  if (!params) return null
  const first = params.getElementsByTagName('param')[0]
  if (!first) return null
  const value = first.getElementsByTagName('value')[0]
  return parseVal(value)
}

async function xmlRpcCall(context, settings, method, params) {
  const endpoint = String(settings.endpoint || '').trim()
  if (!endpoint) throw new Error('Typecho XML-RPC endpoint 未配置')
  const http = context?.http
  const xml = xmlBuildCall(method, params || [])
  const available = await ensureHttpAvailable(context, { silent: true })
  if (available && http?.fetch) {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'Accept': 'text/xml, */*;q=0.1',
        'Cache-Control': 'no-cache',
        'User-Agent': 'flymd-typecho-manager/0.1'
      },
      body: http.Body?.text ? http.Body.text(xml) : xml,
      timeout: 20000
    }
    if (http.ResponseType?.Text !== undefined && options.responseType === undefined) {
      // @ts-ignore
      options.responseType = http.ResponseType.Text
    }
    const resp = await http.fetch(endpoint, options)
    const text = await readResponseText(resp)
    if (!responseOk(resp)) {
      throw new Error(`HTTP ${resp?.status ?? 'ERR'}: ${text.slice(0, 200)}`)
    }
    return xmlParseResponse(text)
  }
  if (context?.invoke) {
    const text = await context.invoke('http_xmlrpc_post', { req: { url: endpoint, xml } })
    return xmlParseResponse(text)
  }
  throw new Error('无法发送 XML-RPC 请求：既没有 ctx.http.fetch，也没有 ctx.invoke')
}

// ---- 管理窗口与设置窗口（UI 状态与基础骨架） ----

// 会话级状态（不持久化）
const sessionState = {
  settings: createDefaultSettings(),
  posts: [],
  categories: [],
  filterMode: 'all', // all | date | category
  dateFrom: '',
  dateTo: '',
  filterCategory: '',
  pageSize: 50,
  pageIndex: 0,
  conflictChoice: null // null | 'overwrite' | 'skip'
}

// 管理窗口 DOM 引用
let overlayEl = null
let dialogEl = null
let statusEl = null
let listBodyEl = null
let filterModeInputs = null
let dateFromInput = null
let dateToInput = null
let categorySelect = null
let defaultDirInput = null
let alwaysUseDefaultCheckbox = null
let pageInfoEl = null
let prevPageBtn = null
let nextPageBtn = null

// 设置窗口 DOM 引用
let settingsOverlayEl = null

function ensureStyle() {
  if (document.getElementById('tm-typecho-style')) return
  const css = [
    '.tm-typecho-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:90000;}',
    '.tm-typecho-overlay.hidden{display:none;}',
    '.tm-typecho-dialog{width:820px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.35);display:flex;flex-direction:column;font-size:13px;overflow:hidden;}',
    '.tm-typecho-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;}',
    '.tm-typecho-header-left{display:flex;align-items:center;gap:8px;}',
    '.tm-typecho-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:rgba(37,99,235,.1);color:#2563eb;border:1px solid rgba(37,99,235,.4);}',
    '.tm-typecho-header-right{display:flex;align-items:center;gap:8px;}',
    '.tm-typecho-btn{cursor:pointer;border:1px solid var(--border);background:rgba(127,127,127,.08);color:var(--fg);border-radius:999px;padding:4px 10px;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:4px;}',
    '.tm-typecho-btn.primary{border-color:#2563eb;background:#2563eb;color:#fff;}',
    '.tm-typecho-btn:hover{background:rgba(127,127,127,.16);}',
    '.tm-typecho-btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8;}',
    '.tm-typecho-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:8px 14px 10px 14px;}',
    '.tm-typecho-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
    '.tm-typecho-filter-group{display:flex;align-items:center;gap:4px;}',
    '.tm-typecho-label-muted{color:var(--muted);font-size:11px;}',
    '.tm-typecho-radio{display:flex;align-items:center;gap:8px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.05);}',
    '.tm-typecho-radio label{display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;}',
    '.tm-typecho-radio input{margin:0;}',
    '.tm-typecho-input,.tm-typecho-select{border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:3px 9px;font-size:12px;}',
    '.tm-typecho-input-date{max-width:140px;}',
    '.tm-typecho-main{flex:1;min-height:0;margin-top:4px;border-radius:8px;border:1px solid var(--border);overflow:hidden;display:flex;flex-direction:column;background:rgba(127,127,127,.02);}',
    '.tm-typecho-table-head{display:grid;grid-template-columns:2.5fr 1.4fr 1.2fr 0.9fr 0.9fr;border-bottom:1px solid var(--border);background:rgba(127,127,127,.06);}',
    '.tm-typecho-th,.tm-typecho-td{padding:6px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.tm-typecho-th{font-weight:600;color:var(--muted);}',
    '.tm-typecho-table-body{flex:1;min-height:0;overflow:auto;}',
    '.tm-typecho-row{display:grid;grid-template-columns:2.5fr 1.4fr 1.2fr 0.9fr 0.9fr;border-top:1px solid rgba(127,127,127,.12);}',
    '.tm-typecho-row:nth-child(odd){background:rgba(127,127,127,.02);}',
    '.tm-typecho-row:hover{background:rgba(37,99,235,.06);}',
    '.tm-typecho-title{cursor:pointer;}',
    '.tm-typecho-status-badge{display:inline-block;font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid rgba(127,127,127,.4);color:var(--muted);}',
    '.tm-typecho-status-publish{color:#16a34a;border-color:rgba(22,163,74,.6);background:rgba(22,163,74,.06);}',
    '.tm-typecho-status-draft{color:#f97316;border-color:rgba(249,115,22,.6);background:rgba(249,115,22,.06);}',
    '.tm-typecho-footer{padding:7px 12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:rgba(127,127,127,.04);}',
    '.tm-typecho-footer-left{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted);}',
    '.tm-typecho-footer-row{display:flex;align-items:center;gap:6px;}',
    '.tm-typecho-checkbox{display:flex;align-items:center;gap:4px;font-size:12px;}',
    '.tm-typecho-footer-right{display:flex;align-items:center;gap:6px;}',
    '.tm-typecho-page-info{font-size:11px;color:var(--muted);}',
    '.tm-typecho-empty{padding:16px 12px;font-size:12px;color:var(--muted);}',
    '.tm-typecho-settings-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:90010;}',
    '.tm-typecho-settings-overlay.hidden{display:none;}',
    '.tm-typecho-settings-dialog{width:480px;max-width:calc(100% - 40px);max-height:80vh;background:var(--bg);color:var(--fg);border-radius:10px;border:1px solid var(--border);box-shadow:0 14px 36px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;font-size:13px;}',
    '.tm-typecho-settings-header{padding:9px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px;}',
    '.tm-typecho-settings-body{padding:12px 14px;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;}',
    '.tm-typecho-settings-row{display:grid;grid-template-columns:110px 1fr;gap:6px;align-items:center;}',
    '.tm-typecho-settings-label{font-size:12px;color:var(--muted);}',
    '.tm-typecho-settings-input{border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--fg);padding:5px 8px;font-size:12px;}',
    '.tm-typecho-settings-footer{padding:8px 14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;}'
  ].join('\n')
  const style = document.createElement('style')
  style.id = 'tm-typecho-style'
  style.textContent = css
  document.head.appendChild(style)
}

function openOverlay() {
  ensureStyle()
  if (!overlayEl) {
    overlayEl = document.createElement('div')
    overlayEl.className = 'tm-typecho-overlay hidden'
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) closeOverlay()
    })
    dialogEl = document.createElement('div')
    dialogEl.className = 'tm-typecho-dialog'
    overlayEl.appendChild(dialogEl)
    document.body.appendChild(overlayEl)
    buildManagerDialog()
  }
  overlayEl.classList.remove('hidden')
}

function closeOverlay() {
  if (overlayEl) overlayEl.classList.add('hidden')
}

function buildManagerDialog() {
  if (!dialogEl) return
  dialogEl.innerHTML = ''

  // 顶部区域
  const header = document.createElement('div')
  header.className = 'tm-typecho-header'

  const headerLeft = document.createElement('div')
  headerLeft.className = 'tm-typecho-header-left'
  const titleSpan = document.createElement('span')
  titleSpan.textContent = '管理 Typecho 博文'
  const badge = document.createElement('span')
  badge.className = 'tm-typecho-badge'
  badge.textContent = 'XML-RPC'
  statusEl = document.createElement('span')
  statusEl.className = 'tm-typecho-label-muted'
  statusEl.textContent = ''
  headerLeft.appendChild(titleSpan)
  headerLeft.appendChild(badge)
  headerLeft.appendChild(statusEl)

  const headerRight = document.createElement('div')
  headerRight.className = 'tm-typecho-header-right'

  const btnRefresh = document.createElement('button')
  btnRefresh.className = 'tm-typecho-btn'
  btnRefresh.textContent = '刷新列表'
  btnRefresh.addEventListener('click', () => { void refreshPosts(globalContextRef) })

  const btnSettings = document.createElement('button')
  btnSettings.className = 'tm-typecho-btn'
  btnSettings.textContent = '连接 / 下载设置'
  btnSettings.addEventListener('click', () => { void openSettingsDialog(globalContextRef) })

  const btnClose = document.createElement('button')
  btnClose.className = 'tm-typecho-btn'
  btnClose.textContent = '关闭'
  btnClose.addEventListener('click', () => { closeOverlay() })

  headerRight.appendChild(btnRefresh)
  headerRight.appendChild(btnSettings)
  headerRight.appendChild(btnClose)

  header.appendChild(headerLeft)
  header.appendChild(headerRight)
  dialogEl.appendChild(header)

  // 主体区域
  const body = document.createElement('div')
  body.className = 'tm-typecho-body'

  // 筛选条
  const filters = document.createElement('div')
  filters.className = 'tm-typecho-filters'

  const modeGroup = document.createElement('div')
  modeGroup.className = 'tm-typecho-filter-group tm-typecho-radio'
  filterModeInputs = {}
  ;[
    { value: 'all', label: '全部' },
    { value: 'date', label: '按时间' },
    { value: 'category', label: '按分类' }
  ].forEach((m) => {
    const lab = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'tm-typecho-mode'
    input.value = m.value
    if (m.value === sessionState.filterMode) input.checked = true
    input.addEventListener('change', () => {
      if (input.checked) {
        sessionState.filterMode = m.value
        sessionState.pageIndex = 0
        updateFilterVisibility()
        void renderPostTable()
      }
    })
    filterModeInputs[m.value] = input
    const span = document.createElement('span')
    span.textContent = m.label
    lab.appendChild(input)
    lab.appendChild(span)
    modeGroup.appendChild(lab)
  })
  filters.appendChild(modeGroup)

  // 时间筛选
  dateFromInput = document.createElement('input')
  dateFromInput.type = 'date'
  dateFromInput.className = 'tm-typecho-input tm-typecho-input-date'
  dateFromInput.value = sessionState.dateFrom
  dateFromInput.addEventListener('change', () => {
    sessionState.dateFrom = dateFromInput.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  dateToInput = document.createElement('input')
  dateToInput.type = 'date'
  dateToInput.className = 'tm-typecho-input tm-typecho-input-date'
  dateToInput.value = sessionState.dateTo
  dateToInput.addEventListener('change', () => {
    sessionState.dateTo = dateToInput.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  const dateGroup = document.createElement('div')
  dateGroup.className = 'tm-typecho-filter-group'
  const fromLabel = document.createElement('span')
  fromLabel.className = 'tm-typecho-label-muted'
  fromLabel.textContent = '从'
  const toLabel = document.createElement('span')
  toLabel.className = 'tm-typecho-label-muted'
  toLabel.textContent = '到'
  dateGroup.appendChild(fromLabel)
  dateGroup.appendChild(dateFromInput)
  dateGroup.appendChild(toLabel)
  dateGroup.appendChild(dateToInput)
  filters.appendChild(dateGroup)

  // 分类筛选
  categorySelect = document.createElement('select')
  categorySelect.className = 'tm-typecho-select'
  categorySelect.addEventListener('change', () => {
    sessionState.filterCategory = categorySelect.value || ''
    sessionState.pageIndex = 0
    void renderPostTable()
  })
  const catGroup = document.createElement('div')
  catGroup.className = 'tm-typecho-filter-group'
  const catLabel = document.createElement('span')
  catLabel.className = 'tm-typecho-label-muted'
  catLabel.textContent = '分类'
  catGroup.appendChild(catLabel)
  catGroup.appendChild(categorySelect)
  filters.appendChild(catGroup)

  body.appendChild(filters)

  // 列表
  const main = document.createElement('div')
  main.className = 'tm-typecho-main'

  const head = document.createElement('div')
  head.className = 'tm-typecho-table-head'
  ;['标题', '分类', '发布时间', '状态', '操作'].forEach((t) => {
    const th = document.createElement('div')
    th.className = 'tm-typecho-th'
    th.textContent = t
    head.appendChild(th)
  })
  main.appendChild(head)

  listBodyEl = document.createElement('div')
  listBodyEl.className = 'tm-typecho-table-body'
  main.appendChild(listBodyEl)

  body.appendChild(main)
  dialogEl.appendChild(body)

  // 底部区域
  const footer = document.createElement('div')
  footer.className = 'tm-typecho-footer'

  const footerLeft = document.createElement('div')
  footerLeft.className = 'tm-typecho-footer-left'

  const row1 = document.createElement('div')
  row1.className = 'tm-typecho-footer-row'
  const dirLabel = document.createElement('span')
  dirLabel.className = 'tm-typecho-label-muted'
  dirLabel.textContent = '默认下载目录（相对当前文件所在目录）：'
  defaultDirInput = document.createElement('input')
  defaultDirInput.type = 'text'
  defaultDirInput.className = 'tm-typecho-input'
  defaultDirInput.placeholder = '例如: typecho-import'
  defaultDirInput.value = sessionState.settings.defaultDownloadDir || ''
  defaultDirInput.addEventListener('change', async () => {
    sessionState.settings.defaultDownloadDir = defaultDirInput.value.trim()
    await saveSettings(globalContextRef, sessionState.settings)
  })
  row1.appendChild(dirLabel)
  row1.appendChild(defaultDirInput)

  const row2 = document.createElement('div')
  row2.className = 'tm-typecho-footer-row'
  const cbWrap = document.createElement('label')
  cbWrap.className = 'tm-typecho-checkbox'
  alwaysUseDefaultCheckbox = document.createElement('input')
  alwaysUseDefaultCheckbox.type = 'checkbox'
  alwaysUseDefaultCheckbox.checked = !!sessionState.settings.alwaysUseDefaultDir
  alwaysUseDefaultCheckbox.addEventListener('change', async () => {
    sessionState.settings.alwaysUseDefaultDir = !!alwaysUseDefaultCheckbox.checked
    await saveSettings(globalContextRef, sessionState.settings)
  })
  const cbText = document.createElement('span')
  cbText.textContent = '始终下载到默认目录（否则下载到当前文件所在目录）'
  cbWrap.appendChild(alwaysUseDefaultCheckbox)
  cbWrap.appendChild(cbText)
  row2.appendChild(cbWrap)

  footerLeft.appendChild(row1)
  footerLeft.appendChild(row2)

  const footerRight = document.createElement('div')
  footerRight.className = 'tm-typecho-footer-right'
  pageInfoEl = document.createElement('span')
  pageInfoEl.className = 'tm-typecho-page-info'
  pageInfoEl.textContent = ''

  prevPageBtn = document.createElement('button')
  prevPageBtn.className = 'tm-typecho-btn'
  prevPageBtn.textContent = '上一页'
  prevPageBtn.addEventListener('click', () => {
    if (sessionState.pageIndex > 0) {
      sessionState.pageIndex--
      void renderPostTable()
    }
  })

  nextPageBtn = document.createElement('button')
  nextPageBtn.className = 'tm-typecho-btn'
  nextPageBtn.textContent = '下一页'
  nextPageBtn.addEventListener('click', () => {
    sessionState.pageIndex++
    void renderPostTable()
  })

  footerRight.appendChild(pageInfoEl)
  footerRight.appendChild(prevPageBtn)
  footerRight.appendChild(nextPageBtn)

  footer.appendChild(footerLeft)
  footer.appendChild(footerRight)
  dialogEl.appendChild(footer)

  updateFilterVisibility()
}

function updateFilterVisibility() {
  const mode = sessionState.filterMode
  const showDate = mode === 'date'
  const showCat = mode === 'category'
  if (dateFromInput) dateFromInput.style.display = showDate ? '' : 'none'
  if (dateToInput) dateToInput.style.display = showDate ? '' : 'none'
  if (categorySelect) categorySelect.style.display = showCat ? '' : 'none'
}

// 简单工具函数
function formatDateShort(d) {
  if (!d) return ''
  try {
    const dt = d instanceof Date ? d : new Date(d)
    if (!dt || isNaN(dt.getTime())) return ''
    const y = dt.getFullYear()
    const m = pad2(dt.getMonth() + 1)
    const day = pad2(dt.getDate())
    return `${y}-${m}-${day}`
  } catch {
    return ''
  }
}

function extractCategoriesFromPosts(posts) {
  const set = new Set()
  for (const p of posts || []) {
    const cats = p.categories || p.category || []
    if (Array.isArray(cats)) {
      for (const c of cats) {
        const s = String(c || '').trim()
        if (s) set.add(s)
      }
    } else if (cats) {
      const s = String(cats || '').trim()
      if (s) set.add(s)
    }
  }
  return Array.from(set.values()).sort()
}

// 拉取与渲染文章列表（逻辑部分）

async function loadAllPosts(context, settings) {
  // 使用 getRecentPosts 拉取一批足够大的文章，后续在本地筛选
  const maxCount = 1000
  const res = await xmlRpcCall(context, settings, 'metaWeblog.getRecentPosts', [
    String(settings.blogId || '0'),
    settings.username,
    settings.password,
    maxCount
  ])
  const list = []
  if (Array.isArray(res)) {
    for (const it of res) {
      if (it && typeof it === 'object') list.push(it)
    }
  }
  return list
}

async function refreshPosts(context) {
  if (!context) return
  try {
    if (!sessionState.settings.endpoint || !sessionState.settings.username || !sessionState.settings.password) {
      context.ui.notice('请先在“连接 / 下载设置”中配置 XML-RPC 地址、用户名和密码', 'err', 2600)
      if (statusEl) statusEl.textContent = '未配置连接'
      return
    }
    if (statusEl) statusEl.textContent = '正在从 Typecho 拉取文章...'

    const posts = await loadAllPosts(context, sessionState.settings)
    sessionState.posts = Array.isArray(posts) ? posts : []
    sessionState.categories = extractCategoriesFromPosts(sessionState.posts)
    sessionState.pageIndex = 0

    // 更新分类下拉
    if (categorySelect) {
      categorySelect.innerHTML = ''
      const optAll = document.createElement('option')
      optAll.value = ''
      optAll.textContent = '全部分类'
      categorySelect.appendChild(optAll)
      for (const c of sessionState.categories) {
        const opt = document.createElement('option')
        opt.value = c
        opt.textContent = c
        categorySelect.appendChild(opt)
      }
      categorySelect.value = sessionState.filterCategory || ''
    }

    await renderPostTable()
    if (statusEl) statusEl.textContent = `已加载 ${sessionState.posts.length} 篇`
  } catch (e) {
    console.error('[Typecho Manager] 刷新文章失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    if (statusEl) statusEl.textContent = '加载失败'
    try { globalContextRef?.ui?.notice?.('加载 Typecho 文章失败：' + msg, 'err', 3200) } catch {}
  }
}

async function renderPostTable() {
  if (!listBodyEl) return
  let items = sessionState.posts.slice()
  const mode = sessionState.filterMode

  // 时间筛选
  if (mode === 'date') {
    const from = sessionState.dateFrom ? new Date(sessionState.dateFrom) : null
    const to = sessionState.dateTo ? new Date(sessionState.dateTo) : null
    items = items.filter((p) => {
      const raw = p.dateCreated || p.date_created || p.pubDate || p.date || null
      if (!raw) return false
      const d = new Date(raw)
      if (!d || isNaN(d.getTime())) return false
      if (from && d < from) return false
      if (to) {
        const dt = new Date(to.getTime())
        dt.setHours(23, 59, 59, 999)
        if (d > dt) return false
      }
      return true
    })
  }

  // 分类筛选
  if (mode === 'category' && sessionState.filterCategory) {
    const target = sessionState.filterCategory
    items = items.filter((p) => {
      const cats = p.categories || p.category || []
      if (Array.isArray(cats)) {
        return cats.some((c) => String(c || '').trim() === target)
      }
      if (cats) {
        return String(cats || '').trim() === target
      }
      return false
    })
  }

  // 按时间降序
  items.sort((a, b) => {
    try {
      const da = new Date(a.dateCreated || a.date_created || a.pubDate || a.date || 0).getTime() || 0
      const db = new Date(b.dateCreated || b.date_created || b.pubDate || b.date || 0).getTime() || 0
      return db - da
    } catch {
      return 0
    }
  })

  const total = items.length
  const ps = sessionState.pageSize
  const maxPageIndex = total > 0 ? Math.max(0, Math.ceil(total / ps) - 1) : 0
  if (sessionState.pageIndex > maxPageIndex) sessionState.pageIndex = maxPageIndex
  const start = sessionState.pageIndex * ps
  const end = start + ps
  const pageItems = items.slice(start, end)

  listBodyEl.innerHTML = ''
  if (pageItems.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'tm-typecho-empty'
    empty.textContent = total === 0 ? '暂无文章，检查连接设置或放宽筛选条件。' : '当前页没有匹配的文章。'
    listBodyEl.appendChild(empty)
  } else {
    for (const p of pageItems) {
      const row = document.createElement('div')
      row.className = 'tm-typecho-row'

      const cid = p.postid || p.postId || p.cid || p.id
      const title = String(p.title || '').trim() || `(未命名 #${cid || ''})`
      const cats = p.categories || p.category || []
      const dateRaw = p.dateCreated || p.date_created || p.pubDate || p.date || ''
      const status = String(p.post_status || p.postStatus || p.status || '').toLowerCase()

      const cellTitle = document.createElement('div')
      cellTitle.className = 'tm-typecho-td tm-typecho-title'
      cellTitle.textContent = title
      cellTitle.title = title
      row.appendChild(cellTitle)

      const cellCat = document.createElement('div')
      cellCat.className = 'tm-typecho-td'
      const catArr = Array.isArray(cats)
        ? cats.map((x) => String(x || '').trim()).filter(Boolean)
        : (cats ? [String(cats || '').trim()] : [])
      cellCat.textContent = catArr.join(', ')
      cellCat.title = cellCat.textContent
      row.appendChild(cellCat)

      const cellDate = document.createElement('div')
      cellDate.className = 'tm-typecho-td'
      cellDate.textContent = formatDateShort(dateRaw)
      cellDate.title = String(dateRaw || '')
      row.appendChild(cellDate)

      const cellStatus = document.createElement('div')
      cellStatus.className = 'tm-typecho-td'
      const sb = document.createElement('span')
      sb.className = 'tm-typecho-status-badge'
      if (status === 'publish') sb.classList.add('tm-typecho-status-publish')
      else if (status === 'draft') sb.classList.add('tm-typecho-status-draft')
      sb.textContent = status || '未知'
      cellStatus.appendChild(sb)
      row.appendChild(cellStatus)

      const cellActions = document.createElement('div')
      cellActions.className = 'tm-typecho-td'
      const btnDl = document.createElement('button')
      btnDl.className = 'tm-typecho-btn'
      btnDl.textContent = '下载到本地'
      btnDl.addEventListener('click', () => { void downloadSinglePost(globalContextRef, p) })
      cellActions.appendChild(btnDl)

      const btnUpdate = document.createElement('button')
      btnUpdate.className = 'tm-typecho-btn'
      btnUpdate.textContent = '用当前文档更新'
      btnUpdate.style.marginLeft = '6px'
      btnUpdate.addEventListener('click', () => { void publishCurrentForPost(globalContextRef, p) })
      cellActions.appendChild(btnUpdate)
      row.appendChild(cellActions)

      listBodyEl.appendChild(row)
    }
  }

  if (pageInfoEl) {
    if (total === 0) pageInfoEl.textContent = '共 0 篇'
    else pageInfoEl.textContent = `共 ${total} 篇 · 第 ${sessionState.pageIndex + 1}/${maxPageIndex + 1} 页`
  }
  if (prevPageBtn) prevPageBtn.disabled = sessionState.pageIndex <= 0
  if (nextPageBtn) nextPageBtn.disabled = sessionState.pageIndex >= maxPageIndex
}

// ---- 下载到本地 & 文件工具 ----

function joinPath(dir, name) {
  const a = String(dir || '')
  const b = String(name || '')
  if (!a) return b
  const sep = a.includes('\\') ? '\\' : '/'
  return a.replace(/[\\/]+$/, '') + sep + b.replace(/^[\\/]+/, '')
}

async function getCurrentBaseDir() {
  try {
    const fn = typeof window !== 'undefined' ? window.flymdGetCurrentFilePath : null
    if (!fn || typeof fn !== 'function') return null
    const cur = fn()
    if (!cur || typeof cur !== 'string') return null
    return cur.replace(/[\\/][^\\/]*$/, '')
  } catch {
    return null
  }
}

async function checkFileExists(context, path) {
  try {
    if (!context?.invoke) return false
    const text = await context.invoke('read_text_file_any', { path })
    return typeof text === 'string'
  } catch {
    return false
  }
}

async function writeTextFileAny(context, path, content) {
  if (!context?.invoke) throw new Error('ctx.invoke 不可用，无法写入文件')
  await context.invoke('write_text_file_any', { path, content })
}

async function resolveConflictForPath(context, path) {
  if (sessionState.conflictChoice === 'overwrite') return 'overwrite'
  if (sessionState.conflictChoice === 'skip') return 'skip'
  const msg = `文件已存在：\n${path}\n\n选择“确定”将覆盖，选择“取消”将跳过。`
  let overwrite = false
  try {
    overwrite = await context.ui.confirm(msg)
  } catch {
    overwrite = false
  }
  sessionState.conflictChoice = overwrite ? 'overwrite' : 'skip'
  return sessionState.conflictChoice
}

async function downloadSinglePost(context, post) {
  if (!context) return
  try {
    const cid = post.postid || post.postId || post.cid || post.id
    if (!cid && cid !== 0) {
      context.ui.notice('该文章缺少 id，无法下载', 'err', 2200)
      return
    }

    const detail = await xmlRpcCall(context, sessionState.settings, 'metaWeblog.getPost', [
      String(cid),
      sessionState.settings.username,
      sessionState.settings.password
    ])

    const contentHtml = detail?.description || detail?.content || ''
    const title = String(detail?.title || '').trim() || `(未命名 #${cid})`
    const slug = String(detail?.wp_slug || detail?.slug || cid || '').trim()
    const cats = detail?.categories || detail?.category || post.categories || []
    const tagsRaw = detail?.mt_keywords || detail?.tags || ''
    const tags = tagsRaw
      ? String(tagsRaw)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : []
    const status = String(detail?.post_status || detail?.postStatus || detail?.status || '').toLowerCase() || 'publish'
    const dateRaw = detail?.dateCreated || detail?.date_created || detail?.pubDate || detail?.date || post.dateCreated

    let mdBody = ''
    try {
      if (context.htmlToMarkdown) {
        mdBody = await context.htmlToMarkdown(contentHtml || '', {
          baseUrl: sessionState.settings.baseUrl || ''
        })
      } else {
        mdBody = contentHtml || ''
      }
    } catch (e) {
      console.error('[Typecho Manager] htmlToMarkdown 失败，回退为原始 HTML', e)
      mdBody = contentHtml || ''
    }

    const dt = dateRaw ? new Date(dateRaw) : new Date()
    const y = dt.getFullYear()
    const m = pad2(dt.getMonth() + 1)
    const day = pad2(dt.getDate())
    const dateStr = isNaN(dt.getTime()) ? '' : `${y}-${m}-${day}`
    const safeSlug = slug || String(cid)
    const filename = (dateStr ? `${dateStr}-` : '') + safeSlug + '.md'

    const base = await getCurrentBaseDir()
    if (!base) {
      context.ui.notice('无法确定当前文件所在目录，请先打开一个本地文档后再下载。', 'err', 3000)
      return
    }
    let baseDir = base
    if (sessionState.settings.alwaysUseDefaultDir && sessionState.settings.defaultDownloadDir) {
      baseDir = joinPath(base, sessionState.settings.defaultDownloadDir)
    }
    const fullPath = joinPath(baseDir, filename)

    const fm = {
      title,
      typechoId: String(cid),
      typechoSlug: safeSlug,
      typechoUpdatedAt: dateRaw ? String(dateRaw) : '',
      categories: Array.isArray(cats)
        ? cats.map((x) => String(x || '').trim()).filter(Boolean)
        : (cats ? [String(cats || '').trim()] : []),
      tags,
      status,
      source: 'typecho'
    }

    const fmLines = []
    const writeEntry = (k, v) => {
      if (v === undefined || v === null || v === '') return
      if (Array.isArray(v)) {
        fmLines.push(`${k}:`)
        for (const it of v) {
          fmLines.push(`  - "${String(it).replace(/"/g, '\\"')}"`)
        }
      } else {
        let s = String(v)
        if (/[#:?\-&*!\[\]{},>|'%@`]/.test(s) || /\s/.test(s)) {
          s = `"${s.replace(/"/g, '\\"')}"`
        }
        fmLines.push(`${k}: ${s}`)
      }
    }
    writeEntry('title', fm.title)
    writeEntry('typechoId', fm.typechoId)
    writeEntry('typechoSlug', fm.typechoSlug)
    writeEntry('typechoUpdatedAt', fm.typechoUpdatedAt)
    writeEntry('categories', fm.categories)
    writeEntry('tags', fm.tags)
    writeEntry('status', fm.status)
    writeEntry('source', fm.source)

    const finalDoc = `---\n${fmLines.join('\n')}\n---\n\n${mdBody || ''}`

    const exists = await checkFileExists(context, fullPath)
    if (exists) {
      const decision = await resolveConflictForPath(context, fullPath)
      if (decision === 'skip') return
      if (decision !== 'overwrite') return
    }

    await writeTextFileAny(context, fullPath, finalDoc)
    context.ui.notice('已保存到本地：' + fullPath, 'ok', 2400)
  } catch (e) {
    console.error('[Typecho Manager] 下载文章失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    try { context.ui.notice('下载文章失败：' + msg, 'err', 3200) } catch {}
  }
}

// ---- 发布 / 更新：使用当前文档覆盖远端 ----

async function publishCurrentDocument(context) {
  if (!context) return
  sessionState.settings = await loadSettings(context)
  const s = sessionState.settings
  if (!s.endpoint || !s.username || !s.password) {
    context.ui.notice('请先在“连接 / 下载设置”中配置 XML-RPC 地址、用户名和密码', 'err', 2600)
    return
  }
  let meta = null
  let body = ''
  try {
    meta = context.getDocMeta && context.getDocMeta()
  } catch {}
  try {
    body = context.getDocBody ? context.getDocBody() : context.getEditorValue()
  } catch {
    body = ''
  }
  meta = meta || {}
  body = String(body || '')
  if (!body.trim()) {
    context.ui.notice('当前文档内容为空，已取消发布', 'err', 2200)
    return
  }
  const cid = meta.typechoId || meta.cid || meta.id
  if (!cid && cid !== 0) {
    context.ui.notice('当前文档缺少 typechoId/cid，无法确定远端文章，请先从 Typecho 导入或手动添加。', 'err', 3200)
    return
  }

  const title = String(meta.title || '').trim() || '(未命名)'
  const cats = Array.isArray(meta.categories) ? meta.categories : []
  const tagArr = Array.isArray(meta.tags)
    ? meta.tags
    : (Array.isArray(meta.keywords) ? meta.keywords : [])
  const tags = tagArr.map((x) => String(x || '').trim()).filter(Boolean)
  const statusStr = String(meta.status || '').toLowerCase()
  const draft = meta.draft === true || statusStr === 'draft'

  let dtRaw = meta.dateCreated || meta.date || meta.typechoUpdatedAt || null
  let dt = dtRaw ? new Date(dtRaw) : new Date()
  if (!dt || isNaN(dt.getTime())) dt = new Date()

  const confirmed = await context.ui.confirm(
    `将使用当前文档内容覆盖 Typecho 上的文章（ID=${cid}，标题=${title}），是否继续？`
  )
  if (!confirmed) return

  const postStruct = {
    title,
    description: body,
    mt_keywords: tags.join(','),
    categories: cats,
    post_type: 'post',
    wp_slug: meta.slug || meta.typechoSlug || '',
    mt_allow_comments: 1,
    dateCreated: dt
  }

  try {
    await xmlRpcCall(context, s, 'metaWeblog.editPost', [
      String(cid),
      s.username,
      s.password,
      postStruct,
      !draft
    ])
    context.ui.notice('远端文章已更新', 'ok', 2300)
  } catch (e) {
    console.error('[Typecho Manager] 发布当前文档失败', e)
    const msg = e && e.message ? e.message : String(e || '未知错误')
    context.ui.notice('更新远端文章失败：' + msg, 'err', 3200)
  }
}

async function publishCurrentForPost(context, post) {
  if (!context || !post) return
  let meta = null
  try {
    meta = context.getDocMeta && context.getDocMeta()
  } catch {}
  meta = meta || {}

  const cidPost = post.postid || post.postId || post.cid || post.id
  const cidMeta = meta.typechoId || meta.cid || meta.id

  if (!cidMeta && cidPost) {
    const ok = await context.ui.confirm(
      `当前文档没有 typechoId，将使用列表中的文章 ID=${cidPost} 作为目标，是否继续？`
    )
    if (!ok) return
    meta.typechoId = String(cidPost)
  } else if (cidMeta && cidPost && String(cidMeta) !== String(cidPost)) {
    const ok = await context.ui.confirm(
      `当前文档的 typechoId=${cidMeta} 与列表中的 ID=${cidPost} 不一致。\n\n仍要使用当前文档覆盖列表所选远端文章吗？`
    )
    if (!ok) return
    meta.typechoId = String(cidPost)
  }

  await publishCurrentDocument(context)
}

// ---- 设置窗口：一次性填写所有选项 ----

async function openSettingsDialog(context) {
  if (!context) return
  ensureStyle()

  if (!settingsOverlayEl) {
    settingsOverlayEl = document.createElement('div')
    settingsOverlayEl.className = 'tm-typecho-settings-overlay hidden'
    settingsOverlayEl.addEventListener('click', (e) => {
      if (e.target === settingsOverlayEl) settingsOverlayEl.classList.add('hidden')
    })

    const dlg = document.createElement('div')
    dlg.className = 'tm-typecho-settings-dialog'

    const header = document.createElement('div')
    header.className = 'tm-typecho-settings-header'
    header.textContent = 'Typecho 连接 / 下载设置'
    dlg.appendChild(header)

    const body = document.createElement('div')
    body.className = 'tm-typecho-settings-body'

    const rows = {}
    const addRow = (labelText, inputEl) => {
      const row = document.createElement('div')
      row.className = 'tm-typecho-settings-row'
      const lab = document.createElement('div')
      lab.className = 'tm-typecho-settings-label'
      lab.textContent = labelText
      row.appendChild(lab)
      row.appendChild(inputEl)
      body.appendChild(row)
    }

    const inputEndpoint = document.createElement('input')
    inputEndpoint.type = 'text'
    inputEndpoint.className = 'tm-typecho-settings-input'
    inputEndpoint.placeholder = 'https://blog.example.com/action/xmlrpc'
    addRow('XML-RPC 地址', inputEndpoint); rows.endpoint = inputEndpoint

    const inputUser = document.createElement('input')
    inputUser.type = 'text'
    inputUser.className = 'tm-typecho-settings-input'
    addRow('用户名', inputUser); rows.username = inputUser

    const inputPwd = document.createElement('input')
    inputPwd.type = 'password'
    inputPwd.className = 'tm-typecho-settings-input'
    addRow('密码', inputPwd); rows.password = inputPwd

    const inputBlogId = document.createElement('input')
    inputBlogId.type = 'text'
    inputBlogId.className = 'tm-typecho-settings-input'
    inputBlogId.placeholder = '通常为 0 或 1'
    addRow('Blog ID', inputBlogId); rows.blogId = inputBlogId

    const inputBaseUrl = document.createElement('input')
    inputBaseUrl.type = 'text'
    inputBaseUrl.className = 'tm-typecho-settings-input'
    inputBaseUrl.placeholder = 'https://blog.example.com（用于补全相对链接，可留空）'
    addRow('站点根地址', inputBaseUrl); rows.baseUrl = inputBaseUrl

    const inputDefaultDir = document.createElement('input')
    inputDefaultDir.type = 'text'
    inputDefaultDir.className = 'tm-typecho-settings-input'
    inputDefaultDir.placeholder = 'typecho-import'
    addRow('默认下载目录', inputDefaultDir); rows.defaultDir = inputDefaultDir

    const cbWrap = document.createElement('label')
    cbWrap.className = 'tm-typecho-checkbox'
    const cbAlways = document.createElement('input')
    cbAlways.type = 'checkbox'
    const cbText = document.createElement('span')
    cbText.textContent = '始终下载到默认目录（否则下载到当前文件所在目录）'
    cbWrap.appendChild(cbAlways)
    cbWrap.appendChild(cbText)
    addRow('目录策略', cbWrap); rows.always = cbAlways

    dlg.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'tm-typecho-settings-footer'

    const btnCancel = document.createElement('button')
    btnCancel.className = 'tm-typecho-btn'
    btnCancel.textContent = '取消'
    btnCancel.addEventListener('click', () => { settingsOverlayEl.classList.add('hidden') })

    const btnTest = document.createElement('button')
    btnTest.className = 'tm-typecho-btn'
    btnTest.textContent = '测试连接'

    const btnSave = document.createElement('button')
    btnSave.className = 'tm-typecho-btn primary'
    btnSave.textContent = '保存'

    footer.appendChild(btnCancel)
    footer.appendChild(btnTest)
    footer.appendChild(btnSave)
    dlg.appendChild(footer)

    settingsOverlayEl.appendChild(dlg)
    document.body.appendChild(settingsOverlayEl)
    settingsOverlayEl._rows = rows

    btnSave.addEventListener('click', async () => {
      const r = settingsOverlayEl._rows
      sessionState.settings.endpoint = String(r.endpoint.value || '').trim()
      sessionState.settings.username = String(r.username.value || '').trim()
      sessionState.settings.password = String(r.password.value || '')
      sessionState.settings.blogId = String(r.blogId.value || '0').trim() || '0'
      sessionState.settings.baseUrl = String(r.baseUrl.value || '').trim()
      sessionState.settings.defaultDownloadDir = String(r.defaultDir.value || '').trim()
      sessionState.settings.alwaysUseDefaultDir = !!r.always.checked

      await saveSettings(context, sessionState.settings)
      settingsOverlayEl.classList.add('hidden')
      try { context.ui.notice('Typecho 设置已保存', 'ok', 2200) } catch {}

      if (defaultDirInput) defaultDirInput.value = sessionState.settings.defaultDownloadDir || ''
      if (alwaysUseDefaultCheckbox) alwaysUseDefaultCheckbox.checked = !!sessionState.settings.alwaysUseDefaultDir
    })

    btnTest.addEventListener('click', async () => {
      const r = settingsOverlayEl._rows
      const tmp = {
        endpoint: String(r.endpoint.value || '').trim(),
        username: String(r.username.value || '').trim(),
        password: String(r.password.value || ''),
        blogId: String(r.blogId.value || '0').trim() || '0',
        baseUrl: String(r.baseUrl.value || '').trim()
      }
      if (!tmp.endpoint || !tmp.username || !tmp.password) {
        context.ui.notice('请先填写完整的 XML-RPC 地址、用户名和密码', 'err', 2600)
        return
      }
      try {
        await xmlRpcCall(context, tmp, 'metaWeblog.getRecentPosts', [
          String(tmp.blogId || '0'),
          tmp.username,
          tmp.password,
          1
        ])
        context.ui.notice('连接测试成功', 'ok', 2400)
      } catch (e) {
        console.error('[Typecho Manager] 连接测试失败', e)
        const msg = e && e.message ? e.message : String(e || '未知错误')
        context.ui.notice('连接测试失败：' + msg, 'err', 3200)
      }
    })
  }

  const rows = settingsOverlayEl._rows
  rows.endpoint.value = sessionState.settings.endpoint || ''
  rows.username.value = sessionState.settings.username || ''
  rows.password.value = sessionState.settings.password || ''
  rows.blogId.value = sessionState.settings.blogId || '0'
  rows.baseUrl.value = sessionState.settings.baseUrl || ''
  rows.defaultDir.value = sessionState.settings.defaultDownloadDir || ''
  rows.always.checked = !!sessionState.settings.alwaysUseDefaultDir

  settingsOverlayEl.classList.remove('hidden')
}




// ---- 插件生命周期：右键菜单入口 ----

let globalContextRef = null
let ctxMenuDisposers = []

async function openManager(context) {
  globalContextRef = context
  // 每次打开时刷新设置到会话状态
  sessionState.settings = await loadSettings(context)
  openOverlay()
  // 打开后若还未加载文章则自动拉取一次
  if (!sessionState.posts || sessionState.posts.length === 0) {
    await refreshPosts(context)
  } else {
    await renderPostTable()
  }
}

export async function activate(context) {
  globalContextRef = context
  sessionState.settings = await loadSettings(context)
  if (context.addContextMenuItem) {
    try {
      const disposeManage = context.addContextMenuItem({
        label: '管理 Typecho 博文',
        icon: '📖',
        onClick: () => { void openManager(globalContextRef) }
      })
      if (typeof disposeManage === 'function') ctxMenuDisposers.push(disposeManage)
    } catch {}
    try {
      const disposePublish = context.addContextMenuItem({
        label: '发布当前文档到 Typecho',
        icon: '⬆️',
        onClick: () => { void publishCurrentDocument(globalContextRef) }
      })
      if (typeof disposePublish === 'function') ctxMenuDisposers.push(disposePublish)
    } catch {}
  }
}

export function deactivate() {
  globalContextRef = null
  if (ctxMenuDisposers && ctxMenuDisposers.length) {
    for (const fn of ctxMenuDisposers) {
      try {
        if (typeof fn === 'function') fn()
      } catch {}
    }
  }
  ctxMenuDisposers = []
}

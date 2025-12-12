// 属性视图插件：基于 YAML/front matter 与标签做简单查询并展示列表

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const PV_LOCALE_LS_KEY = 'flymd.locale'
function pvDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function pvGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(PV_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return pvDetectLocale()
}
function pvText(zh, en) {
  return pvGetLocale() === 'en' ? en : zh
}

// 配置默认值
const PV_DEFAULT_CONFIG = {
  maxFiles: 500, // 扫描的最大文件数上限
  maxResults: 200, // 单次显示的最大结果数
}

// 运行时状态
let PV_RUNTIME_CTX = null

// 统一注入样式（列表视图 + 设置窗口），并保证 z-index 高于扩展市场 ext-overlay (80000)
let PV_STYLE_READY = false
function pvEnsureStyle() {
  if (PV_STYLE_READY) return
  if (typeof document === 'undefined') return
  PV_STYLE_READY = true
  const style = document.createElement('style')
  style.setAttribute('data-flymd-plugin', 'property-view')
  style.textContent = `
.pv-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  /* 需要高于扩展市场 ext-overlay (z-index: 80000) */
  z-index: 90020;
}
.pv-dialog {
  background: var(--flymd-panel-bg, #fff);
  color: inherit;
  width: 880px;
  max-width: calc(100% - 40px);
  max-height: 80vh;
  border-radius: 10px;
  box-shadow: 0 18px 40px rgba(0,0,0,0.35);
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.pv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  font-weight: 600;
}
.pv-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pv-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pv-close-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}
.pv-close-btn:hover {
  background: rgba(0,0,0,0.06);
}
.pv-body {
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}
.pv-filter-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.pv-filter-row label {
  font-size: 12px;
  opacity: 0.9;
}
.pv-filter-input {
  flex: 1;
  min-width: 140px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.15);
  font-size: 13px;
}
.pv-filter-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37,99,235,0.25);
}
.pv-filter-tag {
  width: 160px;
}
.pv-filter-row button {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.18);
  background: rgba(127,127,127,0.05);
  cursor: pointer;
  font-size: 12px;
}
.pv-filter-row button:hover {
  background: rgba(127,127,127,0.12);
}
.pv-meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: rgba(0,0,0,0.55);
}
.pv-table-wrap {
  flex: 1;
  min-height: 160px;
  border-radius: 6px;
  border: 1px solid rgba(0,0,0,0.06);
  overflow: hidden;
  background: rgba(127,127,127,0.02);
}
.pv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pv-table thead {
  background: rgba(127,127,127,0.06);
}
.pv-table th,
.pv-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(0,0,0,0.04);
}
.pv-table th {
  text-align: left;
  font-weight: 500;
  color: rgba(0,0,0,0.7);
}
.pv-table tbody tr {
  cursor: pointer;
}
.pv-table tbody tr:nth-child(2n) {
  background: rgba(127,127,127,0.03);
}
.pv-table tbody tr:hover {
  background: rgba(37,99,235,0.08);
}
.pv-tag {
  display: inline-block;
  margin: 0 4px 2px 0;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(37,99,235,0.1);
  color: #1d4ed8;
}
.pv-empty {
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: rgba(0,0,0,0.55);
}
.pv-footer {
  padding: 8px 14px 10px;
  border-top: 1px solid rgba(0,0,0,0.06);
  display: flex;
  justify-content: flex-end;
  font-size: 12px;
  color: rgba(0,0,0,0.55);
}

.pv-settings-dialog {
  background: var(--flymd-panel-bg, #fff);
  color: inherit;
  min-width: 360px;
  max-width: 420px;
  border-radius: 8px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
  padding: 14px 18px 12px;
  font-size: 13px;
}
.pv-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
}
.pv-settings-body {
  margin-bottom: 10px;
}
.pv-settings-row {
  margin-bottom: 8px;
}
.pv-settings-row label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pv-settings-row span {
  flex: 1;
}
.pv-settings-row input[type="number"] {
  width: 90px;
  padding: 3px 6px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.2);
}
.pv-settings-tip {
  margin-top: 3px;
  font-size: 11px;
  color: rgba(0,0,0,0.55);
}
.pv-settings-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pv-settings-btn {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.2);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}
.pv-settings-btn-primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.pv-settings-btn:hover {
  opacity: 0.92;
}
`
  document.head.appendChild(style)
}

// 加载配置
async function pvLoadConfig(context) {
  try {
    if (!context || !context.storage || typeof context.storage.get !== 'function') {
      return { ...PV_DEFAULT_CONFIG }
    }
    const raw = (await context.storage.get('config')) || {}
    const cfg = typeof raw === 'object' && raw ? raw : {}
    let maxFiles = PV_DEFAULT_CONFIG.maxFiles
    let maxResults = PV_DEFAULT_CONFIG.maxResults
    if (cfg && typeof cfg.maxFiles !== 'undefined') {
      const n = Number(cfg.maxFiles)
      if (Number.isFinite(n) && n > 0) {
        maxFiles = Math.min(Math.max(10, Math.floor(n)), 5000)
      }
    }
    if (cfg && typeof cfg.maxResults !== 'undefined') {
      const m = Number(cfg.maxResults)
      if (Number.isFinite(m) && m > 0) {
        maxResults = Math.min(Math.max(10, Math.floor(m)), 2000)
      }
    }
    return {
      maxFiles,
      maxResults,
    }
  } catch {
    return { ...PV_DEFAULT_CONFIG }
  }
}

// 保存配置
async function pvSaveConfig(context, cfg) {
  try {
    if (!context || !context.storage || typeof context.storage.set !== 'function') return
    const next = {
      maxFiles:
        Number.isFinite(cfg.maxFiles) && cfg.maxFiles > 0
          ? Math.min(Math.max(10, Math.floor(cfg.maxFiles)), 5000)
          : PV_DEFAULT_CONFIG.maxFiles,
      maxResults:
        Number.isFinite(cfg.maxResults) && cfg.maxResults > 0
          ? Math.min(Math.max(10, Math.floor(cfg.maxResults)), 2000)
          : PV_DEFAULT_CONFIG.maxResults,
    }
    await context.storage.set('config', next)
  } catch {}
}

// 简单拆分 YAML front matter
function pvSplitFrontMatter(src) {
  const original = String(src || '')
  if (!original.trim()) {
    return { frontMatter: null, body: '' }
  }
  let text = original
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  const lines = text.split(/\r?\n/)
  if (!lines.length || lines[0].trim() !== '---') {
    return { frontMatter: null, body: original }
  }
  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    return { frontMatter: null, body: original }
  }
  const frontLines = lines.slice(0, endIndex + 1)
  const bodyLines = lines.slice(endIndex + 1)
  const frontMatter = frontLines.join('\n')
  const body = bodyLines.join('\n')
  return { frontMatter, body }
}

// 从 front matter 中提取 title / tags / created / updated
function pvParseMeta(front) {
  const meta = {
    title: '',
    tags: [],
    created: '',
    updated: '',
  }
  if (!front) return meta
  const lines = String(front || '').split(/\r?\n/)
  let inHeader = false
  let inTagsList = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = String(raw || '').trim()
    if (!line) continue
    if (line === '---') {
      if (!inHeader) {
        inHeader = true
        continue
      } else {
        break
      }
    }
    if (!inHeader) continue
    if (line.startsWith('#')) continue
    if (/^tags\s*:/i.test(line)) {
      inTagsList = false
      const m = line.match(/^tags\s*:\s*(.*)$/i)
      const rest = (m && m[1]) || ''
      if (!rest) {
        inTagsList = true
        continue
      }
      if (rest.startsWith('[') && rest.endsWith(']')) {
        const inner = rest.slice(1, -1)
        const parts = inner.split(',').map((x) => x.trim()).filter(Boolean)
        meta.tags = parts.map((s) => pvStripYamlQuotes(s))
        continue
      }
      const parts = rest.split(',').map((x) => x.trim()).filter(Boolean)
      meta.tags = parts.map((s) => pvStripYamlQuotes(s))
      continue
    }
    if (inTagsList) {
      if (/^- /.test(line)) {
        const v = line.replace(/^-+/, '').trim()
        if (v) meta.tags.push(pvStripYamlQuotes(v))
        continue
      } else {
        inTagsList = false
      }
    }
    const t = pvMatchScalar(line, 'title')
    if (t && !meta.title) {
      meta.title = t
      continue
    }
    const c = pvMatchScalar(line, 'created')
    if (c && !meta.created) {
      meta.created = c
      continue
    }
    const u = pvMatchScalar(line, 'updated')
    if (u && !meta.updated) {
      meta.updated = u
      continue
    }
  }
  return meta
}

function pvStripYamlQuotes(v) {
  let s = String(v || '').trim()
  if (!s) return ''
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1)
  }
  return s.trim()
}

function pvMatchScalar(line, key) {
  const re = new RegExp('^' + key + '\\s*:\\s*(.+)$', 'i')
  const m = line.match(re)
  if (!m) return ''
  return pvStripYamlQuotes(m[1])
}

// 从正文中推断标题：优先使用第一个 Markdown 标题行
function pvInferTitleFromBody(body) {
  const lines = String(body || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const title = line.replace(/^#+\s*/, '').trim()
      if (title) return title
    }
  }
  return ''
}

// 读取库内文档并构建简单索引
async function pvBuildIndex(context, cfg) {
  const out = []
  if (!context || typeof context.listLibraryFiles !== 'function') {
    return out
  }
  let files = []
  try {
    files = (await context.listLibraryFiles({
      extensions: ['md', 'markdown'],
      maxDepth: 64,
    })) || []
  } catch (e) {
    console.error('[property-view] 列出库文件失败', e)
    return out
  }
  if (!files || !files.length) return out
  const limit = Math.min(cfg.maxFiles || PV_DEFAULT_CONFIG.maxFiles, files.length)
  const slice = files.slice(0, limit)
  for (let i = 0; i < slice.length; i++) {
    const f = slice[i]
    let text = ''
    try {
      if (typeof context.readTextFile === 'function') {
        text = (await context.readTextFile(f.path)) || ''
      } else if (typeof context.readFile === 'function') {
        text = (await context.readFile(f.path)) || ''
      }
    } catch (e) {
      console.warn('[property-view] 读取文件失败', f.path, e)
      continue
    }
    const { frontMatter, body } = pvSplitFrontMatter(text)
    const meta = pvParseMeta(frontMatter)
    if (!meta.title) {
      meta.title = pvInferTitleFromBody(body) || f.name
    }
    const normTags = Array.isArray(meta.tags) ? meta.tags : []
    out.push({
      path: f.path,
      relative: f.relative || f.path,
      name: f.name || '',
      title: meta.title || f.name || '',
      tags: normTags,
      created: meta.created || '',
      updated: meta.updated || '',
      mtime: typeof f.mtime === 'number' ? f.mtime : 0,
    })
  }
  return out
}

// 根据简单查询过滤结果：关键字匹配 标题 / 路径 / 标签，标签筛选支持多标签 AND
function pvFilterDocs(docs, keyword, tagQuery) {
  const kw = String(keyword || '').trim().toLowerCase()
  const tagRaw = String(tagQuery || '')
  const tagParts = tagRaw
    .split(/[;,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
  return docs.filter((d) => {
    if (kw) {
      const hay =
        (d.title || '') +
        ' ' +
        (d.relative || '') +
        ' ' +
        (Array.isArray(d.tags) ? d.tags.join(' ') : '')
      if (!hay.toLowerCase().includes(kw)) return false
    }
    if (tagParts.length) {
      const tags = (Array.isArray(d.tags) ? d.tags : []).map((t) =>
        String(t || '').toLowerCase(),
      )
      for (let i = 0; i < tagParts.length; i++) {
        if (!tags.includes(tagParts[i])) return false
      }
    }
    return true
  })
}

function pvFormatDate(ts) {
  if (!ts || !Number.isFinite(ts)) return ''
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  } catch {
    return ''
  }
}

// 打开属性视图窗口
async function pvOpenViewDialog(context) {
  if (typeof document === 'undefined') return
  pvEnsureStyle()
  const cfg = await pvLoadConfig(context)

  const overlay = document.createElement('div')
  overlay.className = 'pv-overlay'

  const dialog = document.createElement('div')
  dialog.className = 'pv-dialog'

  const header = document.createElement('div')
  header.className = 'pv-header'

  const headerLeft = document.createElement('div')
  headerLeft.className = 'pv-header-left'
  const titleEl = document.createElement('div')
  titleEl.textContent = pvText('属性视图', 'Property View')
  const tipEl = document.createElement('div')
  tipEl.style.fontSize = '11px'
  tipEl.style.opacity = '0.75'
  tipEl.textContent = pvText('按 YAML 元数据与标签筛选当前库中的 Markdown 文档', 'Filter Markdown files in the current library by YAML metadata and tags.')
  headerLeft.appendChild(titleEl)
  headerLeft.appendChild(tipEl)

  const headerActions = document.createElement('div')
  headerActions.className = 'pv-header-actions'
  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = pvText('重新扫描', 'Rescan')
  refreshBtn.style.padding = '4px 10px'
  refreshBtn.style.borderRadius = '6px'
  refreshBtn.style.border = '1px solid rgba(0,0,0,0.18)'
  refreshBtn.style.background = 'rgba(127,127,127,0.05)'
  refreshBtn.style.cursor = 'pointer'
  refreshBtn.style.fontSize = '12px'

  const closeBtn = document.createElement('button')
  closeBtn.className = 'pv-close-btn'
  closeBtn.textContent = '×'

  headerActions.appendChild(refreshBtn)
  headerActions.appendChild(closeBtn)
  header.appendChild(headerLeft)
  header.appendChild(headerActions)

  const body = document.createElement('div')
  body.className = 'pv-body'

  const filterRow = document.createElement('div')
  filterRow.className = 'pv-filter-row'

  const kwInput = document.createElement('input')
  kwInput.className = 'pv-filter-input'
  kwInput.placeholder = pvText('关键字（标题/路径/标签）', 'Keyword (title/path/tags)')

  const tagInput = document.createElement('input')
  tagInput.className = 'pv-filter-input pv-filter-tag'
  tagInput.placeholder = pvText('标签（用空格或逗号分隔）', 'Tags (space/comma separated)')

  const applyBtn = document.createElement('button')
  applyBtn.textContent = pvText('应用筛选', 'Apply filters')

  filterRow.appendChild(kwInput)
  filterRow.appendChild(tagInput)
  filterRow.appendChild(applyBtn)

  const metaRow = document.createElement('div')
  metaRow.className = 'pv-meta-row'
  const metaLeft = document.createElement('div')
  const metaRight = document.createElement('div')
  metaRow.appendChild(metaLeft)
  metaRow.appendChild(metaRight)

  const tableWrap = document.createElement('div')
  tableWrap.className = 'pv-table-wrap'
  const table = document.createElement('table')
  table.className = 'pv-table'
  const thead = document.createElement('thead')
  const headTr = document.createElement('tr')
  ;[
    pvText('标题', 'Title'),
    pvText('相对路径', 'Relative path'),
    'Tags',
    pvText('创建/更新', 'Created/Updated'),
  ].forEach((text) => {
    const th = document.createElement('th')
    th.textContent = text
    headTr.appendChild(th)
  })
  thead.appendChild(headTr)
  const tbody = document.createElement('tbody')
  table.appendChild(thead)
  table.appendChild(tbody)
  tableWrap.appendChild(table)

  const footer = document.createElement('div')
  footer.className = 'pv-footer'

  body.appendChild(filterRow)
  body.appendChild(metaRow)
  body.appendChild(tableWrap)

  dialog.appendChild(header)
  dialog.appendChild(body)
  dialog.appendChild(footer)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  let allDocs = []

  function close() {
    try {
      overlay.remove()
    } catch {}
  }

  closeBtn.onclick = () => close()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  async function rebuild() {
    metaLeft.textContent = pvText('正在扫描库内文档…', 'Scanning library documents…')
    metaRight.textContent = ''
    tbody.innerHTML = ''
    footer.textContent = ''
    try {
      allDocs = await pvBuildIndex(context, cfg)
      const total = allDocs.length
      metaLeft.textContent =
        pvText('已索引文档数：', 'Indexed documents: ') + total
      metaRight.textContent =
        pvText('最大扫描文件数：', 'Max scanned files: ') + cfg.maxFiles
      applyFilters()
    } catch (e) {
      console.error('[property-view] 重建索引失败', e)
      metaLeft.textContent = pvText('索引失败，请检查控制台日志。', 'Index build failed, please check console.')
    }
  }

  function applyFilters() {
    const filtered = pvFilterDocs(allDocs, kwInput.value, tagInput.value)
    const total = filtered.length
    const maxResults = cfg.maxResults || PV_DEFAULT_CONFIG.maxResults
    const slice = filtered.slice(0, maxResults)
    tbody.innerHTML = ''
    if (!slice.length) {
      const emptyTr = document.createElement('tr')
      const td = document.createElement('td')
      td.colSpan = 4
      td.className = 'pv-empty'
      td.textContent = pvText('没有匹配的文档。', 'No matching documents.')
      emptyTr.appendChild(td)
      tbody.appendChild(emptyTr)
    } else {
      slice.forEach((doc) => {
        const tr = document.createElement('tr')
        const tdTitle = document.createElement('td')
        tdTitle.textContent = doc.title || doc.name || ''

        const tdPath = document.createElement('td')
        tdPath.textContent = doc.relative || doc.path

        const tdTags = document.createElement('td')
        if (doc.tags && doc.tags.length) {
          doc.tags.forEach((t) => {
            const span = document.createElement('span')
            span.className = 'pv-tag'
            span.textContent = t
            tdTags.appendChild(span)
          })
        }

        const tdTime = document.createElement('td')
        const created = doc.created || ''
        const updated = doc.updated || pvFormatDate(doc.mtime)
        tdTime.textContent =
          (created || updated
            ? `${created || ''}${created && updated ? ' / ' : ''}${updated || ''}`
            : '')

        tr.appendChild(tdTitle)
        tr.appendChild(tdPath)
        tr.appendChild(tdTags)
        tr.appendChild(tdTime)

        tr.addEventListener('click', () => {
          try {
            if (context && typeof context.openFileByPath === 'function') {
              context.openFileByPath(doc.path)
            }
          } catch (e) {
            console.error('[property-view] 打开文档失败', e)
          }
        })

        tbody.appendChild(tr)
      })
    }
    footer.textContent =
      pvText('匹配结果：', 'Matched: ') +
      total +
      (total > maxResults
        ? pvText(`（仅显示前 ${maxResults} 条）`, ` (showing first ${maxResults})`)
        : '')
  }

  applyBtn.onclick = applyFilters
  kwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFilters()
  })
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyFilters()
  })
  refreshBtn.onclick = () => {
    rebuild()
  }

  rebuild().catch(() => {})
}

// 打开设置窗口（由宿主在扩展面板中调用）
async function pvOpenSettingsDialog(context) {
  if (typeof document === 'undefined') return null
  pvEnsureStyle()
  const cfg = await pvLoadConfig(context)

  return await new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'pv-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'pv-settings-dialog'

    const header = document.createElement('div')
    header.className = 'pv-settings-header'
    const title = document.createElement('div')
    title.textContent = pvText('属性视图设置', 'Property View Settings')
    const btnClose = document.createElement('button')
    btnClose.className = 'pv-close-btn'
    btnClose.textContent = '×'
    header.appendChild(title)
    header.appendChild(btnClose)

    const body = document.createElement('div')
    body.className = 'pv-settings-body'

    const rowMaxFiles = document.createElement('div')
    rowMaxFiles.className = 'pv-settings-row'
    const labelMaxFiles = document.createElement('label')
    const spanMaxFiles = document.createElement('span')
    spanMaxFiles.textContent = pvText(
      '最大扫描文件数',
      'Maximum number of files to scan',
    )
    const inputMaxFiles = document.createElement('input')
    inputMaxFiles.type = 'number'
    inputMaxFiles.min = '10'
    inputMaxFiles.max = '5000'
    inputMaxFiles.step = '10'
    inputMaxFiles.value = String(cfg.maxFiles || PV_DEFAULT_CONFIG.maxFiles)
    labelMaxFiles.appendChild(spanMaxFiles)
    labelMaxFiles.appendChild(inputMaxFiles)
    const tipMaxFiles = document.createElement('div')
    tipMaxFiles.className = 'pv-settings-tip'
    tipMaxFiles.textContent = pvText(
      '用于限制一次索引的文档数量，避免在超大文档库中阻塞界面。',
      'Limit how many files are indexed in one scan to avoid blocking the UI on very large libraries.',
    )
    rowMaxFiles.appendChild(labelMaxFiles)
    rowMaxFiles.appendChild(tipMaxFiles)

    const rowMaxResults = document.createElement('div')
    rowMaxResults.className = 'pv-settings-row'
    const labelMaxResults = document.createElement('label')
    const spanMaxResults = document.createElement('span')
    spanMaxResults.textContent = pvText(
      '最大显示结果数',
      'Maximum number of results to display',
    )
    const inputMaxResults = document.createElement('input')
    inputMaxResults.type = 'number'
    inputMaxResults.min = '10'
    inputMaxResults.max = '2000'
    inputMaxResults.step = '10'
    inputMaxResults.value = String(
      cfg.maxResults || PV_DEFAULT_CONFIG.maxResults,
    )
    labelMaxResults.appendChild(spanMaxResults)
    labelMaxResults.appendChild(inputMaxResults)
    const tipMaxResults = document.createElement('div')
    tipMaxResults.className = 'pv-settings-tip'
    tipMaxResults.textContent = pvText(
      '匹配结果超过该数量时，仅渲染前若干条，避免列表过长。',
      'When there are too many matches, only the first N rows are rendered to keep the list manageable.',
    )
    rowMaxResults.appendChild(labelMaxResults)
    rowMaxResults.appendChild(tipMaxResults)

    body.appendChild(rowMaxFiles)
    body.appendChild(rowMaxResults)

    const footer = document.createElement('div')
    footer.className = 'pv-settings-footer'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'pv-settings-btn'
    btnCancel.textContent = pvText('取消', 'Cancel')
    const btnOk = document.createElement('button')
    btnOk.className = 'pv-settings-btn pv-settings-btn-primary'
    btnOk.textContent = pvText('保存', 'Save')
    footer.appendChild(btnCancel)
    footer.appendChild(btnOk)

    dialog.appendChild(header)
    dialog.appendChild(body)
    dialog.appendChild(footer)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    function close(result) {
      try {
        overlay.remove()
      } catch {}
      resolve(result)
    }

    btnClose.onclick = () => close(null)
    btnCancel.onclick = () => close(null)
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null)
    }
    btnOk.onclick = () => {
      const maxFiles = parseInt(inputMaxFiles.value || '', 10)
      const maxResults = parseInt(inputMaxResults.value || '', 10)
      const next = {
        maxFiles:
          Number.isFinite(maxFiles) && maxFiles > 0
            ? maxFiles
            : PV_DEFAULT_CONFIG.maxFiles,
        maxResults:
          Number.isFinite(maxResults) && maxResults > 0
            ? maxResults
            : PV_DEFAULT_CONFIG.maxResults,
      }
      close(next)
    }
  })
}

// 插件主入口
export async function activate(context) {
  PV_RUNTIME_CTX = context

  // 对外暴露 API，方便其他插件跳转到属性视图
  if (typeof context.registerAPI === 'function') {
    try {
      context.registerAPI('property-view', {
        // 打开属性视图主窗口
        openView: () => pvOpenViewDialog(context),
      })
    } catch (e) {
      try {
        console.error('[property-view] registerAPI 失败', e)
      } catch {}
    }
  }

  // 在“插件”菜单中添加入口
  if (typeof context.addMenuItem === 'function') {
    context.addMenuItem({
      label: pvText('属性视图', 'Property View'),
      title: pvText(
        '按 YAML 元数据与标签浏览文档列表',
        'Browse files by YAML metadata and tags',
      ),
      onClick: () => {
        pvOpenViewDialog(context)
      },
    })
  }
}

export async function openSettings(context) {
  const next = await pvOpenSettingsDialog(context)
  if (!next) return
  await pvSaveConfig(context, next)
  if (context && context.ui && typeof context.ui.notice === 'function') {
    context.ui.notice(
      pvText('属性视图设置已保存', 'Property View settings saved'),
      'ok',
      1800,
    )
  }
}

export function deactivate() {
  PV_RUNTIME_CTX = null
}

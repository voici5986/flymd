// Git 版本管理插件（库级 / 当前文档）
// 目标：给普通写作用户一个「像 VSCode 一样」的 Git 侧栏，但只做读 + 显式提交，不做任何破坏性操作。
// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const GIT_HISTORY_LOCALE_LS_KEY = 'flymd.locale'
function gitHistDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function gitHistGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(GIT_HISTORY_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return gitHistDetectLocale()
}
function gitText(zh, en) {
  return gitHistGetLocale() === 'en' ? en : zh
}

const PANEL_ID = 'flymd-git-history-panel'
const PANEL_WIDTH = 400

let panelEl = null
let historyListEl = null
let diffEl = null
let statusEl = null
let commitMsgInput = null
let commitScopeSelect = null
let refreshBtn = null
let initRepoBtn = null

let currentRepoRoot = null
let currentSummary = null
let currentFilePath = null
let panelVisible = false
let dockHandle = null
let layoutUnsub = null
let resizeBound = null
let diffOverlayEl = null
let diffOverlayContentEl = null
let lastDiffLines = null
let panelTheme = 'auto' // 'auto' | 'dark' | 'light'

function getDoc() {
  return window.document
}

function isDarkMode() {
  try {
    const doc = getDoc()
    if (doc && doc.body && doc.body.classList.contains('dark-mode')) return true
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return true
    }
  } catch {}
  return false
}

function isPanelDark() {
  if (panelTheme === 'dark') return true
  if (panelTheme === 'light') return false
  return isDarkMode()
}

function applyWorkspaceBoundsToPanel() {
  try {
    if (!panelEl) return
    const doc = getDoc()
    const container = doc.querySelector('.container')
    const viewportHeight = window.innerHeight || 720
    let top = 0
    let height = viewportHeight
    if (container && container.getBoundingClientRect) {
      const rect = container.getBoundingClientRect()
      top = Math.max(0, rect.top || 0)
      height = rect.height || Math.max(0, viewportHeight - top)
    }
    panelEl.style.top = `${top}px`
    panelEl.style.height = `${height}px`
  } catch {}
}

function applyWorkspaceBoundsToDiffOverlay() {
  try {
    if (!diffOverlayEl) return
    const doc = getDoc()
    const container = doc.querySelector('.container')
    const viewportHeight = window.innerHeight || 720
    const viewportWidth = window.innerWidth || 1280
    let top = 0
    let left = 0
    let width = viewportWidth
    let height = viewportHeight
    if (container && container.getBoundingClientRect) {
      const rect = container.getBoundingClientRect()
      top = Math.max(0, rect.top || 0)
      left = rect.left || 0
      width = rect.width || viewportWidth
      height = rect.height || Math.max(0, viewportHeight - top)
    }
    diffOverlayEl.style.top = `${top}px`
    diffOverlayEl.style.left = `${left}px`
    diffOverlayEl.style.width = `${width}px`
    diffOverlayEl.style.height = `${height}px`
  } catch {}
}

function ensurePanel(context) {
  if (panelEl) return panelEl
  const dark = isPanelDark()
  const doc = getDoc()
  const root = doc.createElement('div')
  root.id = PANEL_ID
  root.style.position = 'fixed'
  root.style.right = '0'
  root.style.width = PANEL_WIDTH + 'px'
  root.style.background = dark ? '#1a1b1e' : '#ffffff'
  root.style.borderLeft = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  root.style.boxSizing = 'border-box'
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.fontSize = '14px'
  root.style.color = dark ? '#e5e7eb' : '#0f172a'
  root.style.zIndex = '1200'
  root.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  root.style.pointerEvents = 'auto'

  const header = doc.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.padding = '6px 8px'
  header.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  header.style.background = dark ? '#1a1b1e' : '#ffffff'

  const title = doc.createElement('div')
  title.textContent = gitText('Git 版本管理', 'Git History')
  title.style.fontWeight = '600'
  title.style.fontSize = '14px'
  title.style.color = dark ? '#e5e7eb' : '#111827'

  const headerBtns = doc.createElement('div')
  headerBtns.style.display = 'flex'
  headerBtns.style.gap = '6px'
  headerBtns.style.alignItems = 'center'

  const themeBtn = doc.createElement('button')
  themeBtn.textContent = isPanelDark() ? gitText('日间', 'Light') : gitText('夜间', 'Dark')
  themeBtn.style.fontSize = '13px'
  themeBtn.style.padding = '2px 6px'
  themeBtn.style.cursor = 'pointer'
  themeBtn.style.borderRadius = '6px'
  themeBtn.style.border = dark ? '1px solid #4b5563' : '1px solid #d1d5db'
  themeBtn.style.background = dark ? '#111827' : '#ffffff'
  themeBtn.style.color = dark ? '#e5e7eb' : '#374151'
  themeBtn.addEventListener('click', async () => {
    panelTheme = isPanelDark() ? 'light' : 'dark'
    rebuildGitHistoryPanel(context)
    if (panelVisible) {
      setPanelVisible(true)
      await refreshAll(context)
    }
  })

  refreshBtn = doc.createElement('button')
  refreshBtn.textContent = gitText('刷新', 'Refresh')
  refreshBtn.style.fontSize = '13px'
  refreshBtn.style.padding = '2px 6px'
  refreshBtn.style.cursor = 'pointer'
  refreshBtn.style.borderRadius = '6px'
  refreshBtn.style.border = dark ? '1px solid #374151' : '1px solid #d1d5db'
  refreshBtn.style.background = dark ? '#1a1b1e' : '#ffffff'
  refreshBtn.style.color = dark ? '#e5e7eb' : '#374151'

  const closeBtn = doc.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.title = '关闭'
  closeBtn.style.width = '20px'
  closeBtn.style.height = '20px'
  closeBtn.style.fontSize = '14px'
  closeBtn.style.cursor = 'pointer'
  closeBtn.style.border = 'none'
  closeBtn.style.background = 'transparent'
  closeBtn.style.color = dark ? '#9ca3af' : '#9ca3af'

  headerBtns.appendChild(themeBtn)
  headerBtns.appendChild(refreshBtn)
  headerBtns.appendChild(closeBtn)
  header.appendChild(title)
  header.appendChild(headerBtns)

  const statusBar = doc.createElement('div')
  statusBar.style.padding = '4px 8px'
  statusBar.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  statusBar.style.whiteSpace = 'nowrap'
  statusBar.style.overflow = 'hidden'
  statusBar.style.textOverflow = 'ellipsis'
  statusBar.style.background = dark ? '#111827' : '#f9fafb'
  statusBar.style.color = dark ? '#9ca3af' : '#6b7280'
  statusEl = statusBar

  const initWrap = doc.createElement('div')
  initWrap.style.padding = '4px 8px'
  initWrap.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  initWrap.style.background = dark ? '#111827' : '#f9fafb'

  initRepoBtn = doc.createElement('button')
  initRepoBtn.textContent = gitText('在当前库初始化 Git 仓库', 'Initialize Git repository in current vault')
  initRepoBtn.style.width = '100%'
  initRepoBtn.style.fontSize = '13px'
  initRepoBtn.style.padding = '4px 6px'
  initRepoBtn.style.cursor = 'pointer'
  initRepoBtn.style.borderRadius = '6px'
  initRepoBtn.style.border = dark ? '1px solid #374151' : '1px solid #d1d5db'
  initRepoBtn.style.background = dark ? '#1a1b1e' : '#ffffff'
  initRepoBtn.style.color = dark ? '#e5e7eb' : '#111827'
  initRepoBtn.style.display = 'none'
  initWrap.appendChild(initRepoBtn)

  const commitBox = doc.createElement('div')
  commitBox.style.padding = '6px 8px'
  commitBox.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  commitBox.style.display = 'flex'
  commitBox.style.flexDirection = 'column'
  commitBox.style.gap = '4px'
  commitBox.style.background = dark ? '#111827' : '#f9fafb'

  const commitTitle = doc.createElement('div')
  commitTitle.textContent = gitText('创建快照（commit）', 'Create snapshot (commit)')
  commitTitle.style.fontWeight = '500'
  commitTitle.style.fontSize = '13px'
  commitTitle.style.color = dark ? '#e5e7eb' : '#111827'

  commitMsgInput = doc.createElement('input')
  commitMsgInput.type = 'text'
  commitMsgInput.placeholder = gitText('本次修改的说明，例如：重写引言', 'Commit message, e.g. "Rewrite introduction"')
  commitMsgInput.style.width = '100%'
  commitMsgInput.style.boxSizing = 'border-box'
  commitMsgInput.style.fontSize = '13px'
  commitMsgInput.style.padding = '4px 6px'
  commitMsgInput.style.borderRadius = '4px'
  commitMsgInput.style.border = dark ? '1px solid #374151' : '1px solid #d1d5db'
  commitMsgInput.style.background = dark ? '#111827' : '#ffffff'
  commitMsgInput.style.color = dark ? '#e5e7eb' : '#111827'

  const scopeRow = doc.createElement('div')
  scopeRow.style.display = 'flex'
  scopeRow.style.gap = '4px'

  commitScopeSelect = doc.createElement('select')
  commitScopeSelect.style.flex = '1'
  commitScopeSelect.style.fontSize = '13px'
  commitScopeSelect.style.borderRadius = '4px'
  commitScopeSelect.style.border = dark ? '1px solid #374151' : '1px solid #d1d5db'
  commitScopeSelect.style.background = dark ? '#111827' : '#ffffff'
  commitScopeSelect.style.color = dark ? '#e5e7eb' : '#111827'
  ;[
    { value: 'file', label: gitText('只提交当前文档', 'Commit current document only') },
    { value: 'all', label: gitText('提交库内所有变更', 'Commit all changes in vault') },
  ].forEach((opt) => {
    const o = doc.createElement('option')
    o.value = opt.value
    o.textContent = opt.label
    commitScopeSelect.appendChild(o)
  })

  const commitBtn = doc.createElement('button')
  commitBtn.textContent = gitText('提交', 'Commit')
  commitBtn.style.fontSize = '13px'
  commitBtn.style.padding = '2px 6px'
  commitBtn.style.cursor = 'pointer'
  commitBtn.style.borderRadius = '6px'
  commitBtn.style.border = '1px solid #2563eb'
  commitBtn.style.background = '#2563eb'
  commitBtn.style.color = '#ffffff'

  scopeRow.appendChild(commitScopeSelect)
  scopeRow.appendChild(commitBtn)

  commitBox.appendChild(commitTitle)
  commitBox.appendChild(commitMsgInput)
  commitBox.appendChild(scopeRow)

  const body = doc.createElement('div')
  body.style.flex = '1'
  body.style.display = 'flex'
  body.style.flexDirection = 'column'
  body.style.overflow = 'hidden'
  body.style.background = dark ? '#0b1120' : '#ffffff'

  const historyHeader = doc.createElement('div')
  historyHeader.textContent = gitText('当前文档历史', 'Current document history')
  historyHeader.style.fontSize = '13px'
  historyHeader.style.padding = '4px 8px'
  historyHeader.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  historyHeader.style.background = dark ? '#0b1120' : '#f9fafb'
  historyHeader.style.color = dark ? '#e5e7eb' : '#111827'

  const historyListWrap = doc.createElement('div')
  historyListWrap.style.flex = '1'
  historyListWrap.style.overflow = 'auto'
  historyListWrap.style.padding = '4px 8px'
  historyListWrap.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  historyListWrap.style.background = dark ? '#020617' : '#ffffff'

  historyListEl = doc.createElement('div')
  historyListEl.style.display = 'flex'
  historyListEl.style.flexDirection = 'column'
  historyListEl.style.gap = '4px'
  historyListWrap.appendChild(historyListEl)

  const diffHeader = doc.createElement('div')
  diffHeader.style.display = 'flex'
  diffHeader.style.alignItems = 'center'
  diffHeader.style.justifyContent = 'space-between'
  diffHeader.style.padding = '4px 8px'
  diffHeader.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  diffHeader.style.background = dark ? '#0b1120' : '#f9fafb'

  const diffTitle = doc.createElement('div')
  diffTitle.textContent = gitText('差异预览', 'Diff preview')
  diffTitle.style.fontSize = '13px'
  diffTitle.style.color = dark ? '#e5e7eb' : '#111827'

  const diffExpandBtn = doc.createElement('button')
  diffExpandBtn.textContent = gitText('在工作区大窗查看', 'View diff in main workspace')
  diffExpandBtn.style.fontSize = '12px'
  diffExpandBtn.style.padding = '2px 6px'
  diffExpandBtn.style.cursor = 'pointer'
  diffExpandBtn.style.borderRadius = '4px'
  diffExpandBtn.style.border = dark ? '1px solid #4b5563' : '1px solid #d1d5db'
  diffExpandBtn.style.background = dark ? '#111827' : '#ffffff'
  diffExpandBtn.style.color = dark ? '#e5e7eb' : '#374151'
  diffExpandBtn.addEventListener('click', () => {
    openDiffOverlay()
  })

  diffHeader.appendChild(diffTitle)
  diffHeader.appendChild(diffExpandBtn)

  diffEl = doc.createElement('pre')
  diffEl.style.flex = '1'
  diffEl.style.margin = '0'
  diffEl.style.padding = '4px 8px'
  diffEl.style.overflow = 'auto'
  diffEl.style.background = dark ? '#020617' : '#f9fafb'
  diffEl.style.borderTop = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  diffEl.style.color = dark ? '#e5e7eb' : '#111827'
  diffEl.style.fontFamily = 'ui-monospace, Menlo, SFMono-Regular, Consolas, "Liberation Mono", "Courier New", monospace'
  diffEl.style.fontSize = '13px'
  diffEl.textContent = gitText('选择上方某个提交查看差异…', 'Select a commit above to view diff…')

  body.appendChild(historyHeader)
  body.appendChild(historyListWrap)
  body.appendChild(diffHeader)
  body.appendChild(diffEl)

  root.appendChild(header)
  root.appendChild(statusBar)
  root.appendChild(initWrap)
  root.appendChild(commitBox)
  root.appendChild(body)

  closeBtn.addEventListener('click', () => {
    setPanelVisible(false)
  })

  refreshBtn.addEventListener('click', () => {
    void refreshAll(context)
  })

  commitBtn.addEventListener('click', async () => {
    await doCommit(context)
  })

  initRepoBtn.addEventListener('click', async () => {
    await doInitRepo(context)
  })

  doc.body.appendChild(root)
  panelEl = root
  applyWorkspaceBoundsToPanel()
  return root
}

function destroyGitHistoryPanelDom() {
  try {
    if (panelEl && panelEl.parentElement) {
      panelEl.parentElement.removeChild(panelEl)
    }
  } catch {}
  panelEl = null
  historyListEl = null
  diffEl = null
  statusEl = null
  commitMsgInput = null
  commitScopeSelect = null
  refreshBtn = null
  initRepoBtn = null
}

function rebuildGitHistoryPanel(context) {
  destroyGitHistoryPanelDom()
  ensurePanel(context)
  applyWorkspaceBoundsToPanel()
}

function setPanelVisible(v) {
  panelVisible = !!v
  if (!panelEl) return
  panelEl.style.display = panelVisible ? 'flex' : 'none'
  if (dockHandle && typeof dockHandle.setVisible === 'function') {
    dockHandle.setVisible(panelVisible)
  }
}

async function resolveRepoSummary(context) {
  try {
    let hintPath = null
    if (typeof context.getLibraryRoot === 'function') {
      try {
        hintPath = (await context.getLibraryRoot()) || null
      } catch {}
    }
    if (!hintPath && typeof context.getCurrentFilePath === 'function') {
      try {
        const p = context.getCurrentFilePath()
        if (p) hintPath = p
      } catch {}
    }
    if (!hintPath) {
      return null
    }
    const summary = await context.invoke('git_status_summary', {
      repoPath: hintPath,
    })
    if (summary && summary.isRepo && summary.repoRoot) {
      currentRepoRoot = summary.repoRoot
    } else {
      currentRepoRoot = null
    }
    currentSummary = summary
    return summary
  } catch (e) {
    console.error('[git-history] git_status_summary 失败', e)
    context.ui.notice(
      gitText('Git 状态查询失败：', 'Git status query failed: ') +
        (e?.message || String(e)),
      'err',
      2600,
    )
    return null
  }
}

async function refreshStatusBar(context) {
  if (!statusEl) return
  if (!currentSummary || !currentRepoRoot) {
    statusEl.textContent = gitText(
      '当前库未初始化为 Git 仓库',
      'Current vault is not initialized as a Git repository',
    )
    initRepoBtn && (initRepoBtn.style.display = 'block')
    return
  }
  initRepoBtn && (initRepoBtn.style.display = 'none')
  const branch = currentSummary.branch || '(detached)'
  const head = currentSummary.head
  statusEl.textContent =
    gitText('仓库：', 'Repo: ') +
    `${currentRepoRoot}  ` +
    gitText('分支：', 'Branch: ') +
    `${branch}` +
    (head ? `  HEAD: ${head.slice(0, 7)}` : '')
}

async function refreshHistory(context) {
  if (!historyListEl) return
  historyListEl.innerHTML = ''
  diffEl &&
    (diffEl.textContent = gitText(
      '选择上方某个提交查看差异…',
      'Select a commit above to view diff…',
    ))

  try {
    if (!currentRepoRoot) {
      const p = typeof context.getCurrentFilePath === 'function' ? context.getCurrentFilePath() : null
      currentFilePath = p || null
      const label = currentFilePath
        ? gitText('当前库未在此路径初始化 Git', 'Current vault is not initialized as Git at this path')
        : gitText('当前文档尚未保存，无法查询历史', 'Current document is not saved, cannot query history')
      const row = document.createElement('div')
      row.textContent = label
      row.style.opacity = '0.7'
      historyListEl.appendChild(row)
      return
    }
    const p = typeof context.getCurrentFilePath === 'function' ? context.getCurrentFilePath() : null
    currentFilePath = p || null
    if (!currentFilePath) {
      const row = document.createElement('div')
      row.textContent = gitText(
        '当前文档尚未保存，无法查询历史',
        'Current document is not saved, cannot query history',
      )
      row.style.opacity = '0.7'
      historyListEl.appendChild(row)
      return
    }

    const list = await context.invoke('git_file_history', {
      repoPath: currentRepoRoot,
      filePath: currentFilePath,
      maxCount: 50,
    })
    if (!list || !Array.isArray(list) || list.length === 0) {
      const row = document.createElement('div')
      row.textContent = gitText(
        '当前文档尚无 Git 历史（可能尚未提交过）',
        'Current document has no Git history yet (possibly never committed)',
      )
      row.style.opacity = '0.7'
      historyListEl.appendChild(row)
      return
    }

    list.forEach((item) => {
      const row = document.createElement('div')
      row.style.padding = '4px 6px'
      row.style.borderRadius = '4px'
      row.style.cursor = 'pointer'
      row.style.border = '1px solid transparent'
      row.style.background = 'transparent'

      row.addEventListener('mouseenter', () => {
        row.style.borderColor = isPanelDark() ? '#1f2937' : '#e5e7eb'
        row.style.background = isPanelDark() ? '#020617' : '#f3f4f6'
      })
      row.addEventListener('mouseleave', () => {
        row.style.borderColor = 'transparent'
        row.style.background = 'transparent'
      })

      const title = document.createElement('div')
      title.textContent = item.summary || '(无说明)'
      title.style.fontSize = '13px'
      title.style.color = isPanelDark() ? '#e5e7eb' : '#111827'

      const meta = document.createElement('div')
      meta.style.fontSize = '12px'
      meta.style.opacity = '0.75'
      meta.style.color = isPanelDark() ? '#9ca3af' : '#6b7280'
      const hashShort = item.hash ? String(item.hash).slice(0, 7) : ''
      const author = item.author || ''
      const date = item.date || ''
      meta.textContent = `${hashShort}  ${author}  ${date}`

      const actionsRow = document.createElement('div')
      actionsRow.style.display = 'flex'
      actionsRow.style.justifyContent = 'flex-end'
      actionsRow.style.gap = '4px'

      const rollbackBtn = document.createElement('button')
      rollbackBtn.textContent = '恢复为此版本'
      rollbackBtn.style.fontSize = '12px'
      rollbackBtn.style.padding = '2px 6px'
      rollbackBtn.style.cursor = 'pointer'
      rollbackBtn.style.borderRadius = '4px'
      rollbackBtn.style.border = '1px solid #2563eb'
      rollbackBtn.style.background = '#2563eb'
      rollbackBtn.style.color = '#ffffff'
      rollbackBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        await rollbackToCommit(context, item.hash, item.summary)
      })

      actionsRow.appendChild(rollbackBtn)

      row.appendChild(title)
      row.appendChild(meta)
      row.appendChild(actionsRow)

      row.addEventListener('click', async () => {
        await loadDiffForCommit(context, item.hash)
      })

      historyListEl.appendChild(row)
    })
  } catch (e) {
    console.error('[git-history] 刷新历史失败', e)
    const row = document.createElement('div')
    row.textContent = '历史查询失败：' + (e?.message || String(e))
    row.style.opacity = '0.8'
    historyListEl.appendChild(row)
  }
}

async function rollbackToCommit(context, hash, summary) {
  try {
    if (!currentRepoRoot) {
      context.ui.notice('当前库未初始化为 Git 仓库', 'err', 2200)
      return
    }
    const p = typeof context.getCurrentFilePath === 'function'
      ? context.getCurrentFilePath()
      : null
    if (!p) {
      context.ui.notice('当前文档尚未保存，无法回滚', 'err', 2200)
      return
    }
    const ok = await context.ui.confirm(
      `确定要将当前文档内容恢复为所选提交版本？\n\n提交：${(summary || '').slice(0, 60)}\n\n此操作会覆盖当前文件内容，请确保已备份重要改动。`,
    )
    if (!ok) return
    await context.invoke('git_restore_file_version', {
      repoPath: currentRepoRoot,
      filePath: p,
      commit: hash,
    })
    try {
      if (typeof context.openFileByPath === 'function') {
        await context.openFileByPath(p)
      }
    } catch {}
    context.ui.notice(
      gitText(
        '已恢复为所选版本（如有需要可再创建一次快照）',
        'Restored to selected version (create another snapshot if needed)',
      ),
      'ok',
      2600,
    )
    await refreshAll(context)
  } catch (e) {
    console.error('[git-history] 回滚失败', e)
    context.ui.notice(
      gitText('回滚失败：', 'Rollback failed: ') + (e?.message || String(e)),
      'err',
      2600,
    )
  }
}

async function loadDiffForCommit(context, hash) {
  if (!diffEl) return
  try {
    if (!currentRepoRoot) {
      diffEl.textContent = gitText(
        '尚未检测到 Git 仓库',
        'No Git repository detected yet',
      )
      return
    }
    const p = currentFilePath
    if (!p) {
      diffEl.textContent = gitText(
        '当前文档尚未保存，无法查看差异',
        'Current document is not saved, cannot view diff',
      )
      return
    }

    const diff = await context.invoke('git_file_diff', {
      repoPath: currentRepoRoot,
      filePath: p,
      commit: hash || null,
      contextLines: 3,
    })
    const text =
      diff && String(diff).trim()
        ? String(diff)
        : gitText('无差异内容或 Git 返回空结果。', 'No diff content or Git returned empty result.')
    const lines = text.split('\n')
    lastDiffLines = lines
    renderDiffLines(diffEl, lines)
    if (diffOverlayContentEl && diffOverlayEl && diffOverlayEl.style.display !== 'none') {
      renderDiffLines(diffOverlayContentEl, lines)
    }
  } catch (e) {
    console.error('[git-history] 加载 diff 失败', e)
    diffEl.textContent =
      gitText('差异加载失败：', 'Failed to load diff: ') +
      (e?.message || String(e))
  }
}

function renderDiffLines(container, lines) {
  const dark = isPanelDark()
  container.innerHTML = ''
  lines.forEach((line) => {
    const row = document.createElement('div')
    row.textContent = line
    row.style.whiteSpace = 'pre'
    row.style.fontSize = '13px'
    if (line.startsWith('@@')) {
      row.style.color = '#60a5fa'
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      row.style.color = '#22c55e'
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      row.style.color = '#f97373'
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      row.style.color = '#9ca3af'
    } else {
      row.style.color = dark ? '#e5e7eb' : '#111827'
    }
    container.appendChild(row)
  })
}

function ensureDiffOverlay() {
  if (diffOverlayEl) return diffOverlayEl
  const doc = getDoc()
  const dark = isPanelDark()
  const overlay = doc.createElement('div')
  overlay.id = 'git-history-diff-overlay'
  overlay.style.position = 'fixed'
  overlay.style.zIndex = '1300'
  overlay.style.display = 'none'
  overlay.style.boxSizing = 'border-box'
  overlay.style.background = dark ? 'rgba(15,23,42,0.96)' : 'rgba(255,255,255,0.98)'

  const inner = doc.createElement('div')
  inner.style.display = 'flex'
  inner.style.flexDirection = 'column'
  inner.style.height = '100%'
  inner.style.width = '100%'

  const head = doc.createElement('div')
  head.style.display = 'flex'
  head.style.alignItems = 'center'
  head.style.justifyContent = 'space-between'
  head.style.padding = '6px 10px'
  head.style.borderBottom = dark ? '1px solid #1f2937' : '1px solid #e5e7eb'
  head.style.background = dark ? '#020617' : '#f9fafb'

  const title = doc.createElement('div')
  title.textContent = gitText('差异预览（全屏）', 'Diff preview (fullscreen)')
  title.style.fontSize = '14px'
  title.style.fontWeight = '600'
  title.style.color = dark ? '#e5e7eb' : '#111827'

  const closeBtn = doc.createElement('button')
  closeBtn.textContent = gitText('关闭', 'Close')
  closeBtn.style.fontSize = '13px'
  closeBtn.style.padding = '2px 8px'
  closeBtn.style.cursor = 'pointer'
  closeBtn.style.borderRadius = '6px'
  closeBtn.style.border = dark ? '1px solid #4b5563' : '1px solid #d1d5db'
  closeBtn.style.background = dark ? '#111827' : '#ffffff'
  closeBtn.style.color = dark ? '#e5e7eb' : '#374151'
  closeBtn.addEventListener('click', () => {
    overlay.style.display = 'none'
  })

  head.appendChild(title)
  head.appendChild(closeBtn)

  const contentWrap = doc.createElement('div')
  contentWrap.style.flex = '1'
  contentWrap.style.overflow = 'auto'
  contentWrap.style.padding = '8px 10px'

  const pre = doc.createElement('pre')
  pre.style.margin = '0'
  pre.style.fontFamily = 'ui-monospace, Menlo, SFMono-Regular, Consolas, "Liberation Mono", "Courier New", monospace'
  pre.style.fontSize = '14px'
  pre.style.background = 'transparent'
  pre.style.border = 'none'

  contentWrap.appendChild(pre)
  inner.appendChild(head)
  inner.appendChild(contentWrap)
  overlay.appendChild(inner)
  doc.body.appendChild(overlay)

  diffOverlayEl = overlay
  diffOverlayContentEl = pre
  applyWorkspaceBoundsToDiffOverlay()
  return overlay
}

function openDiffOverlay() {
  const overlay = ensureDiffOverlay()
  applyWorkspaceBoundsToDiffOverlay()
  overlay.style.display = 'block'
  if (lastDiffLines && Array.isArray(lastDiffLines)) {
    renderDiffLines(diffOverlayContentEl, lastDiffLines)
  } else if (diffEl && diffEl.textContent && diffEl.textContent.trim()) {
    const lines = diffEl.textContent.split('\n')
    renderDiffLines(diffOverlayContentEl, lines)
  }
}

async function doInitRepo(context) {
  try {
    const root = typeof context.getLibraryRoot === 'function'
      ? await context.getLibraryRoot()
      : null
    if (!root) {
      context.ui.notice(
        gitText(
          '当前未打开库，无法初始化 Git 仓库',
          'No vault is open, cannot initialize Git repository',
        ),
        'err',
        2200,
      )
      return
    }
    const ok = await context.ui.confirm(
      gitText(
        '在当前库根目录初始化 Git 仓库？\n不会同步远端，仅在本地创建 .git 用于版本管理。',
        'Initialize a Git repository in the root of current vault?\nThis will not sync to any remote; it only creates a local .git for versioning.',
      ),
    )
    if (!ok) return
    await context.invoke('git_init_repo', { repoPath: root })
    context.ui.notice(
      gitText('Git 仓库已初始化', 'Git repository initialized'),
      'ok',
      2000,
    )
    await refreshAll(context)
  } catch (e) {
    console.error('[git-history] 初始化仓库失败', e)
    context.ui.notice(
      gitText('初始化 Git 仓库失败：', 'Failed to initialize Git repository: ') +
        (e?.message || String(e)),
      'err',
      2600,
    )
  }
}

async function doCommit(context) {
  try {
    if (!currentRepoRoot) {
      context.ui.notice(
        gitText(
          '当前库未初始化为 Git 仓库',
          'Current vault is not initialized as a Git repository',
        ),
        'err',
        2200,
      )
      return
    }
    const msg = (commitMsgInput && commitMsgInput.value || '').trim()
    if (!msg) {
      context.ui.notice(
        gitText('请先填写提交说明', 'Please enter a commit message first'),
        'err',
        2000,
      )
      return
    }
    const scope = commitScopeSelect ? commitScopeSelect.value : 'file'
    let filePath = null
    if (scope === 'file') {
      const p = typeof context.getCurrentFilePath === 'function'
        ? context.getCurrentFilePath()
        : null
      if (!p) {
        context.ui.notice(
          gitText(
            '当前文档尚未保存，无法只提交当前文档',
            'Current document is not saved, cannot commit current document only',
          ),
          'err',
          2200,
        )
        return
      }
      filePath = p
    }

    await context.invoke('git_commit_snapshot', {
      repoPath: currentRepoRoot,
      filePath: filePath,
      message: msg,
      all: scope === 'all',
    })

    if (commitMsgInput) commitMsgInput.value = ''
    context.ui.notice(
      gitText(
        '提交完成（若无变更则自动跳过）',
        'Commit completed (skipped automatically if no changes)',
      ),
      'ok',
      2000,
    )
    await refreshAll(context)
  } catch (e) {
    console.error('[git-history] 提交失败', e)
    context.ui.notice(
      gitText('提交失败：', 'Commit failed: ') + (e?.message || String(e)),
      'err',
      2600,
    )
  }
}

async function refreshAll(context) {
  await resolveRepoSummary(context)
  await refreshStatusBar(context)
  await refreshHistory(context)
}

export async function activate(context) {
  // 兜底：确保 invoke 存在
  if (!context.invoke) {
    context.ui.notice(
      gitText(
        '当前环境不支持 Git 插件（缺少 invoke 能力）',
        'Current environment does not support Git plugin (missing invoke capability)',
      ),
      'err',
      2600,
    )
    return
  }

  // 注册布局 Panel，仅用于推挤编辑区，具体 DOM 自己管
  if (context.layout && typeof context.layout.registerPanel === 'function') {
    dockHandle = context.layout.registerPanel('git-history', {
      side: 'right',
      size: PANEL_WIDTH,
      visible: false,
    })
  }

  ensurePanel(context)
  setPanelVisible(false)
  applyWorkspaceBoundsToPanel()
  try {
    if (!resizeBound) {
      resizeBound = () => {
        applyWorkspaceBoundsToPanel()
        applyWorkspaceBoundsToDiffOverlay()
      }
      window.addEventListener('resize', resizeBound)
    }
  } catch {}

  try {
    const winObj = window
    const prev = winObj.__onWorkspaceLayoutChanged
    const handler = () => {
      applyWorkspaceBoundsToPanel()
      applyWorkspaceBoundsToDiffOverlay()
    }
    if (typeof prev === 'function') {
      winObj.__onWorkspaceLayoutChanged = () => {
        try { prev() } catch {}
        handler()
      }
      layoutUnsub = () => {
        try { winObj.__onWorkspaceLayoutChanged = prev } catch {}
      }
    } else {
      winObj.__onWorkspaceLayoutChanged = handler
      layoutUnsub = () => {
        try {
          if (winObj.__onWorkspaceLayoutChanged === handler) {
            winObj.__onWorkspaceLayoutChanged = null
          }
        } catch {}
      }
    }
  } catch {}

  // 在 Ribbon 栏注册快捷按钮
  if (typeof context.addRibbonButton === 'function') {
    context.addRibbonButton({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 0-9 9"/></svg>',
      iconType: 'svg',
      title: gitText('打开 Git 版本管理侧栏', 'Open Git history sidebar'),
      onClick: async () => {
        ensurePanel(context)
        setPanelVisible(!panelVisible)
        if (panelVisible) {
          await refreshAll(context)
        }
      }
    })
  }

  // 菜单：放到扩展菜单下
  context.addMenuItem({
    label: gitText('Git 版本', 'Git History'),
    title: gitText('打开 Git 版本管理侧栏', 'Open Git history sidebar'),
    onClick: async () => {
      ensurePanel(context)
      setPanelVisible(!panelVisible)
      if (panelVisible) {
        await refreshAll(context)
      }
    },
  })

  // 激活时预热一次状态，但不强制打开
  try {
    await resolveRepoSummary(context)
    await refreshStatusBar(context)
  } catch {}
}

export async function deactivate() {
  try {
    if (dockHandle && typeof dockHandle.dispose === 'function') {
      dockHandle.dispose()
    }
  } catch {}
  try {
    if (resizeBound) {
      window.removeEventListener('resize', resizeBound)
    }
  } catch {}
  resizeBound = null
  try {
    if (layoutUnsub) layoutUnsub()
  } catch {}
  layoutUnsub = null
  diffOverlayEl = null
  diffOverlayContentEl = null
  lastDiffLines = null
  try {
    if (panelEl && panelEl.parentElement) {
      panelEl.parentElement.removeChild(panelEl)
    }
  } catch {}
  panelEl = null
  historyListEl = null
  diffEl = null
  statusEl = null
  commitMsgInput = null
  commitScopeSelect = null
  refreshBtn = null
  initRepoBtn = null
  currentRepoRoot = null
  currentSummary = null
  currentFilePath = null
  panelVisible = false
  dockHandle = null
}

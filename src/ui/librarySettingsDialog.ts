// 库设置对话框：只做“库切换器显示/库顺序/WebDAV（启用+远端路径）”
// 关键点：不改库 id；不改已有 WebDAV 配置的默认兼容策略

import { t } from '../i18n'
import { getLibraries, getActiveLibraryId, applyLibrariesSettings, getLibSwitcherPosition, setLibSwitcherPosition, type LibSwitcherPosition } from '../utils/library'
import { getWebdavSyncConfigForLibrary, setWebdavSyncConfigForLibrary, openWebdavSyncDialog } from '../extensions/webdavSync'

type Opts = {
  // 通知外部刷新 UI（例如库侧栏的库列表）
  onRefreshUi?: () => void | Promise<void>
}

function normalizeRootPathInput(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  let p = raw.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  p = p.replace(/\/+$/, '')
  return p || '/'
}

function showNotice(msg: string): void {
  try {
    const nm = (window as any).NotificationManager
    if (nm && typeof nm.show === 'function') {
      nm.show('extension', msg)
      return
    }
  } catch {}
  try { console.log('[库设置]', msg) } catch {}
}

export async function openLibrarySettingsDialog(opts: Opts = {}): Promise<void> {
  const existing = document.getElementById('lib-settings-overlay') as HTMLDivElement | null
  if (existing) {
    try { existing.classList.remove('hidden') } catch {}
    return
  }

  const overlay = document.createElement('div') as HTMLDivElement
  overlay.id = 'lib-settings-overlay'
  overlay.className = 'upl-overlay'
  overlay.innerHTML = `
    <div class="upl-dialog lib-settings-dialog" role="dialog" aria-modal="true">
      <div class="upl-header">
        <span>${t('lib.settings.title') || '库设置'}</span>
        <button id="lib-settings-close" title="${t('common.close') || '关闭'}">×</button>
      </div>
      <div class="upl-body">
        <div class="upl-grid">
          <label>${t('lib.settings.current') || '当前库'}</label>
          <div class="lib-settings-cur">
            <span id="lib-settings-cur-name"></span>
          </div>

          <label>${t('lib.settings.switcher') || '库切换位置'}</label>
          <div class="upl-inline-row">
            <select id="lib-settings-switcher-pos" class="lib-settings-select">
              <option value="ribbon">${t('lib.settings.switcher.ribbon') || '垂直标题栏'}</option>
              <option value="sidebar">${t('lib.settings.switcher.sidebar') || '侧栏内'}</option>
            </select>
            <span class="upl-hint">${t('lib.settings.switcher.hint') || '多库切换图标显示位置'}</span>
          </div>

          <label>WebDAV</label>
          <div class="upl-inline-row">
            <label class="switch" for="lib-settings-webdav-enabled">
              <input id="lib-settings-webdav-enabled" type="checkbox"/>
              <span class="slider"></span>
            </label>
            <span class="upl-hint">${t('lib.settings.webdav.hint') || '只配置当前库；账号/地址等详细项可在 WebDAV 设置中调整'}</span>
          </div>

          <label>${t('lib.settings.webdav.root') || '远端路径'}</label>
          <div>
            <input id="lib-settings-webdav-root" type="text" placeholder="/<库名>"/>
            <div class="lib-settings-webdav-actions">
              <button id="lib-settings-open-webdav" type="button" class="btn-secondary">${t('lib.settings.webdav.open') || '打开 WebDAV 详细设置…'}</button>
            </div>
          </div>
        </div>

        <div class="lib-settings-sep"></div>

        <div class="lib-settings-subtitle">${t('lib.settings.order') || '库顺序与侧栏显示'}</div>
        <div id="lib-settings-list" class="lib-settings-list"></div>

        <div class="upl-actions">
          <button id="lib-settings-cancel" type="button" class="btn-secondary">${t('common.cancel') || '取消'}</button>
          <button id="lib-settings-save" type="button" class="btn-primary">${t('common.save') || '保存'}</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  const close = () => {
    try { overlay.remove() } catch {}
  }

  overlay.addEventListener('click', (e) => {
    try {
      if (e.target === overlay) close()
    } catch {}
  })
  overlay.querySelector('#lib-settings-close')?.addEventListener('click', close)
  overlay.querySelector('#lib-settings-cancel')?.addEventListener('click', close)

  const elCurName = overlay.querySelector('#lib-settings-cur-name') as HTMLSpanElement
  const elSwitcherPos = overlay.querySelector('#lib-settings-switcher-pos') as HTMLSelectElement
  const elWebdavEnabled = overlay.querySelector('#lib-settings-webdav-enabled') as HTMLInputElement
  const elWebdavRoot = overlay.querySelector('#lib-settings-webdav-root') as HTMLInputElement
  const elList = overlay.querySelector('#lib-settings-list') as HTMLDivElement
  const elOpenWebdav = overlay.querySelector('#lib-settings-open-webdav') as HTMLButtonElement | null

  const libs0 = await getLibraries()
  const activeId = await getActiveLibraryId()
  let selectedLibId = (activeId || libs0[0]?.id || null) as string | null

  // 初始化库切换位置设置
  let draftSwitcherPos: LibSwitcherPosition = await getLibSwitcherPosition()
  if (elSwitcherPos) elSwitcherPos.value = draftSwitcherPos

  // 对话框内的草稿状态：取消不落盘
  let draftOrderIds = libs0.map(l => l.id)
  const draftSidebarVisible = new Map<string, boolean>()
  for (const l of libs0) draftSidebarVisible.set(l.id, l.sidebarVisible !== false)

  const draftWebdav = new Map<string, { enabled: boolean; rootPathInput: string }>()
  const dirtyWebdav = new Set<string>()

  async function ensureWebdavDraftLoaded(id: string): Promise<void> {
    if (!id) return
    if (draftWebdav.has(id)) return
    const lib = libs0.find(x => x.id === id)
    const cfg = await (async () => {
      try {
        return await getWebdavSyncConfigForLibrary({ id, name: lib?.name, root: lib?.root })
      } catch {
        return null as any
      }
    })()
    if (!cfg) {
      draftWebdav.set(id, { enabled: false, rootPathInput: '' })
      return
    }
    draftWebdav.set(id, { enabled: !!cfg.enabled, rootPathInput: String(cfg.rootPath || '').trim() })
  }

  function syncSelectedUiFromDraft(): void {
    try {
      if (!selectedLibId) return
      const lib = libs0.find(x => x.id === selectedLibId)
      elCurName.textContent = lib?.name || (t('lib.menu') || '库')
      const w = draftWebdav.get(selectedLibId)
      if (w) {
        elWebdavEnabled.checked = !!w.enabled
        elWebdavRoot.value = w.rootPathInput || ''
        if (!elWebdavRoot.value) elWebdavRoot.placeholder = '/<库名>'
      }
      if (elOpenWebdav) {
        const isActive = !!(activeId && selectedLibId === activeId)
        elOpenWebdav.disabled = !isActive
        elOpenWebdav.title = isActive ? '' : '请先切换到该库再打开 WebDAV 详细设置'
      }
    } catch {}
  }

  async function selectLibraryForEditing(id: string): Promise<void> {
    const nextId = String(id || '').trim()
    if (!nextId) return
    selectedLibId = nextId
    await ensureWebdavDraftLoaded(nextId)
    syncSelectedUiFromDraft()
    renderList()
  }

  if (selectedLibId) {
    await ensureWebdavDraftLoaded(selectedLibId)
    syncSelectedUiFromDraft()
  }

  elWebdavEnabled.addEventListener('change', () => {
    try {
      if (!selectedLibId) return
      const cur = draftWebdav.get(selectedLibId) || { enabled: false, rootPathInput: '' }
      cur.enabled = !!elWebdavEnabled.checked
      draftWebdav.set(selectedLibId, cur)
      dirtyWebdav.add(selectedLibId)
    } catch {}
  })
  elWebdavRoot.addEventListener('input', () => {
    try {
      if (!selectedLibId) return
      const cur = draftWebdav.get(selectedLibId) || { enabled: false, rootPathInput: '' }
      cur.rootPathInput = String(elWebdavRoot.value || '')
      draftWebdav.set(selectedLibId, cur)
      dirtyWebdav.add(selectedLibId)
    } catch {}
  })

  function getDraftLibraries(): Array<{ id: string; name: string; root: string }> {
    const byId = new Map(libs0.map(l => [l.id, l] as const))
    const out: Array<{ id: string; name: string; root: string }> = []
    for (const id of draftOrderIds) {
      const l = byId.get(id)
      if (!l) continue
      out.push({ id: l.id, name: l.name, root: l.root })
    }
    // 补齐：避免草稿顺序丢库
    for (const l of libs0) {
      if (out.find(x => x.id === l.id)) continue
      out.push({ id: l.id, name: l.name, root: l.root })
    }
    return out
  }

  function renderList(): void {
    try {
      elList.innerHTML = ''
      const libs = getDraftLibraries()
      if (!libs || libs.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'pmm-empty'
        empty.textContent = t('lib.settings.empty') || '暂无库'
        elList.appendChild(empty)
        return
      }

      for (let i = 0; i < libs.length; i++) {
        const lib = libs[i]
        const row = document.createElement('div')
        row.className = 'lib-settings-row' + (lib.id === activeId ? ' active' : '') + (lib.id === selectedLibId ? ' selected' : '')

        const name = document.createElement('div')
        name.className = 'lib-settings-name'
        name.textContent = lib.name || lib.id
        name.title = lib.root
        name.addEventListener('click', () => { void selectLibraryForEditing(lib.id) })

        const right = document.createElement('div')
        right.className = 'lib-settings-right'

        const cbWrap = document.createElement('label')
        cbWrap.className = 'lib-settings-cb'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = draftSidebarVisible.get(lib.id) !== false
        cb.addEventListener('change', () => {
          try {
            draftSidebarVisible.set(lib.id, !!cb.checked)
          } catch {}
        })
        const cbText = document.createElement('span')
        cbText.textContent = t('lib.settings.sidebar.short') || '显示'
        cbWrap.appendChild(cb)
        cbWrap.appendChild(cbText)

        const btnUp = document.createElement('button')
        btnUp.type = 'button'
        btnUp.className = 'lib-settings-order-btn'
        btnUp.textContent = '↑'
        btnUp.disabled = i === 0
        btnUp.title = t('lib.settings.order.up') || '上移'
        btnUp.addEventListener('click', () => {
          try {
            if (i <= 0) return
            const ids = getDraftLibraries().map(x => x.id)
            ;[ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]
            draftOrderIds = ids
            renderList()
          } catch {}
        })

        const btnDown = document.createElement('button')
        btnDown.type = 'button'
        btnDown.className = 'lib-settings-order-btn'
        btnDown.textContent = '↓'
        btnDown.disabled = i === libs.length - 1
        btnDown.title = t('lib.settings.order.down') || '下移'
        btnDown.addEventListener('click', () => {
          try {
            if (i >= libs.length - 1) return
            const ids = getDraftLibraries().map(x => x.id)
            ;[ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]
            draftOrderIds = ids
            renderList()
          } catch {}
        })

        right.appendChild(cbWrap)
        right.appendChild(btnUp)
        right.appendChild(btnDown)

        row.appendChild(name)
        row.appendChild(right)
        elList.appendChild(row)
      }
    } catch {}
  }
  renderList()

  overlay.querySelector('#lib-settings-open-webdav')?.addEventListener('click', async () => {
    try {
      close()
      await openWebdavSyncDialog()
    } catch {}
  })

  overlay.querySelector('#lib-settings-save')?.addEventListener('click', async () => {
    try {
      const vis: Record<string, boolean> = {}
      for (const [k, v] of draftSidebarVisible.entries()) vis[k] = !!v
      await applyLibrariesSettings({ orderIds: draftOrderIds, sidebarVisibleById: vis })

      // 保存库切换位置设置并立即更新 UI
      const newSwitcherPos = (elSwitcherPos?.value || draftSwitcherPos) as LibSwitcherPosition
      if (newSwitcherPos !== draftSwitcherPos) {
        await setLibSwitcherPosition(newSwitcherPos)
        // UI 刷新交给外部回调（避免这里到处写 DOM 特殊情况）
      }

      // WebDAV：按"用户真的改过"的库落盘
      for (const libId of dirtyWebdav) {
        const draft = draftWebdav.get(libId)
        if (!draft) continue
        const next: any = { enabled: !!draft.enabled }
        const rawInput = String(draft.rootPathInput || '').trim()
        if (rawInput.length === 0) {
          // 显式清空：移除自定义 rootPath，让读取端回退到默认策略
          next.rootPath = ''
        } else {
          next.rootPath = normalizeRootPathInput(rawInput)
        }
        await setWebdavSyncConfigForLibrary(libId, next)
      }

      if (opts.onRefreshUi) await opts.onRefreshUi()
      showNotice(t('common.saved') || '已保存')
      close()
    } catch (e) {
      console.warn('[库设置] 保存失败', e)
      showNotice(t('common.saveFailed') || '保存失败')
    }
  })
}

// Blinko Snap 插件：右键一键发送到 Blinko

const LS_KEY = 'flymd:blinko-snap:settings'

function createDefaultSettings() {
  return {
    apiBase: '',
    apiToken: ''
  }
}

async function loadSettings(context) {
  const defaults = createDefaultSettings()
  try {
    if (context && context.storage && typeof context.storage.get === 'function') {
      const stored = await context.storage.get('settings')
      if (stored && typeof stored === 'object') {
        return Object.assign({}, defaults, stored)
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return defaults
    return Object.assign({}, defaults, parsed)
  } catch {
    return defaults
  }
}

async function saveSettings(context, settings) {
  const payload = Object.assign(createDefaultSettings(), settings || {})
  try {
    if (context && context.storage && typeof context.storage.set === 'function') {
      await context.storage.set('settings', payload)
    }
  } catch {}
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload))
  } catch {}
  return payload
}

function guessTitleFromBody(body) {
  if (!body || typeof body !== 'string') return '未命名笔记'
  const m = body.match(/^#\s+(.+)$/m)
  if (m && m[1]) return m[1].trim()
  const firstLine = body.split('\n').find((line) => line.trim().length > 0)
  return firstLine ? firstLine.trim().slice(0, 80) : '未命名笔记'
}

function normalizeTags(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter((x) => x.length > 0)
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  }
  return []
}

function buildNotePayload(context, ctx, settings) {
  const meta = (context && typeof context.getDocMeta === 'function') ? (context.getDocMeta() || {}) : {}
  const body = (context && typeof context.getDocBody === 'function') ? context.getDocBody() : (context.getEditorValue ? context.getEditorValue() : '')

  const selected = ctx && typeof ctx.selectedText === 'string' ? ctx.selectedText : ''
  const content = (selected && selected.trim().length > 0) ? selected : body || ''

  if (!content || content.trim().length === 0) {
    throw new Error('编辑器内容为空')
  }

  const title = meta.title || guessTitleFromBody(body || content)
  const tags = normalizeTags(meta.tags || meta.keywords || meta.tag)

  const payload = {
    content,
    type: 0,
    metadata: {
      title,
      tags
    }
  }

  return payload
}

async function sendNoteToBlinko(context, settings, note) {
  if (!context || !context.http || typeof context.http.fetch !== 'function') {
    throw new Error('HTTP 功能不可用')
  }

  const base = String(settings.apiBase || '').trim()
  const token = String(settings.apiToken || '').trim()

  if (!base || !token) {
    throw new Error('Blinko API 地址或 Token 未配置')
  }

  const apiBase = base.replace(/\/+$/, '')
  const url = apiBase + '/v1/note/upsert'

  const res = await context.http.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token
    },
    body: JSON.stringify(note)
  })

  let ok = false
  let status = 0
  try {
    ok = !!(res && (res.ok === true || (typeof res.status === 'number' && res.status >= 200 && res.status < 300)))
    status = typeof res.status === 'number' ? res.status : 0
  } catch {}

  if (!ok) {
    let msg = '未知错误'
    try {
      if (res && typeof res.json === 'function') {
        const data = await res.json()
        if (data && typeof data === 'object') {
          msg = data.message || data.error || JSON.stringify(data)
        }
      } else if (res && typeof res.text === 'function') {
        msg = await res.text()
      }
    } catch {}
    throw new Error('发送失败（状态码 ' + status + '）：' + msg)
  }
}

let globalContextRef = null
let ctxMenuDisposers = []
let settingsOverlayEl = null

function ensureSettingsStyle() {
  if (document.getElementById('blinko-snap-settings-style')) return
  const style = document.createElement('style')
  style.id = 'blinko-snap-settings-style'
  style.textContent = `
.blinko-snap-settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 90010;
}
.blinko-snap-settings-overlay.hidden {
  display: none;
}
.blinko-snap-settings-dialog {
  background: var(--flymd-bg, #1e1e1e);
  color: var(--flymd-fg, #f5f5f5);
  min-width: 360px;
  max-width: 480px;
  padding: 16px 20px 14px;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  font-size: 14px;
}
.blinko-snap-settings-header {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}
.blinko-snap-settings-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.blinko-snap-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.blinko-snap-label {
  font-size: 13px;
  opacity: 0.85;
}
.blinko-snap-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.2);
  color: inherit;
}
.blinko-snap-input:focus {
  outline: none;
  border-color: #ffcc00;
  box-shadow: 0 0 0 1px rgba(255, 204, 0, 0.4);
}
.blinko-snap-desc {
  font-size: 12px;
  opacity: 0.7;
}
.blinko-snap-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.blinko-snap-btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.4);
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
.blinko-snap-btn.primary {
  background: #ffcc00;
  border-color: #ffcc00;
  color: #000;
}
.blinko-snap-btn:focus {
  outline: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
}
`
  document.head.appendChild(style)
}

async function openSettingsDialog(context) {
  if (!context) return
  ensureSettingsStyle()

  const currentSettings = await loadSettings(context)

  if (!settingsOverlayEl) {
    settingsOverlayEl = document.createElement('div')
    settingsOverlayEl.className = 'blinko-snap-settings-overlay hidden'
    settingsOverlayEl.addEventListener('click', (e) => {
      if (e.target === settingsOverlayEl) settingsOverlayEl.classList.add('hidden')
    })

    const dlg = document.createElement('div')
    dlg.className = 'blinko-snap-settings-dialog'

    const header = document.createElement('div')
    header.className = 'blinko-snap-settings-header'
    header.textContent = 'Blinko API 设置'
    dlg.appendChild(header)

    const body = document.createElement('div')
    body.className = 'blinko-snap-settings-body'

    const rows = {}
    const addRow = (labelText, descText, inputEl) => {
      const row = document.createElement('div')
      row.className = 'blinko-snap-row'
      const lab = document.createElement('div')
      lab.className = 'blinko-snap-label'
      lab.textContent = labelText
      row.appendChild(lab)
      if (inputEl) row.appendChild(inputEl)
      if (descText) {
        const desc = document.createElement('div')
        desc.className = 'blinko-snap-desc'
        desc.textContent = descText
        row.appendChild(desc)
      }
      body.appendChild(row)
    }

    const inputBase = document.createElement('input')
    inputBase.type = 'text'
    inputBase.className = 'blinko-snap-input'
    inputBase.placeholder = '例如：https://x.blinko.space/api'
    addRow('API 基础地址', '私有部署请填自己的根路径', inputBase)
    rows.apiBase = inputBase

    const inputToken = document.createElement('input')
    inputToken.type = 'password'
    inputToken.className = 'blinko-snap-input'
    inputToken.placeholder = '在 Blinko 后台生成的访问 Token'
    addRow('访问 Token', '用于 Authorization: Bearer <Token> 认证', inputToken)
    rows.apiToken = inputToken

    dlg.appendChild(body)

    const footer = document.createElement('div')
    footer.className = 'blinko-snap-footer'

    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.className = 'blinko-snap-btn'
    btnCancel.textContent = '取消'
    btnCancel.addEventListener('click', () => {
      settingsOverlayEl.classList.add('hidden')
    })

    const btnSave = document.createElement('button')
    btnSave.type = 'button'
    btnSave.className = 'blinko-snap-btn primary'
    btnSave.textContent = '保存'
    btnSave.addEventListener('click', async () => {
      const next = {
        apiBase: rows.apiBase.value.trim(),
        apiToken: rows.apiToken.value.trim()
      }
      await saveSettings(context, next)
      settingsOverlayEl.classList.add('hidden')
      try {
        context.ui.notice('Blinko 设置已保存', 'ok', 2000)
      } catch {}
    })

    footer.appendChild(btnCancel)
    footer.appendChild(btnSave)
    dlg.appendChild(footer)

    settingsOverlayEl.appendChild(dlg)
    document.body.appendChild(settingsOverlayEl)
    settingsOverlayEl._rows = rows
  }

  const rows = settingsOverlayEl._rows
  rows.apiBase.value = currentSettings.apiBase || 'https://api.blinko.space/api'
  rows.apiToken.value = currentSettings.apiToken || ''

  settingsOverlayEl.classList.remove('hidden')
}

export async function activate(context) {
  globalContextRef = context

  if (!context || !context.http) {
    try {
      context.ui.notice('HTTP 功能不可用，Blinko Snap 已停用', 'err', 3000)
    } catch {}
    return
  }

  try {
    await loadSettings(context)
  } catch {}

  if (typeof context.addContextMenuItem === 'function') {
    try {
      const disposer = context.addContextMenuItem({
        label: '发送到 Blinko',
        icon: '🟡',
        async onClick(ctx) {
          try {
            const settings = await loadSettings(context)
            const note = buildNotePayload(context, ctx, settings)
            await sendNoteToBlinko(context, settings, note)
            context.ui.notice('已发送到 Blinko', 'ok', 2000)
          } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e || '未知错误')
            context.ui.notice('发送到 Blinko 失败：' + msg, 'err', 4000)
            if (/未配置/.test(msg)) {
              void openSettingsDialog(context)
            }
          }
        }
      })
      if (typeof disposer === 'function') ctxMenuDisposers.push(disposer)
    } catch {}
  }

  try {
    context.ui.notice('Blinko Snap 插件已激活', 'ok', 2000)
  } catch {}
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
  if (settingsOverlayEl && settingsOverlayEl.parentNode) {
    try {
      settingsOverlayEl.parentNode.removeChild(settingsOverlayEl)
    } catch {}
  }
  settingsOverlayEl = null
}

export async function openSettings(context) {
  globalContextRef = context || globalContextRef
  if (!globalContextRef) return
  await openSettingsDialog(globalContextRef)
}

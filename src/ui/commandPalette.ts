/**
 * 命令面板 UI：Ctrl+Shift+P 打开，输入过滤，回车执行
 * 注意：这里只负责 UI 与交互；命令列表由外部 provider 提供。
 */

import type { CommandPaletteCommand } from '../core/commandPalette'
import { searchCommandPaletteCommands } from '../core/commandPalette'

const OVERLAY_ID = 'command-palette-overlay'
const INPUT_ID = 'command-palette-input'
const LIST_ID = 'command-palette-list'

let _overlay: HTMLDivElement | null = null
let _input: HTMLInputElement | null = null
let _list: HTMLDivElement | null = null

let _provider: (() => Promise<CommandPaletteCommand[]>) | null = null
let _commands: CommandPaletteCommand[] = []
let _filtered: CommandPaletteCommand[] = []
let _selected = 0
let _lastFocus: HTMLElement | null = null

function ensureOverlay(): HTMLDivElement | null {
  try {
    let ov = document.getElementById(OVERLAY_ID) as HTMLDivElement | null
    if (ov) return ov

    ov = document.createElement('div')
    ov.id = OVERLAY_ID
    ov.className = 'command-palette-overlay'
    ov.innerHTML = `
      <div class="command-palette-dialog" role="dialog" aria-modal="true">
        <input id="${INPUT_ID}" class="command-palette-input" type="text" placeholder="输入命令（支持中文/拼音首字母）…" />
        <div id="${LIST_ID}" class="command-palette-list"></div>
        <div class="command-palette-hint">Enter 执行 · ↑↓ 选择 · Esc 关闭</div>
      </div>
    `
    document.body.appendChild(ov)

    _overlay = ov
    _input = ov.querySelector(`#${INPUT_ID}`) as HTMLInputElement | null
    _list = ov.querySelector(`#${LIST_ID}`) as HTMLDivElement | null

    // 点击遮罩关闭
    ov.addEventListener('click', (e) => {
      if (e.target === ov) closeCommandPalette()
    })

    // 输入更新
    _input?.addEventListener('input', () => {
      _selected = 0
      updateList()
    })

    // 键盘交互（只在输入框聚焦时处理）
    _input?.addEventListener('keydown', (e) => {
      try {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          _selected = Math.min(_selected + 1, Math.max(0, _filtered.length - 1))
          renderList()
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          _selected = Math.max(_selected - 1, 0)
          renderList()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          void runSelected()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          closeCommandPalette()
          return
        }
      } catch {}
    })

    // 点击命令执行（事件委托）
    _list?.addEventListener('click', (e) => {
      try {
        const target = e.target as HTMLElement | null
        const row = target?.closest('.command-palette-item') as HTMLElement | null
        if (!row) return
        const idx = Number(row.dataset.index || '0') || 0
        _selected = Math.max(0, Math.min(idx, Math.max(0, _filtered.length - 1)))
        void runSelected()
      } catch {}
    })

    // 鼠标悬停更新选中（不强制点击）
    _list?.addEventListener('mousemove', (e) => {
      try {
        const target = e.target as HTMLElement | null
        const row = target?.closest('.command-palette-item') as HTMLElement | null
        if (!row) return
        const idx = Number(row.dataset.index || '0') || 0
        if (idx !== _selected) {
          _selected = Math.max(0, Math.min(idx, Math.max(0, _filtered.length - 1)))
          renderList()
        }
      } catch {}
    })

    return ov
  } catch {
    return null
  }
}

function isShown(): boolean {
  try {
    const ov = _overlay || (document.getElementById(OVERLAY_ID) as HTMLDivElement | null)
    return !!(ov && ov.classList.contains('show'))
  } catch {
    return false
  }
}

export function isCommandPaletteOpen(): boolean {
  return isShown()
}

export function setCommandPaletteProvider(
  provider: (() => Promise<CommandPaletteCommand[]>) | null,
): void {
  _provider = provider
}

function renderLoading(text: string): void {
  try {
    if (!_list) return
    _list.innerHTML = ''
    const div = document.createElement('div')
    div.className = 'command-palette-loading'
    div.textContent = text || '加载中…'
    _list.appendChild(div)
  } catch {}
}

function buildDetailText(cmd: CommandPaletteCommand): string {
  const src = cmd.source === 'dropdown' ? '扩展菜单' : '右键菜单'
  const d = String(cmd.detail || '').trim()
  if (!d) return src
  return `${d} · ${src}`
}

function renderList(): void {
  try {
    if (!_list) return
    _list.innerHTML = ''

    if (!_filtered.length) {
      const empty = document.createElement('div')
      empty.className = 'command-palette-empty'
      empty.textContent = '无匹配命令'
      _list.appendChild(empty)
      return
    }

    const frag = document.createDocumentFragment()
    for (let i = 0; i < _filtered.length; i++) {
      const cmd = _filtered[i]
      const row = document.createElement('div')
      const selected = i === _selected
      row.className =
        'command-palette-item' +
        (selected ? ' selected' : '') +
        (cmd.disabled ? ' disabled' : '')
      row.dataset.index = String(i)

      const title = document.createElement('div')
      title.className = 'command-palette-title'
      title.textContent = cmd.title || ''

      const detail = document.createElement('div')
      detail.className = 'command-palette-detail'
      detail.textContent = buildDetailText(cmd) + (cmd.disabled ? '（不可用）' : '')

      row.appendChild(title)
      row.appendChild(detail)
      frag.appendChild(row)
    }
    _list.appendChild(frag)

    // 让选中项可见
    try {
      const el = _list.querySelector(`.command-palette-item[data-index="${_selected}"]`) as HTMLElement | null
      el?.scrollIntoView({ block: 'nearest' })
    } catch {}
  } catch {}
}

function updateList(): void {
  try {
    if (!_input) return
    const q = _input.value || ''
    _filtered = searchCommandPaletteCommands(_commands, q, 60)
    _selected = Math.max(0, Math.min(_selected, Math.max(0, _filtered.length - 1)))
    renderList()
  } catch {
    _filtered = []
    _selected = 0
    renderList()
  }
}

async function runSelected(): Promise<void> {
  try {
    const cmd = _filtered[_selected]
    if (!cmd) return
    if (cmd.disabled) return
    closeCommandPalette()
    await cmd.run()
  } catch (e) {
    console.error('命令执行失败', e)
  }
}

export async function openCommandPalette(): Promise<void> {
  try {
    const ov = ensureOverlay()
    if (!ov || !_input || !_list) return

    if (!isShown()) {
      _lastFocus = (document.activeElement as HTMLElement | null) || null
      ov.classList.add('show')
    }

    _input.value = ''
    _commands = []
    _filtered = []
    _selected = 0
    renderLoading('加载中…')

    setTimeout(() => {
      try { _input?.focus() } catch {}
      try { _input?.select() } catch {}
    }, 0)

    const p = _provider
    if (!p) {
      renderLoading('未配置命令源')
      return
    }
    let cmds: CommandPaletteCommand[] = []
    try { cmds = (await p()) || [] } catch { cmds = [] }
    _commands = cmds
    updateList()
  } catch {}
}

export function closeCommandPalette(): void {
  try {
    const ov = _overlay || (document.getElementById(OVERLAY_ID) as HTMLDivElement | null)
    if (ov) ov.classList.remove('show')
    try { _input && (_input.value = '') } catch {}
    _commands = []
    _filtered = []
    _selected = 0

    const back = _lastFocus
    _lastFocus = null
    if (back && typeof back.focus === 'function') {
      try { back.focus() } catch {}
    }
  } catch {}
}


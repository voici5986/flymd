/**
 * 命令面板（Command Palette）：命令聚合与搜索
 * 目标：只做“入口聚合”，不复制业务逻辑，命令执行复用现有 onClick/handler。
 */

import { pinyin } from 'pinyin-pro'
import type {
  ContextMenuContext,
  ContextMenuItemConfig,
  PluginContextMenuItem,
} from '../ui/contextMenus'
import { getPluginMenuVisibility } from '../extensions/pluginMenuConfig'
import type { PluginDropdownItem } from '../extensions/pluginMenu'

export type CommandPaletteSource = 'dropdown' | 'context'

export type CommandPaletteCommand = {
  id: string
  pluginId: string
  source: CommandPaletteSource
  title: string
  detail?: string
  disabled?: boolean
  run: () => void | Promise<void>
  // 预计算的搜索索引（全部小写）
  _search: {
    title: string
    detail: string
    pinyinFull: string
    pinyinInitials: string
  }
}

export type BuildCommandPaletteDeps = {
  getDropdownItems: () => PluginDropdownItem[]
  getPluginContextMenuItems: () => PluginContextMenuItem[]
  buildBuiltinContextMenuItems: (
    ctx: ContextMenuContext,
  ) => Promise<ContextMenuItemConfig[]>
  getContextMenuContext: () => ContextMenuContext
}

type TempCommand = {
  pluginId: string
  source: CommandPaletteSource
  title: string
  fullPath: string
  detail: string
  disabled?: boolean
  run: () => void | Promise<void>
}

function normText(input: any): string {
  try {
    return String(input || '').trim()
  } catch {
    return ''
  }
}

function lower(input: any): string {
  try {
    return normText(input).toLowerCase()
  } catch {
    return ''
  }
}

function joinPathLabels(labels: string[]): string {
  const out = labels.map((s) => normText(s)).filter(Boolean)
  return out.join(' / ')
}

function buildPinyinIndex(text: string): { full: string; initials: string } {
  try {
    const raw = pinyin(text || '', { toneType: 'none' })
    const cleaned = String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) return { full: '', initials: '' }
    const parts = cleaned.split(' ').filter(Boolean)
    const full = parts.join('')
    const initials = parts.map((p) => (p ? p[0] : '')).join('')
    return { full, initials }
  } catch {
    return { full: '', initials: '' }
  }
}

function pushTempCommand(out: TempCommand[], cmd: TempCommand): void {
  try {
    if (!cmd.title) return
    out.push(cmd)
  } catch {}
}

function flattenDropdownItems(
  items: PluginDropdownItem[],
  out: TempCommand[],
  parent: string[],
  fallbackPluginId: string,
): void {
  try {
    for (const item of items || []) {
      if (!item) continue
      const type = (item as any).type
      if (type === 'divider' || type === 'group') continue
      const label = normText((item as any).label)
      const pluginId = normText((item as any).pluginId) || fallbackPluginId || '@app'
      const nextParent = label ? [...parent, label] : [...parent]
      const children = (item as any).children as PluginDropdownItem[] | undefined
      const hasChildren = !!(children && children.length > 0)

      const onClick = (item as any).onClick as (() => void | Promise<void>) | undefined
      if (typeof onClick === 'function') {
        const fullLabels = label ? [...parent, label] : [...parent]
        const fullPath = joinPathLabels(fullLabels) || label || ''
        const title = label || (fullLabels.length ? fullLabels[fullLabels.length - 1] : '')
        const detail = joinPathLabels(fullLabels.slice(0, -1))
        pushTempCommand(out, {
          pluginId,
          source: 'dropdown',
          title,
          fullPath,
          detail,
          disabled: !!(item as any).disabled,
          run: () => onClick(),
        })
      }

      if (hasChildren) {
        flattenDropdownItems(children!, out, nextParent, pluginId)
      }
    }
  } catch {}
}

function flattenContextMenuItems(
  items: ContextMenuItemConfig[],
  out: TempCommand[],
  parent: string[],
  pluginId: string,
  ctx: ContextMenuContext,
): void {
  try {
    for (const item of items || []) {
      if (!item) continue
      if ((item as any).divider || (item as any).type === 'divider') continue
      if ((item as any).type === 'group') continue

      // 条件不满足则跳过（命令面板不制造“特殊情况”）
      const cond = (item as any).condition as ((c: ContextMenuContext) => boolean) | undefined
      if (typeof cond === 'function') {
        let ok = false
        try { ok = !!cond(ctx) } catch { ok = false }
        if (!ok) continue
      }

      const label = normText((item as any).label)
      const children = (item as any).children as ContextMenuItemConfig[] | undefined
      const hasChildren = !!(children && children.length > 0)
      const nextParent = label ? [...parent, label] : [...parent]

      const onClick = (item as any).onClick as ((c: ContextMenuContext) => void | Promise<void>) | undefined
      if (typeof onClick === 'function') {
        const fullLabels = label ? [...parent, label] : [...parent]
        const fullPath = joinPathLabels(fullLabels) || label || ''
        const title = label || (fullLabels.length ? fullLabels[fullLabels.length - 1] : '')
        const detail = joinPathLabels(fullLabels.slice(0, -1))
        pushTempCommand(out, {
          pluginId,
          source: 'context',
          title,
          fullPath,
          detail,
          disabled: !!(item as any).disabled,
          run: () => onClick(ctx),
        })
      }

      if (hasChildren) {
        flattenContextMenuItems(children!, out, nextParent, pluginId, ctx)
      }
    }
  } catch {}
}

function dedupeAcrossSources(dropdown: TempCommand[], context: TempCommand[]): TempCommand[] {
  try {
    const out: TempCommand[] = []
    const byFullPath = new Map<string, TempCommand>()

    const keyFull = (c: TempCommand) => `${c.pluginId}::${lower(c.fullPath)}`
    for (const d of dropdown) {
      const k = keyFull(d)
      if (!byFullPath.has(k)) {
        byFullPath.set(k, d)
        out.push(d)
      }
    }

    // 辅助索引：pluginId + 叶子标题 → 下拉菜单命令列表（用于“尽量不重复”）
    const dropByLeaf = new Map<string, TempCommand[]>()
    const leafKey = (pluginId: string, title: string) => `${pluginId}::${lower(title)}`
    for (const d of dropdown) {
      const k = leafKey(d.pluginId, d.title)
      const arr = dropByLeaf.get(k) || []
      arr.push(d)
      dropByLeaf.set(k, arr)
    }

    for (const c of context) {
      const k = keyFull(c)
      if (byFullPath.has(k)) continue

      // 右键菜单通常是“扁平叶子”；若它与下拉菜单存在唯一同名叶子，则视为同一入口（去重）
      const isFlat = lower(c.fullPath) === lower(c.title)
      if (isFlat) {
        const candidates = dropByLeaf.get(leafKey(c.pluginId, c.title)) || []
        if (candidates.length === 1) {
          const only = candidates[0]
          const endsWithLeaf =
            lower(only.fullPath) === lower(c.title) ||
            lower(only.fullPath).endsWith(' / ' + lower(c.title))
          if (endsWithLeaf) {
            continue
          }
        }
      }

      byFullPath.set(k, c)
      out.push(c)
    }

    return out
  } catch {
    return [...dropdown, ...context]
  }
}

export async function buildCommandPaletteCommands(
  deps: BuildCommandPaletteDeps,
): Promise<CommandPaletteCommand[]> {
  try {
    const ctx = deps.getContextMenuContext()

    const dropdownTemp: TempCommand[] = []
    try {
      const dropdownItems = deps.getDropdownItems() || []
      flattenDropdownItems(dropdownItems, dropdownTemp, [], '@app')
    } catch {}

    const contextTemp: TempCommand[] = []
    try {
      const builtin = await deps.buildBuiltinContextMenuItems(ctx)
      flattenContextMenuItems(builtin || [], contextTemp, [], '@builtin', ctx)
    } catch {}

    try {
      const pluginItems = deps.getPluginContextMenuItems() || []
      for (const it of pluginItems) {
        if (!it || !it.pluginId || !it.config) continue
        const pid = normText(it.pluginId)
        if (!pid) continue
        // 与右键菜单保持一致：尊重“菜单管理”中的可见性开关
        try {
          const vis = getPluginMenuVisibility(pid)
          if (vis.contextMenu === false) continue
        } catch {}
        flattenContextMenuItems([it.config], contextTemp, [], pid, ctx)
      }
    } catch {}

    const merged = dedupeAcrossSources(dropdownTemp, contextTemp)

    const commands: CommandPaletteCommand[] = []
    for (const c of merged) {
      const title = normText(c.title)
      const detail = normText(c.detail)
      const py = buildPinyinIndex(`${title} ${detail}`)
      const id = `${c.source}::${c.pluginId}::${lower(c.fullPath)}`
      commands.push({
        id,
        pluginId: c.pluginId,
        source: c.source,
        title,
        detail: detail || undefined,
        disabled: !!c.disabled,
        run: c.run,
        _search: {
          title: lower(title),
          detail: lower(detail),
          pinyinFull: py.full,
          pinyinInitials: py.initials,
        },
      })
    }

    // 稳定排序：同分/空查询时也保持一致（先标题再来源）
    commands.sort((a, b) => {
      const ta = a._search.title
      const tb = b._search.title
      if (ta < tb) return -1
      if (ta > tb) return 1
      if (a.source < b.source) return -1
      if (a.source > b.source) return 1
      return 0
    })
    return commands
  } catch {
    return []
  }
}

function isSubsequence(needle: string, hay: string): boolean {
  if (!needle) return true
  if (!hay) return false
  let j = 0
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) j++
  }
  return j === needle.length
}

function scoreOne(cmd: CommandPaletteCommand, q: string): number {
  const t = cmd._search.title
  const d = cmd._search.detail
  const pyI = cmd._search.pinyinInitials
  const pyF = cmd._search.pinyinFull
  if (!q) return 0

  // 1) 标题优先：前缀 > 子串
  let idx = t.indexOf(q)
  if (idx === 0) return 4000 - Math.min(t.length, 200)
  if (idx > 0) return 3500 - idx

  // 2) 拼音首字母：前缀 > 子串
  idx = pyI.indexOf(q)
  if (idx === 0) return 3000 - Math.min(pyI.length, 200)
  if (idx > 0) return 2800 - idx

  // 3) 拼音全拼：子串
  idx = pyF.indexOf(q)
  if (idx >= 0) return 2400 - idx

  // 4) 详情：子串
  idx = d.indexOf(q)
  if (idx >= 0) return 2000 - idx

  // 5) 兜底：子序列（更宽松，但分数低）
  if (isSubsequence(q, t)) return 1200
  if (isSubsequence(q, pyI)) return 1100
  if (isSubsequence(q, pyF)) return 1000

  return -1
}

export function searchCommandPaletteCommands(
  commands: CommandPaletteCommand[],
  query: string,
  limit = 60,
): CommandPaletteCommand[] {
  try {
    const qRaw = lower(query)
    if (!qRaw) return (commands || []).slice(0, Math.max(0, limit))

    const parts = qRaw.split(/\s+/).filter(Boolean)
    if (!parts.length) return (commands || []).slice(0, Math.max(0, limit))

    const scored: Array<{ cmd: CommandPaletteCommand; score: number }> = []
    for (const cmd of commands || []) {
      let total = 0
      let ok = true
      for (const part of parts) {
        const s = scoreOne(cmd, part)
        if (s < 0) { ok = false; break }
        total += s
      }
      if (!ok) continue
      scored.push({ cmd, score: total })
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ta = a.cmd._search.title
      const tb = b.cmd._search.title
      if (ta < tb) return -1
      if (ta > tb) return 1
      return 0
    })

    return scored.slice(0, Math.max(0, limit)).map((x) => x.cmd)
  } catch {
    return (commands || []).slice(0, Math.max(0, limit))
  }
}


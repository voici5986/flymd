/**
 * 跨窗口拖拽：接收端（目标窗口）
 *
 * 核心原则：永远不丢数据
 * - 收到 offer 后先把内容落到本窗口标签中
 * - 成功后回 ACK；发送端收到 ACK 才关闭源标签
 */

import type { TabManager } from './TabManager'
import {
  TAB_TRANSFER_ACK_EVENT,
  TAB_TRANSFER_OFFER_EVENT,
  TAB_TRANSFER_PROTOCOL,
  type TabTransferAck,
  type TabTransferContent,
  type TabTransferOffer,
} from './tabTransferProtocol'

type UndoLike = { resetCurrentStackBaseline: () => void }

let _installed = false
let _installing: Promise<void> | null = null

function getBaseName(p: string): string {
  try {
    const parts = p.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || '未命名'
  } catch {
    return '未命名'
  }
}

async function readContent(content: TabTransferContent | undefined | null): Promise<string | null> {
  const c = content || { type: 'none' as const }
  if (c.type === 'none') return null
  if (c.type === 'inline') return String(c.content || '')
  if (c.type === 'tempFile') {
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      return await readTextFile(c.path)
    } catch {
      return null
    }
  }
  return null
}

async function emitAck(sourceLabel: string, ack: TabTransferAck): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const me = WebviewWindow.getCurrent()
    await me.emitTo(sourceLabel, TAB_TRANSFER_ACK_EVENT, ack)
  } catch {
    // 忽略：没有 ACK 也不会导致数据丢失，只是发送端不会自动关闭
  }
}

async function handleOffer(
  deps: { tabManager: TabManager; undoManager?: UndoLike },
  raw: any,
): Promise<void> {
  const offer = (raw && (raw.payload ?? raw)) as Partial<TabTransferOffer> | null
  if (!offer || offer.protocol !== TAB_TRANSFER_PROTOCOL) return

  const transferId = String(offer.transferId || '')
  const sourceLabel = String(offer.sourceLabel || '')
  if (!transferId || !sourceLabel) return

  let ok = false
  let message = ''

  try {
    const tab = offer.tab || ({} as any)
    const filePath = tab.filePath ? String(tab.filePath) : null
    const isPdf = !!tab.isPdf || (!!filePath && filePath.toLowerCase().endsWith('.pdf'))

    const body = await readContent(offer.content as any)
    const hasBody = typeof body === 'string'
    const contentType = String((offer.content as any)?.type || 'none')
    if (contentType !== 'none' && !hasBody) {
      throw new Error('无法读取拖拽内容（目标窗口尚未就绪或临时文件不可用）')
    }

    // A) 干净文件：只需打开/激活对应文件标签
    if (filePath && !tab.dirty && (!offer.content || offer.content.type === 'none') && !hasBody) {
      const existing = deps.tabManager.findTabByPath(filePath)
      if (existing) {
        await deps.tabManager.switchToTab(existing.id)
        ok = true
      } else {
        const flymd = window as any
        const openFn = flymd?.flymdOpenFile as ((p: string) => Promise<void>) | undefined
        if (typeof openFn !== 'function') {
          throw new Error('窗口尚未就绪，无法打开文件')
        }
        await openFn(filePath)
        ok = true
      }
    } else {
      // B) 有内容（dirty/未保存）：创建一个新标签并写入内容
      const existing = filePath ? deps.tabManager.findTabByPath(filePath) : null

      // 优先复用“空白未修改标签”，避免新窗口出现多一个无用空标签
      const cur = deps.tabManager.getActiveTab()
      const isCurEmpty = !!(
        cur &&
        !cur.filePath &&
        !cur.dirty &&
        !String(cur.content || '').trim()
      )
      const created = isCurEmpty ? (cur as any) : deps.tabManager.createNewTab()
      const target = deps.tabManager.getActiveTab() || created

      // 冲突处理：目标窗口已打开同一路径时，不复用 filePath，改为“无路径标签”，避免覆盖/混淆
      const keepPath = !!(filePath && !existing)
      target.filePath = keepPath ? filePath : null

      // displayName：只有 filePath 为 null 才显示
      if (!target.filePath) {
        const base = filePath ? getBaseName(filePath) : ''
        const from = tab.displayName ? String(tab.displayName) : ''
        const name = (from || base || '未命名') + (existing && filePath ? ' (拖入)' : '')
        target.displayName = name
      } else {
        target.displayName = undefined
      }

      target.isPdf = isPdf
      target.mode = (tab.mode === 'preview' ? 'preview' : 'edit') as any
      target.wysiwygEnabled = !!tab.wysiwygEnabled
      target.content = hasBody ? (body as string) : ''

      // 关键：无路径/冲突降级的标签一律视为 dirty，防止用户误以为已保存
      const dirty = !!tab.dirty || !target.filePath
      target.dirty = dirty

      target.scrollTop = Number(tab.scrollTop) || 0
      target.cursorLine = Number(tab.cursorLine) || 1
      target.cursorCol = Number(tab.cursorCol) || 1

      const applied = await deps.tabManager.applyTabState(target.id)
      if (!applied) throw new Error('窗口尚未就绪，无法应用标签状态')
      try { deps.undoManager?.resetCurrentStackBaseline() } catch {}
      ok = true
    }
  } catch (e) {
    ok = false
    message = e instanceof Error ? e.message : String(e || '处理失败')
    console.error('[TabTransfer] 处理拖入失败:', e)
  } finally {
    await emitAck(sourceLabel, {
      protocol: TAB_TRANSFER_PROTOCOL,
      transferId,
      ok,
      message: message || undefined,
    })
  }
}

export async function initTabTransferReceiver(deps: {
  tabManager: TabManager
  undoManager?: UndoLike
}): Promise<void> {
  if (_installed) return
  if (_installing) return _installing
  _installing = (async () => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      await WebviewWindow.getCurrent().listen(TAB_TRANSFER_OFFER_EVENT, (ev: any) => {
        void handleOffer(deps, ev)
      })
      _installed = true
    } catch {
      // 非 Tauri 环境：不安装
    }
  })()
  try {
    await _installing
  } finally {
    _installing = null
  }
}

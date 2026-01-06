/**
 * 跨窗口拖拽：发送端（源窗口）
 *
 * 目标：
 * - 支持 dirty/未保存：通过 ACK 机制保证不丢数据（先复制/确认，再删除源标签）
 * - 不改 main.ts：仅依赖 Tauri 窗口事件
 */

import type { TabManager } from './TabManager'
import type { TabDocument } from './types'
import {
  TAB_TRANSFER_ACK_EVENT,
  TAB_TRANSFER_OFFER_EVENT,
  TAB_TRANSFER_PROTOCOL,
  type TabTransferAck,
  type TabTransferContent,
  type TabTransferOffer,
} from './tabTransferProtocol'
import { getCurrentWebviewWindowLabel } from '../windows/editorWindows'

type PendingResolver = (ack: TabTransferAck | null) => void

const _pending = new Map<string, PendingResolver>()
let _ackListenerInstalling: Promise<void> | null = null
let _ackListenerInstalled = false

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function byteLenUtf8(s: string): number {
  try {
    return new TextEncoder().encode(s).length
  } catch {
    return s.length
  }
}

function genTransferId(): string {
  // 只用安全字符，避免路径/事件系统出幺蛾子
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

async function ensureAckListener(): Promise<void> {
  if (_ackListenerInstalled) return
  if (_ackListenerInstalling) return _ackListenerInstalling
  _ackListenerInstalling = (async () => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      await WebviewWindow.getCurrent().listen(TAB_TRANSFER_ACK_EVENT, (ev: any) => {
        try {
          const p = (ev && (ev.payload ?? ev)) as Partial<TabTransferAck> | null
          if (!p || p.protocol !== TAB_TRANSFER_PROTOCOL) return
          const id = String(p.transferId || '')
          if (!id) return
          const resolver = _pending.get(id)
          if (!resolver) return
          _pending.delete(id)
          resolver(p as TabTransferAck)
        } catch {
          // 忽略
        }
      })
      _ackListenerInstalled = true
    } catch {
      // 非 Tauri 环境：不安装
    }
  })()
  try {
    await _ackListenerInstalling
  } finally {
    _ackListenerInstalling = null
  }
}

async function waitForAck(transferId: string, timeoutMs: number): Promise<TabTransferAck | null> {
  await ensureAckListener()
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(transferId)
      resolve(null)
    }, Math.max(200, timeoutMs))
    _pending.set(transferId, (ack) => {
      clearTimeout(timer)
      resolve(ack)
    })
  })
}

async function writeTempContent(transferId: string, content: string): Promise<string | null> {
  try {
    const { appLocalDataDir } = await import('@tauri-apps/api/path')
    const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
    const base = (await appLocalDataDir()) || ''
    if (!base) return null
    const sep = base.includes('\\') ? '\\' : '/'
    const dir = base.replace(/[\\/]+$/, '') + sep + 'tab-transfer'
    try { await mkdir(dir, { recursive: true } as any) } catch {}
    const path = dir + sep + `flymd-${transferId}.txt`
    await writeTextFile(path, content)
    return path
  } catch {
    return null
  }
}

async function removeTempContent(path: string | null): Promise<void> {
  if (!path) return
  try {
    const { remove } = await import('@tauri-apps/plugin-fs')
    await remove(path, { recursive: false } as any)
  } catch {
    // 忽略
  }
}

function getBaseName(p: string): string {
  try {
    const parts = p.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || '未命名'
  } catch {
    return '未命名'
  }
}

function snapshotTabForTransfer(tabManager: TabManager, tab: TabDocument): TabDocument & { _snapshotContent: string; _snapshotDirty: boolean } {
  const activeId = tabManager.getActiveTabId()
  if (activeId !== tab.id) {
    return Object.assign({}, tab, {
      _snapshotContent: tab.content,
      _snapshotDirty: !!tab.dirty,
    })
  }

  // 活跃标签：tab.content 可能没及时刷新，必须从编辑器抓一次
  let content = tab.content
  let dirty = !!tab.dirty
  try {
    const flymd = window as any
    const getContent = flymd?.flymdGetEditorContent
    if (typeof getContent === 'function') content = String(getContent() ?? '')
    const isDirty = flymd?.flymdIsDirty
    if (typeof isDirty === 'function') dirty = !!isDirty()
  } catch {
    // 忽略
  }

  return Object.assign({}, tab, {
    _snapshotContent: content,
    _snapshotDirty: dirty,
  })
}

export type MoveTabToWindowOpts = {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  maxInlineBytes?: number
}

/**
 * 将一个标签“移动”到目标窗口（ACK 成功后关闭源标签）。
 */
export async function moveTabToWindowLabel(
  tabManager: TabManager,
  tabId: string,
  targetLabel: string,
  opts?: MoveTabToWindowOpts,
): Promise<{ ok: boolean; message?: string }> {
  const tab = tabManager.findTabById(tabId)
  if (!tab) return { ok: false, message: '标签不存在' }

  const sourceLabel = await getCurrentWebviewWindowLabel()
  if (!sourceLabel) return { ok: false, message: '当前环境不支持多窗口拖拽（非 Tauri）' }

  const snap = snapshotTabForTransfer(tabManager, tab)
  const transferId = genTransferId()

  const maxInlineBytes = typeof opts?.maxInlineBytes === 'number' ? opts!.maxInlineBytes : 512 * 1024
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts!.timeoutMs : 7000
  const retries = typeof opts?.retries === 'number' ? opts!.retries : 12
  const retryDelayMs = typeof opts?.retryDelayMs === 'number' ? opts!.retryDelayMs : 250

  let tempPath: string | null = null

  // 决策：干净且有路径的标签只传路径；其余情况必须带内容，保证不丢数据
  let content: TabTransferContent = { type: 'none' }
  if (!snap.filePath || snap._snapshotDirty) {
    const bytes = byteLenUtf8(snap._snapshotContent || '')
    if (bytes <= maxInlineBytes) {
      content = { type: 'inline', content: snap._snapshotContent || '' }
    } else {
      tempPath = await writeTempContent(transferId, snap._snapshotContent || '')
      if (tempPath) content = { type: 'tempFile', path: tempPath }
      else content = { type: 'inline', content: snap._snapshotContent || '' }
    }
  }

  const offer: TabTransferOffer = {
    protocol: TAB_TRANSFER_PROTOCOL,
    transferId,
    sourceLabel,
    sourceTs: Date.now(),
    tab: {
      filePath: snap.filePath,
      displayName: snap.displayName || (snap.filePath ? undefined : getBaseName(snap.filePath || '')),
      dirty: !!snap._snapshotDirty,
      mode: snap.mode,
      wysiwygEnabled: !!snap.wysiwygEnabled,
      isPdf: !!snap.isPdf,
      scrollTop: snap.scrollTop,
      cursorLine: snap.cursorLine,
      cursorCol: snap.cursorCol,
    },
    content,
  }

  let ackPromise: Promise<TabTransferAck | null> | null = null
  try {
    ackPromise = waitForAck(transferId, timeoutMs)
  } catch {
    // ignore
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const me = WebviewWindow.getCurrent()

    // 发送 + 重试：新窗口可能还没初始化完成，靠 ACK 驱动最终一致
    for (let i = 0; i < retries; i++) {
      try { await me.emitTo(targetLabel, TAB_TRANSFER_OFFER_EVENT, offer) } catch {}
      if (!ackPromise) break
      const got = await Promise.race([
        ackPromise.then((a) => ({ type: 'ack' as const, ack: a })),
        delay(retryDelayMs).then(() => ({ type: 'delay' as const })),
      ])
      if (got.type === 'ack') break
    }

    const ack = ackPromise ? await ackPromise : null
    if (!ack || !ack.ok) {
      await removeTempContent(tempPath)
      return { ok: false, message: ack?.message || '目标窗口未响应' }
    }

    // 成功：先清理临时文件，再关闭源标签（不弹确认，数据已复制到对方）
    await removeTempContent(tempPath)
    try { await tabManager.closeTab(tabId) } catch {}
    return { ok: true }
  } catch (e) {
    await removeTempContent(tempPath)
    return { ok: false, message: (e instanceof Error ? e.message : String(e || '发送失败')) }
  }
}

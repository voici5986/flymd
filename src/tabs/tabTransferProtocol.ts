/**
 * 标签跨窗口拖拽传输协议（同进程多窗口）
 *
 * 设计原则：
 * - 数据结构优先：只传“能保证不丢数据”的最小信息
 * - 不依赖 main.ts 改动：通过 Tauri 窗口事件在窗口之间通信
 * - 兼容演进：用 protocol 字段做版本隔离
 */

import type { EditorMode } from './types'

export const TAB_TRANSFER_PROTOCOL = 'flymd.tab-transfer.v1' as const

// 发送端 -> 接收端
export const TAB_TRANSFER_OFFER_EVENT = 'flymd:tab-transfer-offer' as const

// 接收端 -> 发送端（ACK）
export const TAB_TRANSFER_ACK_EVENT = 'flymd:tab-transfer-ack' as const

export type TabTransferContent =
  | { type: 'none' }
  | { type: 'inline'; content: string }
  | { type: 'tempFile'; path: string }

export type TabTransferOffer = {
  protocol: typeof TAB_TRANSFER_PROTOCOL
  transferId: string
  sourceLabel: string
  sourceTs: number
  tab: {
    filePath: string | null
    displayName?: string
    dirty: boolean
    mode: EditorMode
    wysiwygEnabled: boolean
    isPdf?: boolean
    scrollTop?: number
    cursorLine?: number
    cursorCol?: number
  }
  content: TabTransferContent
}

export type TabTransferAck = {
  protocol: typeof TAB_TRANSFER_PROTOCOL
  transferId: string
  ok: boolean
  message?: string
}


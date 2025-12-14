// 更新相关通用工具函数
// 用于在 UI 模块与主逻辑之间复用 openInBrowser / upMsg 等能力

import { openUrl } from '@tauri-apps/plugin-opener'

function normalizeBrowserUrl(url: string): string {
  const u = String(url || '').trim()
  if (!u) return ''
  // 已带 scheme（http/https/mailto/file 等）直接使用
  if (/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(u)) return u
  // 兼容 //example.com 这种写法
  if (u.startsWith('//')) return 'https:' + u
  // 兼容 example.com 这种写法
  return 'https://' + u
}

export async function openInBrowser(url: string): Promise<void> {
  const u = normalizeBrowserUrl(url)
  if (!u) return
  // 好品味：优先走系统默认浏览器；失败再回退到 window.open
  try { await openUrl(u); return } catch {}
  try { window.open(u, '_blank', 'noopener,noreferrer') } catch {}
}

export function upMsg(s: string): void {
  try {
    const status = document.getElementById('status') as HTMLDivElement | null
    if (status) status.textContent = s
  } catch {}
  try { console.log('[更新] ' + s) } catch {}
}

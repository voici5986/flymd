// 粘贴 URL 自动抓取网页标题：开关与持久化
// 约定：
// - 默认开启（避免破坏既有用户习惯）
// - Ctrl+Shift+V 始终走“纯文本粘贴”，天然可作为一次性的“禁用抓取粘贴”

export const PASTE_URL_TITLE_FETCH_KEY = 'flymd:paste:urlTitleFetch'

export function getPasteUrlTitleFetchEnabled(): boolean {
  try {
    const v = localStorage.getItem(PASTE_URL_TITLE_FETCH_KEY)
    if (v === null) return true
    return v === 'true'
  } catch {
    return true
  }
}

export function setPasteUrlTitleFetchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PASTE_URL_TITLE_FETCH_KEY, enabled ? 'true' : 'false')
    const ev = new CustomEvent('flymd:paste:urlTitleFetch', { detail: { enabled } })
    window.dispatchEvent(ev)
  } catch {}
}


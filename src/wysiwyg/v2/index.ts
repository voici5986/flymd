// 所见模式 V2：基于 Milkdown 的真实所见编辑视图
// 暴露 enable/disable 与 setMarkdown/getMarkdown 能力，供主流程挂接

import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/core'
import { convertFileSrc } from '@tauri-apps/api/core'
// 用于外部（main.ts）在所见模式下插入 Markdown（文件拖放时复用普通模式逻辑）
import { replaceAll } from '@milkdown/utils'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { automd } from '@milkdown/plugin-automd'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { upload, uploadConfig } from '@milkdown/plugin-upload'
import { uploader } from './plugins/paste'
// 注：保留 automd 插件以提供编辑功能，通过 CSS 隐藏其 UI 组件
// 引入富文本所见视图的必要样式（避免工具条/布局错乱导致不可编辑/不可滚动）
// 注：不直接导入 @milkdown/crepe/style.css，避免 Vite 对未导出的样式路径解析失败。

let _editor: Editor | null = null
let _root: HTMLElement | null = null
let _onChange: ((md: string) => void) | null = null
let _suppressInitialUpdate = false
let _lastMd = ''
let _imgObserver: MutationObserver | null = null

function toLocalAbsFromSrc(src: string): string | null {
  try {
    if (!src) return null
    let s = String(src).trim()
    // 去掉 Markdown 尖括号 <...>
    if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1)
    // 尽量解码一次
    try { s = decodeURIComponent(s) } catch {}
    // data/blob/asset/http 跳过
    if (/^(data:|blob:|asset:|https?:)/i.test(s)) return null
    // file:// 解析
    if (/^file:/i.test(s)) {
      try {
        const u = new URL(s)
        let p = u.pathname || ''
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
        p = decodeURIComponent(p)
        if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\')
        return p
      } catch { /* fallthrough */ }
    }
    // Windows 盘符或 UNC
    if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\//g, '\\')
    if (/^\\\\/.test(s)) return s.replace(/\//g, '\\')
    // 绝对路径（类 Unix）
    if (/^\//.test(s)) return s
    return null
  } catch { return null }
}

function isTauriRuntime(): boolean {
  try { return typeof (window as any).__TAURI__ !== 'undefined' } catch { return false }
}

function rewriteLocalImagesToAsset() {
  try {
    if (!isTauriRuntime()) return
    const host = _root?.querySelector('.ProseMirror') as HTMLElement | null
    if (!host) return
    const imgs = host.querySelectorAll('img[src]')
    imgs.forEach((img) => {
      try {
        const el = img as HTMLImageElement
        const raw = el.getAttribute('src') || ''
        const abs = toLocalAbsFromSrc(raw)
        if (!abs) return
        const asset = convertFileSrc(abs)
        if (asset && asset !== el.src) el.src = asset
      } catch {}
    })
    // 监听后续 DOM 变化，保持转换
    if (_imgObserver) { try { _imgObserver.disconnect() } catch {} }
    _imgObserver = new MutationObserver(() => {
      try {
        const imgs2 = host.querySelectorAll('img[src]')
        imgs2.forEach((img) => {
          try {
            const el = img as HTMLImageElement
            const raw = el.getAttribute('src') || ''
            const abs = toLocalAbsFromSrc(raw)
            if (!abs) return
            const asset = convertFileSrc(abs)
            if (asset && asset !== el.src) el.src = asset
          } catch {}
        })
      } catch {}
    })
    _imgObserver.observe(host, { subtree: true, attributes: true, attributeFilter: ['src'] })
  } catch {}
}

function cleanupEditorOnly() {
  try { if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null } } catch {}
  if (_editor) {
    try { _editor.destroy() } catch {}
    _editor = null
  }
}

export async function enableWysiwygV2(root: HTMLElement, initialMd: string, onChange: (md: string) => void) {
  // 规范化内容：空内容也是合法的（新文档或空文档）
  const content = (initialMd || '').toString()
  console.log('[WYSIWYG V2] enableWysiwygV2 called, content length:', content.length)

  // 仅销毁旧编辑器与观察器，保留外层传入的 root（避免被移除导致空白）
  cleanupEditorOnly()
  _root = root
  _onChange = onChange
  _suppressInitialUpdate = true
  _lastMd = content

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, _lastMd)
      // 配置编辑器视图选项，确保可编辑
      ctx.set(editorViewOptionsCtx, { editable: () => true })
      // 配置上传：接入现有图床上传逻辑，同时允许从 HTML 粘贴的文件触发上传
      try {
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader,
          enableHtmlFileUploader: true,
        }))
      } catch {}
    })
    .use(commonmark)
    .use(gfm)
    .use(automd)
    .use(listener)
    .use(upload)
    .create()
  // 初次渲染后聚焦
  try {
    const view = (editor as any).ctx.get(editorViewCtx)
    requestAnimationFrame(() => { try { view?.focus() } catch {} })
  } catch {}
  // 初次渲染后重写本地图片为 asset: url（仅影响 DOM，不改 Markdown）
  try { setTimeout(() => { try { rewriteLocalImagesToAsset() } catch {} }, 0) } catch {}
  // 成功创建后清理占位文案（仅移除纯文本节点，不影响编辑器 DOM）
  try {
    if (_root && _root.firstChild && (_root.firstChild as any).nodeType === 3) {
      _root.removeChild(_root.firstChild)
    }
  } catch {}
  // 兜底：确保编辑区可见且占满容器
  try {
    const pm = _root?.querySelector('.ProseMirror') as HTMLElement | null
    if (pm) {
      pm.style.display = 'block'
      pm.style.minHeight = '100%'
      pm.style.width = '100%'
    }
    const host = _root?.firstElementChild as HTMLElement | null
    if (host) {
      host.style.display = host.style.display || 'block'
      host.style.minHeight = host.style.minHeight || '100%'
      host.style.width = host.style.width || '100%'
    }
  } catch {}
  // 监听内容更新并回写给外层（用于保存与切回源码视图）
  try {
    const ctx = (editor as any).ctx
    const lm = ctx.get(listenerCtx)
    lm.markdownUpdated((_ctx, markdown) => {
      if (_suppressInitialUpdate) return
      // 统一 Windows/UNC/含空格路径的图片写法：在 Markdown 中为目标包上尖括号 <...>
      const md2 = (() => {
        try {
          return String(markdown).replace(/!\[[^\]]*\]\(([^)]+)\)/g, (m, g1) => {
            const s = String(g1 || '').trim()
            // 已经是 <...> 的不处理
            if (s.startsWith('<') && s.endsWith('>')) return m
            const dec = (() => { try { return decodeURIComponent(s) } catch { return s } })()
            const looksLocal = /^(?:file:|[a-zA-Z]:[\\/]|\\\\|\/)/.test(dec)
            const hasSpaceOrSlash = /[\s()\\]/.test(dec)
            if (looksLocal && hasSpaceOrSlash) {
              return m.replace(s, `<${dec}>`)
            }
            return m
          })
        } catch { return markdown }
      })()
      _lastMd = md2
      try { _onChange?.(md2) } catch {}
      try { setTimeout(() => { try { rewriteLocalImagesToAsset() } catch {} }, 0) } catch {}
    })
  } catch {}
  _suppressInitialUpdate = false
  _editor = editor
}

export async function disableWysiwygV2() {
  try { if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null } } catch {}
  if (_editor) {
    try { await _editor.destroy() } catch {}
    _editor = null
  }
  try {
    // 隐藏并移除根节点，避免覆盖层残留拦截点击
    const host = document.getElementById('md-wysiwyg-root') as HTMLElement | null
    if (host) {
      try { host.style.display = 'none' } catch {}
      try { host.innerHTML = '' } catch {}
      try { host.parentElement?.removeChild(host) } catch {}
    }
  } catch {}
  _root = null
  _onChange = null
}

export function isWysiwygV2Enabled(): boolean { return !!_editor }

// 供外部调用：将整个文档替换为指定 Markdown（简易接口）
export async function wysiwygV2ReplaceAll(markdown: string) {
  if (!_editor) return
  try { await _editor.action(replaceAll(markdown)) } catch {}
}

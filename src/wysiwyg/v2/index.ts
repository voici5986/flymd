// 所见模式 V2：基于 Milkdown 的真实所见编辑视图
// 暴露 enable/disable 与 setMarkdown/getMarkdown 能力，供主流程挂接

import { history } from '@milkdown/plugin-history'
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx, commandsCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import { convertFileSrc } from '@tauri-apps/api/core'
import { readFile } from '@tauri-apps/plugin-fs'
// 用于外部（main.ts）在所见模式下插入 Markdown（文件拖放时复用普通模式逻辑）
import { replaceAll, getMarkdown } from '@milkdown/utils'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { automd } from '@milkdown/plugin-automd'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { upload, uploadConfig } from '@milkdown/plugin-upload'
import { uploader } from './plugins/paste'
import { mermaidPlugin } from './plugins/mermaid'
import { mathInlineViewPlugin, mathBlockViewPlugin } from './plugins/math'
import { remarkMathPlugin, katexOptionsCtx, mathInlineSchema, mathBlockSchema, mathInlineInputRule, mathBlockInputRule } from '@milkdown/plugin-math'
// 注：保留 automd 插件以提供编辑功能，通过 CSS 隐藏其 UI 组件
// 引入富文本所见视图的必要样式（避免工具条/布局错乱导致不可编辑/不可滚动）
// 注：不直接导入 @milkdown/crepe/style.css，避免 Vite 对未导出的样式路径解析失败。

let _editor: Editor | null = null
let _root: HTMLElement | null = null
let _onChange: ((md: string) => void) | null = null
let _suppressInitialUpdate = false
let _lastMd = ''
let _imgObserver: MutationObserver | null = null
let _overlayTimer: number | null = null
let _overlayHost: HTMLDivElement | null = null
let _activeMermaidPre: HTMLElement | null = null
// 鼠标与光标分别记录，避免事件互相"顶掉"导致不渲染
// 优先级：光标所在（selection）优先于鼠标悬停（mouse）
let _activeMermaidPreBySelection: HTMLElement | null = null
let _activeMermaidPreByMouse: HTMLElement | null = null
// MutationObserver 用于监听 ProseMirror 清除我们插入的元素
let _mermaidObserver: MutationObserver | null = null
// 所见模式代码块复制按钮覆盖层
const _codeCopyWraps = new Map<HTMLElement, HTMLDivElement>()
let _codeCopyRaf: number | null = null
let _codeCopyHost: HTMLElement | null = null
let _codeCopyScrollHandler: (() => void) | null = null
let _codeCopyResizeObserver: ResizeObserver | null = null
let _codeCopyWindowResizeHandler: (() => void) | null = null
let _inlineCodeMouseTimer: number | null = null
let _rootMouseDownHandler: ((ev: MouseEvent) => void) | null = null

// 根据 DOM 元素删除 Milkdown 文档中的对应节点（仅用于所见模式内简易删除）
function deleteWysiwygNodeByDom(el: HTMLElement | null, typeNames: string[]): void {
  try {
    if (!_editor || !el || !typeNames.length) return
    void _editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { state } = view
      let pos: number
      try {
        pos = view.posAtDOM(el, 0)
      } catch {
        const parent = el.parentElement
        if (!parent) return
        try {
          pos = view.posAtDOM(parent, 0)
        } catch {
          return
        }
      }
      const $pos = state.doc.resolve(pos)
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d)
        const name = node.type?.name
        if (!name || !typeNames.includes(name)) continue
        const from = $pos.before(d)
        const to = $pos.after(d)
        view.dispatch(state.tr.delete(from, to).scrollIntoView())
        return
      }
    })
  } catch {}
}

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

function fromFileUri(u: string): string | null {
  try {
    if (!/^file:/i.test(u)) return null
    const url = new URL(u)
    const host = url.hostname || ''
    let p = url.pathname || ''
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
    p = decodeURIComponent(p)
    if (host) {
      // UNC: file://server/share/path -> \\server\share\path
      const pathPart = p.replace(/^\//, '').replace(/\//g, '\\')
      return '\\' + '\\' + host + (pathPart ? '\\' + pathPart : '')
    }
    if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\')
    return p
  } catch { return null }
}
function isTauriRuntime(): boolean {
  try { return typeof (window as any).__TAURI__ !== 'undefined' } catch { return false }
}

function rewriteLocalImagesToAsset() {
  try {
    const host0 = _root as HTMLElement | null
    const host = (host0?.querySelector('.ProseMirror') as HTMLElement | null) || host0
    if (!host) return

    const toDataUrl = async (abs: string): Promise<string | null> => {
      try {
        const bytes = await readFile(abs as any)
        const mime = (() => {
          const m = (abs || '').toLowerCase().match(/\.([a-z0-9]+)$/)
          switch (m?.[1]) {
            case 'jpg':
            case 'jpeg': return 'image/jpeg'
            case 'png': return 'image/png'
            case 'gif': return 'image/gif'
            case 'webp': return 'image/webp'
            case 'bmp': return 'image/bmp'
            case 'avif': return 'image/avif'
            case 'ico': return 'image/x-icon'
            case 'svg': return 'image/svg+xml'
            default: return 'application/octet-stream'
          }
        })()
        const blob = new Blob([bytes], { type: mime })
        return await new Promise<string>((resolve, reject) => {
          try {
            const fr = new FileReader()
            fr.onerror = () => reject(fr.error || new Error('读取图片失败'))
            fr.onload = () => resolve(String(fr.result || ''))
            fr.readAsDataURL(blob)
          } catch (e) { reject(e as any) }
        })
      } catch { return null }
    }

    const convertOne = (imgEl: HTMLImageElement) => {
      try {
        const raw = imgEl.getAttribute('src') || ''
        // 记录原始 src，供所见模式图片编辑弹窗显示/编辑真实路径，而不是 base64
        if (!imgEl.getAttribute('data-flymd-src-raw')) {
          imgEl.setAttribute('data-flymd-src-raw', raw)
        }
        const abs = toLocalAbsFromSrc(raw)
        if (!abs) return
        void (async () => {
          const dataUrl = await toDataUrl(abs)
          if (dataUrl) {
            if (imgEl.src !== dataUrl) imgEl.src = dataUrl
          }
        })()
      } catch {}
    }

    host.querySelectorAll('img[src]').forEach((img) => { try { convertOne(img as HTMLImageElement) } catch {} })

    if (_imgObserver) { try { _imgObserver.disconnect() } catch {} }
    _imgObserver = new MutationObserver((list) => {
      try {
        for (const m of list) {
          if (m.type === 'attributes' && (m.target as any)?.tagName === 'IMG') {
            const el = m.target as HTMLImageElement
            if (!m.attributeName || m.attributeName.toLowerCase() === 'src') convertOne(el)
          } else if (m.type === 'childList') {
            m.addedNodes.forEach((n) => {
              try {
                if ((n as any)?.nodeType === 1) {
                  const el = n as Element
                  if (el.tagName === 'IMG') { convertOne(el as any) }
                  el.querySelectorAll?.('img[src]')?.forEach((img) => { try { convertOne(img as HTMLImageElement) } catch {} })
                }
              } catch {}
            })
          }
        }
      } catch {}
    })
    _imgObserver.observe(host, { subtree: true, attributes: true, attributeFilter: ['src'], childList: true })
  } catch {}
}

function cleanupEditorOnly() {
  try { if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null } } catch {}
  try { cleanupCodeCopyOverlay() } catch {}
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
    .use(upload)
    .use(remarkMathPlugin)
    .use(katexOptionsCtx)
    .use(mathInlineSchema)
    .use(mathBlockSchema)
    .use(mathInlineInputRule)
    .use(mathBlockInputRule)
    .use(mathInlineViewPlugin)
    .use(mathBlockViewPlugin)
    .use(mermaidPlugin)
    .use(automd)
    .use(listener)
    .use(history)
    .create()

  try { rewriteLocalImagesToAsset() } catch {}

  try { rewriteLocalImagesToAsset() } catch {}
  // 初次渲染后聚焦
  try {
    const view = (editor as any).ctx.get(editorViewCtx)
    requestAnimationFrame(() => { try { view?.focus() } catch {} })
  } catch {}
  // 初次渲染后重写本地图片为 asset: url（仅影响 DOM，不改 Markdown）
  try { setTimeout(() => { try { rewriteLocalImagesToAsset() } catch {} }, 0) } catch {}
  // 首次挂载后运行一次增强渲染（Mermaid 块）- 已由 Milkdown 插件自动处理
  // try { setTimeout(() => { try { scheduleMermaidRender() } catch {} }, 60) } catch {}
  // try { window.addEventListener('resize', () => { try { scheduleMermaidRender() } catch {} }) } catch {}
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
      // 所见模式内：中英文括号/引号成对补全/跳过/成对删除（仅限 ProseMirror 视图）
      try { setupBracketPairingForWysiwyg(pm) } catch {}
      // 滚动时刷新覆盖渲染（重定位 Mermaid 预览块）- 已由 Milkdown 插件处理
      // try { pm.addEventListener('scroll', () => { try { scheduleMermaidRender() } catch {} }) } catch {}
      // 鼠标/光标触发 Mermaid 渲染（非实时）- 注释掉按需渲染，改用全局渲染
      // try { pm.addEventListener('mousemove', (ev) => { try { onPmMouseMove(ev as any) } catch {} }, true) } catch {}
      // try { document.addEventListener('selectionchange', () => { try { onPmSelectionChange() } catch {} }, true) } catch {} 
      // 双击 KaTeX / Mermaid / 图片 进入源码编辑
      try { pm.addEventListener('dblclick', (ev) => {
  const t = ev.target as HTMLElement | null;
  const mathHit = t?.closest?.("div[data-type='math_block']") || t?.closest?.("span[data-type='math_inline']");
  if (mathHit) { ev.stopPropagation(); try { enterLatexSourceEdit(mathHit as HTMLElement) } catch {}; return; }
  const imgHit = t?.closest?.('img');
  if (imgHit) { ev.stopPropagation(); try { enterImageSourceEdit(imgHit as HTMLElement) } catch {}; return; }
}, true) } catch {} 
      try {
        pm.addEventListener('keydown', (ev) => {
          try {
            const kev = ev as KeyboardEvent
            if (kev.key === 'ArrowRight') {
              if (exitInlineCodeToRight()) {
                kev.preventDefault()
                try { kev.stopPropagation() } catch {}
                try { (kev as any).stopImmediatePropagation?.() } catch {}
              }
              return
            }
            if (kev.key === 'Enter') {
              tryHandleMathEnter(kev)
            }
          } catch {}
        }, true)
      } catch {}
      // 所见模式内粘贴 URL：支持和编辑模式一致的“抓取网页标题并插入链接”行为
      try {
        pm.addEventListener('paste', (ev: ClipboardEvent) => {
          try {
            const dt = ev.clipboardData
            if (!dt) return
            const plainText = dt.getData('text/plain') || dt.getData('text') || ''
            const plainTrim = plainText.trim()
            let pasteCombo: 'normal' | 'plain' | null = null
            try {
              const v = (window as any).__flymdLastPasteCombo
              pasteCombo = (v === 'normal' || v === 'plain') ? v : null
              ;(window as any).__flymdLastPasteCombo = null
            } catch {}
            if (pasteCombo === 'normal' && plainTrim && /^https?:\/\/[^\s]+$/i.test(plainTrim)) {
              ev.preventDefault()
              void handleWysiwygPasteUrl(plainTrim)
            }
          } catch {}
        }, true)
      } catch {}
      try { pm.addEventListener('mouseup', () => { try { scheduleInlineCodeMouseExit() } catch {} }, true) } catch {}
      try { pm.addEventListener('touchend', () => { try { scheduleInlineCodeMouseExit() } catch {} }, true) } catch {}
      try { setupCodeCopyOverlay(pm) } catch {}
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
    try {
      lm.docChanged((_ctx) => {
        if (_suppressInitialUpdate) return
        // scheduleMermaidRender() // 已由 Milkdown 插件处理
        try { scheduleMathBlockReparse() } catch {}
      })
    } catch {}
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
            const localFromFile = fromFileUri(dec)
            if (localFromFile) return m.replace(s, `<${localFromFile}>`)
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
      try { scheduleCodeCopyRefresh() } catch {}
      // Markdown 更新时，也刷新 Mermaid 渲染 - 已由 Milkdown 插件处理
      // scheduleMermaidRender()
    })
  } catch {}
  _suppressInitialUpdate = false
  _editor = editor
}

export async function disableWysiwygV2() {
  // 先立即隐藏根节点，避免长文本时 await 期间的视觉不一致
  try {
    const host = document.getElementById('md-wysiwyg-root') as HTMLElement | null
    if (host) host.style.display = 'none'
  } catch {}
  try {
    if (_editor) {
      try { const mdNow = await (_editor as any).action(getMarkdown()); _lastMd = mdNow;} catch {}
    }
  } catch {}
  try { if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null } } catch {}
  try { cleanupCodeCopyOverlay() } catch {}
  try { if (_overlayHost && _overlayHost.parentElement) { _overlayHost.parentElement.removeChild(_overlayHost); _overlayHost = null } } catch {}
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
  try {
    const ctx: any = (_editor as any).ctx
    // 若 editorView 尚未就绪或已被销毁，直接跳过，避免 MilkdownError 冒泡
    try { ctx.get(editorViewCtx) } catch { return }
    await _editor.action(replaceAll(markdown))
  } catch {}
}

// =============== 所见模式：查找 / 替换（Ctrl+H 面板接入） ===============
// 说明：
// - 简化实现：仅在单个文本节点内匹配，不跨节点；
// - 支持大小写开关、前后查找；
// - 替换：当前选区精确匹配则替换，否则先定位到下一处再替换；
// - 全部替换：单事务从后往前批量替换，避免位置偏移；

function _getView(): any { try { return (_editor as any)?.ctx?.get?.(editorViewCtx) } catch { return null } }
// 所见模式内“粘贴 URL 自动抓取标题”逻辑：在 ProseMirror 文档上直接构造/更新链接节点
async function handleWysiwygPasteUrl(url: string) {
  const href = String(url || '').trim()
  if (!href) return
  const placeholder = '正在抓取title'
  try { await wysiwygV2ApplyLink(href, placeholder) } catch {}
  let finalLabel = href
  try {
    const fn = (typeof window !== 'undefined') ? (window as any).flymdFetchPageTitle : null
    if (typeof fn === 'function') {
      const title = await fn(href)
      if (title && String(title).trim()) {
        const safe = String(title).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\[\]]/g, '\\$&')
        if (safe) finalLabel = safe
      }
    }
  } catch {}
  if (!finalLabel || finalLabel === placeholder) return
  try { updateFirstLinkLabel(placeholder, finalLabel, href) } catch {}
}
// 在文档中找到第一个文本为 oldLabel 且 href 匹配的链接，并用 newLabel 替换其文本
function updateFirstLinkLabel(oldLabel: string, newLabel: string, href: string) {
  try {
    const view = _getView()
    if (!view) return
    const st = view.state
    const schema = st.schema as any
    const linkType = schema?.marks?.link
    if (!linkType) return
    let target: { from: number, to: number } | null = null
    st.doc.descendants((node: any, pos: number) => {
      if (!node?.isText) return true
      const text = String(node.text || '')
      if (text !== oldLabel) return true
      const hasLink = (node.marks || []).some((m: any) => m.type === linkType && String(m.attrs?.href || '') === href)
      if (!hasLink) return true
      target = { from: pos, to: pos + text.length }
      return false
    })
    if (!target) return
    const tr = st.tr.insertText(newLabel, target.from, target.to).scrollIntoView()
    view.dispatch(tr)
  } catch {}
}

// 所见模式：中英文括号/引号成对补全 / 跳过右侧 / 成对删除（仅作用于 ProseMirror 视图，不影响源码模式逻辑）
function setupBracketPairingForWysiwyg(pm: HTMLElement | null) {
  try {
    if (!pm) return
  } catch { return }

  // 仅包含括号/引号类标点，不处理 * / _ / ~ 等 Markdown 语法
  const OPEN_TO_CLOSE: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    "'": "'",
    '（': '）',
    '【': '】',
    '《': '》',
    '「': '」',
    '『': '』',
    '“': '”',
    '‘': '’',
  }
  const CLOSERS = new Set<string>(Object.values(OPEN_TO_CLOSE))
  let prevSelFrom = 0
  let prevSelTo = 0
  let prevSelText = ''
  let _lastWrapTs = 0  // 记录上次环抱补全的时间戳，用于防抖

  const snapshotSelection = () => {
    try {
      const view = _getView()
      if (!view) return
      const st = view.state
      const sel = st.selection
      if (!(sel instanceof TextSelection)) return
      prevSelFrom = sel.from >>> 0
      prevSelTo = sel.to >>> 0
      if (prevSelFrom < prevSelTo) {
        prevSelText = st.doc.textBetween(prevSelFrom, prevSelTo, undefined, '\n')
      } else {
        prevSelText = ''
      }
    } catch {}
  }

  const handleBeforeInput = (ev: InputEvent) => {
    try {
      // 防抖：如果刚刚执行过环抱补全，跳过后续的 beforeinput 事件
      if (Date.now() - _lastWrapTs < 100) {
        ev.preventDefault()  // 必须阻止浏览器默认行为，否则会重复插入字符
        return
      }
      snapshotSelection()
      const data = (ev as any).data as string || ''
      if (!data || data.length !== 1) return
      // 组合输入阶段全部交给 IME；后续在 input(Composition*) 中统一处理
      if ((ev as any).isComposing) return

      const ch = data
      const isOpen = Object.prototype.hasOwnProperty.call(OPEN_TO_CLOSE, ch)
      const isClose = CLOSERS.has(ch)
      if (!isOpen && !isClose) return

      const view = _getView()
      if (!view) return
      const state = view.state
      const sel = state.selection
      if (!(sel instanceof TextSelection)) return
      const from = sel.from >>> 0
      const to = sel.to >>> 0

      // 成对/环抱补全：插入 open+close，或用 open/close 环绕选区
      if (isOpen) {
        const closeCh = OPEN_TO_CLOSE[ch]
        ev.preventDefault()
        try { ev.stopPropagation() } catch {}
        let tr = state.tr
        if (from === to) {
          tr = tr.insertText(ch + closeCh, from, to)
          tr = tr.setSelection(TextSelection.create(tr.doc, from + ch.length)) as any
        } else {
          tr = tr.insertText(ch, from)
          tr = tr.insertText(closeCh, to + ch.length)
          const endPos = to + ch.length + closeCh.length
          tr = tr.setSelection(TextSelection.create(tr.doc, endPos)) as any
        }
        view.dispatch(tr)
        try { view.focus() } catch {}
        prevSelFrom = 0; prevSelTo = 0; prevSelText = ''
        return
      }

      // 右侧已存在相同闭合标点时：仅移动光标跳过，而不重复插入
      if (isClose && from === to) {
        const next = state.doc.textBetween(from, from + 1, undefined, '\n')
        if (next === ch) {
          ev.preventDefault()
          try { ev.stopPropagation() } catch {}
          const tr = state.tr.setSelection(TextSelection.create(state.doc, from + ch.length)) as any
          view.dispatch(tr)
          try { view.focus() } catch {}
        }
      }
    } catch {}
  }

  // 中文输入法等通过组合提交的括号/引号：在 input(Composition*) 阶段补全
  const handleInput = (ev: InputEvent) => {
    try {
      const data = (ev as any).data as string || ''
      if (!data) return
      const it = String((ev as any).inputType || '')
      // 仅处理组合相关提交，避免与普通按键路径重复
      if (!/Composition/i.test(it)) return

      const ch = data.length > 0 ? data[0] : ''
      const closeCh = OPEN_TO_CLOSE[ch]
      if (!closeCh) return

      const view = _getView()
      if (!view) return
      const state = view.state
      const sel = state.selection
      if (!(sel instanceof TextSelection)) return

      // 组合输入 + 之前存在选区：环抱补全（ch + 选中文本 + closeCh）
      if (prevSelFrom < prevSelTo && prevSelText) {
        const from = prevSelFrom >>> 0
        const to = from + ch.length
        const seg = state.doc.textBetween(from, to, undefined, '\n')
        if (seg === ch) {
          let tr = state.tr.insertText(ch + prevSelText + closeCh, from, to)
          let endPos = from + ch.length + prevSelText.length + closeCh.length
          try {
            const extra = tr.doc.textBetween(endPos, endPos + ch.length + closeCh.length, undefined, '\n')
            if (extra === (ch + closeCh)) {
              tr = tr.delete(endPos, endPos + ch.length + closeCh.length)
            }
          } catch {}
          // 成对环抱后，将光标移到闭合符号之后
          tr = tr.setSelection(TextSelection.create(tr.doc, endPos)) as any
          view.dispatch(tr)
          prevSelFrom = 0; prevSelTo = 0; prevSelText = ''
          _lastWrapTs = Date.now()  // 记录环抱补全时间，用于防抖
          try { view.focus() } catch {}
          return
        }
      }

      // 无选区：组合输入后在右侧补全闭合符
      if (sel.empty) {
        const pos = sel.from >>> 0
        if (pos <= 0) return
        const prev = state.doc.textBetween(pos - 1, pos, undefined, '\n')
        if (prev !== ch) return
        const next = state.doc.textBetween(pos, pos + 1, undefined, '\n')
        if (next === closeCh) return
        let tr = state.tr.insertText(closeCh, pos, pos)
        tr = tr.setSelection(TextSelection.create(tr.doc, pos)) as any
        view.dispatch(tr)
        try { view.focus() } catch {}
      }
    } catch {}
  }

  const handleKeydown = (ev: KeyboardEvent) => {
    try {
      if (ev.key !== 'Backspace') return
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      // 组合输入阶段不介入
      if ((ev as any).isComposing) return

      const view = _getView()
      if (!view) return
      const state = view.state
      const sel = state.selection
      if (!(sel instanceof TextSelection)) return
      if (!sel.empty) return

      const pos = sel.from >>> 0
      if (pos === 0) return
      const prev = state.doc.textBetween(pos - 1, pos, undefined, '\n')
      const next = state.doc.textBetween(pos, pos + 1, undefined, '\n')
      if (!prev || !next) return
      const expectedClose = OPEN_TO_CLOSE[prev]
      if (!expectedClose || expectedClose !== next) return

      ev.preventDefault()
      try { ev.stopPropagation() } catch {}
      let tr = state.tr.delete(pos - 1, pos + 1)
      const newPos = Math.max(0, pos - 1)
      tr = tr.setSelection(TextSelection.create(tr.doc, newPos)) as any
      view.dispatch(tr)
      try { view.focus() } catch {}
    } catch {}
  }

  try { pm.addEventListener('beforeinput', (e) => { try { handleBeforeInput(e as any) } catch {} }, true) } catch {}
  try { pm.addEventListener('input', (e) => { try { handleInput(e as any) } catch {} }, true) } catch {}
  try { pm.addEventListener('keydown', (e) => { try { handleKeydown(e as any) } catch {} }, true) } catch {}

  // 兜底：空白/内容较少时，点击编辑区域外围空白也能把光标放回文档末尾并保持焦点
  try {
    const rootEl = _root as HTMLElement | null
    if (rootEl) {
      if (_rootMouseDownHandler) {
        try { rootEl.removeEventListener('mousedown', _rootMouseDownHandler, true) } catch {}
      }
      _rootMouseDownHandler = (ev: MouseEvent) => {
        try {
          const tgt = ev.target as HTMLElement | null
          // ProseMirror 内部点击完全交给编辑器自身处理
          if (tgt && tgt.closest('.ProseMirror')) return
          const view = _getView()
          if (!view) return
          const state = view.state
          const doc = state.doc
          const safePos = doc.content.size >>> 0
          const tr = state.tr.setSelection(TextSelection.create(doc, safePos))
          view.dispatch(tr.scrollIntoView())
          try { view.focus() } catch {}
          ev.preventDefault()
          try { ev.stopPropagation() } catch {}
        } catch {}
      }
      rootEl.addEventListener('mousedown', _rootMouseDownHandler, true)
    }
  } catch {}
}
function exitInlineCodeToRight(focusView = true): boolean {
  try {
    const view = _getView()
    if (!view) return false
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
    const range = sel.getRangeAt(0)
    const codeEl = findInlineCodeAncestor(range.startContainer)
    if (!codeEl) return false
    if (!isCaretAtInlineCodeEnd(range, codeEl)) return false
    const parent = codeEl.parentNode
    if (!parent) return false
    const idx = Array.prototype.indexOf.call(parent.childNodes, codeEl)
    if (idx < 0) return false
    const pos = view.posAtDOM(parent as Node, idx + 1)
    const state = view.state
    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos))
    view.dispatch(tr)
    if (focusView) {
      try { view.focus() } catch {}
    }
    return true
  } catch { return false }
}

function scheduleInlineCodeMouseExit() {
  try {
    if (_inlineCodeMouseTimer != null) { window.clearTimeout(_inlineCodeMouseTimer); _inlineCodeMouseTimer = null }
  } catch {}
  _inlineCodeMouseTimer = window.setTimeout(() => {
    _inlineCodeMouseTimer = null
    try { exitInlineCodeToRight() } catch {}
  }, 0)
}

// 所见模式下：输入 $$ 回车 后自动打开 KaTeX 源码编辑框
function tryHandleMathEnter(ev: KeyboardEvent) {
  try {
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (!_editor) return
    const view: any = (_editor as any)?.ctx?.get?.(editorViewCtx)
    if (!view) return
    const state = view.state
    const $from = state.selection.$from
    const parent: any = $from.parent
    const text = String(parent?.textContent || '').trim()
    if (text !== '$$') return

    // 让 Milkdown 先处理输入规则（mathBlockInputRule），再定位到新建的 math_block 节点
    window.setTimeout(() => {
      try {
        const viewNow: any = (_editor as any)?.ctx?.get?.(editorViewCtx)
        if (!viewNow) return
        const st = viewNow.state
        const $pos = st.selection.$from
        for (let d = $pos.depth; d >= 0; d--) {
          const node: any = $pos.node(d)
          if (node && node.type?.name === 'math_block') {
            const nodePos = $pos.before(d)
            let dom: HTMLElement | null = null
            try { dom = viewNow.nodeDOM(nodePos) as HTMLElement | null } catch {}
            if (dom) {
              try { (dom as any).dataset.flymdNewMath = '1' } catch {}
              try { enterLatexSourceEdit(dom) } catch {}
            }
            break
          }
        }
      } catch {}
    }, 0)
  } catch {}
}

function findInlineCodeAncestor(node: Node | null): HTMLElement | null {
  try {
    let cur: Node | null = node
    while (cur) {
      if (cur instanceof HTMLElement) {
        if (cur.tagName === 'CODE' && !cur.closest('pre')) return cur
      }
      cur = cur.parentNode
    }
    return null
  } catch { return null }
}

function isCaretAtInlineCodeEnd(range: Range, codeEl: HTMLElement): boolean {
  try {
    const probe = document.createRange()
    probe.selectNodeContents(codeEl)
    probe.collapse(false)
    return range.compareBoundaryPoints(Range.START_TO_START, probe) === 0
  } catch { return false }
}
function _norm(s: string, cs: boolean): string { return cs ? s : s.toLowerCase() }

function _find(term: string, cs: boolean, backwards = false): { from: number, to: number } | null {
  try {
    const view = _getView()
    if (!view || !term) return null
    const state = view.state
    const needle = _norm(String(term), cs)
    const selFrom = state.selection.from >>> 0
    let found: { from: number, to: number } | null = null

    const scan = (startPos: number, endPos: number) => {
      let hit: { from: number, to: number } | null = null
      state.doc.descendants((node: any, pos: number) => {
        if (!backwards && hit) return false
        if (!node?.isText) return true
        const text: string = String(node.text || '')
        if (!text) return true
        const absStart = pos >>> 0
        const absEnd = (pos + text.length) >>> 0
        if (absEnd <= startPos || absStart >= endPos) return true
        const localStart = Math.max(0, startPos - absStart)
        const localEnd = Math.min(text.length, endPos - absStart)
        const segment = text.slice(0, localEnd)
        if (!backwards) {
          const idx = _norm(segment, cs).indexOf(needle, localStart)
          if (idx >= 0) { const from = absStart + idx; hit = { from, to: from + term.length }; return false }
        } else {
          const idx = _norm(segment, cs).lastIndexOf(needle, Math.max(0, Math.min(localEnd - 1, selFrom - absStart)))
          if (idx >= 0 && idx < localEnd) { const from = absStart + idx; hit = { from, to: from + term.length }; return true }
        }
        return true
      })
      if (hit) { found = hit; return true }
      return false
    }

    if (!backwards) {
      if (!scan(state.selection.to >>> 0, state.doc.content.size >>> 0)) scan(0, selFrom)
    } else {
      if (!scan(0, selFrom)) scan(selFrom, state.doc.content.size >>> 0)
    }
    return found
  } catch { return null }
}

function _selectAndScroll(from: number, to: number): boolean {
  try {
    const view = _getView()
    if (!view) return false
    const st = view.state
    const tr = st.tr.setSelection(TextSelection.create(st.doc, from, to)).scrollIntoView()
    view.dispatch(tr)
    try { view.focus() } catch {}
    return true
  } catch { return false }
}

export function wysiwygV2FindNext(term: string, caseSensitive = false): boolean {
  const hit = _find(String(term || ''), !!caseSensitive, false)
  if (!hit) return false
  return _selectAndScroll(hit.from, hit.to)
}

export function wysiwygV2FindPrev(term: string, caseSensitive = false): boolean {
  const hit = _find(String(term || ''), !!caseSensitive, true)
  if (!hit) return false
  return _selectAndScroll(hit.from, hit.to)
}

export function wysiwygV2ReplaceOne(term: string, replacement: string, caseSensitive = false): boolean {
  try {
    const view = _getView()
    if (!view) return false
    const st = view.state
    const cur = st.doc.textBetween(st.selection.from, st.selection.to)
    const match = !!term && (caseSensitive ? cur === term : cur.toLowerCase() === term.toLowerCase())
    if (!match) {
      if (!wysiwygV2FindNext(term, caseSensitive)) return false
    }
    const st2 = view.state
    const tr = st2.tr.insertText(String(replacement || ''), st2.selection.from, st2.selection.to).scrollIntoView()
    view.dispatch(tr)
    try { view.focus() } catch {}
    return true
  } catch { return false }
}

export function wysiwygV2ReplaceAllInDoc(term: string, replacement: string, caseSensitive = false): number {
  try {
    const view = _getView()
    if (!view || !term) return 0
    const st = view.state
    const needle = _norm(String(term), !!caseSensitive)
    const matches: Array<{ from: number, to: number }> = []
    st.doc.descendants((node: any, pos: number) => {
      if (!node?.isText) return true
      const text = String(node.text || '')
      if (!text) return true
      const hay = _norm(text, !!caseSensitive)
      let i = 0
      for (;;) {
        const idx = hay.indexOf(needle, i)
        if (idx < 0) break
        const from = (pos >>> 0) + idx
        matches.push({ from, to: from + term.length })
        i = idx + Math.max(1, term.length)
      }
      return true
    })
    if (!matches.length) return 0
    let tr = st.tr
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i]
      tr = tr.insertText(String(replacement || ''), m.from, m.to)
    }
    view.dispatch(tr.scrollIntoView())
    try { view.focus() } catch {}
    return matches.length
  } catch { return 0 }
}

// =============== 自动渲染覆盖层：Mermaid 代码块 ===============
// 全局渲染节流定时器
let _renderThrottleTimer: number | null = null
// 记录已渲染的 Mermaid 图表，避免重复渲染导致闪烁
const _renderedMermaid = new WeakMap<HTMLElement, string>()

function scheduleMermaidRender() {
  console.log('[DEBUG] scheduleMermaidRender 被调用')
  try { if (_renderThrottleTimer != null) { clearTimeout(_renderThrottleTimer); _renderThrottleTimer = null } } catch {}
  // 使用节流：300ms 内多次调用只执行一次
  _renderThrottleTimer = window.setTimeout(() => { try { renderMermaidNow() } catch {} }, 300)
}

function getHost(): HTMLElement | null {
  try {
    const host0 = _root as HTMLElement | null
    return (host0?.querySelector('.ProseMirror') as HTMLElement | null) || host0
  } catch { return null }
}

function ensureOverlayHost(): HTMLDivElement | null {
  try {
    const root = _root
    if (!root) return null
    if (_overlayHost && _overlayHost.parentElement) return _overlayHost
    const ov = document.createElement('div')
    ov.className = 'overlay-host'
    ov.style.position = 'absolute'
    ov.style.inset = '0'
    ov.style.zIndex = '5'
    ov.style.pointerEvents = 'none'
    root.appendChild(ov)
    _overlayHost = ov
    return ov
  } catch { return null }
}

function scheduleCodeCopyRefresh() {
  try {
    if (_codeCopyRaf != null) return
    _codeCopyRaf = window.requestAnimationFrame(() => {
      _codeCopyRaf = null
      try { refreshCodeCopyButtonsNow() } catch {}
    })
  } catch {}
}

function cleanupCodeCopyOverlay() {
  try {
    if (_codeCopyHost && _codeCopyScrollHandler) { _codeCopyHost.removeEventListener('scroll', _codeCopyScrollHandler) }
  } catch {}
  _codeCopyScrollHandler = null
  _codeCopyHost = null
  try {
    if (_codeCopyResizeObserver) { _codeCopyResizeObserver.disconnect(); _codeCopyResizeObserver = null }
  } catch {}
  if (_codeCopyWindowResizeHandler) {
    try { window.removeEventListener('resize', _codeCopyWindowResizeHandler) } catch {}
    _codeCopyWindowResizeHandler = null
  }
  if (_codeCopyRaf != null) {
    try { cancelAnimationFrame(_codeCopyRaf) } catch {}
    _codeCopyRaf = null
  }
  for (const wrap of _codeCopyWraps.values()) {
    try { wrap.remove() } catch {}
  }
  _codeCopyWraps.clear()
}

function setupCodeCopyOverlay(host: HTMLElement | null) {
  cleanupCodeCopyOverlay()
  let scrollHost: HTMLElement | null = null
  try {
    const root = _root as HTMLElement | null
    // 优先使用 .scrollView，其次是 .ProseMirror
    const sv = root?.querySelector('.scrollView') as HTMLElement | null
    const pm = root?.querySelector('.ProseMirror') as HTMLElement | null
    scrollHost = sv || pm || host || root
  } catch {
    scrollHost = host
  }
  if (!scrollHost) return
  _codeCopyHost = scrollHost
  const onScroll = () => { scheduleCodeCopyRefresh() }
  _codeCopyScrollHandler = onScroll
  // 同时绑定到 scrollHost 和其父容器，确保滚动事件被捕获
  try { scrollHost.addEventListener('scroll', onScroll, { passive: true }) } catch { try { scrollHost.addEventListener('scroll', onScroll) } catch {} }
  // 额外绑定到 _root，捕获可能的冒泡事件
  try { if (_root && _root !== scrollHost) _root.addEventListener('scroll', onScroll, { passive: true, capture: true }) } catch {}
  if (typeof ResizeObserver !== 'undefined') {
    try {
      _codeCopyResizeObserver = new ResizeObserver(() => { scheduleCodeCopyRefresh() })
      _codeCopyResizeObserver.observe(scrollHost)
    } catch {}
  }
  const onResize = () => { scheduleCodeCopyRefresh() }
  _codeCopyWindowResizeHandler = onResize
  window.addEventListener('resize', onResize)
  scheduleCodeCopyRefresh()
}

function getCodeCopyText(pre: HTMLElement): string | null {
  if (!pre || !pre.isConnected) return null
  if (!pre.offsetParent) return null
  if (pre.closest('.mermaid-node-wrapper')) return null
  const codeEl = pre.querySelector('code') as HTMLElement | null
  if (!codeEl) return null
  const raw = codeEl.textContent || ''
  if (!raw.trim()) return null

  // 提取语言信息并构造 Markdown 格式
  let lang = ''
  const codeClasses = codeEl.className || ''
  const preClasses = pre.className || ''
  const langMatch = (codeClasses + ' ' + preClasses).match(/language-(\w+)/)
  if (langMatch && langMatch[1]) {
    lang = langMatch[1]
  }

  // 返回 Markdown 格式的代码块
  if (lang) {
    return '```' + lang + '\n' + raw + '\n```'
  } else {
    return '```\n' + raw + '\n```'
  }
}

function positionCodeCopyWrap(pre: HTMLElement, wrap: HTMLDivElement, rootRc: DOMRect) {
  try {
    const preRc = pre.getBoundingClientRect()
    // 如果代码块完全在视口之上或之下，则隐藏对应按钮，避免在顶部堆积
    if (preRc.bottom <= rootRc.top || preRc.top >= rootRc.bottom) {
      wrap.style.display = 'none'
      return
    }
    // 代码块在可视区域内时，确保按钮可见（flex 布局）
    wrap.style.display = 'flex'
    // 使用整个容器的宽度（包含 Delete + Copy 按钮）
    const wrapW = wrap.offsetWidth || 60
    // 所见模式下滚动发生在内部 scrollView，pre 与 root 的相对位置已经包含滚动偏移
    const left = Math.max(0, (preRc.left - rootRc.left) + Math.max(0, preRc.width - wrapW - 16))
    const top = Math.max(0, (preRc.top - rootRc.top) + 14)
    wrap.style.left = left + 'px'
    wrap.style.top = top + 'px'
  } catch {}
}

function refreshCodeCopyButtonsNow() {
  try {
    const host = getHost()
    const root = _root as HTMLElement | null
    const ov = ensureOverlayHost()
    if (!host || !root || !ov) return
    const rootRc = root.getBoundingClientRect()
    const pres = Array.from(host.querySelectorAll('pre')) as HTMLElement[]
    const alive = new Set<HTMLElement>()
    for (const pre of pres) {
      const copyText = getCodeCopyText(pre)
      if (copyText == null) continue
      alive.add(pre)
      let wrap = _codeCopyWraps.get(pre)
      if (!wrap || !wrap.parentElement) {
        wrap = document.createElement('div')
        wrap.className = 'ov-codecopy'
        wrap.style.position = 'absolute'
        wrap.style.pointerEvents = 'none'
        wrap.style.zIndex = '8'
        wrap.style.display = 'flex'
        wrap.style.gap = '8px'
        // Delete 按钮（左侧，需二次确认）
        const delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'code-delete'
        delBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>'
        delBtn.style.pointerEvents = 'auto'
        ;(delBtn as any).__targetPre = pre
        ;(delBtn as any).__deleteArmed = false
        // 保存原始 SVG 图标用于重置
        const delBtnOriginalHTML = delBtn.innerHTML
        delBtn.addEventListener('click', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          const btn = ev.currentTarget as HTMLButtonElement
          // 第一次点击只进入"待确认"状态，第二次点击才真正删除
          if (!(btn as any).__deleteArmed) {
            ;(btn as any).__deleteArmed = true
            btn.textContent = '确认'
            btn.classList.add('armed')
            return
          }
          const targetPre = (btn as any).__targetPre as HTMLElement | null
          if (targetPre) deleteWysiwygNodeByDom(targetPre, ['code_block'])
        })
        // 失焦时重置确认状态
        delBtn.addEventListener('blur', () => {
          if ((delBtn as any).__deleteArmed) {
            ;(delBtn as any).__deleteArmed = false
            delBtn.innerHTML = delBtnOriginalHTML
            delBtn.classList.remove('armed')
          }
        })
        wrap.appendChild(delBtn)
        // Copy 按钮（右侧）
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'code-copy'
        btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
        btn.style.pointerEvents = 'auto'
        ;(btn as any).__copyText = copyText
        wrap.appendChild(btn)
        ov.appendChild(wrap)
        _codeCopyWraps.set(pre, wrap)
      } else {
        const btn = wrap.querySelector('button.code-copy') as HTMLButtonElement | null
        if (btn) {
          ;(btn as any).__copyText = copyText
        }
      }
      positionCodeCopyWrap(pre, wrap, rootRc)
    }
    for (const [pre, wrap] of Array.from(_codeCopyWraps.entries())) {
      if (!alive.has(pre) || !pre.isConnected) {
        try { wrap.remove() } catch {}
        _codeCopyWraps.delete(pre)
      }
    }
  } catch {}
}

async function renderMermaidInto(el: HTMLDivElement, code: string) {
  try {
    const mod: any = await import('mermaid')
    const mermaid = mod?.default || mod
    // 所见模式：静默 mermaid 内部错误与日志，避免在输入中提示干扰
    try { (mermaid as any).parseError = () => {} } catch {}
    try { if ((mermaid as any).mermaidAPI) (mermaid as any).mermaidAPI.parseError = () => {} } catch {}
    try {
      mermaid.initialize?.({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'default',
        logLevel: 'fatal' as any,
        fontSize: 16 as any,
        flowchart: { useMaxWidth: true } as any,
        themeVariables: { fontFamily: 'Segoe UI, Helvetica, Arial, sans-serif', fontSize: '16px' } as any,
      })
    } catch {}
    const id = 'mmd-' + Math.random().toString(36).slice(2)
    const { svg } = await mermaid.render(id, code || '')
    // 包装为带工具条的容器
    el.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.innerHTML = svg
    const svgEl = wrap.firstElementChild as SVGElement | null
    if (svgEl) {
      const fig = document.createElement('div')
      fig.className = 'mmd-figure'
      fig.appendChild(svgEl)
      try {
        const mk: any = (window as any).createMermaidToolsFor
        if (typeof mk === 'function') {
          const tools = mk(svgEl)
          if (tools) fig.appendChild(tools)
        }
      } catch {}
      el.appendChild(fig)
    }
    try {
      const svgEl = el.querySelector('svg') as SVGElement | null
      if (svgEl) {
        try { (svgEl.style as any).display = 'block'; (svgEl.style as any).maxWidth = '100%'; (svgEl.style as any).height = 'auto' } catch {}
        try { if (!svgEl.getAttribute('preserveAspectRatio')) svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet') } catch {}
        try {
          const vb = svgEl.getAttribute('viewBox') || ''
          if (!/(\d|\s)\s*(\d|\s)/.test(vb)) {
            const w = parseFloat(svgEl.getAttribute('width') || '')
            const h = parseFloat(svgEl.getAttribute('height') || '')
            if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
          }
        } catch {}
        try { if (svgEl.hasAttribute('width')) svgEl.removeAttribute('width') } catch {}
        try { if (svgEl.hasAttribute('height')) svgEl.removeAttribute('height') } catch {}
        setTimeout(() => {
          try {
            const bb = (svgEl as any).getBBox ? (svgEl as any).getBBox() : null
            if (bb && bb.width > 0 && bb.height > 0) {
              const pad = (() => { try { return Math.max(2, Math.min(24, Math.round(Math.max(bb.width, bb.height) * 0.02))) } catch { return 8 } })()
              const vx = Math.floor(bb.x) - pad
              const vy = Math.floor(bb.y) - pad
              const vw = Math.ceil(bb.width) + pad * 2
              const vh = Math.ceil(bb.height) + pad * 2
              svgEl.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)
              const host = el.parentElement as HTMLElement | null
              const pbW = Math.max(0, host?.clientWidth || el.clientWidth || 0)
              const targetW = vw
              let scale = 0.75
              try { const sv = localStorage.getItem('flymd:mermaidScale'); const n = sv ? parseFloat(sv) : NaN; if (Number.isFinite(n) && n > 0) scale = n } catch {}
              const base = pbW > 0 ? Math.min(pbW, targetW) : targetW
              const finalW = Math.max(10, Math.round(base * scale))
              ;(svgEl.style as any).width = finalW + 'px'
            }
          } catch {}
        }, 0)
      }
    } catch {}
  } catch (e) {
    // 所见模式：隐藏渲染失败提示（保持空内容，不覆盖底下的源码输入）
    try { el.innerHTML = '' } catch {}
  }
}


function onPmMouseMove(ev: MouseEvent) {
  try {
    const t = ev.target as HTMLElement | null
    const pre = t?.closest?.('pre') as HTMLElement | null
    const hit = (() => {
      if (!pre) return null
      const codeEl = pre.querySelector('code') as HTMLElement | null
      const langFromClass = codeEl ? /\\blanguage-([\\w-]+)\\b/.exec(codeEl.className || '')?.[1] : ''
      const langFromAttr = (pre.getAttribute('data-language') || pre.getAttribute('data-lang') || '').toLowerCase()
      const lang = (langFromAttr || langFromClass || '').toLowerCase()
      return lang === 'mermaid' ? pre : null
    })()
    // 鼠标只是辅助手段：仅在没有光标命中的情况下生效
    _activeMermaidPreByMouse = hit
    const next = _activeMermaidPreBySelection || _activeMermaidPreByMouse
    if (next !== _activeMermaidPre) { _activeMermaidPre = next; scheduleMermaidRender() }
  } catch {}
}

function onPmSelectionChange() {
  try {
    const sel = window.getSelection()
    const n = sel?.focusNode as (Node & { parentElement?: HTMLElement }) | null
    const el = (n && (n as any).nodeType === 1 ? (n as any as HTMLElement) : n?.parentElement) as HTMLElement | null
    const pre = el?.closest?.('pre') as HTMLElement | null
    const codeEl = pre?.querySelector?.('code') as HTMLElement | null
    const langFromClass = codeEl ? /\\blanguage-([\\w-]+)\\b/.exec(codeEl.className || '')?.[1] : ''
    const langFromAttr = pre ? (pre.getAttribute('data-language') || pre.getAttribute('data-lang') || '').toLowerCase() : ''
    const lang = (langFromAttr || langFromClass || '').toLowerCase()
    const hit = (lang === 'mermaid' ? pre : null) as HTMLElement | null
    // 光标优先级最高：直接覆盖选择源，再与鼠标源合并计算
    _activeMermaidPreBySelection = hit
    const next = _activeMermaidPreBySelection || _activeMermaidPreByMouse
    if (next !== _activeMermaidPre) { _activeMermaidPre = next; scheduleMermaidRender() }
  } catch {}
}

// ===== Latex 源码编辑：在 KaTeX 上方叠加一个 textarea 进行就地编辑，保存后仅更新该数学节点 =====

//  闭合后再渲染（不在输入起始处触发）
let _mathReparseTimer: number | null = null
let _suppressMathReparse = false // 在手动更新数学节点后临时阻止 reparse
function scheduleMathBlockReparse() {
  if (_suppressMathReparse) return // 阻止重复处理
  try { if (_mathReparseTimer != null) { clearTimeout(_mathReparseTimer); _mathReparseTimer = null } } catch {}
  _mathReparseTimer = window.setTimeout(async () => {
    if (_suppressMathReparse) return // 再次检查
    try {
      const mdNow = await (_editor as any).action(getMarkdown())
      if (/\$\$[\s\S]*?\$\$/m.test(String(mdNow || ''))) {
        await (_editor as any).action(replaceAll(String(mdNow || '')))
      }
    } catch {}
  }, 240)
}
function updateMilkdownMathFromDom(mathEl: HTMLElement, newValue: string) {
  try {
    // 阻止 scheduleMathBlockReparse 重复处理
    _suppressMathReparse = true
    setTimeout(() => { _suppressMathReparse = false }, 500)

    const view: any = (_editor as any)?.ctx?.get?.(editorViewCtx)
    if (!view || !mathEl) return
    let pos: number | null = null
    try { pos = view.posAtDOM(mathEl, 0) } catch {}
    if (pos == null || typeof pos !== 'number') return
    const state = view.state
    const $pos = state.doc.resolve(pos)
    const isMath = (n: any) => !!n && (n.type?.name === 'math_inline' || n.type?.name === 'math_block')
    const isBlock = (mathEl.dataset?.type === 'math_block' || mathEl.tagName === 'DIV')
    const targetType = isBlock ? 'math_block' : 'math_inline'

    // 更可靠的位置查找：向上遍历深度找到 math 节点
    let from = -1, to = -1
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d)
      if (node.type?.name === targetType) {
        from = $pos.before(d)
        to = $pos.after(d)
        break
      }
    }
    // 回退：检查 nodeAfter/nodeBefore
    if (from < 0) {
      if ($pos.nodeAfter && isMath($pos.nodeAfter)) {
        from = pos
        to = pos + $pos.nodeAfter.nodeSize
      } else if ($pos.nodeBefore && isMath($pos.nodeBefore)) {
        from = pos - $pos.nodeBefore.nodeSize
        to = pos
      }
    }
    // 仍未找到则不执行
    if (from < 0 || to < 0 || from === to) {
      console.warn('[updateMilkdownMathFromDom] 无法找到 math 节点位置')
      return
    }

    const schema = state.schema
    let node: any
    if (isBlock) {
      const t = schema.nodes['math_block']
      node = t?.create?.({ value: String(newValue || '') })
    } else {
      const t = schema.nodes['math_inline']
      const text = schema.text(String(newValue || ''))
      node = t?.create?.({}, text)
    }
    if (!node) return
    const tr = state.tr.replaceRangeWith(from, to, node)
    view.dispatch(tr.scrollIntoView())
  } catch (e) {
    console.error('[updateMilkdownMathFromDom] 错误:', e)
  }
}
// 从图片 DOM 反向更新 Milkdown 文档中的 image 节点
function updateMilkdownImageFromDom(imgEl: HTMLImageElement, newSrc: string, newAlt: string) {
  try {
    const view: any = (_editor as any)?.ctx?.get?.(editorViewCtx)
    if (!view || !imgEl) return
    let pos: number | null = null
    try { pos = view.posAtDOM(imgEl, 0) } catch {}
    if (pos == null || typeof pos !== 'number') return
    const state = view.state
    const $pos = state.doc.resolve(pos)
    const isImage = (n: any) => !!n && n.type?.name === 'image'
    let nodePos = pos
    let node: any = $pos.nodeAfter
    if (!isImage(node) && $pos.nodeBefore && isImage($pos.nodeBefore)) {
      node = $pos.nodeBefore
      nodePos = pos - node.nodeSize
    }
    if (!isImage(node)) return
    const attrs: any = { ...(node.attrs || {}) }
    const src = String(newSrc || '').trim()
    if (src) attrs.src = src
    attrs.alt = String(newAlt || '')
    const tr = state.tr.setNodeMarkup(nodePos, node.type, attrs, node.marks)
    view.dispatch(tr.scrollIntoView())
  } catch {}
}

function deleteMilkdownImageFromDom(imgEl: HTMLImageElement) {
  try {
    const view: any = (_editor as any)?.ctx?.get?.(editorViewCtx)
    if (!view || !imgEl) return
    let pos: number | null = null
    try { pos = view.posAtDOM(imgEl, 0) } catch {}
    if (pos == null || typeof pos !== 'number') return
    const state = view.state
    const $pos = state.doc.resolve(pos)
    const isImage = (n: any) => !!n && n.type?.name === 'image'
    let nodePos = pos
    let node: any = $pos.nodeAfter
    if (!isImage(node) && $pos.nodeBefore && isImage($pos.nodeBefore)) {
      node = $pos.nodeBefore
      nodePos = pos - node.nodeSize
    }
    if (!isImage(node)) return
    const tr = state.tr.delete(nodePos, nodePos + node.nodeSize)
    view.dispatch(tr.scrollIntoView())
  } catch {}
}
// 图片源码编辑：在所见模式中双击图片，弹出 alt/src 编辑框
function enterImageSourceEdit(hitEl: HTMLElement) {
  try {
    const img = (hitEl.closest('img') as HTMLImageElement) || null
    if (!img) return
    const ov = ensureOverlayHost()
    if (!ov) return
    const hostRc = (_root as HTMLElement).getBoundingClientRect()
    const rc = img.getBoundingClientRect()
    const hostWidth = hostRc.width || 0

    const marginX = 16
    const baseWidth = rc.width || 0
    const minWidth = Math.max(320, baseWidth + 40)
    const maxWidth = Math.max(200, hostWidth - marginX * 2)
    const finalWidth = Math.min(maxWidth, minWidth)

    const wrap = document.createElement('div')
    wrap.className = 'ov-image'
    wrap.style.position = 'absolute'
    wrap.style.pointerEvents = 'none'
    const centerX = (rc.left - hostRc.left) + (rc.width / 2)
    let left = centerX - finalWidth / 2
    left = Math.max(marginX, Math.min(hostWidth - finalWidth - marginX, left))
    wrap.style.left = Math.max(0, Math.round(left)) + 'px'
    wrap.style.top = Math.max(8, Math.round(rc.bottom - hostRc.top + 8)) + 'px'
    wrap.style.width = Math.max(10, finalWidth) + 'px'

    const inner = document.createElement('div')
    inner.style.pointerEvents = 'auto'
    inner.style.background = 'var(--wysiwyg-bg)'
    inner.style.borderRadius = '4px'
    inner.style.padding = '6px'
    inner.style.boxSizing = 'border-box'
    inner.style.display = 'flex'
    inner.style.flexDirection = 'column'
    inner.style.rowGap = '4px'
    inner.style.position = 'relative'

    const altInput = document.createElement('input')
    altInput.type = 'text'
    altInput.value = img.getAttribute('alt') || ''
    altInput.placeholder = '替换文本（可选）'
    altInput.style.width = '100%'

    const urlInput = document.createElement('input')
    urlInput.type = 'text'
    // 优先使用记录下来的原始路径（file/本地相对路径等），避免展示 base64 / asset: 等转译结果
    urlInput.value = img.getAttribute('data-flymd-src-raw') || img.getAttribute('src') || ''
    urlInput.placeholder = '图片地址（必填）'
    urlInput.style.width = '100%'

    const btnRow = document.createElement('div')
    btnRow.style.display = 'flex'
    btnRow.style.justifyContent = 'flex-end'
    btnRow.style.columnGap = '8px'

    const btnDelete = document.createElement('button')
    btnDelete.type = 'button'
    btnDelete.textContent = 'Delete'

    const btnCancel = document.createElement('button')
    btnCancel.type = 'button'
    btnCancel.textContent = '取消'

    const btnOk = document.createElement('button')
    btnOk.type = 'button'
    btnOk.textContent = '确定'

    btnRow.appendChild(btnDelete)
    btnRow.appendChild(btnCancel)
    btnRow.appendChild(btnOk)

    inner.appendChild(altInput)
    inner.appendChild(urlInput)
    inner.appendChild(btnRow)
    wrap.appendChild(inner)
    ov.appendChild(wrap)

    const close = () => { try { ov.removeChild(wrap) } catch {} }
    const apply = () => {
      const src = urlInput.value.trim()
      const alt = altInput.value || ''
      if (!src) { try { urlInput.focus() } catch {}; return }
      try { img.setAttribute('data-flymd-src-raw', src) } catch {}
      try { updateMilkdownImageFromDom(img, src, alt) } catch {}
      close()
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); apply(); return }
    }

    altInput.addEventListener('keydown', onKey)
    urlInput.addEventListener('keydown', onKey)
    btnCancel.addEventListener('click', () => { close() })
    btnOk.addEventListener('click', () => { apply() })
    btnDelete.addEventListener('click', (ev) => {
      ev.preventDefault()
      // 第一次点击只进入"待确认"状态，第二次点击才真正删除图片
      if (!(btnDelete as any)._armed) {
        ;(btnDelete as any)._armed = true
        btnDelete.textContent = '确认删除'
        return
      }
      deleteMilkdownImageFromDom(img)
      close()
    })
    // 删除按钮失焦时重置确认状态
    btnDelete.addEventListener('blur', () => {
      if ((btnDelete as any)._armed) {
        ;(btnDelete as any)._armed = false
        btnDelete.textContent = 'Delete'
      }
    })

    setTimeout(() => { try { urlInput.focus(); urlInput.select() } catch {} }, 0)
  } catch {}
}

function enterLatexSourceEdit(hitEl: HTMLElement) {
  try {
    const mathEl = (hitEl.closest("div[data-type='math_block']") as HTMLElement) || (hitEl.closest("span[data-type='math_inline']") as HTMLElement)
    if (!mathEl) return
    const isNew = !!(mathEl as any).dataset?.flymdNewMath
    try { delete (mathEl as any).dataset?.flymdNewMath } catch {}
    const rawCode = (mathEl.dataset?.value || mathEl.textContent || '')
    const code = String(rawCode || '').trim()
    const ov = ensureOverlayHost()
    const hostRc = (_root as HTMLElement).getBoundingClientRect()
    const rc = mathEl.getBoundingClientRect()
    const hostWidth = hostRc.width || 0
    const isBlock = (mathEl.dataset?.type === 'math_block' || mathEl.tagName === 'DIV')

    // 计算编辑弹层宽度：在公式自身宽度基础上增加余量，并限制在容器范围内
    const marginX = 16
    const baseWidth = rc.width || 0
    const minWidth = Math.max(320, baseWidth + 40)
    const maxWidth = Math.max(200, hostWidth - marginX * 2)
    const finalWidth = Math.min(maxWidth, minWidth)

    const wrap = document.createElement('div')
    wrap.className = 'ov-katex'
    wrap.style.position = 'absolute'
    wrap.style.pointerEvents = 'none'
    // 水平居中对齐当前公式，并保证不会超出容器
    const centerX = (rc.left - hostRc.left) + (rc.width / 2)
    let left = centerX - finalWidth / 2
    left = Math.max(marginX, Math.min(hostWidth - finalWidth - marginX, left))
    wrap.style.left = Math.max(0, Math.round(left)) + 'px'
    // 垂直位置：放在公式下方留一点空隙
    wrap.style.top = Math.max(8, Math.round(rc.bottom - hostRc.top + 8)) + 'px'
    wrap.style.width = Math.max(10, finalWidth) + 'px'

    const inner = document.createElement('div')
    inner.style.pointerEvents = 'auto'
    inner.style.background = 'var(--wysiwyg-bg)'
    inner.style.borderRadius = '4px'
    inner.style.padding = '6px'
    inner.style.boxSizing = 'border-box'
    inner.style.display = 'flex'
    inner.style.flexDirection = 'column'
    inner.style.alignItems = 'stretch'

    const header = document.createElement('div')
    header.style.display = 'flex'
    header.style.justifyContent = 'flex-end'
    header.style.marginBottom = '4px'

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.textContent = 'Delete'

    header.appendChild(delBtn)
    inner.appendChild(header)

    const ta = document.createElement('textarea')
    const placeholder = '在此输入Katex公式'
    const displayCode = (isBlock && isNew && !code) ? placeholder : code
    ta.value = (isBlock ? ('$$\n' + (displayCode || '') + '\n$$') : ('$' + (displayCode || '') + '$'))
    ta.style.width = '100%'
    // 根据公式类型与渲染高度估算一个更宽松的编辑高度，避免复杂公式被挤在两行内
    const baseLines = isBlock ? 4 : 3
    const lineHeightPx = 20
    const renderH = rc.height || 0
    const minHeightPx = Math.max(baseLines * lineHeightPx, renderH + (isBlock ? 16 : 8))
    ta.style.minHeight = minHeightPx + 'px'
    ta.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
    ta.style.fontSize = '14px'
    ta.style.lineHeight = '1.4'
    ta.style.resize = 'vertical'

    inner.appendChild(ta)

    const apply = () => {
      let v = ta.value
      v = String(v || '').trim()
      const isBlk = (mathEl.dataset?.type === 'math_block' || mathEl.tagName === 'DIV')
      if (isBlk) {
        const m = v.match(/^\s*\$\$\s*[\r\n]?([\s\S]*?)\s*[\r\n]?\$\$\s*$/)
        if (m) v = m[1]
      } else {
        const m = v.match(/^\s*\$([\s\S]*?)\$\s*$/)
        if (m) v = m[1]
      }
      updateMilkdownMathFromDom(mathEl, v)
      try { ov?.removeChild(wrap) } catch {}
    }

    ta.addEventListener('keydown', (ev) => {
      const kev = ev as KeyboardEvent
      if (kev.key === 'Escape') { try { ov?.removeChild(wrap) } catch {}; return }
      if (kev.key === 'Enter' && (kev.ctrlKey || kev.metaKey)) {
        kev.preventDefault()
        apply()
      }
    })
    // 点击其他区域：自动应用当前输入，再关闭编辑框（但点击 Delete 按钮时不关闭）
    ta.addEventListener('blur', (ev) => {
      const related = (ev as FocusEvent).relatedTarget as HTMLElement | null
      // 如果焦点转移到 Delete 按钮，不关闭，让删除逻辑接管
      if (related && (related === delBtn || related.closest?.('button') === delBtn)) return
      apply()
    })

    let deleteArmed = false
    const resetDeleteState = () => {
      if (deleteArmed) {
        deleteArmed = false
        delBtn.textContent = 'Delete'
      }
    }
    delBtn.addEventListener('click', (ev) => {
      ev.preventDefault()
      // 第一次点击只进入"待确认"状态，第二次点击才真正删除公式
      if (!deleteArmed) {
        deleteArmed = true
        delBtn.textContent = '确认删除'
        return
      }
      deleteWysiwygNodeByDom(mathEl, ['math_inline', 'math_block'])
      try { ov?.removeChild(wrap) } catch {}
    })
    // 删除按钮失焦时重置确认状态，并关闭编辑框（除非焦点转移到 textarea）
    delBtn.addEventListener('blur', (ev) => {
      const related = (ev as FocusEvent).relatedTarget as HTMLElement | null
      resetDeleteState()
      // 如果焦点转移到 textarea，不关闭编辑框（允许用户继续编辑）
      if (related === ta) return
      // 焦点转移到其他地方，关闭编辑框
      try { ov?.removeChild(wrap) } catch {}
    })

    wrap.appendChild(inner)
    ov?.appendChild(wrap)
    setTimeout(() => { try { ta.focus(); ta.select() } catch {} }, 0)
  } catch {}
}
function renderMermaidNow() {
  console.log('[DEBUG] renderMermaidNow 被调用')
  const host = getHost()
  const ov = ensureOverlayHost()
  console.log('[DEBUG] host:', host, 'ov:', ov)
  if (!host || !ov) return

  const hostRc = (_root as HTMLElement).getBoundingClientRect()

  // 方案：使用覆盖层 + 给 pre 设置 min-height
  try {
    const allPres = Array.from(host.querySelectorAll('pre')) as HTMLElement[]
    console.log('[DEBUG] 找到的所有 pre 元素数量:', allPres.length)

    const pres: HTMLElement[] = allPres.filter(pre => {
      const langFromAttr = (pre.getAttribute('data-language') || '').toLowerCase()
      return langFromAttr === 'mermaid'
    })

    console.log('[DEBUG] 过滤后的 mermaid 代码块数量:', pres.length)

    for (const pre of pres) {
      try {
        const codeEl = pre.querySelector('code') as HTMLElement | null
        if (!codeEl) continue

        const code = (codeEl.textContent || '').trim()
        if (!code) continue

        // 为每个 pre 元素分配唯一 ID
        if (!pre.dataset.mermaidId) {
          pre.dataset.mermaidId = 'mmd-' + Math.random().toString(36).slice(2)
        }
        const mermaidId = pre.dataset.mermaidId

        // 检查是否已经渲染过
        const cached = _renderedMermaid.get(pre)
        if (cached === code) {
          console.log('[DEBUG] 代码未变化，跳过渲染')
          // 更新覆盖层位置
          const exist = ov.querySelector(`.ov-mermaid[data-mermaid-id="${mermaidId}"]`) as HTMLDivElement | null
          if (exist) {
            const rc = pre.getBoundingClientRect()
            const codeRc = codeEl.getBoundingClientRect()
            exist.style.left = Math.max(0, rc.left - hostRc.left) + 'px'
            exist.style.top = Math.max(0, codeRc.bottom - hostRc.top + 8) + 'px'
            exist.style.width = Math.max(10, rc.width) + 'px'
          }
          continue
        }

        _renderedMermaid.set(pre, code)
        console.log('[DEBUG] 开始渲染 mermaid，id:', mermaidId)

        const rc = pre.getBoundingClientRect()
        const codeRc = codeEl.getBoundingClientRect()

        // 创建覆盖层
        const wrap = document.createElement('div')
        wrap.className = 'ov-mermaid'
        wrap.dataset.mermaidId = mermaidId
        wrap.style.position = 'absolute'
        wrap.style.left = Math.max(0, rc.left - hostRc.left) + 'px'
        wrap.style.top = Math.max(0, codeRc.bottom - hostRc.top + 8) + 'px'
        wrap.style.width = Math.max(10, rc.width) + 'px'
        wrap.style.pointerEvents = 'auto'
        wrap.style.zIndex = '10'

        const inner = document.createElement('div')
        inner.style.background = 'var(--wysiwyg-bg)'
        inner.style.borderRadius = '4px'
        inner.style.padding = '8px'
        inner.style.opacity = '0'
        inner.style.transition = 'opacity 0.15s ease-in'
        inner.style.boxSizing = 'border-box'

        wrap.appendChild(inner)
        ov.appendChild(wrap)

        // 双击切换回源代码
        wrap.addEventListener('dblclick', (e) => {
          e.stopPropagation()
          wrap.style.display = 'none'
          pre.scrollIntoView({ block: 'center', behavior: 'smooth' })
        })

        // 渲染图表
        void (async () => {
          try {
            await renderMermaidInto(inner, code)
            const renderedHeight = inner.getBoundingClientRect().height

            // 关键：设置 pre 的 min-height，使用 !important 防止被覆盖
            pre.style.setProperty('min-height', (renderedHeight + 32) + 'px', 'important')
            console.log('[DEBUG] 设置 pre min-height:', renderedHeight + 32, 'px')

            requestAnimationFrame(() => { inner.style.opacity = '1' })
          } catch (e) {
            console.error('[DEBUG] 渲染失败:', e)
          }
        })()

      } catch (e) {
        console.error('[DEBUG] 处理 pre 失败:', e)
      }
    }
  } catch (e) {
    console.error('[DEBUG] renderMermaidNow 失败:', e)
  }
}







// =============== 所见模式内编辑快捷：加粗 / 斜体 / 链接 ===============
// 方案：调用 Milkdown 命令，同时在“有选区”时自动把光标移到选区末尾，避免继续输入时覆盖原文本
export async function wysiwygV2ToggleBold() {
  if (!_editor) return
  const { toggleStrongCommand } = await import('@milkdown/preset-commonmark')
  await _editor.action((ctx) => {
    const commands = ctx.get(commandsCtx)
    const view = ctx.get(editorViewCtx)
    const { state } = view
    const { empty } = state.selection
    const hadRange = !empty
    commands.call((toggleStrongCommand as any).key)
      if (hadRange) {
        try {
          const st2 = view.state
          const pos = st2.selection.to >>> 0
          const safePos = Math.max(0, Math.min(st2.doc.content.size, pos))
          let tr = st2.tr.setSelection(TextSelection.create(st2.doc, safePos))
          try { (tr as any).setStoredMarks([]) } catch {}
          view.dispatch(tr.scrollIntoView())
        } catch {}
      }
  })
}

export async function wysiwygV2ToggleItalic() {
  if (!_editor) return
  const { toggleEmphasisCommand } = await import('@milkdown/preset-commonmark')
  await _editor.action((ctx) => {
    const commands = ctx.get(commandsCtx)
    const view = ctx.get(editorViewCtx)
    const { state } = view
    const { empty } = state.selection
    const hadRange = !empty
    commands.call((toggleEmphasisCommand as any).key)
    if (hadRange) {
      try {
        const st2 = view.state
        const pos = st2.selection.to >>> 0
        const safePos = Math.max(0, Math.min(st2.doc.content.size, pos))
        let tr = st2.tr.setSelection(TextSelection.create(st2.doc, safePos))
        try { (tr as any).setStoredMarks([]) } catch {}
        view.dispatch(tr.scrollIntoView())
      } catch {}
    }
  })
}
// 所见模式链接应用：
// - 兼容旧签名：wysiwygV2ApplyLink(href, title?)
// - 新用法：wysiwygV2ApplyLink(href, label) —— 在无选区时插入带文本的链接，有选区时用 label 覆盖选中文本
export async function wysiwygV2ApplyLink(href: string, labelOrTitle?: string, maybeTitle?: string) {
  if (!_editor) return
  const { toggleLinkCommand, updateLinkCommand } = await import('@milkdown/preset-commonmark')
  await _editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const commands = ctx.get(commandsCtx)
    const { state } = view
    const { empty } = state.selection as any
    const hadRange = !empty

    // 兼容：如果传入了第三个参数，则视为旧签名 (href, title)
    const hasTitle = typeof maybeTitle === 'string'
    const title = hasTitle ? (labelOrTitle as string | undefined) : (maybeTitle as string | undefined)
    const label = hasTitle ? undefined : (labelOrTitle as string | undefined)

    const schema = state.schema as any
    const linkType = schema.marks?.link
    const attrs: any = title ? { href, title } : { href }

    // 新行为：提供了 label 时，统一用 replaceSelectionWith 插入一整个带 link mark 的文本节点
    // 这样不会出现“最后一个字符漏掉”的偏移问题，同时兼容“有选区”和“无选区”两种情况
    if (typeof label === 'string' && label && linkType) {
      try {
        let tr = state.tr
        const textNode = schema.text(label, [linkType.create(attrs)])
        // 无论是否有选区，直接用链接文本替换当前选区 / 光标位置
        tr = tr.replaceSelectionWith(textNode, false)
        // 将光标放到插入文本的末尾，避免继续输入覆盖选中文本
        const pos = tr.selection.to >>> 0
        tr = tr.setSelection(TextSelection.create(tr.doc, pos))
        // 关键：清空 storedMarks，避免后续输入继续继承链接样式
        try { (tr as any).setStoredMarks([]) } catch {}
        view.dispatch(tr.scrollIntoView())
        return
      } catch {
        // 若手工事务失败，兜底退回旧逻辑
      }
    }

    // 旧行为（无 label）：调用 Milkdown 内置命令，并在“有选区”时把光标移到链接之后
    if (!commands.call((toggleLinkCommand as any).key, attrs)) {
      commands.call((updateLinkCommand as any).key, attrs)
      return
    }
    try {
      const st2 = view.state
      if (!st2.selection.empty) {
        const pos = st2.selection.to >>> 0
        const safePos = Math.max(0, Math.min(st2.doc.content.size, pos))
        let tr = st2.tr.setSelection(TextSelection.create(st2.doc, safePos))
        try { (tr as any).setStoredMarks([]) } catch {}
        view.dispatch(tr.scrollIntoView())
      }
    } catch {}
  })
}

// 获取当前选中的文本
export function wysiwygV2GetSelectedText(): string {
  if (!_editor) return ''
  try {
    const view = (_editor as any).ctx?.get?.(editorViewCtx)
    if (!view) return ''
    const { state } = view
    const { from, to } = state.selection
    const selectedText = state.doc.textBetween(from, to, ' ')
    return selectedText || ''
  } catch {
    return ''
  }
}








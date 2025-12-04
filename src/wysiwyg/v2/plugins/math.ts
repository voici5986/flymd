// Milkdown Math 插件：修复 KaTeX 渲染时显示源代码的问题
import { $view } from '@milkdown/utils'
import { mathInlineSchema, mathBlockSchema } from '@milkdown/plugin-math'
import type { Node } from '@milkdown/prose/model'
import type { EditorView, NodeView } from '@milkdown/prose/view'

// Math Inline NodeView
class MathInlineNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null
  private katexContainer: HTMLElement
  private node: Node

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node

    // 创建外层容器
    this.dom = document.createElement('span')
    this.dom.classList.add('math-inline-wrapper')
    this.dom.dataset.type = 'math_inline'
    this.dom.style.display = 'inline-block'
    this.dom.style.position = 'relative'

    // 创建隐藏的 contentDOM（保持可编辑）
    this.contentDOM = document.createElement('span')
    this.contentDOM.style.position = 'absolute'
    this.contentDOM.style.opacity = '0'
    this.contentDOM.style.pointerEvents = 'none'
    this.contentDOM.style.width = '0'
    this.contentDOM.style.height = '0'
    this.contentDOM.style.overflow = 'hidden'
    this.dom.appendChild(this.contentDOM)

    // 创建 KaTeX 渲染容器
    this.katexContainer = document.createElement('span')
    this.katexContainer.classList.add('katex-display-inline')
    this.dom.appendChild(this.katexContainer)

    // 初始渲染
    this.renderMath()
  }

  private async renderMath() {
    try {
      const code = this.node.textContent || ''
      const value = this.node.attrs.value || code

      // 将原始公式内容同步到 DOM 属性，供外层编辑逻辑安全读取
      try { (this.dom as HTMLElement).dataset.value = value } catch {}

      // 动态导入 KaTeX 及其 CSS（CSS 只会加载一次，用于隐藏 .katex-mathml）
      const [katex] = await Promise.all([
        import('katex'),
        import('katex/dist/katex.min.css')
      ])

      this.katexContainer.innerHTML = ''
      katex.default.render(value, this.katexContainer, {
        throwOnError: false,
        displayMode: false,
        strict: 'ignore',
      })
    } catch (e) {
      console.error('[Math Plugin] 渲染失败:', e)
      this.katexContainer.textContent = this.node.textContent || ''
    }
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false

    const oldValue = this.node.attrs.value || this.node.textContent
    const newValue = node.attrs.value || node.textContent

    this.node = node

    if (oldValue !== newValue) {
      this.renderMath()
    }

    return true
  }

  ignoreMutation() {
    return true
  }
}

// Math Block NodeView
class MathBlockNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null
  private katexContainer: HTMLElement
  private node: Node

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node

    // 创建外层容器
    this.dom = document.createElement('div')
    this.dom.classList.add('math-block-wrapper')
    this.dom.dataset.type = 'math_block'
    this.dom.style.margin = '1em 0'
    this.dom.style.position = 'relative'

    // 创建隐藏的 contentDOM（保持可编辑）
    this.contentDOM = document.createElement('div')
    this.contentDOM.style.position = 'absolute'
    this.contentDOM.style.opacity = '0'
    this.contentDOM.style.pointerEvents = 'none'
    this.contentDOM.style.width = '0'
    this.contentDOM.style.height = '0'
    this.contentDOM.style.overflow = 'hidden'
    this.dom.appendChild(this.contentDOM)

    // 创建 KaTeX 渲染容器
    this.katexContainer = document.createElement('div')
    this.katexContainer.classList.add('katex-display-block')
    this.katexContainer.style.textAlign = 'center'
    this.dom.appendChild(this.katexContainer)

    // 初始渲染
    this.renderMath()
  }

  private async renderMath() {
    try {
      const value = this.node.attrs.value || this.node.textContent || ''

      // 将原始公式内容同步到 DOM 属性，供外层编辑逻辑安全读取
      try { (this.dom as HTMLElement).dataset.value = value } catch {}

      // 动态导入 KaTeX 及其 CSS（CSS 只会加载一次，用于隐藏 .katex-mathml）
      const [katex] = await Promise.all([
        import('katex'),
        import('katex/dist/katex.min.css')
      ])

      this.katexContainer.innerHTML = ''
      katex.default.render(value, this.katexContainer, {
        throwOnError: false,
        displayMode: true,
        strict: 'ignore',
      })
    } catch (e) {
      console.error('[Math Plugin] 渲染失败:', e)
      this.katexContainer.textContent = this.node.textContent || ''
    }
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false

    const oldValue = this.node.attrs.value || this.node.textContent
    const newValue = node.attrs.value || node.textContent

    this.node = node

    if (oldValue !== newValue) {
      this.renderMath()
    }

    return true
  }

  ignoreMutation() {
    return true
  }
}

// 创建 math inline 插件
export const mathInlineViewPlugin = $view(mathInlineSchema.node, () => {
  return (node, view, getPos) => {
    return new MathInlineNodeView(node, view, getPos as () => number | undefined)
  }
})

// 创建 math block 插件
export const mathBlockViewPlugin = $view(mathBlockSchema.node, () => {
  return (node, view, getPos) => {
    return new MathBlockNodeView(node, view, getPos as () => number | undefined)
  }
})

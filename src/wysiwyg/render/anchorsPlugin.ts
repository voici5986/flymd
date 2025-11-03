// anchorsPlugin.ts - 为 markdown-it 注入源位锚点（data-pos-start/data-line）
// 仅对块级 token 打标，后续用于 WYSIWYG 滚动映射

import type MarkdownIt from 'markdown-it'

export function anchorsPlugin(md: MarkdownIt) {
  md.core.ruler.push('anchor-pos', (state) => {
    try {
      let pos = 0
      for (const token of state.tokens) {
        if (token.map && token.block) {
          const startLine = token.map[0]
          token.attrSet('data-line', String(startLine))
          token.attrSet('data-pos-start', String(pos))
        }
        if (token.content) pos += token.content.length
      }
    } catch {}
    return false
  })
}
export default anchorsPlugin

// 所见模式 V2：基于 Milkdown 的真实所见编辑视图
// 暴露 enable/disable 与 setMarkdown/getMarkdown 能力，供主流程挂接

import { Crepe } from '@milkdown/crepe'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { automd } from '@milkdown/plugin-automd'
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload'
import type { Ctx } from '@milkdown/kit/ctx'
import { EditorView } from '@milkdown/prose/view'
import { vue } from '@codemirror/lang-markdown'
import { uploader } from './plugins/paste'

let _crepe: Crepe | null = null
let _root: HTMLElement | null = null
let _onChange: ((md: string) => void) | null = null

export async function enableWysiwygV2(root: HTMLElement, markdown: string, onChange: (md: string) => void) {
  await disableWysiwygV2()
  _root = root
  _onChange = onChange
  const crepe = new Crepe({
    root,
    defaultValue: (markdown || '').toString(),
    featureConfigs: {
      'code-mirror': { extensions: [vue()] },
      // 其余默认特性使用 crepe 内置配置
    },
  })
  crepe.on((lm) => {
    lm.markdownUpdated((ctx: Ctx, next: string) => { if (_onChange) _onChange(next) })
    lm.mounted((ctx: Ctx) => {
      // 处理初次 selection/滚动怪异
      const view = ctx.get('editorView') as EditorView
      requestAnimationFrame(() => {
        try {
          view.dom.dispatchEvent(new Event('selectionchange'))
          view.updateState(view.state)
        } catch {}
      })
    })
  })
  const editor = crepe.editor
  editor.ctx.inject(uploadConfig.key)
  editor
    .use(automd)
    .use(upload)
    .use(commonmark)
    .use(gfm)
  await crepe.create()
  editor.ctx.update(uploadConfig.key, prev => ({ ...prev, uploader }))
  _crepe = crepe
}

export async function disableWysiwygV2() {
  if (_crepe) {
    try { _crepe.destroy() } catch {}
    _crepe = null
  }
  if (_root) {
    try { _root.innerHTML = '' } catch {}
    _root = null
  }
  _onChange = null
}

export function isWysiwygV2Enabled(): boolean { return !!_crepe }


// IME compatibility patch: delegate events globally, act only on #editor in edit mode
(function () {
  try {
    const getEditor = (): HTMLTextAreaElement | null => document.getElementById('editor') as HTMLTextAreaElement | null
    const isEditMode = (): boolean => {
      try {
        const ta = getEditor(); if (!ta) return false
        const style = window.getComputedStyle(ta)
        const visible = style && style.display !== 'none' && style.visibility !== 'hidden'
        return visible && !ta.disabled
      } catch { return false }
    }

    // 标记 imePatch 激活，用于主模块避免重复键盘钩子处理
    try { (window as any)._imePatchActive = true } catch {}

    const codeClose = (ch: string): string | null => {
      if (!ch || ch.length !== 1) return null
      const c = ch.charCodeAt(0)
      switch (c) {
        case 0x28: return ')'
        case 0x5B: return ']'
        case 0x7B: return '}'
        case 0x22: return '"'
        case 0x27: return "'"
        case 0x60: return '`'
        case 0x2A: return '*'
        case 0x5F: return '_'
        case 0x300A: return String.fromCharCode(0x300B) // 
        case 0x3010: return String.fromCharCode(0x3011) // 
        case 0xFF08: return String.fromCharCode(0xFF09) // 
        case 0x300C: return String.fromCharCode(0x300D) // 
        case 0x300E: return String.fromCharCode(0x300F) // 
        case 0x201C: return String.fromCharCode(0x201D) // 
        case 0x2018: return String.fromCharCode(0x2019) // 
        default: return null
      }
    }

    // prev snapshot for diff in input
    const rememberPrev = () => {
      try {
        const ta = getEditor(); if (!ta) return
        ;(window as any)._edPrevVal = String(ta.value || '')
        ;(window as any)._edPrevSelS = ta.selectionStart >>> 0
        ;(window as any)._edPrevSelE = ta.selectionEnd >>> 0
      } catch {}
    }

    // 撤销友好的插入/删除：优先使用 execCommand，失败则回退到 setRangeText
    function insertUndoable(ta: HTMLTextAreaElement, text: string): boolean {
      try { ta.focus(); document.execCommand('insertText', false, text); return true } catch {
        try {
          const s = ta.selectionStart >>> 0, e = ta.selectionEnd >>> 0
          ta.setRangeText(text, s, e, 'end')
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
          return true
        } catch { return false }
      }
    }
    function deleteUndoable(ta: HTMLTextAreaElement): boolean {
      try { ta.focus(); document.execCommand('delete'); return true } catch {
        const s = ta.selectionStart >>> 0, e = ta.selectionEnd >>> 0
        if (s !== e) {
          ta.setRangeText('', s, e, 'end')
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
          return true
        }
        return false
      }
    }

    // IME composing guard
    const isComposingEv = (ev: any): boolean => {
      try { return !!(ev && (ev.isComposing || (ev.data && (ev.inputType || '').includes('Composition')))) } catch { return false }
    }

    // collapse duplicates like 《《《|》》》 -> 《|》 at caret
    const collapseDuplicatePairAtCaret = (ta: HTMLTextAreaElement): boolean => {
      try {
        const s = ta.selectionStart >>> 0
        const e = ta.selectionEnd >>> 0
        if (s !== e) return false
        const val = String(ta.value || '')
        if (s === 0 || s >= val.length) return false

        const PAIRS: Array<[string, string]> = [
          ['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`'], ['*', '*'], ['_', '_'],
          [String.fromCharCode(0x300A), String.fromCharCode(0x300B)], // 《》
          [String.fromCharCode(0x3010), String.fromCharCode(0x3011)], // 【】
          [String.fromCharCode(0xFF08), String.fromCharCode(0xFF09)], // （）
          [String.fromCharCode(0x300C), String.fromCharCode(0x300D)], // 「」
          [String.fromCharCode(0x300E), String.fromCharCode(0x300F)], // 『』
          [String.fromCharCode(0x201C), String.fromCharCode(0x201D)], // “”
          [String.fromCharCode(0x2018), String.fromCharCode(0x2019)], // ‘’
        ]

        const L0 = val[s - 1]
        const R0 = val[s]
        for (const [L, R] of PAIRS) {
          if (L0 === L && R0 === R) {
            let i = s - 1, openRun = 0; while (i >= 0 && val[i] === L) { openRun++; i-- }
            let j = s, closeRun = 0; while (j < val.length && val[j] === R) { closeRun++; j++ }
            if (openRun >= 2 && closeRun >= 2) {
              const leftStart = s - openRun
              const newVal = val.slice(0, leftStart + 1) + R + val.slice(s + closeRun)
              ta.value = newVal
              ta.selectionStart = ta.selectionEnd = leftStart + 1
              return true
            }
          }
        }
        return false
      } catch { return false }
    }

    const handleBeforeInput = (ev: InputEvent) => {
      try {
        const ta = getEditor(); if (!ta) return
        if (ev.target !== ta) return
        if (!isEditMode()) return
        const it = (ev as any).inputType || ''
        if (!/insert(Text|CompositionText|FromComposition)/i.test(it)) return
        const data = (ev as any).data as string || ''
        // 组合输入：除 ~ / ～ 外一律放行给 IME；而 ~ / ～ 允许在 composing 阶段处理，以便识别连击
        const composing = isComposingEv(ev)
        const isTildeData = (!!data && (/^~+$/.test(data) || /^～+$/.test(data)))
        if (composing && !isTildeData) return
        if (!data) return
        // 英文输入法下的 '*' 交由 editor keydown 连击逻辑处理，这里直接跳过以避免重复
        if (!composing && data === '*') return
        const s = ta.selectionStart >>> 0
        const e = ta.selectionEnd >>> 0
        const val = String(ta.value || '')
        // 波浪线（~ / ～）：Markdown 仅有成对的 ~~ 删除线
        // 规则：单个 ~/～ 不触发补全；输入连续两个 ~~ 或 ～～（短时间内）触发补全为 "~~~~" 或 "～～～～" 并将光标置于中间
        {
          const isAsciiPair = (data === '~~')
          const isFullPair = (data === '～～')
          if (isAsciiPair || isFullPair) {
            ev.preventDefault()
            const token = isFullPair ? '～～' : '~~'
            const mid = val.slice(s, e)
            ta.selectionStart = s; ta.selectionEnd = e
            const ins = (e > s) ? (token + mid + token) : (token + token)
            if (!insertUndoable(ta, ins)) {
              ta.value = val.slice(0, s) + ins + val.slice(e)
            }
            const tlen = token.length
            if (e > s) { ta.selectionStart = s + tlen; ta.selectionEnd = s + tlen + mid.length }
            else { ta.selectionStart = ta.selectionEnd = s + tlen }
            rememberPrev(); return
          }
        }
        // 三连反引号：插入围栏（可撤销）
        if (data === '```') {
          ev.preventDefault()
          const mid = val.slice(s, e)
          const content = (e > s ? ('\n' + mid + '\n') : ('\n\n'))
          ta.selectionStart = s; ta.selectionEnd = e
          if (!insertUndoable(ta, '```' + content + '```')) {
            ta.value = val.slice(0, s) + '```' + content + '```' + val.slice(e)
          }
          ta.selectionStart = ta.selectionEnd = (e > s ? (s + content.length + 3) : (s + 4))
          rememberPrev()
          return
        }
        if (data.length === 1) {
          // 跳过右侧闭合
          const close = codeClose(data)
          if (!close && val[s] === data && s === e) { ev.preventDefault(); ta.selectionStart = ta.selectionEnd = s + 1; rememberPrev(); return }
          if (close) {
            ev.preventDefault()
            const mid = val.slice(s, e)
            ta.selectionStart = s; ta.selectionEnd = e
            if (e > s) {
              if (!insertUndoable(ta, data + mid + close)) {
                ta.value = val.slice(0, s) + data + mid + close + val.slice(e)
              }
              // 环抱补全后光标移到闭合符号之后，而不是选中中间内容
              ta.selectionStart = ta.selectionEnd = s + 1 + mid.length + close.length
            } else {
              if (!insertUndoable(ta, data + close)) {
                ta.value = val.slice(0, s) + data + close + val.slice(e)
              }
              ta.selectionStart = ta.selectionEnd = s + 1
            }
            rememberPrev()
            return
          }
        }
      } catch {}
    }

    const handleInput = (ev: InputEvent | Event) => {
      try {
        const ta = getEditor(); if (!ta) return
        if ((ev as any).target !== ta) return
        if (!isEditMode()) return
        if (isComposingEv(ev)) return
        const prev = String((window as any)._edPrevVal ?? '')
        const ps = ((window as any)._edPrevSelS >>> 0) || 0
        const pe = ((window as any)._edPrevSelE >>> 0) || ps
        const cur = String(ta.value || '')
        // diff by LCP/LCS
        let a = 0; const minLen = Math.min(prev.length, cur.length)
        while (a < minLen && prev.charCodeAt(a) === cur.charCodeAt(a)) a++
        let b = 0; const prevRemain = prev.length - a; const curRemain = cur.length - a
        while (b < prevRemain && b < curRemain && prev.charCodeAt(prev.length - 1 - b) === cur.charCodeAt(cur.length - 1 - b)) b++
        const inserted = cur.slice(a, cur.length - b)
        const removed = prev.slice(a, prev.length - b)
        const hadSel = (pe > ps) || (removed.length > 0)
        // 英文输入法下 '*' 交由 editor 的 keydown 连击逻辑，这里跳过，避免与 keydown 路径重复
        if (String((ev as any).type || '') !== 'compositionend' && inserted === '*') { rememberPrev(); return }
        // 单个 ~ / ～：若与左侧同类波浪相邻，则展开为成对补全
        if (inserted === '~' || inserted === '～') {
          const ch = inserted
          const token = ch + ch // "~~" or "～～"
          if (a > 0 && prev.slice(a - 1, a) === ch) {
            const left = prev.slice(0, a - 1)
            const right = prev.slice(a)
            ta.value = left + token + token + right
            const tlen = token.length
            ta.selectionStart = ta.selectionEnd = (a - 1 + tlen)
            rememberPrev(); return
          }
        }
        // 组合输入兜底：处理 ~~ / ～～
        if (inserted === '~~' || inserted === '～～') {
          const token = inserted
          if (hadSel) {
            ta.value = prev.slice(0, a) + token + removed + token + prev.slice(prev.length - b)
            ta.selectionStart = a + token.length; ta.selectionEnd = a + token.length + removed.length
          } else {
            ta.value = prev.slice(0, a) + token + token + prev.slice(prev.length - b)
            ta.selectionStart = ta.selectionEnd = a + token.length
          }
          rememberPrev(); return
        }
        // 中文输入法：连续输入两个￥/¥ 映射为 $$（用于 Markdown 数学环境）
        // - 组合提交（一次性插入两个字符）
        if (inserted === '\uFFE5\uFFE5' || inserted === '\u00A5\u00A5' || inserted === '\uFFE5\u00A5' || inserted === '\u00A5\uFFE5') {
          const token = '$$'
          if (hadSel) {
            ta.value = prev.slice(0, a) + token + removed + token + prev.slice(prev.length - b)
            ta.selectionStart = a + token.length; ta.selectionEnd = a + token.length + removed.length
          } else {
            ta.value = prev.slice(0, a) + token + token + prev.slice(prev.length - b)
            ta.selectionStart = ta.selectionEnd = a + token.length
          }
          rememberPrev(); return
        }
        // fence：中文输入法对 ``` 的补全效果差，此处删除处理，保留 handleBeforeInput 中的英文输入法路径
        // 加粗（** / ＊＊）：IME 一次性提交两颗星，仅将光标移至中间，避免重复补全
                // 加粗（** / ＊＊）：IME 一次性提交两颗星，补全为 **|** 或 **选区**
        if (inserted === '**' || /^[\uFF0A]{2}$/.test(inserted)) {
          // IME 双星：不改文本，仅将光标移至中间，避免重复补全
          ta.selectionStart = ta.selectionEnd = a + (inserted.length >> 1)
          rememberPrev(); return
        }
        if (inserted.length === 1) {
        // 连续两个￥/¥（逐个按键提交）：将左侧的 ￥/¥ + 当前 ￥/¥ 一起替换为 $$，并将光标置于两 $ 中间
        if ((inserted === '\uFFE5' || inserted === '\u00A5') && a > 0) {
          const L = prev.slice(a - 1, a)
          if (L === '\uFFE5' || L === '\u00A5') {
            const left = prev.slice(0, a - 1)
            const right = prev.slice(prev.length - b)
            const token = '$$'
            ta.value = left + token + right
            ta.selectionStart = ta.selectionEnd = (a - 1 + token.length)
            rememberPrev(); return
          }
        }
        if (inserted === '*' || (inserted && inserted.charCodeAt(0) === 0xFF0A)) {
          // 仅在 compositionend 调用路径或无法区分时启用（依赖上方 skip 规则避免英文重复）
          if (a > 0 && prev.slice(a - 1, a + 1) === '**') {
            const left = a - 1, right = a + 1
            ta.selectionStart = left; ta.selectionEnd = right
            if (!insertUndoable(ta as any, '****')) {
              (ta as any).value = prev.slice(0, left) + '****' + prev.slice(right)
            }
            ta.selectionStart = ta.selectionEnd = left + 2
            rememberPrev(); return
          }
        }
          const close = codeClose(inserted)
          // 中文输入法下不处理反引号，避免与 ``` 代码块补全冲突
          if (close && inserted !== '`') {
            if (hadSel) {
              ta.value = prev.slice(0, a) + inserted + removed + close + prev.slice(prev.length - b)
              // 环抱补全后光标移到闭合符号之后，而不是选中中间内容
              ta.selectionStart = ta.selectionEnd = a + 1 + removed.length + close.length
            } else {
              ta.value = cur.slice(0, a + 1) + close + cur.slice(a + 1)
              ta.selectionStart = ta.selectionEnd = a + 1
            }
            rememberPrev(); return
          }
          // skip right closer
          if (!hadSel && prev.slice(a, a + 1) === inserted) {
            ta.selectionStart = ta.selectionEnd = a + 1; rememberPrev(); return
          }
        }
        rememberPrev()
      } catch {}
    }

    document.addEventListener('beforeinput', (e) => { try { handleBeforeInput(e as any) } catch {} }, true)
    document.addEventListener('input', (e) => { try { handleInput(e as any) } catch {} }, true)
    document.addEventListener('compositionend', (e) => {
      try {
        setTimeout(() => {
          try {
            handleInput(e as any)
            const ta = getEditor(); if (ta && collapseDuplicatePairAtCaret(ta)) { rememberPrev() }
          } catch {}
        }, 0)
      } catch {}
    }, true)

    // init snapshot
    rememberPrev()
  } catch {}
})();



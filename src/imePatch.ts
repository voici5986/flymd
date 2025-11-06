// IME 兼容补全（文档级事件委托，仅针对 #editor 且编辑模式非所见时）
(function () {
  try {
    const getEditor = (): HTMLTextAreaElement | null => document.getElementById('editor') as HTMLTextAreaElement | null
    const isEditMode = (): boolean => {
      try {
        const ta = getEditor(); if (!ta) return false
        // 仅在 textarea 可见且未禁用时认为是“编辑模式 + 非所见”
        const style = window.getComputedStyle(ta)
        const visible = style && style.display !== 'none' && style.visibility !== 'hidden'
        return visible && !ta.disabled
      } catch { return false }
    }

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
        case 0x300A: return String.fromCharCode(0x300B) // 《》
        case 0x3010: return String.fromCharCode(0x3011) // 【】
        case 0xFF08: return String.fromCharCode(0xFF09) // （）
        case 0x300C: return String.fromCharCode(0x300D) // 「」
        case 0x300E: return String.fromCharCode(0x300F) // 『』
        case 0x201C: return String.fromCharCode(0x201D) // “”
        case 0x2018: return String.fromCharCode(0x2019) // ‘’
        default: return null
      }
    }

    // 快照：用于 input 兜底差异计算
    const rememberPrev = () => {
      try {
        const ta = getEditor(); if (!ta) return
        ;(window as any)._edPrevVal = String(ta.value || '')
        ;(window as any)._edPrevSelS = ta.selectionStart >>> 0
        ;(window as any)._edPrevSelE = ta.selectionEnd >>> 0
      } catch {}
    }

    const handleBeforeInput = (ev: InputEvent) => {
      try {
        const ta = getEditor(); if (!ta) return
        if (ev.target !== ta) return
        if (!isEditMode()) return
        const it = (ev as any).inputType || ''
        if (!/insert(Text|CompositionText|FromComposition)/i.test(it)) return
        const data = (ev as any).data as string || ''
        if (!data) return
        const s = ta.selectionStart >>> 0
        const e = ta.selectionEnd >>> 0
        const val = String(ta.value || '')
        // 三连反引号
        if (data === '```') {
          ev.preventDefault()
          const mid = val.slice(s, e)
          const content = (e > s ? ('\n' + mid + '\n') : ('\n\n'))
          ta.value = val.slice(0, s) + '```' + content + '```' + val.slice(e)
          ta.selectionStart = ta.selectionEnd = (e > s ? (s + content.length + 3) : (s + 4))
          rememberPrev()
          return
        }
        if (data.length === 1) {
          // 跳过右侧
          const closeR = codeClose(data)
          if (!closeR && val[s] === data && s === e) { ev.preventDefault(); ta.selectionStart = ta.selectionEnd = s + 1; rememberPrev(); return }
          const close = codeClose(data)
          if (close) {
            ev.preventDefault()
            const mid = val.slice(s, e)
            if (e > s) {
              ta.value = val.slice(0, s) + data + mid + close + val.slice(e)
              ta.selectionStart = s + 1; ta.selectionEnd = s + 1 + mid.length
            } else {
              ta.value = val.slice(0, s) + data + close + val.slice(e)
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
        const prev = String((window as any)._edPrevVal ?? '')
        const ps = ((window as any)._edPrevSelS >>> 0) || 0
        const pe = ((window as any)._edPrevSelE >>> 0) || ps
        const cur = String(ta.value || '')
        // LCP/LCS 差异区间
        let a = 0; const minLen = Math.min(prev.length, cur.length)
        while (a < minLen && prev.charCodeAt(a) === cur.charCodeAt(a)) a++
        let b = 0; const prevRemain = prev.length - a; const curRemain = cur.length - a
        while (b < prevRemain && b < curRemain && prev.charCodeAt(prev.length - 1 - b) === cur.charCodeAt(cur.length - 1 - b)) b++
        const inserted = cur.slice(a, cur.length - b)
        const removed = prev.slice(a, prev.length - b)
        const hadSel = (pe > ps) || (removed.length > 0)
        // 三连反引号（兜底）
        if (inserted === '```') {
          const content = hadSel ? ('\n' + removed + '\n') : ('\n\n')
          ta.value = prev.slice(0, a) + '```' + content + '```' + prev.slice(prev.length - b)
          ta.selectionStart = ta.selectionEnd = (hadSel ? (a + content.length + 3) : (a + 4))
          rememberPrev(); return
        }
        if (inserted.length === 1) {
          const close = codeClose(inserted)
          if (close) {
            if (hadSel) {
              ta.value = prev.slice(0, a) + inserted + removed + close + prev.slice(prev.length - b)
              ta.selectionStart = a + 1; ta.selectionEnd = a + 1 + removed.length
            } else {
              ta.value = cur.slice(0, a + 1) + close + cur.slice(a + 1)
              ta.selectionStart = ta.selectionEnd = a + 1
            }
            rememberPrev(); return
          }
          // 右标记跳过
          if (!hadSel && prev.slice(a, a + 1) === inserted) {
            ta.selectionStart = ta.selectionEnd = a + 1; rememberPrev(); return
          }
        }
        rememberPrev()
      } catch {}
    }

    document.addEventListener('beforeinput', (e) => { try { handleBeforeInput(e as any) } catch {} }, true)
    document.addEventListener('input', (e) => { try { handleInput(e as any) } catch {} }, true)
    document.addEventListener('compositionend', (e) => { try { setTimeout(() => { try { handleInput(e as any) } catch {} }, 0) } catch {} }, true)

    // 初始快照
    rememberPrev()
  } catch {}
})();

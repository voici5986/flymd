// Excel/Sheets 公式里常见的 `$B$2` / `C$2` / `$U:$U` 等“绝对引用”会误触发 Markdown 行内数学 `$...$`，
// 造成 KaTeX 把整段当数学渲染（字体、字距全变了）。
//
// 关键点：不要去“聪明地”改数学解析器——那会破坏正常的 `$E=mc^2$` 之类内容。
// 正确做法是：只在“明显是 Excel 公式的行”（行首是 `=`，允许前面有列表/引用前缀）里，把 `$` 转义成 `\\$`。

function transformOutsideCode(
  md: string,
  mapAt: (line: string, i: number) => { text: string, advance?: number } | null
): string {
  try {
    const lines = String(md || '').split('\n')
    let inFence = false
    let fenceCh = ''
    let fenceLen = 0

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      const m = line.match(/^\s*(`{3,}|~{3,})/)
      if (m) {
        const ch = m[1][0]
        const len = m[1].length
        if (!inFence) {
          inFence = true
          fenceCh = ch
          fenceLen = len
        } else if (ch === fenceCh && len >= fenceLen) {
          inFence = false
          fenceCh = ''
          fenceLen = 0
        }
        continue
      }
      if (inFence) continue

      // 处理行内 code span：按 Markdown 规则用相同数量的反引号开关
      let out = ''
      let inCode = false
      let codeTickLen = 0
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '`') {
          let j = i
          while (j < line.length && line[j] === '`') j++
          const run = j - i
          out += '`'.repeat(run)
          if (!inCode) {
            inCode = true
            codeTickLen = run
          } else if (run === codeTickLen) {
            inCode = false
            codeTickLen = 0
          }
          i = j - 1
          continue
        }
        if (!inCode) {
          const rep = mapAt(line, i)
          if (rep != null) {
            out += rep.text
            i += rep.advance || 0
            continue
          }
        }
        out += ch
      }
      lines[li] = out
    }

    return lines.join('\n')
  } catch {
    return String(md || '')
  }
}

function isExcelFormulaLine(line: string): boolean {
  try {
    const raw = String(line || '')
    const t = raw.trim()
    // Setext 标题下划线：一整行 '=' 不应该被当成公式
    if (t && /^=+$/.test(t)) return false

    let i = 0
    while (i < raw.length && /\s/.test(raw[i])) i++

    // blockquote（允许连续多个 >）
    while (raw[i] === '>') {
      i++
      if (raw[i] === ' ') i++
      while (i < raw.length && /\s/.test(raw[i])) i++
    }

    // list marker: -,*,+ 或 1. / 1)
    if (raw[i] === '-' || raw[i] === '*' || raw[i] === '+') {
      const j = i + 1
      if (raw[j] === ' ' || raw[j] === '\t') {
        i = j + 1
        while (i < raw.length && /\s/.test(raw[i])) i++
      }
    } else if (raw[i] >= '0' && raw[i] <= '9') {
      let j = i
      while (j < raw.length && raw[j] >= '0' && raw[j] <= '9') j++
      if (raw[j] === '.' || raw[j] === ')') {
        j++
        if (raw[j] === ' ' || raw[j] === '\t') {
          i = j + 1
          while (i < raw.length && /\s/.test(raw[i])) i++
        }
      }
    }

    return raw[i] === '='
  } catch {
    return false
  }
}

function isEscapedByBackslash(line: string, dollarPos: number): boolean {
  // 统计 '$' 左侧连续反斜杠个数，奇数表示被转义
  let bs = 0
  for (let j = dollarPos - 1; j >= 0 && line[j] === '\\'; j--) bs++
  return (bs & 1) === 1
}

// 给 Excel 引用里的 '$' 加保护：`$` -> `\$`
export function protectExcelDollarRefs(md: string): string {
  return transformOutsideCode(md, (line, i) => {
    if (line[i] !== '$') return null
    if (!isExcelFormulaLine(line)) return null
    if (line[i + 1] === '$') return null
    if (isEscapedByBackslash(line, i)) return null
    return { text: '\\$' }
  })
}

// 去掉保护：`\\$` -> `$`（仅在 Excel 公式行里做反转）
export function unprotectExcelDollarRefs(md: string): string {
  return transformOutsideCode(md, (line, i) => {
    if (!isExcelFormulaLine(line)) return null
    if (line[i] !== '\\') return null
    if (line[i + 1] !== '$') return null
    // 不动 `\\\\$`（两条反斜杠）这类用户显式写法
    if (i > 0 && line[i - 1] === '\\') return null
    // 消费掉 `\$`
    return { text: '$', advance: 1 }
  })
}

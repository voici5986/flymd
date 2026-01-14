// src/exporters/pdf.ts
// 使用 html2canvas + jsPDF 将指定 DOM 元素导出为 PDF 字节

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function waitForFonts(doc: Document, timeoutMs = 8000): Promise<void> {
  try {
    const ready = (doc as any).fonts?.ready
    if (!ready || typeof ready.then !== 'function') return
    await Promise.race([ready, waitMs(timeoutMs)])
  } catch {}
}

// 导出性能参数：默认“尽快完成”，不要被坏图床拖 20s+。
const EXPORT_WAIT_ORIG_IMAGES_MS = 1200
const EXPORT_WAIT_CLONE_IMAGES_MS = 2500
const EXPORT_FETCH_REMOTE_IMAGE_MS = 6000

async function waitForImagesIn(root: ParentNode, timeoutMs = 20000): Promise<void> {
  const imgs = Array.from(root.querySelectorAll?.('img') || []) as HTMLImageElement[]
  if (!imgs.length) return

  const tasks = imgs.map(async (img) => {
    try {
      if (img.complete && img.naturalWidth > 0) {
        if (typeof (img as any).decode === 'function') {
          try { await (img as any).decode() } catch {}
        }
        return
      }
    } catch {}

    await new Promise<void>((resolve) => {
      const done = () => resolve()
      try {
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      } catch {
        resolve()
      }
    })

    try {
      if (typeof (img as any).decode === 'function') {
        try { await (img as any).decode() } catch {}
      }
    } catch {}
  })

  await Promise.race([Promise.all(tasks), waitMs(timeoutMs)])
}

async function getHttpClient(): Promise<{ fetch: any } | null> {
  // 优先使用 tauri plugin-http（可绕过浏览器 CORS），否则回退到 window.fetch（仍会受 CORS 限制）
  try {
    const mod: any = await import('@tauri-apps/plugin-http')
    if (typeof mod?.fetch === 'function') return { fetch: mod.fetch }
  } catch {}
  try {
    if (typeof fetch === 'function') return { fetch: (input: string, init: any) => fetch(input, init) }
  } catch {}
  return null
}

function inferMimeByUrl(url: string): string {
  const m = (url || '').toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/)
  switch (m?.[1]) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'avif': return 'image/avif'
    case 'svg': return 'image/svg+xml'
    case 'ico': return 'image/x-icon'
    default: return 'application/octet-stream'
  }
}

async function fetchRemoteAsObjectUrl(url: string, timeoutMs = 20000): Promise<string> {
  const client = await getHttpClient()
  if (!client?.fetch) return ''

  const p = (async () => {
    const resp = await client.fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'image/*;q=0.9,*/*;q=0.1' },
    })
    const ok = resp && (resp.ok === true || (typeof resp.status === 'number' && resp.status >= 200 && resp.status < 300))
    if (!ok) return ''
    const ab: ArrayBuffer = await resp.arrayBuffer()
    let mime = ''
    try {
      const ct = resp.headers?.get?.('content-type') || resp.headers?.get?.('Content-Type')
      if (ct) mime = String(ct).split(';')[0].trim()
    } catch {}
    if (!/^image\//i.test(mime)) mime = inferMimeByUrl(url)
    const blob = new Blob([ab], { type: mime || 'application/octet-stream' })
    return URL.createObjectURL(blob)
  })()

  return await Promise.race([p, waitMs(timeoutMs).then(() => '')])
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const safeLimit = Math.max(1, Math.min(limit || 1, items.length || 1))
  let idx = 0
  const workers = Array.from({ length: safeLimit }, async () => {
    for (;;) {
      const i = idx++
      if (i >= items.length) return
      try { await fn(items[i]) } catch {}
    }
  })
  await Promise.all(workers)
}

async function inlineCrossOriginImages(root: ParentNode, timeoutMs = 20000): Promise<string[]> {
  // html2canvas 对“无 CORS 头的跨域图片”只能放弃，结果就是导出的 PDF 没图。
  // 解决办法：用 tauri plugin-http 把图片抓下来，替换成 blob: URL（同源），再让 html2canvas 渲染。
  const imgs = Array.from(root.querySelectorAll?.('img') || []) as HTMLImageElement[]
  if (!imgs.length) return []

  const origin = (() => { try { return new URL(document.baseURI || location.href).origin } catch { return '' } })()
  const targets = imgs.map((img) => {
    const src = String((img as any).currentSrc || img.getAttribute('src') || img.src || '').trim()
    return { img, src }
  }).filter(({ src }) => {
    if (!/^https?:\/\//i.test(src)) return false
    try { return origin ? (new URL(src).origin !== origin) : true } catch { return true }
  })
  if (!targets.length) return []

  const objectUrls: string[] = []
  const cache = new Map<string, string>()
  await runWithConcurrency(targets, 4, async ({ img, src }) => {
    const cached = cache.get(src)
    const u = cached != null ? cached : await fetchRemoteAsObjectUrl(src, timeoutMs)
    if (cached == null) cache.set(src, u || '')
    if (!u) return
    try { img.setAttribute('src', u) } catch { try { (img as any).src = u } catch {} }
    objectUrls.push(u)
  })
  return objectUrls
}

function normalizeSvgSize(svgEl: SVGElement, targetWidth: number) {
  try {
    const vb = svgEl.getAttribute('viewBox')
    let w = 0, h = 0
    if (vb) {
      const p = vb.split(/\s+/).map(Number)
      if (p.length === 4) { w = p[2]; h = p[3] }
    }
    const hasWH = Number(svgEl.getAttribute('width')) || Number(svgEl.getAttribute('height'))
    if ((!w || !h) && hasWH) {
      w = Number(svgEl.getAttribute('width')) || 800
      h = Number(svgEl.getAttribute('height')) || 600
    }
    if (!w || !h) { w = 800; h = 600 }
    const ratio = targetWidth / w
    const targetHeight = Math.max(1, Math.round(h * ratio))
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    svgEl.setAttribute('width', String(targetWidth))
    svgEl.setAttribute('height', String(targetHeight))
    try { (svgEl.style as any).maxWidth = '100%'; (svgEl.style as any).height = 'auto' } catch {}
  } catch {}
}

function clampInt(n: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.trunc(n) : 0
  if (v < min) return min
  if (v > max) return max
  return v
}

function pickBreakYByWhitespace(canvas: HTMLCanvasElement, yStart: number, yTarget: number, searchPx = 28): number {
  // 目的：把分页切到“行间空白”处，避免 PDF 里出现“半行被切掉/上下页不连贯”。
  // 这不是完美排版，但比固定像素硬切强太多，而且实现足够简单。
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as any)
    if (!ctx) return yTarget

    const height = canvas.height | 0
    const width = canvas.width | 0
    const tgt = clampInt(yTarget, 0, height)
    // 分页切点必须落在“当前页高度”以内：超过目标高度会导致图片超出纸张被裁掉。
    const minY = clampInt(tgt - searchPx, 0, height)
    const maxY = clampInt(tgt, 0, height)
    // 太靠近页首没意义：那基本是在“切断刚开始的内容”
    const safeMinY = Math.max(minY, (yStart | 0) + 160)
    if (maxY <= safeMinY) return tgt

    const bandH = (maxY - safeMinY + 1) | 0
    const img = ctx.getImageData(0, safeMinY, width, bandH).data
    const stepX = Math.max(8, Math.floor(width / 420)) // 采样约 300~500 点，速度与稳定性都够

    let bestRow = -1
    let bestScore = -1
    for (let row = 0; row < bandH; row++) {
      const rowOff = row * width * 4
      let white = 0
      let total = 0
      for (let x = 0; x < width; x += stepX) {
        const i = rowOff + x * 4
        const a = img[i + 3] | 0
        if (a === 0) { white++; total++; continue }
        const r = img[i] | 0, g = img[i + 1] | 0, b = img[i + 2] | 0
        if (r >= 250 && g >= 250 && b >= 250) white++
        total++
      }
      const score = white / Math.max(1, total)
      if (score > bestScore) {
        bestScore = score
        bestRow = row
        // 几乎全白，直接收工
        if (score >= 0.995) break
      }
    }

    // 找不到靠谱的空白行就别硬凑了，回退到目标位置
    if (bestRow < 0 || bestScore < 0.92) return tgt
    const bestY = safeMinY + bestRow
    // 避免切出来的页太短（会导致页数暴涨）
    if ((bestY - (yStart | 0)) < 240) return tgt
    return bestY
  } catch {
    return yTarget
  }
}

type AvoidRange = { top: number; bottom: number }

function mergeRanges(ranges: AvoidRange[], mergeGapPx = 2): AvoidRange[] {
  const rs = (ranges || []).filter((r) => Number.isFinite(r.top) && Number.isFinite(r.bottom) && r.bottom > r.top)
  rs.sort((a, b) => a.top - b.top)
  const out: AvoidRange[] = []
  for (const r of rs) {
    const last = out.length ? out[out.length - 1] : null
    if (!last || r.top > last.bottom + mergeGapPx) out.push({ top: r.top, bottom: r.bottom })
    else last.bottom = Math.max(last.bottom, r.bottom)
  }
  return out
}

function uniqSorted(values: number[], eps = 0.5): number[] {
  const arr = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const out: number[] = []
  for (const v of arr) {
    const last = out.length ? out[out.length - 1] : null
    if (last == null || Math.abs(v - last) > eps) out.push(v)
  }
  return out
}

function collectBreakCandidatesCss(root: HTMLElement): number[] {
  // 生成“可断页候选点”：优先用布局信息（行框/块框边界），别用像素猜。
  // 这能从根上消灭“分页切到半行字”的特殊情况。
  try {
    const rootRect = root.getBoundingClientRect()
    const content = (root.querySelector('.preview-body') as HTMLElement | null) || root
    const candidates: number[] = [0]

    const push = (y: number) => {
      if (!Number.isFinite(y)) return
      if (y <= 0) return
      candidates.push(y)
    }

    const blocks = Array.from(content.querySelectorAll<HTMLElement>(
      'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,table,figure,hr,ul,ol,section,div',
    ))

    for (const el of blocks) {
      try {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const r = el.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) continue
        push(r.top - rootRect.top)
        push(r.bottom - rootRect.top)

        const tag = el.tagName.toLowerCase()
        const wantLines = tag === 'p' || tag === 'li' || tag === 'blockquote'
        if (!wantLines) continue

        const range = document.createRange()
        range.selectNodeContents(el)
        const rects = Array.from(range.getClientRects())
        for (const rr of rects) {
          try {
            if (!(rr.width > 0 && rr.height > 0)) continue
            push(rr.bottom - rootRect.top)
          } catch {}
        }
      } catch {}
    }

    // 总高度（兜底）：避免最后一页被截掉
    try {
      const h = Math.max(content.scrollHeight || 0, root.scrollHeight || 0, (rootRect.height || 0))
      push(h)
    } catch {}

    return uniqSorted(candidates, 0.75)
  } catch {
    return []
  }
}

function pickEndByCandidates(y: number, desiredEnd: number, candidates: number[], avoid: AvoidRange[]): number {
  // 在 candidates 中找一个 <= desiredEnd 的最大值（并尽量不落在不可切割区间内）。
  const maxY = clampInt(desiredEnd - 2, 0, 1 << 30)
  const minSlice = 240

  let lo = 0
  let hi = (candidates.length - 1) | 0
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = candidates[mid]
    if (v <= maxY) { idx = mid; lo = mid + 1 } else hi = mid - 1
  }

  for (let i = idx; i >= 0; i--) {
    const c = clampInt(candidates[i], 0, 1 << 30)
    if (c <= y + minSlice) break
    let end = adjustBreakAvoidingRanges(c, y, avoid)
    end = clampInt(end, y + 1, desiredEnd)
    if (end <= y + minSlice) continue
    return end
  }
  return 0
}

function collectAvoidRangesCss(root: HTMLElement): AvoidRange[] {
  // 基于 DOM 布局的“不可切割区间”：图片/表格/代码块等应当整体落在同一页里。
  // 这是用数据结构消灭特殊情况：别靠像素“猜空白”，直接知道哪里不能切。
  try {
    const rootRect = root.getBoundingClientRect()
    const sel = 'img,figure,table,pre,blockquote,hr,svg,canvas'
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(sel))
    const ranges: AvoidRange[] = []
    for (const n of nodes) {
      try {
        // KaTeX 的 SVG 本质是行内字形，不要把它当成“整块图片”处理
        if (n.tagName.toLowerCase() === 'svg' && n.closest('.katex')) continue
        const cs = getComputedStyle(n)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const r = n.getBoundingClientRect()
        if (!(r.width > 0 && r.height > 0)) continue
        // 预览样式里图片默认带 box-shadow（阴影不算在 getBoundingClientRect 里），
        // 刚好卡在分页边界时会出现“只剩一条边/被切一丢丢”的视觉问题；这里给图片额外留安全边。
        const tag = n.tagName.toLowerCase()
        const pad = tag === 'img' ? 18 : 6
        const top = (r.top - rootRect.top) - pad
        const bottom = (r.bottom - rootRect.top) + pad
        // 过滤掉极小元素（比如 UI 图标）
        if (bottom - top < 24) continue
        ranges.push({ top, bottom })
      } catch {}
    }
    return mergeRanges(ranges, 4)
  } catch {
    return []
  }
}

function adjustBreakAvoidingRanges(breakY: number, yStart: number, ranges: AvoidRange[]): number {
  // 若切点落在“不可切割区间”内部，则把切点挪到该区间开始之前（把整个块推到下一页）。
  // 这比“切到一张图的天空部分”看起来像空白然后把图切两半要靠谱得多。
  const y = clampInt(breakY, 0, 1 << 30)
  for (const r of ranges) {
    const top = clampInt(r.top, 0, 1 << 30)
    const bottom = clampInt(r.bottom, 0, 1 << 30)
    if (y > top && y < bottom) {
      const before = top - 2
      if (before > yStart + 1) return before
      return y
    }
  }
  return y
}

export async function exportPdf(el: HTMLElement, opt?: any): Promise<Uint8Array> {
  // 先等“原页面”图片与字体稳定下来，否则 html2canvas 计算布局时会把未加载完的图片当成 0 高度，
  // 最终表现为：PDF 里图片缺失/只截了一半（典型就是图床慢的时候更容易触发）。
  try {
    const doc = el.ownerDocument || document
    await waitForFonts(doc)
    // 原预览里的图片加载失败/超时很常见（尤其是图床/CORS/离线），导出不应该在这里卡死。
    await waitForImagesIn(el, Math.max(0, Number(opt?.waitOrigImagesMs ?? EXPORT_WAIT_ORIG_IMAGES_MS) || 0))
    // 再等一帧，让布局把最终尺寸吃进去
    await nextFrame()
  } catch {}

  const options = {
    margin: 10, // 单位：mm
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    ...opt,
  }

  // 用 .preview 作为父作用域，复用现有 Markdown 样式（否则很多规则不会命中，表现为“格式丢了”）
  const exportRoot = document.createElement('div')
  exportRoot.className = 'preview flymd-export-preview'
  exportRoot.style.background = '#ffffff'
  exportRoot.style.position = 'static'
  exportRoot.style.overflow = 'visible'
  exportRoot.style.padding = '0'

  const clone = el.cloneNode(true) as HTMLElement

  // 把原图片的最终尺寸/选中的资源同步到克隆节点，消除“布局依赖图片加载”的特殊情况
  try {
    const origImgs = Array.from(el.querySelectorAll('img')) as HTMLImageElement[]
    const cloneImgs = Array.from(clone.querySelectorAll('img')) as HTMLImageElement[]
    const n = Math.min(origImgs.length, cloneImgs.length)
    for (let i = 0; i < n; i++) {
      try {
        const o = origImgs[i]
        const c = cloneImgs[i]
        const src = String((o as any).currentSrc || o.src || '').trim()
        if (src) c.src = src
        const nw = Number(o.naturalWidth || 0)
        const nh = Number(o.naturalHeight || 0)
        if (nw > 0 && nh > 0) {
          c.setAttribute('width', String(nw))
          c.setAttribute('height', String(nh))
        }
      } catch {}
    }
  } catch {}

  // 关键：让 preview-body 在容器内自适应，不要撑破 html2pdf 的 A4 宽度容器
  try {
    clone.style.width = '100%'
    clone.style.maxWidth = '100%'
    clone.style.boxSizing = 'border-box'
  } catch {}

  // 基础样式：保证图片不溢出 + KaTeX 关键样式
  const style = document.createElement('style')
  style.textContent = `
    /* 导出 PDF：禁用动画/过渡，避免 html2canvas 捕捉到中间态导致错位/截断 */
    .flymd-export-preview, .flymd-export-preview * { animation: none !important; transition: none !important; }

    /* 关键：统一为 border-box，彻底杜绝 padding 把宽度撑爆导致左右被裁 */
    .flymd-export-preview, .flymd-export-preview * { box-sizing: border-box !important; }
    .flymd-export-preview .preview-body { width: 100% !important; max-width: 100% !important; }
    .flymd-export-preview .preview-body { margin: 0 !important; padding: 10mm 10mm 12mm 10mm; }

    /* 不导出交互标记（这些东西会影响布局与分页） */
    .flymd-export-preview .code-copy,
    .flymd-export-preview .code-lang,
    .flymd-export-preview .caret-dot {
      display: none !important;
    }

    /* 导出 PDF：强制使用浅色变量，避免深色模式下导出变成“白底浅字”几乎看不见 */
    .flymd-export-preview {
      color-scheme: light;
      --bg: #ffffff;
      --fg: #1f2328;
      --muted: #7a7a7a;
      --border: #e5e7eb;
      --border-strong: #cbd5e1;
      --code-bg: #f6f8fa;
      --code-border: #e5e7eb;
      --code-fg: #1f2328;
      --code-muted: #667085;
      --c-key: #7c3aed;
      --c-str: #2563eb;
      --c-num: #059669;
      --c-fn:  #db2777;
      --c-com: #9ca3af;
      --table-border: #cbd5e1;
      --table-header-bg: #f1f5f9;
      --table-header-fg: #1e293b;
      --table-row-hover: #f8fafc;
    }

    /* 导出容器：让 .preview 从“应用布局”退化为“普通文档流” */
    .flymd-export-preview.preview {
      position: static !important;
      top: auto !important; left: auto !important; right: auto !important; bottom: auto !important;
      overflow: visible !important;
      padding: 0 !important;
      background: #ffffff !important;
      box-shadow: none !important;
    }

    .flymd-export-preview .preview-body img,
    .flymd-export-preview img { max-width: 100% !important; height: auto !important; }
    .flymd-export-preview figure { max-width: 100% !important; }

    /* 导出时禁用图片阴影：阴影在分页边界会被“切一条”，看起来像图片被切割 */
    .flymd-export-preview img { box-shadow: none !important; }

    /* 断页保护：尽量别在块级元素内部断页（避免出现“半行在上一页、半行在下一页”） */
    .flymd-export-preview p,
    .flymd-export-preview blockquote,
    .flymd-export-preview pre,
    .flymd-export-preview table,
    .flymd-export-preview figure,
    .flymd-export-preview ul,
    .flymd-export-preview ol,
    .flymd-export-preview li,
    .flymd-export-preview hr,
    .flymd-export-preview img,
    .flymd-export-preview svg,
    .flymd-export-preview canvas {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .flymd-export-preview h1,
    .flymd-export-preview h2,
    .flymd-export-preview h3,
    .flymd-export-preview h4,
    .flymd-export-preview h5,
    .flymd-export-preview h6 { break-after: avoid-page; page-break-after: avoid; }

    /* KaTeX 关键样式（必需，确保 PDF 中根号等符号正确显示） */
    .flymd-export-preview .katex { font-size: 1em; text-indent: 0; text-rendering: auto; }
    .flymd-export-preview .katex svg { display: inline-block; position: relative; width: 100%; height: 100%; }
    .flymd-export-preview .katex svg path { fill: currentColor; }
    .flymd-export-preview .katex .hide-tail { overflow: hidden; }
    .flymd-export-preview .md-math-inline .katex { display: inline-block; }
    .flymd-export-preview .md-math-block .katex { display: block; text-align: center; }
  `
  exportRoot.appendChild(style)
  exportRoot.appendChild(clone)

  // 冻结 SVG 为屏幕显示尺寸（逐一读取原节点的像素尺寸）
  // 但完全跳过 KaTeX 的 SVG，因为它们需要特殊的 viewBox 处理
  try {
    const origSvgs = Array.from((el as HTMLElement).querySelectorAll('svg')) as SVGElement[]
    const cloneSvgs = Array.from(clone.querySelectorAll('svg')) as SVGElement[]
    const n = Math.min(origSvgs.length, cloneSvgs.length)
    for (let i = 0; i < n; i++) {
      try {
        // 跳过 KaTeX 的 SVG
        if (cloneSvgs[i].closest('.katex')) {
          // KaTeX SVG：读取实际屏幕像素尺寸并设置
          const r = (origSvgs[i] as any).getBoundingClientRect?.() || { width: 0, height: 0 }
          const w = Math.max(1, Math.round((r.width as number) || 0))
          const h = Math.max(1, Math.round((r.height as number) || 0))
          // 保留 viewBox 但设置实际像素尺寸
          cloneSvgs[i].setAttribute('width', String(w))
          cloneSvgs[i].setAttribute('height', String(h))
          cloneSvgs[i].style.width = w + 'px'
          cloneSvgs[i].style.height = h + 'px'
          continue
        }

        // 非 KaTeX SVG（mermaid、图表等）：使用原有逻辑
        const r = (origSvgs[i] as any).getBoundingClientRect?.() || { width: 0, height: 0 }
        const w = Math.max(1, Math.round((r.width as number) || 0))
        const h = Math.max(1, Math.round((r.height as number) || 0))
        cloneSvgs[i].setAttribute('preserveAspectRatio', 'xMidYMid meet')
        if (w) cloneSvgs[i].setAttribute('width', String(w))
        if (h) cloneSvgs[i].setAttribute('height', String(h))
        try { (cloneSvgs[i].style as any).width = w + 'px'; (cloneSvgs[i].style as any).height = 'auto' } catch {}
      } catch {}
    }
  } catch {}

  // 等克隆节点的图片也进入“可计算尺寸”的稳定态（多数情况下会命中缓存，成本很低）
  const blobUrls: string[] = []
  let mount: HTMLDivElement | null = null
  try {
    // 关键：跨域图床如果没给 CORS 头，html2canvas 会直接报错并跳过图片；这里把它们内联为 blob: 同源资源
    try { blobUrls.push(...(await inlineCrossOriginImages(clone, Math.max(0, Number(opt?.fetchRemoteImageMs ?? EXPORT_FETCH_REMOTE_IMAGE_MS) || 0)))) } catch {}
    try {
      await waitForImagesIn(clone, Math.max(0, Number(opt?.waitCloneImagesMs ?? EXPORT_WAIT_CLONE_IMAGES_MS) || 0))
      await nextFrame()
    } catch {}

    let html2canvas: any = null
    let jsPDF: any = null
    try {
      const m: any = await import('html2canvas')
      html2canvas = (m && (m.default || m)) || m
    } catch {}
    try {
      const m: any = await import('jspdf')
      jsPDF = m?.jsPDF || m?.default?.jsPDF || m?.default || m
    } catch {}

    // 兜底：如果依赖加载失败，回退到 html2pdf（保持功能可用）
    if (typeof html2canvas !== 'function' || typeof jsPDF !== 'function') {
      const mod: any = await import('html2pdf.js/dist/html2pdf.bundle.min.js')
      const html2pdf: any = (mod && (mod.default || mod)) || mod
      const ab: ArrayBuffer = await html2pdf().set(options).from(exportRoot).toPdf().output('arraybuffer')
      return new Uint8Array(ab)
    }

    const marginMm = Math.max(0, Number((options as any)?.margin ?? 10) || 0)
    const pdf = new jsPDF({
      // 这里强制使用 mm：导出 DOM/CSS 也用 mm，单位不一致只会制造无意义的复杂性。
      unit: 'mm',
      format: (options as any)?.jsPDF?.format || 'a4',
      orientation: (options as any)?.jsPDF?.orientation || 'portrait',
      compress: true,
    })
    const pageW = Number(pdf.internal?.pageSize?.getWidth?.() || 0) || 210
    const pageH = Number(pdf.internal?.pageSize?.getHeight?.() || 0) || 297
    const innerW = Math.max(1, pageW - marginMm * 2)
    const innerH = Math.max(1, pageH - marginMm * 2)

    // 让导出 DOM 的排版宽度锁定为“纸张可打印宽度”，避免因为窗口宽度不同导致的分页差异。
    exportRoot.style.width = innerW + 'mm'
    exportRoot.style.maxWidth = innerW + 'mm'

    // 挂载到 DOM：让 html2canvas 拿到稳定的 layout（不挂载时偶尔会出现高度为 0 或字体测量偏差）。
    mount = document.createElement('div')
    mount.className = 'flymd-pdf-export-mount'
    mount.style.position = 'fixed'
    mount.style.left = '-100000px'
    mount.style.top = '0'
    mount.style.width = innerW + 'mm'
    mount.style.maxWidth = innerW + 'mm'
    mount.style.background = '#ffffff'
    mount.style.overflow = 'visible'
    mount.style.pointerEvents = 'none'
    mount.style.zIndex = '-1'
    mount.appendChild(exportRoot)
    document.body.appendChild(mount)

    try {
      await waitForFonts(document)
      await waitForImagesIn(exportRoot, Math.max(0, Number(opt?.waitCloneImagesMs ?? EXPORT_WAIT_CLONE_IMAGES_MS) || 0))
      await nextFrame()
    } catch {}

    // 性能兜底：长文档用较低 scale，避免“导出很慢/内存爆炸”；短文档保持清晰度。
    try {
      const baseScale = Number((options as any)?.html2canvas?.scale ?? 2) || 2
      const r = exportRoot.getBoundingClientRect?.()
      const h = Number(r?.height || 0) || 0
      let cap = baseScale
      if (h > 22000) cap = Math.min(cap, 1.25)
      else if (h > 12000) cap = Math.min(cap, 1.5)
      ;(options as any).html2canvas = { ...(options as any).html2canvas, scale: cap }
    } catch {}

    const avoidCss = collectAvoidRangesCss(exportRoot)
    const breakCandidatesCss = collectBreakCandidatesCss(exportRoot)
    const rootRectForMap = (() => {
      try { return exportRoot.getBoundingClientRect() } catch { return null }
    })()

    const canvas: HTMLCanvasElement = await html2canvas(exportRoot, {
      ...(options as any)?.html2canvas,
      backgroundColor: (options as any)?.html2canvas?.backgroundColor || '#ffffff',
      scrollX: 0,
      scrollY: 0,
      logging: false,
    })

    const pxPerMm = canvas.width / innerW
    const pageHeightPx = Math.max(1, Math.floor(innerH * pxPerMm))
    const quality = Math.max(0.5, Math.min(1, Number((options as any)?.image?.quality ?? 0.98) || 0.98))

    const avoidRanges = (() => {
      try {
        const wCss = Number(rootRectForMap?.width || 0) || 0
        const cssToCanvas = canvas.width / Math.max(1, wCss)
        return mergeRanges(avoidCss.map((r) => ({ top: r.top * cssToCanvas, bottom: r.bottom * cssToCanvas })), 6)
      } catch {
        return [] as AvoidRange[]
      }
    })()

    const breakCandidatesPx = (() => {
      try {
        const wCss = Number(rootRectForMap?.width || 0) || 0
        const cssToCanvas = canvas.width / Math.max(1, wCss)
        const arr = (breakCandidatesCss || []).map((v) => v * cssToCanvas).filter((v) => v > 0 && v < canvas.height)
        arr.push(canvas.height)
        return uniqSorted(arr, 1)
      } catch {
        return [canvas.height]
      }
    })()

    // 每页切分：优先把切点对齐到“行间空白”，并避开图片/表格等不可切割块。
    // 不要做“页间重叠”：那只会把上一页的半行文字带到下一页顶部，看起来像“分页乱码”。
    const overlapPx = 0
    let y = 0
    let first = true
    while (y < canvas.height) {
      const targetEnd = Math.min(canvas.height, y + pageHeightPx)
      let end = 0
      if (targetEnd >= canvas.height) end = canvas.height
      else end = pickEndByCandidates(y, targetEnd, breakCandidatesPx, avoidRanges)

      if (!end) end = pickBreakYByWhitespace(canvas, y, targetEnd, 28)
      end = adjustBreakAvoidingRanges(end, y, avoidRanges)
      end = clampInt(end, y + 1, targetEnd)
      const sliceH = Math.max(1, end - y)

      const pageCanvas = document.createElement('canvas')
      pageCanvas.width = canvas.width
      pageCanvas.height = sliceH
      const pctx = pageCanvas.getContext('2d')
      if (!pctx) throw new Error('无法创建 canvas 上下文')
      pctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH)

      const imgData = pageCanvas.toDataURL('image/jpeg', quality)
      const drawH = sliceH / pxPerMm
      if (!first) pdf.addPage()
      first = false
      pdf.addImage(imgData, 'JPEG', marginMm, marginMm, innerW, drawH, undefined, 'FAST')

      if (end >= canvas.height) break
      // 保证单调前进：不重叠时直接从切点继续。
      y = Math.max(y + 1, end - overlapPx)
    }

    const ab: ArrayBuffer = pdf.output('arraybuffer')
    return new Uint8Array(ab)
  } finally {
    try {
      if (mount) mount.remove()
      else if (exportRoot.parentNode) exportRoot.parentNode.removeChild(exportRoot)
    } catch {}
    // 释放 blob URL，避免长文档导出后内存涨不回来
    for (const u of blobUrls) {
      try { URL.revokeObjectURL(u) } catch {}
    }
  }
}

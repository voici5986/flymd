// 本地图片 src 解析：把 Markdown/DOM 中的图片链接尽力解析为“本地绝对路径”
// 设计目标：
// - 仅用于渲染阶段（预览/所见），不改写用户 Markdown 原文
// - 不碰现有图床/拖拽/粘贴/上传等逻辑：已是可加载协议的一律跳过
// - 统一处理 Windows 相对路径（如 .\\tp\\1.png）与 file:// URI

function stripMarkdownAngleBrackets(input: string): string {
  const s = String(input || '').trim()
  if (s.startsWith('<') && s.endsWith('>') && s.length >= 2) return s.slice(1, -1)
  return s
}

function decodeMaybeOnce(input: string): string {
  try { return decodeURIComponent(input) } catch { return input }
}

function looksLikeWindowsDrivePath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input)
}

function looksLikeUrlSchemeButNotDriveLetter(input: string): boolean {
  // 注意：Windows 盘符 "C:\\" 也长得像 "c:"，必须排除
  if (/^[a-zA-Z]:/.test(input)) return false
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)
}

function fromFileUri(u: string): string | null {
  try {
    if (!/^file:/i.test(u)) return null
    const url = new URL(u)
    const host = url.hostname || ''
    let p = url.pathname || ''
    // Windows 场景：/D:/path => D:/path
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
    p = decodeMaybeOnce(p)
    if (host) {
      // UNC: file://server/share/path -> \\server\share\path
      const pathPart = p.replace(/^\//, '').replace(/\//g, '\\')
      return '\\' + '\\' + host + (pathPart ? '\\' + pathPart : '')
    }
    if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\')
    return p
  } catch {
    return null
  }
}

function normalizeForResolve(p: string): string {
  let s = String(p || '')
  // UNC: \\server\share -> //server/share
  if (s.startsWith('\\\\')) s = '//' + s.slice(2)
  return s.replace(/\\/g, '/')
}

function resolveDots(normalizedPath: string): string {
  const parts = String(normalizedPath || '').split('/')
  const stack: string[] = []

  // 根边界：禁止 '..' 把路径弹出根目录（驱动器/UNC/Unix 根）
  let rootMin = 0

  // UNC: //server/share/...
  if (parts.length >= 2 && parts[0] === '' && parts[1] === '') {
    stack.push('', '')
    rootMin = 2
    parts.splice(0, 2)
  } else if (parts.length >= 1 && parts[0] === '') {
    // Unix: /a/b
    stack.push('')
    rootMin = 1
    parts.splice(0, 1)
  } else if (parts.length >= 1 && /^[a-zA-Z]:$/.test(parts[0])) {
    // Windows: C:/a/b
    stack.push(parts[0])
    rootMin = 1
    parts.splice(0, 1)
  }

  for (const seg0 of parts) {
    const seg = String(seg0 || '')
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (stack.length > rootMin) stack.pop()
      continue
    }
    stack.push(seg)
  }

  return stack.join('/')
}

function resolveRelativePath(baseDir: string, rel: string): string {
  const baseNorm = normalizeForResolve(baseDir).replace(/\/+$/, '')
  const relNorm = normalizeForResolve(rel).replace(/^\/+/, '')
  const combined = baseNorm ? (baseNorm + '/' + relNorm) : relNorm
  const resolved = resolveDots(combined)

  const baseIsUnc = baseDir.startsWith('\\\\') || baseNorm.startsWith('//')
  const baseIsDrive = /^[a-zA-Z]:/.test(baseDir)
  if (baseIsUnc || baseIsDrive) return resolved.replace(/\//g, '\\')
  return resolved
}

function normalizeForCompare(p: string): string {
  return normalizeForResolve(String(p || '')).replace(/\/+$/, '')
}

function encodePathSegments(p: string): string {
  try {
    const s = String(p || '').replace(/\\/g, '/')
    return s
      .split('/')
      .filter((seg) => seg !== '')
      .map((seg) => encodeURIComponent(seg))
      .join('/')
  } catch {
    return String(p || '').replace(/\\/g, '/')
  }
}

// 若 absPath 位于当前文档同目录的 images/ 下，返回适合写入 Markdown 的相对路径（已进行编码）
// - 返回 null：表示不应写为相对路径（例如图片不在 images/，或无 currentFilePath）
export function toDocRelativeImagePathIfInImages(absPath: string, currentFilePath?: string | null): string | null {
  try {
    const cur = String(currentFilePath || '').trim()
    const abs = String(absPath || '').trim()
    if (!cur || !abs) return null

    const baseDir = cur.replace(/[\\/][^\\/]*$/, '')
    if (!baseDir) return null
    const sep = baseDir.includes('\\') ? '\\' : '/'
    const imagesDir = baseDir.replace(/[\\/]+$/, '') + sep + 'images'

    const absNorm = normalizeForCompare(abs)
    const imgNorm = normalizeForCompare(imagesDir)

    const winLike = /^[a-zA-Z]:/.test(imagesDir) || imagesDir.startsWith('\\\\') || imgNorm.startsWith('//')
    const a = winLike ? absNorm.toLowerCase() : absNorm
    const b = winLike ? imgNorm.toLowerCase() : imgNorm

    const prefix = b.endsWith('/') ? b : b + '/'
    if (!a.startsWith(prefix)) return null

    const tail = absNorm.slice(prefix.length)
    if (!tail) return null
    return 'images/' + encodePathSegments(tail)
  } catch {
    return null
  }
}

// 将图片 src 尽力解析为本地绝对路径：
// - 返回 null：表示不该按本地文件处理（远程/已是可加载协议/无法解析）
export function resolveLocalImageAbsPathFromSrc(rawSrc: string, currentFilePath?: string | null): string | null {
  try {
    let s = stripMarkdownAngleBrackets(String(rawSrc || '').trim())
    if (!s) return null

    // 尽力解码一次（处理 %5C 等）
    s = decodeMaybeOnce(s)

    // 已可加载协议：直接跳过（不能破坏现有逻辑）
    if (/^(data:|blob:|asset:|https?:)/i.test(s)) return null

    // 特例：某些情况下反斜杠被编码但 decode 失败，这里兜底还原
    if (/^(?:%5[cC]){2}/.test(s)) {
      s = (() => {
        try { return decodeURIComponent(s) } catch { return s.replace(/%5[cC]/g, '\\') }
      })()
    }

    // file:// URI
    if (/^file:/i.test(s)) {
      const p = fromFileUri(s)
      return p ? p : null
    }

    // Windows 盘符绝对路径
    if (looksLikeWindowsDrivePath(s)) return s.replace(/\//g, '\\')
    // UNC
    if (/^\\\\/.test(s)) return s.replace(/\//g, '\\')
    // Unix 绝对路径
    if (/^\//.test(s)) return s

    // 其它自定义协议（例如 uploading://、obsidian:// 等）：不是本地路径，必须跳过
    if (looksLikeUrlSchemeButNotDriveLetter(s)) return null

    // 相对路径：必须有当前文档路径作为 base
    const cur = String(currentFilePath || '').trim()
    if (!cur) return null
    const baseDir = cur.replace(/[\\/][^\\/]*$/, '')
    if (!baseDir) return null
    return resolveRelativePath(baseDir, s)
  } catch {
    return null
  }
}

// 本地图片路径辅助：用于跨设备同步后的“绝对路径失效”自愈
// 设计目标：不改动用户文档内容，只在渲染阶段尽力把旧路径映射到当前文档目录的 images/ 下。

function normalizeSlashes(p: string): string {
  return String(p || '').replace(/\\/g, '/')
}

function dirnameLike(p: string): string {
  return String(p || '').replace(/[\\/][^\\/]*$/, '')
}

function basenameLike(p: string): string {
  const s = String(p || '').trim()
  if (!s) return ''
  const parts = s.split(/[\\/]+/)
  return parts[parts.length - 1] || ''
}

function joinLike(base: string, rel: string): string {
  const b = String(base || '').replace(/[\\/]+$/, '')
  const r = String(rel || '').replace(/^[\\/]+/, '')
  const sep = b.includes('\\') ? '\\' : '/'
  if (!b) return r
  if (!r) return b
  return b + sep + r.split(/[\\/]+/).join(sep)
}

// 从旧绝对路径中提取 images/ 后面的尾部（支持子目录）：.../images/a/b.png -> a/b.png
function extractImagesTail(abs: string): string | null {
  const s = normalizeSlashes(abs)
  const m = s.match(/\/images\/(.+)$/i)
  return m?.[1] ? String(m[1]) : null
}

// 给定“旧设备绝对路径”，猜测它在“当前设备”的实际位置：
// 约定：同步可用的本地图片应落在“当前文档同目录 images/”。
export function guessSyncedDocImageAbsPath(currentFilePath: string, oldAbsPath: string): string | null {
  const cur = String(currentFilePath || '').trim()
  const old = String(oldAbsPath || '').trim()
  if (!cur || !old) return null

  const docDir = dirnameLike(cur)
  if (!docDir) return null

  const imagesDir = joinLike(docDir, 'images')
  const tail = extractImagesTail(old)
  if (tail) return joinLike(imagesDir, tail)

  const name = basenameLike(old)
  if (!name) return null
  return joinLike(imagesDir, name)
}


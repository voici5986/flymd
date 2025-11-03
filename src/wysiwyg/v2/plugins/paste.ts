// 粘贴上传适配：将图片粘贴/拖拽转为文档中的 image 节点
import type { Uploader } from '@milkdown/kit/plugin/upload'
import type { Node as ProseNode, Schema } from '@milkdown/prose/model'
import { uploadImageToS3R2, type UploaderConfig } from '../../../uploader/s3'
// 本地保存：在未启用图床或开启“总是保存到本地”时，将粘贴/拖拽的图片写入 images/ 或默认粘贴目录
// 文件保存交给外层（main.ts）以避免在插件侧直接依赖 Tauri 插件

async function getAlwaysLocal(): Promise<boolean> {
  try { const fn = (window as any).flymdAlwaysSaveLocalImages; return typeof fn === 'function' ? !!(await fn()) : false } catch { return false }
}
async function getCurrentPath(): Promise<string | null> {
  try { const fn = (window as any).flymdGetCurrentFilePath; return typeof fn === 'function' ? (await fn()) : null } catch { return null }
}
async function getDefaultPasteDir(): Promise<string | null> {
  try { const fn = (window as any).flymdGetDefaultPasteDir; return typeof fn === 'function' ? (await fn()) : null } catch { return null }
}
function pathJoin(a: string, b: string): string { const sep = a.includes('\\') ? '\\' : '/'; return a.replace(/[\\/]+$/, '') + sep + b.replace(/^[\\/]+/, '') }
function needAngle(url: string): boolean { return /[\s()]/.test(url) || /^[a-zA-Z]:/.test(url) || /\\/.test(url) }

export const uploader: Uploader = async (files, schema) => {
  const images: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)
    if (!f) continue
    if (!f.type.includes('image')) continue
    images.push(f)
  }
  const nodes: ProseNode[] = []
  const alwaysLocal = await getAlwaysLocal()
  for (const img of images) {
    let done = false
    // 1) 若配置启用直连图床且未强制本地，优先外链
    try {
      if (!alwaysLocal) {
        const cfgGetter = (typeof window !== 'undefined') ? (window as any).flymdGetUploaderConfig : null
        const upCfg: UploaderConfig | null = typeof cfgGetter === 'function' ? await cfgGetter() : null
        if (upCfg && upCfg.enabled) {
          const res = await uploadImageToS3R2(img, img.name || 'image', img.type || 'application/octet-stream', upCfg)
          const url = res?.publicUrl || ''
          if (url) {
            const n = schema.nodes.image.createAndFill({ src: url, alt: img.name }) as ProseNode
            if (n) { nodes.push(n); done = true }
          }
        }
      }
    } catch {}
    // 2) 否则保存到本地 images/ 或默认粘贴目录
    if (!done) {
      try {
        const cur = await getCurrentPath()
        let baseDir: string | null = null
        if (cur && typeof cur === 'string') {
          const dir = cur.replace(/[\\/][^\\/]*$/, '')
          baseDir = pathJoin(dir, 'images')
        } else {
          baseDir = await getDefaultPasteDir()
        }
        const saver = (window as any).flymdSaveImageToLocalAndGetPath
        const dstPath: string | null = typeof saver === 'function' ? await saver(img, img.name || 'image') : null
        if (dstPath) {
          const url = needAngle(dstPath) ? `<${dstPath}>` : dstPath
          const n = schema.nodes.image.createAndFill({ src: url, alt: img.name }) as ProseNode
          if (n) { nodes.push(n); done = true }
        }
      } catch {}
    }
    // 3) 兜底：base64
    if (!done) {
      try {
        const dataUrl = await toDataUrl(img)
        const n = schema.nodes.image.createAndFill({ src: dataUrl, alt: img.name }) as ProseNode
        if (n) nodes.push(n)
      } catch {}
    }
  }
  return nodes
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader()
      fr.onerror = () => reject(fr.error || new Error('read error'))
      fr.onload = () => resolve(String(fr.result || ''))
      fr.readAsDataURL(file)
    } catch (e) { reject(e) }
  })
}

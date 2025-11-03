// 粘贴上传适配：将图片粘贴/拖拽转为文档中的 image 节点
import type { Uploader } from '@milkdown/kit/plugin/upload'
import type { Node as ProseNode, Schema } from '@milkdown/prose/model'
import { uploadImageToS3R2 } from '../../../uploader/s3'

export const uploader: Uploader = async (files, schema) => {
  const images: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)
    if (!f) continue
    if (!f.type.includes('image')) continue
    images.push(f)
  }
  const nodes: ProseNode[] = []
  for (const img of images) {
    try {
      // 走现有的图床上传，回写 URL
      const url = await uploadImageToS3R2(img)
      const node = schema.nodes.image.createAndFill({ src: url, alt: img.name }) as ProseNode
      if (node) nodes.push(node)
    } catch {
      // 失败兜底：转 base64（避免丢失）
      try {
        const dataUrl = await toDataUrl(img)
        const node = schema.nodes.image.createAndFill({ src: dataUrl, alt: img.name }) as ProseNode
        if (node) nodes.push(node)
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


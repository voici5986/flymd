// 粘贴/拖拽图片异步上传核心模块
// 只关心占位符替换与本地/图床/兜底策略，不直接依赖 DOM 全局

import type { AnyUploaderConfig } from '../uploader/types'
import { uploadImageToCloud } from '../uploader/upload'
import { toDocRelativeImagePathIfInImages } from '../utils/localImageSrcResolve'

export type EditorMode = 'edit' | 'preview'

export interface ImageUploadDeps {
  // 编辑器内容读写
  getEditorValue(): string
  setEditorValue(v: string): void
  // 编辑器状态
  getMode(): EditorMode
  isWysiwyg(): boolean
  // 视图刷新
  renderPreview(): void
  scheduleWysiwygRender(): void
  // 标记文档已修改并刷新标题/状态栏
  markDirtyAndRefresh(): void
  // 光标处插入文本
  insertAtCursor(text: string): void
  // 当前文档路径（用于决定本地保存目录）
  getCurrentFilePath(): string | null
  // 运行时与路径相关工具
  isTauriRuntime(): boolean
  ensureDir(dir: string): Promise<void>
  getDefaultPasteDir(): Promise<string | null>
  getUserPicturesDir(): Promise<string | null>
  // 图床与转码配置
  getAlwaysSaveLocalImages(): Promise<boolean>
  // 本地图片链接写法：仅影响写入 Markdown（不改渲染与已有内容）
  getPreferRelativeLocalImages(): Promise<boolean>
  getUploaderConfig(): Promise<AnyUploaderConfig | null>
  getTranscodePrefs(): Promise<{ convertToWebp: boolean; webpQuality: number; saveLocalAsWebp: boolean }>
  // 文件写入与 dataURL 工具
  writeBinaryFile(path: string, bytes: Uint8Array): Promise<void>
  fileToDataUrl(file: File): Promise<string>
  // WebP 转码：由调用方注入，保持行为一致
  transcodeToWebpIfNeeded(
    blob: Blob,
    fname: string,
    quality: number,
    opts: { skipAnimated: boolean }
  ): Promise<{ blob: Blob; fileName: string; type?: string }>
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function genUploadId(): string {
  return `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function replaceUploadingPlaceholder(
  deps: ImageUploadDeps,
  id: string,
  replacementMarkdown: string
) {
  try {
    const token = `uploading://${id}`
    const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(token)}\\)`)
    const before = deps.getEditorValue()
    if (re.test(before)) {
      const next = before.replace(re, replacementMarkdown)
      deps.setEditorValue(next)
      deps.markDirtyAndRefresh()
      const mode = deps.getMode()
      if (mode === 'preview') deps.renderPreview()
      else if (deps.isWysiwyg()) deps.scheduleWysiwygRender()
    }
  } catch {
    // 静默失败：占位符保留在文档中
  }
}

async function saveBlobLocallyWithPrefs(
  deps: ImageUploadDeps,
  blob: Blob,
  fname: string
): Promise<string | null> {
  const { saveLocalAsWebp, webpQuality } = await deps.getTranscodePrefs()
  let blobForSave: Blob = blob
  let nameForSave: string = fname
  try {
    if (saveLocalAsWebp) {
      const r = await deps.transcodeToWebpIfNeeded(blob, fname, webpQuality, { skipAnimated: true })
      blobForSave = r.blob
      nameForSave = r.fileName
    }
  } catch {}

  const currentFilePath = deps.getCurrentFilePath()

  // 1a. 当前文档同目录 images/
  if (deps.isTauriRuntime() && currentFilePath) {
    try {
      const base = currentFilePath.replace(/[\\/][^\\/]*$/, '')
      const sep = base.includes('\\') ? '\\' : '/'
      const imgDir = base + sep + 'images'
      await deps.ensureDir(imgDir)
      const dst = imgDir + sep + nameForSave
      const buf = new Uint8Array(await blobForSave.arrayBuffer())
      await deps.writeBinaryFile(dst, buf)
      return dst
    } catch {
      // ignore, 继续尝试其他目录
    }
  }

  // 1b. 未保存的文档：默认粘贴目录
  if (deps.isTauriRuntime() && !currentFilePath) {
    try {
      const dir = await deps.getDefaultPasteDir()
      if (dir) {
        const baseDir = dir.replace(/[\\/]+$/, '')
        const sep = baseDir.includes('\\') ? '\\' : '/'
        const dst = baseDir + sep + nameForSave
        const buf = new Uint8Array(await blobForSave.arrayBuffer())
        await deps.ensureDir(baseDir)
        await deps.writeBinaryFile(dst, buf)
        return dst
      }
    } catch {
      // ignore
    }
  }

  // 1c. 兜底：用户图片目录
  if (deps.isTauriRuntime() && !currentFilePath) {
    try {
      const pic = await deps.getUserPicturesDir()
      if (pic) {
        const baseDir = pic.replace(/[\\/]+$/, '')
        const sep = baseDir.includes('\\') ? '\\' : '/'
        const dst = baseDir + sep + nameForSave
        const buf = new Uint8Array(await blobForSave.arrayBuffer())
        await deps.ensureDir(baseDir)
        await deps.writeBinaryFile(dst, buf)
        return dst
      }
    } catch {
      // ignore
    }
  }

  return null
}

export function createImageUploader(deps: ImageUploadDeps) {
  async function handleUploadCore(fileOrBlob: File | Blob, fname: string, mime?: string) {
    const id = genUploadId()
    deps.insertAtCursor(`![${fname || 'image'}](uploading://${id})`)

    void (async () => {
      try {
        const alwaysLocal = await deps.getAlwaysSaveLocalImages()
        const upCfg = await deps.getUploaderConfig()
        const uploaderEnabled = !!(upCfg && (upCfg as any).enabled)

        let localPath: string | null = null
        let cloudUrl: string | null = null

        // ===== 步骤 1: 本地保存（如果需要）=====
        if (!uploaderEnabled || alwaysLocal) {
          localPath = await saveBlobLocallyWithPrefs(deps, fileOrBlob, fname)
        }

        // ===== 步骤 2: 图床上传（如果启用）=====
        if (!localPath && uploaderEnabled && upCfg) {
          try {
            let blob2: Blob = fileOrBlob
            let name2: string = fname
            let mime2: string = mime || (fileOrBlob as any).type || 'application/octet-stream'
            try {
              if ((upCfg as any).convertToWebp) {
                const r = await deps.transcodeToWebpIfNeeded(
                  fileOrBlob,
                  fname,
                  (upCfg as any).webpQuality ?? 0.85,
                  { skipAnimated: true }
                )
                blob2 = r.blob
                name2 = r.fileName
                mime2 = r.type || 'image/webp'
              }
            } catch {}

            const res = await uploadImageToCloud(blob2, name2, mime2, upCfg)
            cloudUrl = res.publicUrl
          } catch {
            // 上传失败继续后续兜底
          }
        }

        // ===== 步骤 2b: 上传失败则强制本地保存（禁止 base64 兜底）=====
        if (!localPath && !cloudUrl && uploaderEnabled && !alwaysLocal) {
          localPath = await saveBlobLocallyWithPrefs(deps, fileOrBlob, fname)
        }

        // ===== 步骤 3: 决定最终 URL =====
        if (localPath) {
          let mdUrl: string = localPath
          try {
            const preferRel = await deps.getPreferRelativeLocalImages()
            if (preferRel) {
              const rel = toDocRelativeImagePathIfInImages(localPath, deps.getCurrentFilePath())
              if (rel) mdUrl = rel
            }
          } catch {}
          if (mdUrl === localPath) {
            const needAngle =
              /[\s()]/.test(localPath) ||
              /^[a-zA-Z]:/.test(localPath) ||
              /\\/.test(localPath)
            mdUrl = needAngle ? `<${localPath}>` : localPath
          }
          replaceUploadingPlaceholder(deps, id, `![${fname}](${mdUrl})`)
          return
        }
        if (cloudUrl) {
          replaceUploadingPlaceholder(deps, id, `![${fname}](${cloudUrl})`)
          return
        }
      } catch {
        // 完全失败时占位符保留，避免插入 base64 破坏文档
      }
    })()
  }

  function startAsyncUploadFromFile(file: File, fname: string): Promise<void> {
    void handleUploadCore(file, fname, file.type || 'application/octet-stream')
    return Promise.resolve()
  }

  function startAsyncUploadFromBlob(blob: Blob, fname: string, mime: string): Promise<void> {
    void handleUploadCore(blob, fname, mime)
    return Promise.resolve()
  }

  return {
    startAsyncUploadFromFile,
    startAsyncUploadFromBlob,
  }
}

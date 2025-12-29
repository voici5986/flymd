// 桌面端：录音/音频文件转写（官方代理 + 火山自配）
// 原则：不把一坨逻辑塞进 main.ts；这里只做独立状态机 + 菜单入口。

import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import type { Store } from '@tauri-apps/plugin-store'
import { addToPluginsMenu } from './pluginMenu'
import { getHttpClient } from './runtime'
import { acquireMic, type MicLease, getActiveMicOwner } from './micManager'

const FEATURE_ID = 'speech-transcribe'

// 官方默认：走自带后端代理（部署在 site/ai/audio_proxy.php）
const AUDIO_TRANSCRIBE_PROXY_URL = 'https://flymd.llingfei.com/ai/audio_proxy.php'

// 软门槛 token（服务端同样是软门槛：别当鉴权）
const FLYMD_CLIENT_TOKEN_SECRET = 'flymd-rolling-secret-v1'
const FLYMD_CLIENT_TOKEN_WINDOW_SECONDS = 120

const MANUAL_TRANSCRIBE_STORE_KEY = 'manual_transcribe'
const ASR_SAMPLE_RATE = 16000

type ManualTranscribeMode = 'official' | 'volc'
type ManualTranscribeConfig = {
  mode: ManualTranscribeMode
  volc?: {
    endpoint?: string
    appKey: string
    accessKey: string
    resourceId?: string
    language?: string
    enableDdc?: boolean
  }
}

export type SpeechTranscribeDeps = {
  getStore(): Store | null
  insertAtCursor(text: string): void
  pluginNotice(msg: string, level?: 'ok' | 'err', ms?: number): void
  confirmNative(message: string, title?: string): Promise<boolean>
}

type ActiveSpeechRecorder = {
  recorder: MediaRecorder
  lease: MicLease
  chunks: BlobPart[]
  mimeType: string
  startedAt: number
}

let _initialized = false
let _deps: SpeechTranscribeDeps | null = null
let _active: ActiveSpeechRecorder | null = null
let _busy = false

export function initSpeechTranscribeFeature(deps: SpeechTranscribeDeps): void {
  if (_initialized) return
  _initialized = true
  _deps = deps
  updateMenu()
}

async function manualTranscribeStoreGet(): Promise<ManualTranscribeConfig> {
  try {
    const store = _deps?.getStore?.() || null
    if (!store) return { mode: 'official' }
    const raw = (await store.get(MANUAL_TRANSCRIBE_STORE_KEY)) as any
    const mode = String(raw?.mode || '').trim()
    if (mode === 'volc') return raw as any
  } catch {}
  return { mode: 'official' }
}

async function manualTranscribeStoreSet(patch: Partial<ManualTranscribeConfig>): Promise<void> {
  try {
    const store = _deps?.getStore?.() || null
    if (!store) return
    const prev = await manualTranscribeStoreGet()
    const next: ManualTranscribeConfig = { ...(prev as any), ...(patch as any) }
    await store.set(MANUAL_TRANSCRIBE_STORE_KEY, next as any)
    await store.save()
  } catch {}
}

function manualTranscribeProviderLabel(cfg: ManualTranscribeConfig): string {
  if (cfg?.mode === 'volc') return '火山引擎（用户自配）'
  return '官方默认（走自带后端）'
}

// JS 绘制的“转写设置”窗口：替代 prompt/confirmNative 这种原生弹窗
const MANUAL_TRANSCRIBE_UI_OVERLAY_ID = 'flymd-speech-transcribe-ui-overlay'

let _manualTranscribeUiResolve: ((cfg: ManualTranscribeConfig | null) => void) | null = null

function closeManualTranscribeUi(ov: HTMLDivElement, result: ManualTranscribeConfig | null): void {
  const resolve = _manualTranscribeUiResolve
  _manualTranscribeUiResolve = null

  try { ov.classList.add('hidden') } catch {}
  try { (ov.querySelector('#flymd-speech-transcribe-ui-body') as HTMLDivElement | null)!.innerHTML = '' } catch {}
  try { (ov.querySelector('#flymd-speech-transcribe-ui-actions') as HTMLDivElement | null)!.innerHTML = '' } catch {}

  try { resolve?.(result) } catch {}
}

function ensureManualTranscribeUiOverlay(): HTMLDivElement | null {
  try {
    const container = document.querySelector('.container') as HTMLDivElement | null
    if (!container) return null

    let ov = document.getElementById(MANUAL_TRANSCRIBE_UI_OVERLAY_ID) as HTMLDivElement | null
    if (ov) return ov

    ov = document.createElement('div')
    ov.id = MANUAL_TRANSCRIBE_UI_OVERLAY_ID
    ov.className = 'link-overlay hidden'
    ov.innerHTML = `
      <div class="link-dialog" role="dialog" aria-modal="true" aria-labelledby="flymd-speech-transcribe-ui-title">
        <div class="link-header">
          <div id="flymd-speech-transcribe-ui-title">转写设置（自定义模型）</div>
          <button id="flymd-speech-transcribe-ui-close" class="about-close" title="关闭">×</button>
        </div>
        <div class="link-body" id="flymd-speech-transcribe-ui-body"></div>
        <div class="link-actions" id="flymd-speech-transcribe-ui-actions"></div>
      </div>
    `
    container.appendChild(ov)

    const close = () => { closeManualTranscribeUi(ov!, null) }
    const btn = ov.querySelector('#flymd-speech-transcribe-ui-close') as HTMLButtonElement | null
    if (btn) btn.addEventListener('click', close)
    ov.addEventListener('click', (e) => { if (e.target === ov) close() })
    ov.addEventListener('keydown', (e) => {
      if ((e as any)?.key === 'Escape') close()
    })

    return ov
  } catch {
    return null
  }
}

function showManualTranscribeUi(
  htmlBody: string,
  htmlActions: string,
  onBind: (ov: HTMLDivElement) => void,
): Promise<ManualTranscribeConfig | null> {
  return new Promise((resolve) => {
    const ov = ensureManualTranscribeUiOverlay()
    if (!ov) return resolve(null)

    // 防止上一次未正常关闭导致 Promise 悬挂
    if (_manualTranscribeUiResolve) {
      try { _manualTranscribeUiResolve(null) } catch {}
      _manualTranscribeUiResolve = null
    }
    _manualTranscribeUiResolve = resolve

    const body = ov.querySelector('#flymd-speech-transcribe-ui-body') as HTMLDivElement | null
    const actions = ov.querySelector('#flymd-speech-transcribe-ui-actions') as HTMLDivElement | null
    if (!body || !actions) return closeManualTranscribeUi(ov, null)

    body.innerHTML = htmlBody
    actions.innerHTML = htmlActions
    ov.classList.remove('hidden')
    try { onBind(ov) } catch {}
    try { (ov.querySelector('input,button,select,textarea') as any)?.focus?.() } catch {}
  })
}

async function showManualTranscribeSettingsDialog(cur: ManualTranscribeConfig): Promise<ManualTranscribeConfig | null> {
  const endpointDefault = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
  const resourceIdDefault = 'volc.seedasr.auc'
  const curMode: ManualTranscribeMode = cur?.mode === 'volc' ? 'volc' : 'official'

  const htmlBody = `
    <div id="st-root" style="font-size:13px;line-height:1.6;">
      <div style="margin-bottom:10px;color:var(--muted);">仅影响：录音 / 音频文件转写。</div>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <label style="display:flex;gap:6px;align-items:center;">
          <input id="st-mode-official" type="radio" name="st-mode" value="official">
          <span>默认</span>
        </label>
        <label style="display:flex;gap:6px;align-items:center;">
          <input id="st-mode-volc" type="radio" name="st-mode" value="volc">
          <span>火山引擎</span>
        </label>
      </div>

      <div id="st-volc-fields" style="display:none;">
        <div style="display:grid;grid-template-columns:160px 1fr;gap:8px 10px;align-items:center;">
          <div>接口地址</div>
          <input id="st-endpoint" class="input" placeholder="${endpointDefault}">

          <div>X-Api-App-Key（必填）</div>
          <input id="st-appKey" class="input" placeholder="请输入 App Key">

          <div>X-Api-Access-Key（必填）</div>
          <input id="st-accessKey" class="input" placeholder="请输入 Access Key" type="password">

          <div>X-Api-Resource-Id</div>
          <input id="st-resourceId" class="input" placeholder="${resourceIdDefault}">

          <div>language（可选；留空=自动）</div>
          <input id="st-language" class="input" placeholder="例如：zh-CN / en-US">

          <div>enable_ddc（语义顺滑）</div>
          <label style="display:flex;gap:8px;align-items:center;">
            <input id="st-enableDdc" type="checkbox">
            <span style="color:var(--muted);font-size:12px;">启用</span>
          </label>
        </div>
        <div style="margin-top:10px;color:var(--muted);font-size:12px;">提示：密钥会保存在本地配置里（未加密）。</div>
      </div>

      <div id="st-msg" style="margin-top:10px;color:var(--muted);"></div>
    </div>
  `

  const htmlActions = `
    <button id="st-save">保存</button>
    <button id="st-cancel">取消</button>
  `

  return await showManualTranscribeUi(htmlBody, htmlActions, (ov) => {
    const modeOfficial = ov.querySelector('#st-mode-official') as HTMLInputElement | null
    const modeVolc = ov.querySelector('#st-mode-volc') as HTMLInputElement | null
    const volcFields = ov.querySelector('#st-volc-fields') as HTMLDivElement | null

    const endpointEl = ov.querySelector('#st-endpoint') as HTMLInputElement | null
    const appKeyEl = ov.querySelector('#st-appKey') as HTMLInputElement | null
    const accessKeyEl = ov.querySelector('#st-accessKey') as HTMLInputElement | null
    const resourceIdEl = ov.querySelector('#st-resourceId') as HTMLInputElement | null
    const languageEl = ov.querySelector('#st-language') as HTMLInputElement | null
    const enableDdcEl = ov.querySelector('#st-enableDdc') as HTMLInputElement | null

    const msgEl = ov.querySelector('#st-msg') as HTMLDivElement | null
    const btnSave = ov.querySelector('#st-save') as HTMLButtonElement | null
    const btnCancel = ov.querySelector('#st-cancel') as HTMLButtonElement | null

    const root = ov.querySelector('#st-root') as HTMLDivElement | null

    const setMsg = (s: string, isErr: boolean) => {
      if (!msgEl) return
      msgEl.textContent = s
      msgEl.style.color = isErr ? 'var(--err, #d33)' : 'var(--muted)'
    }

    const syncModeUi = () => {
      const mode: ManualTranscribeMode =
        (ov.querySelector('input[name="st-mode"]:checked') as HTMLInputElement | null)?.value === 'volc'
          ? 'volc'
          : 'official'
      if (volcFields) volcFields.style.display = mode === 'volc' ? '' : 'none'
      if (mode === 'official') setMsg('当前：默认', false)
      else setMsg('当前：火山引擎', false)
    }

    if (modeOfficial) modeOfficial.checked = curMode === 'official'
    if (modeVolc) modeVolc.checked = curMode === 'volc'

    if (endpointEl) endpointEl.value = String(cur?.volc?.endpoint || endpointDefault)
    if (appKeyEl) appKeyEl.value = String(cur?.volc?.appKey || '')
    if (accessKeyEl) accessKeyEl.value = String(cur?.volc?.accessKey || '')
    if (resourceIdEl) resourceIdEl.value = String(cur?.volc?.resourceId || resourceIdDefault)
    if (languageEl) languageEl.value = String(cur?.volc?.language || '')
    if (enableDdcEl) enableDdcEl.checked = !!cur?.volc?.enableDdc

    if (modeOfficial) modeOfficial.addEventListener('change', syncModeUi)
    if (modeVolc) modeVolc.addEventListener('change', syncModeUi)
    syncModeUi()

    const close = (v: ManualTranscribeConfig | null) => { closeManualTranscribeUi(ov, v) }
    if (btnCancel) btnCancel.addEventListener('click', () => close(null))

    const submit = () => {
      try {
        const mode: ManualTranscribeMode =
          (ov.querySelector('input[name="st-mode"]:checked') as HTMLInputElement | null)?.value === 'volc'
            ? 'volc'
            : 'official'

        if (mode === 'official') return close({ mode: 'official', volc: undefined })

        const endpoint = String(endpointEl?.value || '').trim() || endpointDefault
        const appKey = String(appKeyEl?.value || '').trim()
        const accessKey = String(accessKeyEl?.value || '').trim()
        const resourceId = String(resourceIdEl?.value || '').trim() || resourceIdDefault
        const language = String(languageEl?.value || '').trim()
        const enableDdc = !!enableDdcEl?.checked

        if (!appKey) return setMsg('未填写 X-Api-App-Key', true)
        if (!accessKey) return setMsg('未填写 X-Api-Access-Key', true)

        close({ mode: 'volc', volc: { endpoint, appKey, accessKey, resourceId, language, enableDdc } })
      } catch (e) {
        setMsg('保存失败：' + String((e as any)?.message || e || ''), true)
      }
    }

    if (btnSave) btnSave.addEventListener('click', submit)
    if (root) {
      root.addEventListener('keydown', (e) => {
        const k = (e as any)?.key
        if (k === 'Enter') submit()
      })
    }

    // 体验优先：火山模式时让用户直接开始填密钥
    try {
      if (curMode === 'volc') (appKeyEl || endpointEl)?.focus?.()
    } catch {}
  })
}

function updateMenu(): void {
  try {
    const children: any[] = []
    children.push({
      label: _active ? '停止录音并转写' : '开始录音',
      disabled: _busy,
      onClick: () => { void toggleRecordAndTranscribeMenu() },
    })
    children.push({
      label: '选择音频文件转写…',
      disabled: _busy,
      onClick: () => { void transcribeFromAudioFileMenu() },
    })
    children.push({
      label: '转写设置（自定义模型）…',
      disabled: _busy,
      onClick: () => { void openManualTranscribeSettingsFromMenu() },
    })
    addToPluginsMenu(FEATURE_ID, { label: '语音转写', children })
  } catch {}
}

async function openManualTranscribeSettingsFromMenu(): Promise<void> {
  const deps = _deps
  if (!deps) return
  try {
    const cur = await manualTranscribeStoreGet()
    const next = await showManualTranscribeSettingsDialog(cur)
    if (!next) return

    await manualTranscribeStoreSet({ mode: next.mode, volc: next.volc })
    if (next.mode === 'volc') deps.pluginNotice('火山转写配置已保存', 'ok', 2600)
    else deps.pluginNotice('已切回官方默认转写', 'ok', 2200)
    updateMenu()
  } catch (e) {
    deps.pluginNotice('打开转写设置失败：' + String((e as any)?.message || e || ''), 'err', 2600)
  }
}

function fnv1a32Hex(str: string): string {
  try {
    let hash = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i) & 0xff
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  } catch {
    return '00000000'
  }
}

function buildRollingClientToken(): string {
  const slice = Math.floor(Date.now() / 1000 / FLYMD_CLIENT_TOKEN_WINDOW_SECONDS)
  const base = `${FLYMD_CLIENT_TOKEN_SECRET}:${slice}:2pai`
  const partA = fnv1a32Hex(base)
  const partB = fnv1a32Hex(`${base}:${slice % 97}`)
  return `flymd-${partA}${partB}`
}

function guessAudioMimeType(name: string): string {
  const n = String(name || '').toLowerCase()
  if (n.endsWith('.mp3')) return 'audio/mpeg'
  if (n.endsWith('.m4a')) return 'audio/mp4'
  if (n.endsWith('.aac')) return 'audio/aac'
  if (n.endsWith('.wav')) return 'audio/wav'
  if (n.endsWith('.ogg')) return 'audio/ogg'
  if (n.endsWith('.webm')) return 'audio/webm'
  if (n.endsWith('.opus')) return 'audio/opus'
  if (n.endsWith('.pcm')) return 'audio/pcm'
  return 'application/octet-stream'
}

function pickRecorderMimeType(): string {
  try {
    const mr = (window as any).MediaRecorder
    if (!mr || typeof mr.isTypeSupported !== 'function') return ''
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ]
    for (const t of candidates) {
      try { if (mr.isTypeSupported(t)) return t } catch {}
    }
  } catch {}
  return ''
}

function makeRecordingFileName(mimeType: string): string {
  const now = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const ext =
    mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('mp4') ? 'm4a'
        : 'webm'
  return `flymd-record-${ts}.${ext}`
}

async function blobToBase64Payload(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('读取音频失败'))
      reader.onload = () => {
        const s = String(reader.result || '')
        const idx = s.indexOf('base64,')
        if (idx < 0) return reject(new Error('base64 编码失败'))
        resolve(s.slice(idx + 'base64,'.length))
      }
      reader.readAsDataURL(blob)
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e || 'blobToBase64 failed')))
    }
  })
}

function floatToInt16Pcm(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length)
  for (let i = 0; i < src.length; i++) {
    let v = src[i]
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v < 0 ? (v * 0x8000) : (v * 0x7fff)
  }
  return out
}

function resampleTo16kInt16(src: Float32Array, srcRate: number): Int16Array {
  const inRate = Number(srcRate) || ASR_SAMPLE_RATE
  if (inRate === ASR_SAMPLE_RATE) return floatToInt16Pcm(src)
  if (!src.length) return new Int16Array(0)

  const ratio = inRate / ASR_SAMPLE_RATE
  const outLen = Math.max(0, Math.floor(src.length / ratio))
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s1 = src[idx] ?? 0
    const s2 = src[idx + 1] ?? s1
    let v = s1 + (s2 - s1) * frac
    if (v > 1) v = 1
    else if (v < -1) v = -1
    out[i] = v < 0 ? (v * 0x8000) : (v * 0x7fff)
  }
  return out
}

function pcm16ToWavBytes(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.byteLength
  const buf = new ArrayBuffer(44 + dataSize)
  const dv = new DataView(buf)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i) & 0xff) }

  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  writeStr(36, 'data')
  dv.setUint32(40, dataSize, true)

  const out = new Uint8Array(buf)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44)
  return out
}

async function decodeAudioDataCompat(ctx: AudioContext, buf: ArrayBuffer): Promise<AudioBuffer> {
  return await new Promise((resolve, reject) => {
    try {
      const anyCtx: any = ctx as any
      const p = anyCtx.decodeAudioData(buf, (ab: AudioBuffer) => resolve(ab), (e: any) => reject(e))
      if (p && typeof p.then === 'function') p.then(resolve, reject)
    } catch (e) {
      reject(e)
    }
  })
}

async function audioBlobToWav16kBlob(blob: Blob): Promise<{ wavBlob: Blob; durationSec: number }> {
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
  if (!Ctx) throw new Error('当前环境不支持音频解码（缺少 AudioContext）')
  const ctx: AudioContext = new Ctx()
  try {
    const ab = await blob.arrayBuffer()
    const audioBuf = await decodeAudioDataCompat(ctx, ab.slice(0))
    const durationSec = Number(audioBuf.duration || 0) || 0
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('音频时长无效')
    if (durationSec > 60 * 60) throw new Error('音频过长（超过 1 小时），请分段后再转写')

    const len = audioBuf.length
    const chs = audioBuf.numberOfChannels || 1
    let mono: Float32Array
    if (chs <= 1) {
      mono = audioBuf.getChannelData(0).slice(0)
    } else {
      mono = new Float32Array(len)
      for (let c = 0; c < chs; c++) {
        const src = audioBuf.getChannelData(c)
        for (let i = 0; i < len; i++) mono[i] += (src[i] || 0)
      }
      for (let i = 0; i < len; i++) mono[i] /= chs
    }

    const pcm16 = resampleTo16kInt16(mono, audioBuf.sampleRate || ASR_SAMPLE_RATE)
    const wav = pcm16ToWavBytes(pcm16, ASR_SAMPLE_RATE)
    const wavBlob = new Blob([wav], { type: 'audio/wav' })
    return { wavBlob, durationSec }
  } finally {
    try { await (ctx as any).close?.() } catch {}
  }
}

function makeUuid(): string {
  try {
    const c: any = (globalThis as any).crypto
    if (c && typeof c.randomUUID === 'function') return String(c.randomUUID())
  } catch {}
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `${rnd()}-${rnd()}-${rnd()}-${rnd()}`
}

async function volcTranscribeWav16kBase64(
  base64Wav: string,
  cfg: NonNullable<ManualTranscribeConfig['volc']>,
): Promise<string> {
  const endpoint = String(cfg.endpoint || '').trim() || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
  const appKey = String(cfg.appKey || '').trim()
  const accessKey = String(cfg.accessKey || '').trim()
  const resourceId = String(cfg.resourceId || '').trim() || 'volc.seedasr.auc'
  if (!appKey || !accessKey) throw new Error('火山配置缺失：X-Api-App-Key / X-Api-Access-Key')

  const bodyObj: any = {
    user: { uid: appKey },
    audio: { data: base64Wav, format: 'wav', rate: ASR_SAMPLE_RATE, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: cfg.enableDdc !== false,
    },
  }
  const lang = String(cfg.language || '').trim()
  if (lang) bodyObj.audio.language = lang

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': makeUuid(),
    'X-Api-Sequence': '-1',
  }

  let text = ''
  let status = 0
  try {
    const http = await getHttpClient()
    if (http && typeof http.fetch === 'function') {
      const req: any = { method: 'POST', headers, responseType: http.ResponseType?.Text }
      req.body = (http.Body && typeof http.Body.json === 'function') ? http.Body.json(bodyObj) : JSON.stringify(bodyObj)
      const resp: any = await http.fetch(endpoint, req)
      status = Number(resp?.status || 0) || 0
      const ok = resp?.ok === true || (status >= 200 && status < 300)
      text = typeof resp?.text === 'function' ? String(await resp.text()) : String(resp?.data || '')
      if (!ok) throw new Error(`HTTP ${status || 0}：${text || 'unknown'}`)
    } else {
      throw new Error('no http client')
    }
  } catch {
    const resp2 = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(bodyObj) })
    status = resp2.status
    text = await resp2.text()
    if (!resp2.ok) throw new Error(`HTTP ${status}：${text || 'unknown'}`)
  }

  const data = (() => { try { return JSON.parse(text) } catch { return null } })()
  const out = String((data && data.result && (data.result.text ?? data.result?.Text)) || '').trim()
  if (!out) throw new Error('火山转写结果为空')
  return out
}

function isProxyAllowedType(name: string, mimeType: string): boolean {
  const n = String(name || '').toLowerCase()
  const mt = String(mimeType || '').toLowerCase()
  if (n.endsWith('.wav') || mt === 'audio/wav') return true
  if (n.endsWith('.mp3') || mt === 'audio/mpeg') return true
  if (n.endsWith('.pcm') || mt === 'audio/pcm') return true
  if (n.endsWith('.opus') || mt === 'audio/opus') return true
  if (n.endsWith('.webm') || mt === 'audio/webm' || mt === 'video/webm') return true
  if (n.endsWith('.ogg') || mt === 'audio/ogg' || mt === 'application/ogg') return true
  return false
}

async function transcribeAudioBlob(blob: Blob, name: string, mimeType: string): Promise<string> {
  const deps = _deps
  if (!deps) throw new Error('deps not ready')

  const cfg = await manualTranscribeStoreGet()
  if (cfg.mode === 'volc') {
    const v = cfg.volc
    if (!v || !String(v.appKey || '').trim() || !String(v.accessKey || '').trim()) {
      deps.pluginNotice('火山配置不完整：已回退官方默认转写（可在“插件 → 语音转写 → 转写设置”里配置）', 'err', 3200)
    } else {
      const { wavBlob } = await audioBlobToWav16kBlob(blob)
      const base64 = await blobToBase64Payload(wavBlob)
      if (!base64) throw new Error('音频编码失败（base64 为空）')
      return await volcTranscribeWav16kBase64(base64, v)
    }
  }

  // 官方默认：走自带后端代理；若格式不在白名单，先转成 wav 再发，避免无意义拒绝。
  let fileBlob: Blob = blob
  let finalName = String(name || '').trim() || ((blob instanceof File) ? String((blob as any).name || '') : '') || 'audio'
  let finalType = String(mimeType || '').trim() || String((blob as any)?.type || '') || 'application/octet-stream'

  if (!isProxyAllowedType(finalName, finalType)) {
    const { wavBlob } = await audioBlobToWav16kBlob(blob)
    fileBlob = wavBlob
    finalName = finalName.replace(/\.[A-Za-z0-9]+$/, '') + '.wav'
    finalType = 'audio/wav'
  }

  const file = (() => {
    try {
      if (fileBlob instanceof File) {
        const sameName = !!finalName && fileBlob.name === finalName
        const sameType = !!finalType && fileBlob.type === finalType
        if (sameName && sameType) return fileBlob
        return new File([fileBlob], finalName, { type: finalType })
      }
    } catch {}
    return new File([fileBlob], finalName, { type: finalType })
  })()

  const form = new FormData()
  form.append('file', file)
  const headers: Record<string, string> = { 'X-Flymd-Token': buildRollingClientToken() }

  // 优先走 http 插件（绕开 CORS / 代理问题），失败回退 fetch
  let text = ''
  let status = 0
  try {
    const http = await getHttpClient()
    if (http && typeof http.fetch === 'function') {
      const req: any = { method: 'POST', headers, responseType: http.ResponseType?.Text }
      if (http.Body && typeof http.Body.form === 'function') req.body = http.Body.form(form)
      else req.body = form
      const resp: any = await http.fetch(AUDIO_TRANSCRIBE_PROXY_URL, req)
      status = Number(resp?.status || 0) || 0
      const ok = resp?.ok === true || (status >= 200 && status < 300)
      text = typeof resp?.text === 'function' ? String(await resp.text()) : String(resp?.data || '')
      if (!ok) throw new Error(`转写失败（HTTP ${status || 0}）：${text || 'unknown'}`)
    } else {
      throw new Error('no http client')
    }
  } catch {
    const resp2 = await fetch(AUDIO_TRANSCRIBE_PROXY_URL, { method: 'POST', headers, body: form })
    status = resp2.status
    text = await resp2.text()
    if (!resp2.ok) throw new Error(`转写失败（HTTP ${status}）：${text || 'unknown'}`)
  }

  const data = (() => { try { return JSON.parse(text) } catch { return null } })()
  const out = String((data && (data.text ?? data?.data?.text)) || '').trim()
  if (!out) throw new Error('转写结果为空')
  return out
}

async function toggleRecordAndTranscribeMenu(): Promise<void> {
  const deps = _deps
  if (!deps) return

  if (_busy) {
    deps.pluginNotice('正在忙：请稍候…', 'err', 1600)
    return
  }

  // 停止并转写
  if (_active) {
    try {
      _busy = true
      updateMenu()
      deps.pluginNotice('正在停止录音…', 'ok', 1200)
      try { _active.recorder.stop() } catch {}
    } finally {
      // stop 回调里会清理 _busy
    }
    return
  }

  // 开始录音
  try {
    if (!(navigator as any)?.mediaDevices?.getUserMedia) {
      deps.pluginNotice('当前环境不支持录音（缺少 getUserMedia）', 'err', 2600)
      return
    }
    if (typeof (window as any).MediaRecorder !== 'function') {
      deps.pluginNotice('当前环境不支持录音（缺少 MediaRecorder）', 'err', 2600)
      return
    }

    const cfg = await manualTranscribeStoreGet()
    deps.pluginNotice('请求麦克风权限…', 'ok', 1400)

    let lease: MicLease
    try {
      lease = await acquireMic('speech-transcribe')
    } catch (e) {
      const msg = String((e as any)?.message || e || '')
      const owner = getActiveMicOwner()
      if (owner === 'asr-note') {
        deps.pluginNotice('麦克风正在被“自动语音笔记”占用：请先暂停或停止后再录音', 'err', 3600)
      } else if (msg) {
        deps.pluginNotice('获取麦克风失败：' + msg, 'err', 3200)
      } else {
        deps.pluginNotice('获取麦克风失败', 'err', 3200)
      }
      return
    }

    const mimeType = pickRecorderMimeType()
    const chunks: BlobPart[] = []
    const recorder = new MediaRecorder(lease.stream, mimeType ? { mimeType } : undefined)
    recorder.addEventListener('dataavailable', (ev: any) => {
      try { if (ev?.data) chunks.push(ev.data) } catch {}
    })

    const startedAt = Date.now()
    _active = { recorder, lease, chunks, mimeType: mimeType || recorder.mimeType || 'audio/webm', startedAt }
    updateMenu()

    recorder.addEventListener('stop', () => {
      void (async () => {
        const local = _active
        try {
          _active = null
          updateMenu()
          _busy = true
          updateMenu()

          if (!local || !local.chunks.length) {
            deps.pluginNotice('录音为空（未捕获到音频数据）', 'err', 2600)
            return
          }

          const blob = new Blob(local.chunks, { type: local.mimeType })
          const name = makeRecordingFileName(local.mimeType)
          deps.pluginNotice('录音已停止：正在转写…', 'ok', 2200)
          const out = await transcribeAudioBlob(blob, name, local.mimeType)
          deps.insertAtCursor(out)
          deps.pluginNotice('转写完成', 'ok', 1600)
        } catch (e) {
          deps.pluginNotice('录音转写失败：' + String((e as any)?.message || e || ''), 'err', 3200)
        } finally {
          _busy = false
          updateMenu()
          try { local?.lease?.release?.() } catch {}
        }
      })()
    })

    recorder.addEventListener('error', (ev: any) => {
      try {
        const msg = String((ev as any)?.error?.message || (ev as any)?.message || '')
        deps.pluginNotice('录音异常中断' + (msg ? `：${msg}` : ''), 'err', 3200)
      } catch {}
      try { lease.release() } catch {}
      _active = null
      updateMenu()
    })

    recorder.start(250)
    deps.pluginNotice(`已开始录音（${manualTranscribeProviderLabel(cfg)}）。再次点击将停止并转写。`, 'ok', 2800)
  } catch (e) {
    try {
      const r = _active
      _active = null
      updateMenu()
      try { r?.lease?.release?.() } catch {}
    } catch {}
    deps.pluginNotice('录音失败：' + String((e as any)?.message || e || ''), 'err', 3200)
  }
}

async function transcribeFromAudioFileMenu(): Promise<void> {
  const deps = _deps
  if (!deps) return

  if (_busy) {
    deps.pluginNotice('正在忙：请稍候…', 'err', 1600)
    return
  }
  _busy = true
  updateMenu()
  try {
    const cfg = await manualTranscribeStoreGet()
    const providerLabel = manualTranscribeProviderLabel(cfg)
    deps.pluginNotice(`请选择音频文件（${providerLabel}）…`, 'ok', 2000)

    const sel = await open({
      multiple: false,
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'webm', 'ogg', 'opus', 'pcm', 'm4a', 'aac'] },
      ],
    } as any)
    const p = (typeof sel === 'string') ? sel : (Array.isArray(sel) ? sel[0] : '')
    if (!p) return

    const name = String(p.split(/[\\/]+/).pop() || 'audio').trim() || 'audio'
    const mimeType = guessAudioMimeType(name)
    const bytes = await readFile(p as any)
    const blob = new Blob([bytes as any], { type: mimeType })

    deps.pluginNotice('正在转写…', 'ok', 2000)
    const out = await transcribeAudioBlob(blob, name, mimeType)
    deps.insertAtCursor(out)
    deps.pluginNotice('转写完成', 'ok', 1600)
  } catch (e) {
    deps.pluginNotice('转写失败：' + String((e as any)?.message || e || ''), 'err', 3200)
  } finally {
    _busy = false
    updateMenu()
  }
}

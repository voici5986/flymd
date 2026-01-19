// 图床（S3/R2）设置对话框 UI 模块
// 从 main.ts 拆分：负责图床设置弹窗的 DOM 操作与交互逻辑

import type { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

const IMGLA_BASE_URL = 'https://www.imgla.net'

export type UploaderDialogDeps = {
  getStore(): Store | null
  showError(msg: string, err?: unknown): void
  setUploaderEnabledSnapshot(enabled: boolean): void
}

// 图床设置弹窗显隐控制
export function showUploaderOverlay(show: boolean): void {
  const overlay = document.getElementById('uploader-overlay') as HTMLDivElement | null
  if (!overlay) return
  if (show) overlay.classList.remove('hidden')
  else overlay.classList.add('hidden')
}

// 简单的连通性测试：只验证 Endpoint 可达性（不进行真实上传）
export async function testUploaderConnectivity(endpoint: string): Promise<{ ok: boolean; status: number; note: string }> {
  try {
    const ep = (endpoint || '').trim()
    if (!ep) return { ok: false, status: 0, note: '请填写 Endpoint' }
    let u: URL
    try { u = new URL(ep) } catch { return { ok: false, status: 0, note: 'Endpoint 非法 URL' } }
    const origin = u.origin
    try {
      const mod: any = await import('@tauri-apps/plugin-http')
      if (mod && typeof mod.fetch === 'function') {
        const r = await mod.fetch(origin, { method: 'HEAD' })
        const ok = r && (r.ok === true || (typeof r.status === 'number' && r.status >= 200 && r.status < 500))
        return { ok, status: (r as any)?.status ?? 0, note: ok ? '可访问' : '不可访问' }
      }
    } catch {}
    try {
      const r2 = await fetch(origin as any, { method: 'HEAD' as any, mode: 'no-cors' as any } as any)
      void r2
      return { ok: true, status: 0, note: '已发起网络请求' }
    } catch (e: any) {
      return { ok: false, status: 0, note: e?.message || '网络失败' }
    }
  } catch (e: any) {
    return { ok: false, status: 0, note: e?.message || '异常' }
  }
}

// 打开图床设置对话框：读取配置并绑定交互
export async function openUploaderDialog(deps: UploaderDialogDeps): Promise<void> {
  const overlay = document.getElementById('uploader-overlay') as HTMLDivElement | null
  const form = overlay?.querySelector('#upl-form') as HTMLFormElement | null
  if (!overlay || !form) return

  const inputProvider = overlay.querySelector('#upl-provider') as HTMLSelectElement
  const inputEnabled = overlay.querySelector('#upl-enabled') as HTMLInputElement
  const inputAlwaysLocal = overlay.querySelector('#upl-always-local') as HTMLInputElement
  const inputLocalPreferRelative = overlay.querySelector('#upl-local-prefer-relative') as HTMLInputElement
  const inputAk = overlay.querySelector('#upl-ak') as HTMLInputElement
  const inputSk = overlay.querySelector('#upl-sk') as HTMLInputElement
  const inputBucket = overlay.querySelector('#upl-bucket') as HTMLInputElement
  const inputEndpoint = overlay.querySelector('#upl-endpoint') as HTMLInputElement
  const inputRegion = overlay.querySelector('#upl-region') as HTMLInputElement
  const inputDomain = overlay.querySelector('#upl-domain') as HTMLInputElement
  const inputTpl = overlay.querySelector('#upl-template') as HTMLInputElement
  const inputPathStyle = overlay.querySelector('#upl-pathstyle') as HTMLInputElement
  const inputAcl = overlay.querySelector('#upl-acl') as HTMLInputElement
  const inputImglaBaseUrl = overlay.querySelector('#upl-imgla-baseurl') as HTMLInputElement
  const inputImglaToken = overlay.querySelector('#upl-imgla-token') as HTMLInputElement
  const selectImglaStrategy = overlay.querySelector('#upl-imgla-strategy-sel') as HTMLSelectElement
  const inputImglaStrategy = overlay.querySelector('#upl-imgla-strategy') as HTMLInputElement
  const btnImglaStrategyRefresh = overlay.querySelector('#upl-imgla-strategy-refresh') as HTMLButtonElement
  const selectImglaAlbum = overlay.querySelector('#upl-imgla-album') as HTMLSelectElement
  const btnImglaAlbumRefresh = overlay.querySelector('#upl-imgla-album-refresh') as HTMLButtonElement
  const linkImglaOpen = overlay.querySelector('#upl-imgla-open') as HTMLAnchorElement
  const inputWebpEnable = overlay.querySelector('#upl-webp-enable') as HTMLInputElement
  const inputWebpQuality = overlay.querySelector('#upl-webp-quality') as HTMLInputElement
  const labelWebpQualityVal = overlay.querySelector('#upl-webp-quality-val') as HTMLSpanElement
  const inputWebpLocal = overlay.querySelector('#upl-webp-local') as HTMLInputElement
  const btnCancel = overlay.querySelector('#upl-cancel') as HTMLButtonElement
  const btnClose = overlay.querySelector('#upl-close') as HTMLButtonElement
  const btnTest = overlay.querySelector('#upl-test') as HTMLButtonElement
  const testRes = overlay.querySelector('#upl-test-result') as HTMLDivElement

  const store = deps.getStore()

  const getProvider = (): 's3' | 'imgla' => {
    const v = String(inputProvider?.value || '').toLowerCase()
    return v === 'imgla' ? 'imgla' : 's3'
  }

  const applyProviderVisibility = () => {
    try {
      const provider = getProvider()
      const groups = overlay.querySelectorAll('.upl-group[data-upl-provider]')
      groups.forEach((el) => {
        const p = String((el as HTMLElement).getAttribute('data-upl-provider') || '').toLowerCase()
        ;(el as HTMLElement).classList.toggle('hidden', p !== provider)
      })
    } catch {}
  }

  const parseIntOr = (v: string, fallback: number) => {
    const n = parseInt(String(v || '').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  const fillSelect = (
    sel: HTMLSelectElement,
    items: Array<{ value: string; label: string }>,
    selected?: string,
  ) => {
    try {
      sel.innerHTML = ''
      for (const it of items) {
        const opt = document.createElement('option')
        opt.value = it.value
        opt.textContent = it.label
        sel.appendChild(opt)
      }
      if (selected !== undefined) sel.value = selected
    } catch {}
  }

  const refreshImglaAlbums = async () => {
    try {
      if (!selectImglaAlbum) return
      const token = String(inputImglaToken?.value || '').trim()
      if (!token) {
        fillSelect(selectImglaAlbum, [{ value: '', label: '请先填写 ImgLa 令牌' }], '')
        return
      }
      fillSelect(selectImglaAlbum, [{ value: '', label: '加载中...' }], '')
      const baseUrl = String(inputImglaBaseUrl?.value || '').trim().replace(/\/+$/, '') || IMGLA_BASE_URL
      const list: any = await invoke('flymd_imgla_list_albums', { req: { baseUrl, token } } as any)
      const albums = Array.isArray(list) ? list : []
      const opts: Array<{ value: string; label: string }> = [{ value: '', label: '全部相册' }]
      for (const a of albums) {
        const id = a && typeof a.id !== 'undefined' ? String(a.id) : ''
        const name = a && typeof a.name === 'string' ? a.name : id
        if (!id) continue
        opts.push({ value: id, label: name })
      }
      const desired = String((selectImglaAlbum as any).dataset?.desired || (selectImglaAlbum as any).value || '')
      fillSelect(selectImglaAlbum, opts, desired || '')
      try { delete (selectImglaAlbum as any).dataset.desired } catch {}
    } catch (e) {
      fillSelect(selectImglaAlbum, [{ value: '', label: '相册列表获取失败' }], '')
    }
  }

  const refreshImglaStrategies = async () => {
    try {
      if (!selectImglaStrategy) return
      const token = String(inputImglaToken?.value || '').trim()
      if (!token) {
        fillSelect(selectImglaStrategy, [{ value: '1', label: '请先填写 ImgLa 令牌' }], '1')
        return
      }
      fillSelect(selectImglaStrategy, [{ value: '1', label: '加载中...' }], '1')
      const baseUrl = String(inputImglaBaseUrl?.value || '').trim().replace(/\/+$/, '') || IMGLA_BASE_URL
      const list: any = await invoke('flymd_imgla_list_strategies', { req: { baseUrl, token } } as any)
      const strategies = Array.isArray(list) ? list : []
      try {
        console.log('[UploaderDialog] ImgLa strategies loaded', {
          count: strategies.length,
          sample: strategies[0] ? { id: strategies[0].id, name: strategies[0].name } : null,
        })
      } catch {}
      const opts: Array<{ value: string; label: string }> = []
      for (const s of strategies) {
        const id = s && typeof s.id !== 'undefined' ? String(s.id) : ''
        const name = s && typeof s.name === 'string' ? s.name : ''
        const ty = s && typeof s.type === 'string' ? s.type : ''
        const driver = s && typeof s.driver === 'string' ? s.driver : ''
        const extra = (ty || driver) ? ` [${(ty || driver)}]` : ''
        if (!id) continue
        opts.push({ value: id, label: name ? `${name}${extra} (#${id})` : `#${id}` })
      }
      // 没拿到策略时也别空着：后端会抛错，这里只是兜底
      if (opts.length === 0) opts.push({ value: '1', label: '未获取到策略列表（可手动输入右侧 ID）' })

      const desired = String((selectImglaStrategy as any).dataset?.desired || (selectImglaStrategy as any).value || '')
      const selected = desired || (opts[0]?.value || '1')
      fillSelect(selectImglaStrategy, opts, selected)
      try { delete (selectImglaStrategy as any).dataset.desired } catch {}
      // 让数字输入同步到选中的策略 id（用户仍可手动改）
      try {
        if (inputImglaStrategy && selected) inputImglaStrategy.value = String(parseIntOr(selected, 1))
      } catch {}
    } catch (e) {
      try { console.warn('[UploaderDialog] ImgLa 策略列表获取失败', e) } catch {}
      try {
        if (selectImglaStrategy) {
          fillSelect(selectImglaStrategy, [{ value: '1', label: '策略列表获取失败（仍可手动输入右侧 ID）' }], '1')
        }
      } catch {}
    }
  }

  // 预填
  try {
    if (store) {
      const up = (await store.get('uploader')) as any
      const provider = String(up?.provider || '').toLowerCase() === 'imgla' ? 'imgla' : 's3'
      if (inputProvider) inputProvider.value = provider
      inputEnabled.checked = !!up?.enabled
      inputAlwaysLocal.checked = !!up?.alwaysLocal
      if (inputLocalPreferRelative) inputLocalPreferRelative.checked = !!up?.localPreferRelative
      inputAk.value = up?.accessKeyId || ''
      inputSk.value = up?.secretAccessKey || ''
      inputBucket.value = up?.bucket || ''
      inputEndpoint.value = up?.endpoint || ''
      inputRegion.value = up?.region || ''
      inputDomain.value = up?.customDomain || ''
      inputTpl.value = up?.keyTemplate || '{year}/{month}{fileName}{md5}.{extName}'
      inputPathStyle.checked = up?.forcePathStyle !== false
      inputAcl.checked = up?.aclPublicRead !== false
      inputImglaBaseUrl.value = (up?.imglaBaseUrl || up?.baseUrl || IMGLA_BASE_URL)
      inputImglaToken.value = up?.imglaToken || up?.token || ''
      const strategyStr = String(
        (typeof up?.imglaStrategyId === 'number' ? up.imglaStrategyId : parseIntOr(String(up?.imglaStrategyId || ''), 1)) ||
          (typeof up?.strategyId === 'number' ? up.strategyId : parseIntOr(String(up?.strategyId || ''), 1)) ||
          1,
      )
      if (inputImglaStrategy) inputImglaStrategy.value = String(parseIntOr(strategyStr, 1))
      if (selectImglaStrategy) {
        ;(selectImglaStrategy as any).dataset.desired = strategyStr
        // 先塞一个占位，后续 refresh 会替换为真实列表
        fillSelect(selectImglaStrategy, [{ value: strategyStr, label: `#${strategyStr}` }], strategyStr)
      }
      const albumId = up?.imglaAlbumId ?? up?.albumId
      const albumStr = (albumId === null || albumId === undefined || albumId === '') ? '' : String(albumId)
      if (selectImglaAlbum) {
        ;(selectImglaAlbum as any).dataset.desired = albumStr
        fillSelect(selectImglaAlbum, [{ value: '', label: '全部相册' }], albumStr)
      }
      inputWebpEnable.checked = !!up?.convertToWebp
      const q = typeof up?.webpQuality === 'number' ? up.webpQuality : 0.85
      inputWebpQuality.value = String(q)
      if (labelWebpQualityVal) labelWebpQualityVal.textContent = String(Number(q).toFixed(2))
      inputWebpLocal.checked = !!up?.saveLocalAsWebp
    }
  } catch {}

  showUploaderOverlay(true)
  applyProviderVisibility()
  try { await refreshImglaStrategies() } catch {}
  try { await refreshImglaAlbums() } catch {}

  // 打开 ImgLa 官网
  try {
    if (linkImglaOpen) {
      linkImglaOpen.addEventListener('click', (ev) => {
        ev.preventDefault()
        void openUrl('https://www.imgla.net/')
      })
    }
  } catch {}

  // 开关即时生效：切换启用时立即写入（仅在必填项齐全时生效）
  try {
    const applyImmediate = async () => {
      try {
        const cfg = {
          provider: getProvider(),
          enabled: !!inputEnabled.checked,
          alwaysLocal: !!inputAlwaysLocal.checked,
          localPreferRelative: !!inputLocalPreferRelative?.checked,
          accessKeyId: inputAk.value.trim(),
          secretAccessKey: inputSk.value.trim(),
          bucket: inputBucket.value.trim(),
          endpoint: inputEndpoint.value.trim() || undefined,
          region: inputRegion.value.trim() || undefined,
          customDomain: inputDomain.value.trim() || undefined,
          keyTemplate: inputTpl.value.trim() || '{year}/{month}{fileName}{md5}.{extName}',
          forcePathStyle: !!inputPathStyle.checked,
          aclPublicRead: !!inputAcl.checked,
          imglaBaseUrl: inputImglaBaseUrl.value.trim() || '',
          imglaToken: inputImglaToken.value.trim() || '',
          imglaStrategyId: parseIntOr(inputImglaStrategy.value, 1),
          imglaAlbumId: (() => {
            const v = String(selectImglaAlbum?.value || '').trim()
            const n = parseInt(v, 10)
            return Number.isFinite(n) && n > 0 ? n : ''
          })(),
          convertToWebp: !!inputWebpEnable.checked,
          webpQuality: (() => { const n = parseFloat(inputWebpQuality.value); return Number.isFinite(n) ? n : 0.85 })(),
          saveLocalAsWebp: !!inputWebpLocal.checked,
        }
        if (cfg.enabled && !cfg.alwaysLocal) {
          if (cfg.provider === 'imgla') {
            if (!cfg.imglaToken) {
              alert('启用 ImgLa 上传需要填写令牌')
              inputEnabled.checked = false
              return
            }
          } else {
            if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
              // 直接使用 alert，避免额外依赖
              alert('启用上传需要 AccessKeyId、SecretAccessKey、Bucket')
              inputEnabled.checked = false
              return
            }
          }
        }
        if (store) {
          await store.set('uploader', cfg)
          await store.save()
          deps.setUploaderEnabledSnapshot(!!cfg.enabled)
        }
      } catch (e) {
        console.warn('即时应用图床开关失败', e)
      }
    }
    inputProvider?.addEventListener('change', () => {
      applyProviderVisibility()
      void applyImmediate()
      void refreshImglaStrategies()
      void refreshImglaAlbums()
    })
    inputEnabled.addEventListener('change', () => { void applyImmediate() })
    inputAlwaysLocal.addEventListener('change', () => { void applyImmediate() })
    inputLocalPreferRelative?.addEventListener('change', () => { void applyImmediate() })
    inputImglaToken?.addEventListener('change', () => { void applyImmediate(); void refreshImglaStrategies(); void refreshImglaAlbums() })
    inputImglaBaseUrl?.addEventListener('change', () => { void refreshImglaStrategies(); void refreshImglaAlbums() })
    // 下拉选择策略时同步数字输入，并立即保存
    selectImglaStrategy?.addEventListener('change', () => {
      try {
        const v = String(selectImglaStrategy.value || '').trim()
        if (v && inputImglaStrategy) inputImglaStrategy.value = String(parseIntOr(v, 1))
      } catch {}
      void applyImmediate()
    })
    // 手动输入策略 ID
    inputImglaStrategy?.addEventListener('change', () => { void applyImmediate() })
    selectImglaAlbum?.addEventListener('change', () => { void applyImmediate() })
    btnImglaAlbumRefresh?.addEventListener('click', (ev) => { ev.preventDefault(); void refreshImglaAlbums() })
    btnImglaStrategyRefresh?.addEventListener('click', (ev) => { ev.preventDefault(); void refreshImglaStrategies() })
    inputWebpEnable.addEventListener('change', () => { void applyImmediate() })
    inputWebpQuality.addEventListener('input', () => {
      try {
        if (labelWebpQualityVal) {
          labelWebpQualityVal.textContent = String(Number(parseFloat(inputWebpQuality.value)).toFixed(2))
        }
      } catch {}
    })
    inputWebpQuality.addEventListener('change', () => { void applyImmediate() })
    inputWebpLocal.addEventListener('change', () => { void applyImmediate() })
  } catch {}

  const onCancel = () => { showUploaderOverlay(false) }

  const onSubmit = async (e: Event) => {
    e.preventDefault()
    try {
      const cfg = {
        provider: getProvider(),
        enabled: !!inputEnabled.checked,
        alwaysLocal: !!inputAlwaysLocal.checked,
        localPreferRelative: !!inputLocalPreferRelative?.checked,
        accessKeyId: inputAk.value.trim(),
        secretAccessKey: inputSk.value.trim(),
        bucket: inputBucket.value.trim(),
        endpoint: inputEndpoint.value.trim() || undefined,
        region: inputRegion.value.trim() || undefined,
        customDomain: inputDomain.value.trim() || undefined,
        keyTemplate: inputTpl.value.trim() || '{year}/{month}{fileName}{md5}.{extName}',
        forcePathStyle: !!inputPathStyle.checked,
        aclPublicRead: !!inputAcl.checked,
        imglaToken: inputImglaToken.value.trim() || '',
        imglaStrategyId: parseIntOr(inputImglaStrategy.value, 1),
        imglaAlbumId: (() => {
          const v = String(selectImglaAlbum?.value || '').trim()
          const n = parseInt(v, 10)
          return Number.isFinite(n) && n > 0 ? n : ''
        })(),
        convertToWebp: !!inputWebpEnable.checked,
        webpQuality: (() => { const n = parseFloat(inputWebpQuality.value); return Number.isFinite(n) ? n : 0.85 })(),
        saveLocalAsWebp: !!inputWebpLocal.checked,
      }
      if (cfg.enabled && !cfg.alwaysLocal) {
        if (cfg.provider === 'imgla') {
          if (!cfg.imglaToken) {
            alert('启用 ImgLa 上传需要填写令牌')
            return
          }
        } else {
          if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
            alert('启用直传时 AccessKeyId、SecretAccessKey、Bucket 为必填')
            return
          }
        }
      }
      if (store) {
        await store.set('uploader', cfg)
        await store.save()
        deps.setUploaderEnabledSnapshot(!!cfg.enabled)
      }
      showUploaderOverlay(false)
    } catch (err) {
      deps.showError('保存图床设置失败', err)
    } finally {
      try { form.removeEventListener('submit', onSubmit) } catch {}
      try { btnCancel?.removeEventListener('click', onCancel) } catch {}
      try { btnClose?.removeEventListener('click', onCancel) } catch {}
      try { overlay.removeEventListener('click', onOverlayClick) } catch {}
      try { btnTest?.removeEventListener('click', onTestClick) } catch {}
    }
  }

  const onOverlayClick = (e: MouseEvent) => { if (e.target === overlay) onCancel() }

  const onTestClick = async (ev: MouseEvent) => {
    ev.preventDefault()
    try {
      if (!testRes) return
      const ep =
        getProvider() === 'imgla'
          ? (String(inputImglaBaseUrl?.value || '').trim().replace(/\/+$/, '') || IMGLA_BASE_URL)
          : (inputEndpoint?.value || '').trim()
      testRes.textContent = '测试中...'
      ;(testRes as any).className = ''
      testRes.id = 'upl-test-result'
      const res = await testUploaderConnectivity(ep)
      testRes.textContent = res.ok ? '可达' : '不可达'
      ;(testRes as any).className = res.ok ? 'ok' : 'err'
    } catch {
      if (testRes) {
        testRes.textContent = '测试失败'
        ;(testRes as any).className = 'err'
      }
    }
  }

  form.addEventListener('submit', onSubmit)
  btnCancel.addEventListener('click', onCancel)
  btnClose.addEventListener('click', onCancel)
  overlay.addEventListener('click', onOverlayClick)
  if (btnTest) btnTest.addEventListener('click', onTestClick)
}

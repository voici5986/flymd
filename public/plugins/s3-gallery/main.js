// 图床相册插件：浏览与管理图床图片（S3/R2 或 ImgLa）
// 设计原则：
// - 只做一件事：列出历史上传图片，提供复制链接 / 插入文档 / 删除云端对象
// - 所有 UI 用 JS/DOM 绘制，不调用原生对话框
// - 不触碰宿主逻辑，仅通过 context.invoke 与后端交互

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const S3G_LOCALE_LS_KEY = 'flymd.locale'
function s3gDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function s3gGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(S3G_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return s3gDetectLocale()
}
function s3gText(zh, en) {
  return s3gGetLocale() === 'en' ? en : zh
}

// S3/R2 本地历史分页：超过 9 条就翻页显示，避免一次性渲染太多导致 UI/预览交互不稳定
const S3G_PAGE_SIZE = 9

// 设备检测函数：支持响应式布局
function s3gIsMobile() {
  return window.innerWidth <= 576
}

function s3gIsTablet() {
  return window.innerWidth > 576 && window.innerWidth <= 768
}

function s3gGetDeviceType() {
  const width = window.innerWidth
  if (width <= 576) return 'mobile'
  if (width <= 768) return 'tablet'
  return 'desktop'
}

let _panel = null
let _listRoot = null
let _loadingEl = null
let _ctx = null
let _records = []

// 当前图床模式：'s3' | 'imgla'
let _mode = 's3'
let _controlsEl = null
let _titleEl = null
let _providerTagEl = null
let _albumSelectEl = null
let _albumRefreshBtnEl = null
let _loadMoreBtnEl = null
let _imglaPage = 1
let _imglaHasMore = true
let _imglaAlbumId = ''

// 分页状态：统一按 9 条本地分页渲染；ImgLa/Lsky 在需要时再拉下一页远端数据
let _page = 1
let _pageTotal = 1
let _pagerEl = null
let _pagePrevBtnEl = null
let _pageNextBtnEl = null
let _pageLabelEl = null

// 悬浮预览层：鼠标悬浮缩略图时展示大图，避免改动现有布局
let _previewRoot = null
let _previewImg = null
let _previewCaption = null
let _previewUrl = ''
let _previewRaf = 0
let _previewX = 0
let _previewY = 0

// 移动端全屏预览模态框
let _mobileModal = null
let _mobileModalImg = null
let _mobileModalCaption = null

// resize 监听器和防抖定时器
let _resizeHandler = null
let _resizeTimer = null

function s3gEnsurePreviewLayer() {
  if (_previewRoot && document.body.contains(_previewRoot)) return _previewRoot

  const root = document.createElement('div')
  root.id = 'flymd-s3-gallery-preview'
  root.style.position = 'fixed'
  root.style.left = '0'
  root.style.top = '0'
  root.style.zIndex = '10000'
  root.style.display = 'none'
  root.style.pointerEvents = 'none'
  root.style.background = 'rgba(0,0,0,0.78)'
  root.style.border = '1px solid rgba(255,255,255,0.10)'
  root.style.borderRadius = '10px'
  root.style.padding = '8px'
  root.style.boxShadow = '0 10px 28px rgba(0,0,0,0.45)'

  // 响应式尺寸：移动端使用更小的预览窗口
  if (s3gIsMobile()) {
    root.style.maxWidth = '85vw'
    root.style.maxHeight = '60vh'
  } else {
    root.style.maxWidth = '70vw'
    root.style.maxHeight = '70vh'
  }

  const img = document.createElement('img')
  img.style.display = 'block'
  img.style.objectFit = 'contain'
  img.style.borderRadius = '6px'

  if (s3gIsMobile()) {
    img.style.maxWidth = '85vw'
    img.style.maxHeight = '55vh'
  } else {
    img.style.maxWidth = '70vw'
    img.style.maxHeight = '65vh'
  }

  const cap = document.createElement('div')
  cap.style.marginTop = '6px'
  cap.style.fontSize = '11px'
  cap.style.opacity = '0.85'
  cap.style.whiteSpace = 'nowrap'
  cap.style.overflow = 'hidden'
  cap.style.textOverflow = 'ellipsis'

  if (s3gIsMobile()) {
    cap.style.maxWidth = '85vw'
  } else {
    cap.style.maxWidth = '70vw'
  }

  root.appendChild(img)
  root.appendChild(cap)
  document.body.appendChild(root)

  _previewRoot = root
  _previewImg = img
  _previewCaption = cap
  return root
}

function s3gHidePreview() {
  if (_previewRoot) _previewRoot.style.display = 'none'
}

function s3gSchedulePreviewPos() {
  if (!_previewRoot || _previewRoot.style.display === 'none') return
  if (_previewRaf) return
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16)
  _previewRaf = raf(() => {
    _previewRaf = 0
    s3gPositionPreview(_previewX, _previewY)
  })
}

function s3gPositionPreview(x, y) {
  if (!_previewRoot) return
  const root = _previewRoot
  const offset = 14
  const pad = 8
  const rect = root.getBoundingClientRect()

  let left = x + offset
  let top = y + offset

  const maxLeft = window.innerWidth - rect.width - pad
  const maxTop = window.innerHeight - rect.height - pad
  if (left > maxLeft) left = x - rect.width - offset
  if (top > maxTop) top = y - rect.height - offset
  if (left < pad) left = pad
  if (top < pad) top = pad

  root.style.left = `${Math.round(left)}px`
  root.style.top = `${Math.round(top)}px`
}

function s3gShowPreview(url, caption) {
  if (!url) return
  s3gEnsurePreviewLayer()
  if (!_previewRoot || !_previewImg || !_previewCaption) return

  _previewRoot.style.display = 'block'
  _previewRoot.style.visibility = 'hidden'

  if (_previewUrl !== url) {
    _previewImg.src = url
    _previewUrl = url
  }
  _previewImg.alt = caption || ''
  _previewCaption.textContent = caption || ''

  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16)
  raf(() => {
    if (!_previewRoot || _previewRoot.style.display === 'none') return
    _previewRoot.style.visibility = 'visible'
    s3gPositionPreview(_previewX, _previewY)
  })
}

// 移动端全屏预览模态框
function s3gShowMobileModal(url, caption) {
  if (!url) return

  // 创建模态框（懒加载）
  if (!_mobileModal) {
    const modal = document.createElement('div')
    modal.id = 'flymd-s3-gallery-mobile-modal'
    modal.style.position = 'fixed'
    modal.style.left = '0'
    modal.style.top = '0'
    modal.style.width = '100vw'
    modal.style.height = '100vh'
    modal.style.background = 'rgba(0,0,0,0.95)'
    modal.style.zIndex = '10001'
    modal.style.display = 'none'
    modal.style.justifyContent = 'center'
    modal.style.alignItems = 'center'
    modal.style.flexDirection = 'column'
    modal.style.padding = '16px'

    const img = document.createElement('img')
    img.style.maxWidth = '90vw'
    img.style.maxHeight = '80vh'
    img.style.objectFit = 'contain'

    const cap = document.createElement('div')
    cap.style.color = '#fff'
    cap.style.marginTop = '12px'
    cap.style.fontSize = '14px'
    cap.style.textAlign = 'center'
    cap.style.maxWidth = '90vw'
    cap.style.wordBreak = 'break-all'

    const closeBtn = document.createElement('button')
    closeBtn.textContent = '×'
    closeBtn.style.position = 'absolute'
    closeBtn.style.top = '16px'
    closeBtn.style.right = '16px'
    closeBtn.style.width = '44px'
    closeBtn.style.height = '44px'
    closeBtn.style.borderRadius = '50%'
    closeBtn.style.border = 'none'
    closeBtn.style.background = 'rgba(255,255,255,0.2)'
    closeBtn.style.color = '#fff'
    closeBtn.style.fontSize = '28px'
    closeBtn.style.cursor = 'pointer'
    closeBtn.style.lineHeight = '44px'
    closeBtn.style.textAlign = 'center'
    closeBtn.onclick = () => {
      modal.style.display = 'none'
    }

    // 点击背景关闭
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.style.display = 'none'
      }
    }

    modal.appendChild(img)
    modal.appendChild(cap)
    modal.appendChild(closeBtn)
    document.body.appendChild(modal)

    _mobileModal = modal
    _mobileModalImg = img
    _mobileModalCaption = cap
  }

  // 显示模态框
  _mobileModalImg.src = url
  _mobileModalImg.alt = caption || ''
  _mobileModalCaption.textContent = caption || ''
  _mobileModal.style.display = 'flex'
}

function s3gHideMobileModal() {
  if (_mobileModal) _mobileModal.style.display = 'none'
}

async function s3gGetUploaderRawConfig() {
  try {
    const w = typeof window !== 'undefined' ? window : null
    const fn1 = w && w.flymdGetUploaderStoreRaw
    if (typeof fn1 === 'function') return await fn1()
  } catch {}
  try {
    const w = typeof window !== 'undefined' ? window : null
    const fn2 = w && w.flymdGetUploaderRawConfig
    if (typeof fn2 === 'function') return await fn2()
  } catch {}
  return null
}

function s3gNormalizeUploader(raw) {
  const provider = raw && String(raw.provider || '').toLowerCase() === 'imgla' ? 'imgla' : 's3'
  if (provider === 'imgla') {
    return {
      provider: 'imgla',
      baseUrl: String(raw.imglaBaseUrl || raw.baseUrl || 'https://www.imgla.net').trim().replace(/\/+$/, ''),
      token: String(raw.imglaToken || raw.token || '').trim(),
      albumId: raw.imglaAlbumId != null ? raw.imglaAlbumId : raw.albumId,
    }
  }
  return { provider: 's3' }
}

function s3gProviderLabel(mode) {
  return mode === 'imgla' ? 'ImgLa' : 'S3/R2'
}

function s3gApplyModeUi(mode) {
  _mode = mode === 'imgla' ? 'imgla' : 's3'
  if (_titleEl) {
    _titleEl.textContent =
      s3gText('图床相册', 'Image Gallery') + ' · ' + s3gProviderLabel(_mode)
  }
  if (_providerTagEl) _providerTagEl.textContent = s3gText('当前：', 'Current: ') + s3gProviderLabel(_mode)
  const showAlbum = _mode === 'imgla'
  if (_albumSelectEl) _albumSelectEl.style.display = showAlbum ? 'block' : 'none'
  if (_albumRefreshBtnEl) _albumRefreshBtnEl.style.display = showAlbum ? 'block' : 'none'
  if (_loadMoreBtnEl) _loadMoreBtnEl.style.display = showAlbum ? 'block' : 'none'
  // 统一分页：两个模式都用分页条，避免一次渲染过多导致预览交互不稳定
  if (_pagerEl) _pagerEl.style.display = 'flex'
}

function s3gGetSelectedImglaAlbumId() {
  try {
    if (!_albumSelectEl) return ''
    const v = String(_albumSelectEl.value || '').trim()
    return v
  } catch {}
  return ''
}

async function s3gLoadImglaAlbums(context, cfg) {
  if (!context || !context.invoke || !_albumSelectEl) return
  const baseUrl = cfg && cfg.baseUrl ? String(cfg.baseUrl) : ''
  const token = cfg && cfg.token ? String(cfg.token) : ''
  if (!baseUrl || !token) {
    _albumSelectEl.innerHTML = ''
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = s3gText('请先在设置中填写 ImgLa 令牌', 'Please configure ImgLa token in Settings first')
    _albumSelectEl.appendChild(opt)
    return
  }
  _albumSelectEl.innerHTML = ''
  const optLoading = document.createElement('option')
  optLoading.value = ''
  optLoading.textContent = s3gText('加载相册中…', 'Loading albums…')
  _albumSelectEl.appendChild(optLoading)

  try {
    const list = await context.invoke('flymd_imgla_list_albums', { req: { baseUrl, token } })
    const albums = Array.isArray(list) ? list : []
    _albumSelectEl.innerHTML = ''
    const optAll = document.createElement('option')
    optAll.value = ''
    optAll.textContent = s3gText('全部相册', 'All albums')
    _albumSelectEl.appendChild(optAll)
    for (const a of albums) {
      if (!a) continue
      const id = a.id != null ? String(a.id) : ''
      const name = typeof a.name === 'string' ? a.name : id
      if (!id) continue
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = name || id
      _albumSelectEl.appendChild(opt)
    }

    // 默认选中：优先使用设置中的 albumId，其次用上次选择
    const stored = (() => {
      try {
        const ls = typeof localStorage !== 'undefined' ? localStorage : null
        const v = ls && ls.getItem('flymd.imgla.albumId')
        return v ? String(v) : ''
      } catch { return '' }
    })()
    const fromCfg = cfg && cfg.albumId != null ? String(cfg.albumId) : ''
    const desired = stored || fromCfg || ''
    if (desired) _albumSelectEl.value = desired
    _imglaAlbumId = s3gGetSelectedImglaAlbumId()
  } catch (e) {
    _albumSelectEl.innerHTML = ''
    const optFail = document.createElement('option')
    optFail.value = ''
    optFail.textContent = s3gText('相册列表获取失败', 'Failed to fetch albums')
    _albumSelectEl.appendChild(optFail)
  }
}

function ensurePanel(context) {
  _ctx = context
  if (_panel && document.body.contains(_panel)) return _panel

  const panel = document.createElement('div')
  panel.id = 'flymd-s3-gallery-panel'
  panel.style.position = 'fixed'
  panel.style.background = 'var(--flymd-bg, #1e1e1e)'
  panel.style.color = 'var(--flymd-fg, #eee)'
  panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)'
  panel.style.borderRadius = '10px'
  panel.style.zIndex = '9999'
  panel.style.display = 'flex'
  panel.style.flexDirection = 'column'
  panel.style.overflow = 'hidden'
  panel.style.fontSize = '13px'

  // 响应式布局：根据设备类型调整面板宽度和位置
  const deviceType = s3gGetDeviceType()
  if (deviceType === 'mobile') {
    // 移动端：几乎全屏，留 8px 边距
    panel.style.left = '8px'
    panel.style.right = '8px'
    panel.style.bottom = '8px'
    panel.style.width = 'auto'
    panel.style.maxHeight = '85vh'
  } else if (deviceType === 'tablet') {
    // 平板端：居中，90% 宽度
    panel.style.left = '5vw'
    panel.style.right = '5vw'
    panel.style.bottom = '32px'
    panel.style.width = 'auto'
    panel.style.maxHeight = '75vh'
  } else {
    // 桌面端：原始位置和宽度
    panel.style.right = '24px'
    panel.style.bottom = '32px'
    panel.style.width = '520px'
    panel.style.maxHeight = '70vh'
  }

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.padding = '8px 12px'
  header.style.borderBottom = '1px solid rgba(255,255,255,0.06)'
  header.style.background = 'rgba(0,0,0,0.25)'

  const title = document.createElement('div')
  title.textContent = s3gText('图床相册', 'Image Gallery')
  title.style.fontWeight = '600'
  _titleEl = title

  const rightBox = document.createElement('div')
  rightBox.style.display = 'flex'
  rightBox.style.alignItems = 'center'
  rightBox.style.gap = '8px'

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = s3gText('刷新', 'Refresh')
  refreshBtn.style.cursor = 'pointer'
  refreshBtn.style.border = 'none'
  refreshBtn.style.borderRadius = '4px'
  refreshBtn.style.background = '#3b82f6'
  refreshBtn.style.color = '#fff'
  // 响应式按钮尺寸
  if (s3gIsMobile()) {
    refreshBtn.style.padding = '6px 12px'
    refreshBtn.style.fontSize = '13px'
  } else {
    refreshBtn.style.padding = '2px 10px'
    refreshBtn.style.fontSize = '12px'
  }
  refreshBtn.onclick = () => {
    void refreshList(_ctx)
  }

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cursor = 'pointer'
  closeBtn.style.border = 'none'
  closeBtn.style.borderRadius = '4px'
  closeBtn.style.textAlign = 'center'
  closeBtn.style.background = 'transparent'
  closeBtn.style.color = 'inherit'
  // 响应式按钮尺寸
  if (s3gIsMobile()) {
    closeBtn.style.width = '32px'
    closeBtn.style.height = '32px'
    closeBtn.style.fontSize = '20px'
    closeBtn.style.lineHeight = '32px'
  } else {
    closeBtn.style.width = '24px'
    closeBtn.style.height = '24px'
    closeBtn.style.fontSize = '16px'
    closeBtn.style.lineHeight = '22px'
  }
  closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(255,255,255,0.1)' }
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'transparent' }
  closeBtn.onclick = () => {
    s3gHidePreview()
    panel.style.display = 'none'
  }

  rightBox.appendChild(refreshBtn)
  rightBox.appendChild(closeBtn)
  header.appendChild(title)
  header.appendChild(rightBox)

  const body = document.createElement('div')
  body.style.flex = '1'
  body.style.display = 'flex'
  body.style.flexDirection = 'column'
  body.style.padding = '8px 12px'
  body.style.overflow = 'hidden'

  const controls = document.createElement('div')
  controls.style.display = 'flex'
  controls.style.gap = '8px'
  controls.style.marginBottom = '6px'
  // 响应式布局：移动端垂直堆叠
  if (s3gIsMobile()) {
    controls.style.flexDirection = 'column'
    controls.style.alignItems = 'stretch'
  } else {
    controls.style.flexDirection = 'row'
    controls.style.alignItems = 'center'
  }

  const providerTag = document.createElement('div')
  providerTag.style.fontSize = '11px'
  providerTag.style.opacity = '0.8'
  // 响应式文本换行
  if (s3gIsMobile()) {
    providerTag.style.whiteSpace = 'normal'
    providerTag.style.marginBottom = '4px'
  } else {
    providerTag.style.whiteSpace = 'nowrap'
  }
  _providerTagEl = providerTag

  const albumSelect = document.createElement('select')
  albumSelect.style.minWidth = '0'
  albumSelect.style.borderRadius = '6px'
  albumSelect.style.border = '1px solid rgba(255,255,255,0.12)'
  albumSelect.style.background = 'rgba(0,0,0,0.2)'
  albumSelect.style.color = 'inherit'
  albumSelect.style.fontSize = '12px'
  // 响应式宽度和 padding
  if (s3gIsMobile()) {
    albumSelect.style.width = '100%'
    albumSelect.style.padding = '8px'
  } else {
    albumSelect.style.flex = '1'
    albumSelect.style.padding = '4px 8px'
  }
  albumSelect.onchange = () => {
    _imglaAlbumId = s3gGetSelectedImglaAlbumId()
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage : null
      if (ls) ls.setItem('flymd.imgla.albumId', _imglaAlbumId || '')
    } catch {}
    _page = 1
    _imglaPage = 1
    _imglaHasMore = true
    void refreshList(_ctx)
  }
  _albumSelectEl = albumSelect

  const albumRefreshBtn = document.createElement('button')
  albumRefreshBtn.textContent = s3gText('刷新相册', 'Refresh albums')
  albumRefreshBtn.style.cursor = 'pointer'
  albumRefreshBtn.style.border = '1px solid rgba(255,255,255,0.12)'
  albumRefreshBtn.style.borderRadius = '6px'
  albumRefreshBtn.style.background = 'rgba(0,0,0,0.2)'
  albumRefreshBtn.style.color = 'inherit'
  albumRefreshBtn.style.fontSize = '12px'
  // 响应式宽度和 padding
  if (s3gIsMobile()) {
    albumRefreshBtn.style.width = '100%'
    albumRefreshBtn.style.padding = '8px 10px'
  } else {
    albumRefreshBtn.style.padding = '4px 10px'
  }
  albumRefreshBtn.onclick = () => {
    _page = 1
    _imglaPage = 1
    _imglaHasMore = true
    void refreshList(_ctx)
  }
  _albumRefreshBtnEl = albumRefreshBtn

  controls.appendChild(providerTag)
  controls.appendChild(albumSelect)
  controls.appendChild(albumRefreshBtn)
  _controlsEl = controls

  const hint = document.createElement('div')
  hint.textContent = s3gText(
    '相册：S3/R2 显示本机上传历史；ImgLa 显示所选相册内的远端图片。删除会尝试从云端删除对象，请谨慎使用。',
    'Gallery: S3/R2 shows local upload history; ImgLa shows remote images in the selected album. Deletion removes remote objects; use with caution.',
  )
  hint.style.fontSize = '11px'
  hint.style.opacity = '0.75'
  hint.style.marginBottom = '6px'

  const loading = document.createElement('div')
  loading.textContent = s3gText('加载中…', 'Loading…')
  loading.style.fontSize = '12px'
  loading.style.marginBottom = '6px'
  loading.style.display = 'none'
  _loadingEl = loading

  const listRoot = document.createElement('div')
  listRoot.style.flex = '1'
  listRoot.style.overflow = 'auto'
  listRoot.style.display = 'grid'
  listRoot.style.paddingBottom = '4px'
  // 响应式网格：移动端使用更小的列宽
  if (s3gIsMobile()) {
    listRoot.style.gridTemplateColumns = 'repeat(auto-fill, minmax(135px, 1fr))'
    listRoot.style.gridGap = '6px'
  } else {
    listRoot.style.gridTemplateColumns = 'repeat(auto-fill, minmax(150px, 1fr))'
    listRoot.style.gridGap = '8px'
  }
  _listRoot = listRoot

  const footer = document.createElement('div')
  footer.style.display = 'flex'
  footer.style.justifyContent = 'center'
  footer.style.padding = '6px 0 2px 0'

  // 分页条：统一按 9 条本地分页渲染；ImgLa/Lsky 在需要时再拉下一页远端数据
  const pager = document.createElement('div')
  pager.style.display = 'none'
  pager.style.alignItems = 'center'
  pager.style.gap = '8px'
  pager.style.width = '100%'
  pager.style.justifyContent = 'center'
  _pagerEl = pager

  const prevBtn = document.createElement('button')
  prevBtn.textContent = s3gText('上一页', 'Prev')
  prevBtn.style.cursor = 'pointer'
  prevBtn.style.border = '1px solid rgba(255,255,255,0.12)'
  prevBtn.style.borderRadius = '6px'
  prevBtn.style.padding = '4px 10px'
  prevBtn.style.background = 'rgba(0,0,0,0.2)'
  prevBtn.style.color = 'inherit'
  prevBtn.style.fontSize = '12px'
  prevBtn.onclick = () => {
    s3gHidePreview()
    if (_page <= 1) return
    _page = _page - 1
    renderList(_records)
  }
  _pagePrevBtnEl = prevBtn

  const pageLabel = document.createElement('div')
  pageLabel.style.fontSize = '12px'
  pageLabel.style.opacity = '0.85'
  pageLabel.style.whiteSpace = 'nowrap'
  _pageLabelEl = pageLabel

  const nextBtn = document.createElement('button')
  nextBtn.textContent = s3gText('下一页', 'Next')
  nextBtn.style.cursor = 'pointer'
  nextBtn.style.border = '1px solid rgba(255,255,255,0.12)'
  nextBtn.style.borderRadius = '6px'
  nextBtn.style.padding = '4px 10px'
  nextBtn.style.background = 'rgba(0,0,0,0.2)'
  nextBtn.style.color = 'inherit'
  nextBtn.style.fontSize = '12px'
  nextBtn.onclick = () => {
    void s3gNextPage(_ctx)
  }
  _pageNextBtnEl = nextBtn

  pager.appendChild(prevBtn)
  pager.appendChild(pageLabel)
  pager.appendChild(nextBtn)
  footer.appendChild(pager)

  const loadMoreBtn = document.createElement('button')
  loadMoreBtn.textContent = s3gText('加载更多', 'Load more')
  loadMoreBtn.style.cursor = 'pointer'
  loadMoreBtn.style.border = '1px solid rgba(255,255,255,0.12)'
  loadMoreBtn.style.borderRadius = '6px'
  loadMoreBtn.style.padding = '4px 10px'
  loadMoreBtn.style.background = 'rgba(0,0,0,0.2)'
  loadMoreBtn.style.color = 'inherit'
  loadMoreBtn.style.fontSize = '12px'
  loadMoreBtn.onclick = () => { void loadMoreImgla(_ctx) }
  _loadMoreBtnEl = loadMoreBtn
  footer.appendChild(loadMoreBtn)

  body.appendChild(controls)
  body.appendChild(hint)
  body.appendChild(loading)
  body.appendChild(listRoot)
  body.appendChild(footer)

  panel.appendChild(header)
  panel.appendChild(body)

  document.body.appendChild(panel)
  _panel = panel
  try { s3gApplyModeUi(_mode) } catch {}

  // 添加 resize 监听器：支持横竖屏切换和窗口缩放
  if (!_resizeHandler) {
    _resizeHandler = () => {
      if (_resizeTimer) clearTimeout(_resizeTimer)
      _resizeTimer = setTimeout(() => {
        if (_panel && _panel.style.display !== 'none') {
          const deviceType = s3gGetDeviceType()

          // 重新应用面板样式
          if (deviceType === 'mobile') {
            _panel.style.left = '8px'
            _panel.style.right = '8px'
            _panel.style.bottom = '8px'
            _panel.style.width = 'auto'
            _panel.style.maxHeight = '85vh'
          } else if (deviceType === 'tablet') {
            _panel.style.left = '5vw'
            _panel.style.right = '5vw'
            _panel.style.bottom = '32px'
            _panel.style.width = 'auto'
            _panel.style.maxHeight = '75vh'
          } else {
            _panel.style.right = '24px'
            _panel.style.bottom = '32px'
            _panel.style.left = 'auto'
            _panel.style.width = '520px'
            _panel.style.maxHeight = '70vh'
          }

          // 重新渲染列表以更新按钮样式和网格布局
          if (_records && _records.length > 0) {
            renderList(_records)
          }
        }
      }, 150)
    }
    window.addEventListener('resize', _resizeHandler)
  }

  return panel
}

function s3gUpdatePager(totalCount) {
  if (!_pagerEl || !_pageLabelEl || !_pagePrevBtnEl || !_pageNextBtnEl) return
  const total = typeof totalCount === 'number' && totalCount > 0 ? totalCount : 0
  const pages = Math.max(1, Math.ceil(total / S3G_PAGE_SIZE))
  _pageTotal = pages
  if (_page < 1) _page = 1
  if (_page > pages) _page = pages

  const show = pages > 1 || (_mode === 'imgla' && (_imglaHasMore || _page > 1))
  _pagerEl.style.display = show ? 'flex' : 'none'

  _pageLabelEl.textContent =
    pages > 1
      ? s3gText('第 ', 'Page ') + String(_page) + s3gText(' / ', ' / ') + String(pages)
      : s3gText('第 ', 'Page ') + String(_page)

  _pagePrevBtnEl.disabled = _page <= 1
  const canNext = _page < pages || (_mode === 'imgla' && _imglaHasMore)
  _pageNextBtnEl.disabled = !canNext

  if (_loadMoreBtnEl) {
    _loadMoreBtnEl.disabled = !(_mode === 'imgla' && _imglaHasMore)
  }
}

function renderList(records) {
  if (!_listRoot) return
  _listRoot.innerHTML = ''
  _records = Array.isArray(records) ? records.slice() : []
  s3gUpdatePager(_records.length)

  if (!_records.length) {
    const empty = document.createElement('div')
    empty.textContent = s3gText('暂无上传记录', 'No uploaded images found')
    empty.style.fontSize = '12px'
    empty.style.opacity = '0.7'
    empty.style.padding = '16px 4px'
    _listRoot.appendChild(empty)
    return
  }

  // 超过 9 条就只渲染当前页，避免一次渲染过多导致预览交互不稳定
  const view = (_records.length > S3G_PAGE_SIZE)
    ? _records.slice((_page - 1) * S3G_PAGE_SIZE, _page * S3G_PAGE_SIZE)
    : _records

  for (const rec of view) {
    const card = document.createElement('div')
    card.style.borderRadius = '6px'
    card.style.border = '1px solid rgba(255,255,255,0.06)'
    card.style.background = 'rgba(0,0,0,0.2)'
    card.style.display = 'flex'
    card.style.flexDirection = 'column'
    card.style.overflow = 'hidden'

    const thumbBox = document.createElement('div')
    thumbBox.style.width = '100%'
    thumbBox.style.height = '90px'
    thumbBox.style.background = '#111'
    thumbBox.style.display = 'flex'
    thumbBox.style.alignItems = 'center'
    thumbBox.style.justifyContent = 'center'
    thumbBox.style.overflow = 'hidden'

    const url = rec.public_url || rec.publicUrl || ''
    if (url) {
      const img = document.createElement('img')
      img.src = url
      img.alt = rec.file_name || rec.key || ''
      img.style.maxWidth = '100%'
      img.style.maxHeight = '100%'
      img.style.objectFit = 'contain'
      thumbBox.appendChild(img)

      // 预览功能：移动端点击显示模态框，桌面端悬浮预览
      thumbBox.style.cursor = 'zoom-in'
      if (s3gIsMobile()) {
        // 移动端：点击显示全屏模态框
        thumbBox.onclick = () => {
          s3gShowMobileModal(url, img.alt || '')
        }
      } else {
        // 桌面端：悬浮预览
        thumbBox.onmouseenter = (ev) => {
          _previewX = ev && typeof ev.clientX === 'number' ? ev.clientX : 0
          _previewY = ev && typeof ev.clientY === 'number' ? ev.clientY : 0
          s3gShowPreview(url, img.alt || '')
        }
        thumbBox.onmousemove = (ev) => {
          _previewX = ev && typeof ev.clientX === 'number' ? ev.clientX : _previewX
          _previewY = ev && typeof ev.clientY === 'number' ? ev.clientY : _previewY
          s3gSchedulePreviewPos()
        }
        thumbBox.onmouseleave = () => {
          s3gHidePreview()
        }
      }
    } else {
      const span = document.createElement('span')
      span.textContent = '无预览'
      span.style.fontSize = '11px'
      span.style.opacity = '0.7'
      thumbBox.appendChild(span)
    }

    const meta = document.createElement('div')
    meta.style.padding = '6px 8px'
    meta.style.flex = '1'

    const name = document.createElement('div')
    name.textContent = rec.file_name || (rec.key || '').split('/').pop() || '(未命名)'
    name.style.fontSize = '12px'
    name.style.marginBottom = '4px'

    const time = document.createElement('div')
    time.style.fontSize = '11px'
    time.style.opacity = '0.7'
    const t = rec.uploaded_at || rec.uploadedAt || ''
    if (t) {
      const d = new Date(t)
      if (!isNaN(d.getTime())) {
        const yy = d.getFullYear()
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        const hh = String(d.getHours()).padStart(2, '0')
        const mi = String(d.getMinutes()).padStart(2, '0')
        time.textContent = `${yy}-${mm}-${dd} ${hh}:${mi}`
      } else {
        time.textContent = t
      }
    } else {
      time.textContent = '(未知时间)'
    }

    const sizeLine = document.createElement('div')
    sizeLine.style.fontSize = '11px'
    sizeLine.style.opacity = '0.7'
    const kb = typeof rec.size === 'number' && rec.size > 0 ? (rec.size / 1024).toFixed(1) + ' KB' : ''
    const bucket = rec.bucket || ''
    sizeLine.textContent = [bucket, kb].filter(Boolean).join(' · ')

    meta.appendChild(name)
    meta.appendChild(time)
    if (bucket || kb) meta.appendChild(sizeLine)

    const actions = document.createElement('div')
    actions.style.display = 'flex'
    actions.style.justifyContent = 'space-between'
    actions.style.gap = '4px'
    actions.style.padding = '4px 8px 6px 8px'
    actions.style.borderTop = '1px solid rgba(255,255,255,0.06)'

    const btnCopy = document.createElement('button')
    btnCopy.textContent = '复制链接'
    styleActionButton(btnCopy)
    btnCopy.onclick = () => { void copyUrl(url) }

    const btnInsert = document.createElement('button')
    btnInsert.textContent = '插入到文档'
    styleActionButton(btnInsert)
    btnInsert.onclick = () => {
      const alt = rec.file_name || (rec.key || '').split('/').pop() || 'image'
      if (url && _ctx && _ctx.insertAtCursor) {
        _ctx.insertAtCursor(`![${alt}](${url})`)
        _ctx.ui && _ctx.ui.notice && _ctx.ui.notice('已插入图床图片链接', 'ok', 2000)
      }
    }

    const btnDelete = document.createElement('button')
    btnDelete.textContent = '删除'
    styleActionButton(btnDelete)
    btnDelete.style.background = '#dc2626'
    btnDelete.onclick = () => { void deleteRecord(_ctx, rec) }

    actions.appendChild(btnCopy)
    actions.appendChild(btnInsert)
    actions.appendChild(btnDelete)

    card.appendChild(thumbBox)
    card.appendChild(meta)
    card.appendChild(actions)
    _listRoot.appendChild(card)
  }
}

function styleActionButton(btn) {
  btn.style.flex = '1'
  btn.style.border = 'none'
  btn.style.borderRadius = '4px'
  btn.style.cursor = 'pointer'
  btn.style.background = '#374151'
  btn.style.color = '#f9fafb'
  // 响应式按钮尺寸：移动端更大的触摸目标
  if (s3gIsMobile()) {
    btn.style.padding = '8px 6px'
    btn.style.fontSize = '12px'
  } else {
    btn.style.padding = '3px 4px'
    btn.style.fontSize = '11px'
  }
}

async function copyUrl(url) {
  if (!url) return
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(String(url))
    } else {
      const ta = document.createElement('textarea')
      ta.value = String(url)
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    _ctx &&
      _ctx.ui &&
      _ctx.ui.notice &&
      _ctx.ui.notice(
        s3gText('链接已复制到剪贴板', 'Link copied to clipboard'),
        'ok',
        1800,
      )
  } catch (e) {
    console.warn('[s3-gallery] 复制链接失败', e)
    _ctx &&
      _ctx.ui &&
      _ctx.ui.notice &&
      _ctx.ui.notice(
        s3gText('复制链接失败', 'Failed to copy link'),
        'err',
        2200,
      )
  }
}

function s3gMergeUniqueRecords(prev, next) {
  const a = Array.isArray(prev) ? prev : []
  const b = Array.isArray(next) ? next : []
  if (!a.length) return b.slice()
  if (!b.length) return a.slice()
  const seen = new Set()
  for (const r of a) {
    if (!r) continue
    const id = r.id != null ? String(r.id) : ''
    if (id) seen.add(id)
  }
  const out = a.slice()
  for (const r of b) {
    if (!r) continue
    const id = r.id != null ? String(r.id) : ''
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    out.push(r)
  }
  return out
}

async function loadMoreImgla(context, opts) {
  if (_mode !== 'imgla') return 0
  if (!context || !context.invoke) return 0
  if (!_imglaHasMore) return 0

  const noRender = !!(opts && opts.noRender)
  const manageLoading = !(opts && opts.keepLoading)
  if (manageLoading && _loadingEl) _loadingEl.style.display = 'block'

  try {
    const raw = await s3gGetUploaderRawConfig()
    const cfg = s3gNormalizeUploader(raw || {})
    const baseUrl = String(cfg.baseUrl || '').trim()
    const token = String(cfg.token || '').trim()
    if (!baseUrl || !token) return 0

    const nextRemotePage = (_imglaPage || 1) + 1
    const albumIdStr = s3gGetSelectedImglaAlbumId()
    const albumNum = albumIdStr ? parseInt(albumIdStr, 10) : 0
    const list = await context.invoke('flymd_imgla_list_images', {
      req: {
        baseUrl,
        token,
        albumId: albumNum > 0 ? albumNum : undefined,
        page: nextRemotePage,
      },
    })
    const arr = Array.isArray(list) ? list : []
    if (!arr.length) {
      _imglaHasMore = false
      if (!noRender) renderList(_records)
      context.ui &&
        context.ui.notice &&
        context.ui.notice(s3gText('没有更多图片了', 'No more images'), 'ok', 1600)
      return 0
    }

    _imglaPage = nextRemotePage
    const before = Array.isArray(_records) ? _records.length : 0
    _records = s3gMergeUniqueRecords(_records, arr)
    const added = Math.max(0, _records.length - before)
    if (!noRender) renderList(_records)
    return added
  } catch (e) {
    console.warn('[s3-gallery] 加载更多失败', e)
    const msg = e && e.message ? String(e.message) : String(e || '未知错误')
    context.ui &&
      context.ui.notice &&
      context.ui.notice(s3gText('加载更多失败：', 'Load more failed: ') + msg, 'err', 2200)
    return 0
  } finally {
    if (manageLoading && _loadingEl) _loadingEl.style.display = 'none'
  }
}

async function s3gNextPage(context) {
  s3gHidePreview()
  if (_page < (_pageTotal || 1)) {
    _page = _page + 1
    renderList(_records)
    return
  }
  if (_mode !== 'imgla') return
  if (!_imglaHasMore) return
  const added = await loadMoreImgla(context, { noRender: true, keepLoading: true })
  if (added > 0) {
    _page = _page + 1
  }
  renderList(_records)
}

async function refreshList(context) {
  if (!context || !context.invoke) return
  if (_loadingEl) _loadingEl.style.display = 'block'
  try {
    const raw = await s3gGetUploaderRawConfig()
    const cfg = s3gNormalizeUploader(raw || {})
    s3gApplyModeUi(cfg.provider)

    if (cfg.provider === 'imgla') {
      const baseUrl = String(cfg.baseUrl || '').trim()
      const token = String(cfg.token || '').trim()
      if (!baseUrl || !token) {
        renderList([])
        context.ui &&
          context.ui.notice &&
          context.ui.notice(
            s3gText('未配置 ImgLa 图床：请先在设置中填写令牌', 'ImgLa is not configured: please set token in Settings'),
            'err',
            2800,
          )
        return
      }

      _page = 1
      _imglaPage = 1
      _imglaHasMore = true
      await s3gLoadImglaAlbums(context, cfg)
      _imglaAlbumId = s3gGetSelectedImglaAlbumId()
      const albumNum = _imglaAlbumId ? parseInt(_imglaAlbumId, 10) : 0
      const list = await context.invoke('flymd_imgla_list_images', {
        req: {
          baseUrl,
          token,
          albumId: albumNum > 0 ? albumNum : undefined,
          page: 1,
        },
      })
      const arr = Array.isArray(list) ? list : []
      if (!arr.length) _imglaHasMore = false
      renderList(arr)
      return
    }

    const list = await context.invoke('flymd_list_uploaded_images')
    if (Array.isArray(list)) {
      // S3/R2：每次刷新回到第一页（避免删除/新增导致页码越界）
      _page = 1
      // 兼容：若历史中包含 ImgLa 记录（bucket/provider），在 S3/R2 模式下不显示
      const filtered = list.filter((r) => {
        try {
          const p = r && r.provider ? String(r.provider) : ''
          if (p && p.toLowerCase() === 'imgla') return false
          const b = r && r.bucket ? String(r.bucket) : ''
          if (b === 'imgla') return false
        } catch {}
        return true
      })
      renderList(filtered)
    } else {
      renderList([])
      context.ui &&
        context.ui.notice &&
        context.ui.notice(
          s3gText('图床相册：后端未返回列表', 'Gallery: backend did not return a list'),
          'err',
          2400,
        )
    }
  } catch (e) {
    console.error('[s3-gallery] 刷新失败', e)
    renderList([])
    const msg = e && e.message ? String(e.message) : String(e || '未知错误')
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText('刷新失败：', 'Refresh failed: ') +
          msg,
        'err',
        2800,
      )
  } finally {
    if (_loadingEl) _loadingEl.style.display = 'none'
  }
}

async function deleteRecord(context, rec) {
  if (!context || !rec) return

  const isImgLa = (() => {
    try {
      const p = rec && rec.provider ? String(rec.provider).toLowerCase() : ''
      if (p === 'imgla') return true
      const b = rec && rec.bucket ? String(rec.bucket) : ''
      if (b === 'imgla') return true
      if (_mode === 'imgla') return true
    } catch {}
    return false
  })()

  try {
    const ok = await context.ui.confirm(
      s3gText(
        isImgLa
          ? '确定要删除这张图片吗？此操作会从 ImgLa 中删除图片，且可能导致已有文档中的链接失效。'
          : '确定要删除这张图片吗？此操作会从 S3/R2 中删除对象，且可能导致已有文档中的链接失效。',
        isImgLa
          ? 'Are you sure you want to delete this image? This will delete it from ImgLa and may break links in existing documents.'
          : 'Are you sure you want to delete this image? This will delete the object from S3/R2 and may break links in existing documents.',
      ),
    )
    if (!ok) return
  } catch {
    // confirm 不可用时，不做删除，避免误删
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText(
          '当前环境不支持确认对话框，已取消删除操作',
          'Confirm dialog not supported in current environment, deletion cancelled',
        ),
        'err',
        2600,
      )
    return
  }

  const raw = await s3gGetUploaderRawConfig()

  if (isImgLa) {
    const cfg = s3gNormalizeUploader(raw || {})
    const baseUrl = String(cfg.baseUrl || '').trim()
    const token = String(cfg.token || '').trim()
    const remoteKey = (() => {
      try {
        const k = rec.remote_key || rec.remoteKey || rec.key
        const n = typeof k === 'number' ? k : parseInt(String(k || ''), 10)
        return Number.isFinite(n) ? n : 0
      } catch { return 0 }
    })()
    if (!baseUrl || !token || !remoteKey) {
      context.ui &&
        context.ui.notice &&
        context.ui.notice(
          s3gText('未配置 ImgLa 图床或图片 key 无效，无法删除', 'ImgLa not configured or invalid image key, cannot delete'),
          'err',
          3200,
        )
      return
    }
    try {
      await context.invoke('flymd_imgla_delete_image', {
        req: { baseUrl, token, key: remoteKey },
      })
      context.ui &&
        context.ui.notice &&
        context.ui.notice(
          s3gText('已从 ImgLa 删除图片', 'Image deleted from ImgLa'),
          'ok',
          2200,
        )
      s3gHidePreview()
      _records = _records.filter((r) => {
        const rk = r && (r.remote_key || r.remoteKey || 0)
        const n = typeof rk === 'number' ? rk : parseInt(String(rk || ''), 10)
        return n !== remoteKey
      })
      const pages = Math.max(1, Math.ceil((_records.length || 0) / S3G_PAGE_SIZE))
      if (_page > pages) _page = pages
      renderList(_records)
    } catch (e) {
      console.error('[s3-gallery] 删除 ImgLa 图片失败', e)
      const msg = e && e.message ? String(e.message) : String(e || '未知错误')
      context.ui &&
        context.ui.notice &&
        context.ui.notice(
          s3gText('删除远端图片失败：', 'Failed to delete remote image: ') + msg,
          'err',
          3200,
        )
    }
    return
  }

  // S3/R2 删除：需要 accessKey/secret/bucket
  const cfg = raw || null
  const ak = cfg && cfg.accessKeyId ? String(cfg.accessKeyId) : ''
  const sk = cfg && cfg.secretAccessKey ? String(cfg.secretAccessKey) : ''
  const bucket0 = cfg && cfg.bucket ? String(cfg.bucket) : ''
  if (!ak || !sk || !bucket0) {
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText('尚未在宿主中配置内置图床，无法执行远端删除', 'Built-in image host is not configured in the host, cannot delete remote images'),
        'err',
        3200,
      )
    return
  }

  const endpoint = (cfg && cfg.endpoint) ? cfg.endpoint : null
  const region = (cfg && cfg.region) ? cfg.region : null
  const forcePathStyle = !(cfg && cfg.forcePathStyle === false)
  const customDomain = (cfg && cfg.customDomain) ? cfg.customDomain : null

  try {
    await context.invoke('flymd_delete_uploaded_image', {
      req: {
        accessKeyId: ak,
        secretAccessKey: sk,
        bucket: rec.bucket || bucket0,
        region,
        endpoint,
        forcePathStyle,
        customDomain,
        key: rec.key,
      },
    })
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText('已从 S3/R2 删除图片', 'Image deleted from S3/R2'),
        'ok',
        2200,
      )
    // 从当前列表中移除并重绘
    const key = rec.key
    const bucket = rec.bucket
    _records = _records.filter((r) => !(r.key === key && r.bucket === bucket))
    renderList(_records)
  } catch (e) {
    console.error('[s3-gallery] 删除远端图片失败', e)
    const msg = e && e.message ? String(e.message) : String(e || '未知错误')
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText('删除远端图片失败：', 'Failed to delete remote image: ') +
          msg,
        'err',
        3200,
      )
  }
}

export async function activate(context) {
  // 插件激活时只挂菜单，不做其他副作用
  _ctx = context
  context.addMenuItem({
    label: s3gText('图床相册', 'Image Gallery'),
    title: s3gText('查看并管理图床图片（S3/R2 或 ImgLa）', 'Browse and manage images from S3/R2 or ImgLa'),
    onClick: async () => {
      const panel = ensurePanel(context)
      panel.style.display = 'flex'
      await refreshList(context)
    },
  })
}

export function deactivate() {
  // 清理面板，避免多次挂载
  try {
    if (_panel && _panel.parentElement) {
      _panel.parentElement.removeChild(_panel)
    }
  } catch {}
  try {
    if (_previewRoot && _previewRoot.parentElement) {
      _previewRoot.parentElement.removeChild(_previewRoot)
    }
  } catch {}
  // 清理移动端模态框
  try {
    if (_mobileModal && _mobileModal.parentElement) {
      _mobileModal.parentElement.removeChild(_mobileModal)
    }
  } catch {}
  // 移除 resize 监听器
  try {
    if (_resizeHandler) {
      window.removeEventListener('resize', _resizeHandler)
    }
    if (_resizeTimer) {
      clearTimeout(_resizeTimer)
    }
  } catch {}

  _panel = null
  _listRoot = null
  _loadingEl = null
  _records = []
  _controlsEl = null
  _titleEl = null
  _providerTagEl = null
  _albumSelectEl = null
  _albumRefreshBtnEl = null
  _loadMoreBtnEl = null
  _imglaPage = 1
  _imglaHasMore = true
  _imglaAlbumId = ''
  _page = 1
  _pageTotal = 1
  _pagerEl = null
  _pagePrevBtnEl = null
  _pageNextBtnEl = null
  _pageLabelEl = null
  _previewRoot = null
  _previewImg = null
  _previewCaption = null
  _previewUrl = ''
  _previewRaf = 0
  _mobileModal = null
  _mobileModalImg = null
  _mobileModalCaption = null
  _resizeHandler = null
  _resizeTimer = null
}

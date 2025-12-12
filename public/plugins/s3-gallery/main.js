// S3 图床相册插件：浏览与管理通过内置 S3/R2 图床上传的图片
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

let _panel = null
let _listRoot = null
let _loadingEl = null
let _ctx = null
let _records = []

function ensurePanel(context) {
  _ctx = context
  if (_panel && document.body.contains(_panel)) return _panel

  const panel = document.createElement('div')
  panel.id = 'flymd-s3-gallery-panel'
  panel.style.position = 'fixed'
  panel.style.right = '24px'
  panel.style.bottom = '32px'
  panel.style.width = '520px'
  panel.style.maxHeight = '70vh'
  panel.style.background = 'var(--flymd-bg, #1e1e1e)'
  panel.style.color = 'var(--flymd-fg, #eee)'
  panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)'
  panel.style.borderRadius = '10px'
  panel.style.zIndex = '9999'
  panel.style.display = 'flex'
  panel.style.flexDirection = 'column'
  panel.style.overflow = 'hidden'
  panel.style.fontSize = '13px'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.padding = '8px 12px'
  header.style.borderBottom = '1px solid rgba(255,255,255,0.06)'
  header.style.background = 'rgba(0,0,0,0.25)'

  const title = document.createElement('div')
  title.textContent = s3gText('S3 图床相册', 'S3 Image Gallery')
  title.style.fontWeight = '600'

  const rightBox = document.createElement('div')
  rightBox.style.display = 'flex'
  rightBox.style.alignItems = 'center'
  rightBox.style.gap = '8px'

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = s3gText('刷新', 'Refresh')
  refreshBtn.style.cursor = 'pointer'
  refreshBtn.style.border = 'none'
  refreshBtn.style.borderRadius = '4px'
  refreshBtn.style.padding = '2px 10px'
  refreshBtn.style.background = '#3b82f6'
  refreshBtn.style.color = '#fff'
  refreshBtn.style.fontSize = '12px'
  refreshBtn.onclick = () => {
    void refreshList(_ctx)
  }

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cursor = 'pointer'
  closeBtn.style.border = 'none'
  closeBtn.style.borderRadius = '4px'
  closeBtn.style.width = '24px'
  closeBtn.style.height = '24px'
  closeBtn.style.fontSize = '16px'
  closeBtn.style.lineHeight = '22px'
  closeBtn.style.textAlign = 'center'
  closeBtn.style.background = 'transparent'
  closeBtn.style.color = 'inherit'
  closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(255,255,255,0.1)' }
  closeBtn.onmouseleave = () => { closeBtn.style.background = 'transparent' }
  closeBtn.onclick = () => {
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

  const hint = document.createElement('div')
  hint.textContent = s3gText(
    '仅展示通过内置 S3/R2 图床成功上传的图片。删除操作会尝试从云端删除对象，请谨慎使用。',
    'Only shows images successfully uploaded via the built-in S3/R2 image host. Deletion will attempt to remove objects from the cloud; use with caution.',
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
  listRoot.style.gridTemplateColumns = 'repeat(auto-fill, minmax(150px, 1fr))'
  listRoot.style.gridGap = '8px'
  listRoot.style.paddingBottom = '4px'
  _listRoot = listRoot

  body.appendChild(hint)
  body.appendChild(loading)
  body.appendChild(listRoot)

  panel.appendChild(header)
  panel.appendChild(body)

  document.body.appendChild(panel)
  _panel = panel
  return panel
}

function renderList(records) {
  if (!_listRoot) return
  _listRoot.innerHTML = ''
  _records = Array.isArray(records) ? records.slice() : []

  if (!_records.length) {
    const empty = document.createElement('div')
    empty.textContent = s3gText('暂无上传记录', 'No uploaded images found')
    empty.style.fontSize = '12px'
    empty.style.opacity = '0.7'
    empty.style.padding = '16px 4px'
    _listRoot.appendChild(empty)
    return
  }

  for (const rec of _records) {
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
  btn.style.padding = '3px 4px'
  btn.style.cursor = 'pointer'
  btn.style.fontSize = '11px'
  btn.style.background = '#374151'
  btn.style.color = '#f9fafb'
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

async function refreshList(context) {
  if (!context || !context.invoke) return
  if (_loadingEl) _loadingEl.style.display = 'block'
  try {
    const list = await context.invoke('flymd_list_uploaded_images')
    if (Array.isArray(list)) {
      renderList(list)
    } else {
      renderList([])
      context.ui &&
        context.ui.notice &&
        context.ui.notice(
          s3gText('S3 图床相册：后端未返回列表', 'S3 gallery: backend did not return a list'),
          'err',
          2400,
        )
    }
  } catch (e) {
    console.error('[s3-gallery] 拉取上传历史失败', e)
    renderList([])
    const msg = e && e.message ? String(e.message) : String(e || '未知错误')
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText('获取图床历史失败：', 'Failed to fetch upload history: ') +
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
  try {
    const ok = await context.ui.confirm(
      s3gText(
        '确定要删除这张图片吗？此操作会从 S3/R2 中删除对象，且可能导致已有文档中的链接失效。',
        'Are you sure you want to delete this image? This will delete the object from S3/R2 and may break links in existing documents.',
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

  let cfg = null
  try {
    const getter = typeof window !== 'undefined' ? (window).flymdGetUploaderConfig : null
    if (typeof getter === 'function') {
      cfg = await getter()
    }
  } catch (e) {
    console.warn('[s3-gallery] 读取图床配置失败', e)
  }

  if (!cfg || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket) {
    context.ui &&
      context.ui.notice &&
      context.ui.notice(
        s3gText(
          '尚未在宿主中配置 S3/R2 图床，无法执行远端删除',
          'S3/R2 image host is not configured in the host, cannot delete remote images',
        ),
        'err',
        3200,
      )
    return
  }

  const endpoint = cfg.endpoint || null
  const region = cfg.region || null
  const forcePathStyle = cfg.forcePathStyle !== false
  const customDomain = cfg.customDomain || null

  try {
    await context.invoke('flymd_delete_uploaded_image', {
      req: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        bucket: rec.bucket || cfg.bucket,
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
    label: s3gText('S3 图床相册', 'S3 Image Gallery'),
    title: s3gText('查看并管理内置图床上传的图片', 'Browse and manage images uploaded via the built-in image host'),
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
  _panel = null
  _listRoot = null
  _loadingEl = null
  _records = []
}

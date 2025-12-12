// AutoYAML 插件：为当前文档自动补全 YAML 前置信息，可选调用 AI 助手生成标签等元数据

// 配置默认值
const AUTOYAML_DEFAULT_CONFIG = {
  enableContextMenu: true, // 是否在右键菜单中显示 AutoYAML
  enableAI: true, // 是否尝试使用 AI 助手生成 tags 等元数据
  maxTags: 8, // 单文档 tags 生成上限
}

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const AUTOYAML_LOCALE_LS_KEY = 'flymd.locale'
function autoyamlDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function autoyamlGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(AUTOYAML_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return autoyamlDetectLocale()
}
function autoyamlText(zh, en) {
  return autoyamlGetLocale() === 'en' ? en : zh
}

// 运行时缓存：用于在设置界面中更新右键菜单状态
let AUTOYAML_RUNTIME_CTX = null
let AUTOYAML_CTX_MENU_DISPOSER = null

// 简单检测文首是否已经存在 YAML front matter
function splitFrontMatter(src) {
  const original = String(src || '')
  if (!original.trim()) {
    return { frontMatter: null, body: '' }
  }

  // 处理 BOM，避免干扰开头的 ---
  let text = original
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }

  const lines = text.split(/\r?\n/)
  if (!lines.length || lines[0].trim() !== '---') {
    // 没有标准 YAML 起始标记，当作无 front matter
    return { frontMatter: null, body: original }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    // 找不到结束的 ---，当作无效 front matter，直接返回原文
    return { frontMatter: null, body: original }
  }

  const frontLines = lines.slice(0, endIndex + 1)
  const bodyLines = lines.slice(endIndex + 1)
  const frontMatter = frontLines.join('\n')
  const body = bodyLines.join('\n')
  return { frontMatter, body }
}

// 从正文中推断标题：优先使用第一个 Markdown 标题行
function inferTitleFromBody(body) {
  const lines = String(body || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // 去掉 # 前缀和前后空格
      const title = line.replace(/^#+\s*/, '').trim()
      if (title) return title
    }
  }
  return null
}

// 简单的 YAML 标量转义：遇到空格或特殊字符就用双引号包裹
function escapeYamlScalar(value) {
  const s = String(value ?? '')
  if (!s) return "''"
  // 有空白或 YAML 关键字符时，直接走 JSON.stringify，省心
  if (/\s/.test(s) || /[:#\-\[\]\{\},&*!?|>'\"%@`]/.test(s)) {
    return JSON.stringify(s)
  }
  return s
}

// 加载配置
async function autoyamlLoadConfig(context) {
  try {
    if (!context || !context.storage || typeof context.storage.get !== 'function') {
      return { ...AUTOYAML_DEFAULT_CONFIG }
    }
    const raw = (await context.storage.get('config')) || {}
    const cfg = typeof raw === 'object' && raw ? raw : {}
    let maxTags = AUTOYAML_DEFAULT_CONFIG.maxTags
    if (cfg && typeof cfg.maxTags !== 'undefined') {
      const n = Number(cfg.maxTags)
      if (Number.isFinite(n) && n >= 0) {
        maxTags = Math.min(Math.max(0, Math.floor(n)), 64)
      }
    }
    return {
      enableContextMenu:
        typeof cfg.enableContextMenu === 'boolean'
          ? !!cfg.enableContextMenu
          : AUTOYAML_DEFAULT_CONFIG.enableContextMenu,
      enableAI:
        typeof cfg.enableAI === 'boolean' ? !!cfg.enableAI : AUTOYAML_DEFAULT_CONFIG.enableAI,
      maxTags,
    }
  } catch {
    return { ...AUTOYAML_DEFAULT_CONFIG }
  }
}

// 保存配置
async function autoyamlSaveConfig(context, cfg) {
  try {
    if (!context || !context.storage || typeof context.storage.set !== 'function') return
    const next = {
      enableContextMenu:
        typeof cfg.enableContextMenu === 'boolean'
          ? !!cfg.enableContextMenu
          : AUTOYAML_DEFAULT_CONFIG.enableContextMenu,
      enableAI:
        typeof cfg.enableAI === 'boolean' ? !!cfg.enableAI : AUTOYAML_DEFAULT_CONFIG.enableAI,
      maxTags:
        typeof cfg.maxTags === 'number' && Number.isFinite(cfg.maxTags)
          ? Math.min(Math.max(0, Math.floor(cfg.maxTags)), 64)
          : AUTOYAML_DEFAULT_CONFIG.maxTags,
    }
    await context.storage.set('config', next)
  } catch {
    // 忽略存储错误
  }
}

// 尝试获取 AI 助手插件的 API（ai-assistant）
async function getAiApi(context) {
  try {
    if (!context || typeof context.getPluginAPI !== 'function') return null
    const api = context.getPluginAPI('ai-assistant')
    if (!api || typeof api.callAI !== 'function') return null
    if (typeof api.isConfigured === 'function') {
      const ok = await api.isConfigured()
      if (!ok) return null
    }
    return api
  } catch {
    return null
  }
}

// 从 AI 返回的字符串里解析出元数据对象
function parseAiMetadataFromText(text) {
  if (!text || typeof text !== 'string') return null
  const raw = text.trim()
  if (!raw) return null

  const tryParse = (s) => {
    try {
      const v = JSON.parse(s)
      if (!v || typeof v !== 'object') return null
      return v
    } catch {
      return null
    }
  }

  let obj = tryParse(raw)
  if (!obj) {
    const m = raw.match(/\{[\s\S]*?\}/)
    if (m) {
      obj = tryParse(m[0])
    }
  }
  if (!obj) return null

  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .map((x) => String(x || '').trim())
        .filter((x) => !!x)
    : []
  const category =
    obj.category && typeof obj.category === 'string'
      ? obj.category.trim()
      : ''
  const summary =
    obj.summary && typeof obj.summary === 'string'
      ? obj.summary.trim()
      : ''

  return {
    tags,
    category,
    summary,
  }
}

// 调用 AI 助手生成元数据（tags / category / summary）
async function generateMetadataWithAI(context, body, title, cfg) {
  const ai = await getAiApi(context)
  if (!ai) return null

  const safeBody = String(body || '')
  const safeTitle = String(title || '').trim() || autoyamlText('未命名', 'Untitled')
  const trimmedBody =
    safeBody.length > 4000 ? safeBody.slice(0, 4000) : safeBody

  const maxTags =
    cfg && typeof cfg.maxTags === 'number' && Number.isFinite(cfg.maxTags)
      ? Math.min(Math.max(0, Math.floor(cfg.maxTags)), 64)
      : AUTOYAML_DEFAULT_CONFIG.maxTags

  const prompt = [
    '你是一个 Markdown 文档的元数据生成器。',
    '根据给定的「标题」和「正文」，生成适合作为 YAML front matter 的元数据。',
    '请只输出一个 JSON 对象，不要输出任何解释或多余文字。',
    'JSON 字段要求：',
    `- tags: string[]，长度 0~${maxTags || 0}，每个元素是简短主题词，可以是中文或英文，不要包含 # 号。`,
    '- category: string，可选，表示文档类别，例如“工作”、“学习”、“随笔”等，不确定可以用空字符串。',
    '- summary: string，可选，简短中文摘要，不超过 80 字；如果无法给出摘要可以用空字符串。',
    '无法合理生成的字段请使用空数组或空字符串。',
    '',
    '下面是待分析的内容：',
    '标题：' + safeTitle,
    '',
    '正文：',
    trimmedBody,
  ].join('\n')

  let reply = ''
  try {
    reply = await ai.callAI(prompt, {
      system: '你是严谨的中文文档元数据助手，只输出 JSON。',
    })
  } catch (e) {
    console.error('[autoyaml] AI 调用失败', e)
    return null
  }

  const meta = parseAiMetadataFromText(reply)
  return meta
}

// 构造 YAML front matter（可选合并 AI 元数据）
function buildFrontMatter(body, aiMeta, cfg) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts =
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    ' ' +
    pad(now.getHours()) +
    ':' +
    pad(now.getMinutes()) +
    ':' +
    pad(now.getSeconds())

  const inferredTitle = inferTitleFromBody(body)
  const title = inferredTitle || autoyamlText('未命名', 'Untitled')

  const lines = []
  lines.push('---')
  lines.push('title: ' + escapeYamlScalar(title))
  lines.push('created: ' + escapeYamlScalar(ts))
  lines.push('updated: ' + escapeYamlScalar(ts))

  // tags 优先使用 AI 返回的结果，否则为空数组
  let tagsLine = 'tags: []'
  if (aiMeta && Array.isArray(aiMeta.tags) && aiMeta.tags.length > 0) {
    const limit =
      cfg && typeof cfg.maxTags === 'number' && Number.isFinite(cfg.maxTags)
        ? Math.min(Math.max(0, Math.floor(cfg.maxTags)), 64)
        : AUTOYAML_DEFAULT_CONFIG.maxTags
    const limited =
      limit > 0 ? aiMeta.tags.slice(0, limit) : []
    const escapedTags = limited.map((t) => escapeYamlScalar(t))
    tagsLine = 'tags: [' + escapedTags.join(', ') + ']'
  }
  lines.push(tagsLine)

  if (aiMeta && aiMeta.category) {
    lines.push('category: ' + escapeYamlScalar(aiMeta.category))
  }
  if (aiMeta && aiMeta.summary) {
    lines.push('summary: ' + escapeYamlScalar(aiMeta.summary))
  }

  lines.push('---')
  return lines.join('\n')
}

// 对当前文档应用 AutoYAML 逻辑
async function applyAutoYaml(context) {
  try {
    const cfg = await autoyamlLoadConfig(context)
    const src = context.getEditorValue() || ''
    const { frontMatter, body } = splitFrontMatter(src)

    if (frontMatter) {
      // 已经有 front matter，暂时不自动改写，避免意外破坏用户配置
      context.ui.notice('文首已存在 YAML 元数据，未进行修改', 'ok', 2000)
      return
    }

    let aiMeta = null
    let notifId = null
    if (cfg.enableAI) {
      // 右下角长期通知：提示正在调用 AI
      try {
        if (context.ui && typeof context.ui.showNotification === 'function') {
          notifId = context.ui.showNotification('AutoYAML：正在调用 AI 生成标签和摘要...', {
            type: 'info',
            duration: 0,
          })
        } else if (context.ui && typeof context.ui.notice === 'function') {
          context.ui.notice('AutoYAML：正在调用 AI 生成标签和摘要...', 'ok', 2200)
        }
      } catch {}

      aiMeta = await generateMetadataWithAI(context, body, inferTitleFromBody(body), cfg)

      // 关闭进行中的通知
      if (notifId && context.ui && typeof context.ui.hideNotification === 'function') {
        try {
          context.ui.hideNotification(notifId)
        } catch {}
      }

      if (!aiMeta) {
        // 启用了 AI 但不可用时，只提示一次“已退回本地规则”会更好，这里简单提示
        try {
          context.ui.notice(
            autoyamlText(
              'AI 助手不可用，已退回本地规则生成 YAML',
              'AI Assistant unavailable, falling back to local rules to generate YAML',
            ),
            'ok',
            2200,
          )
        } catch {}
      }
    }

    const fm = buildFrontMatter(body, aiMeta, cfg)
    // 去掉正文开头多余的空行，避免出现大量连续空白
    const cleanedBody = String(body || '').replace(/^\s*\r?\n/, '')
    const next = fm + '\n' + cleanedBody
    context.setEditorValue(next)
    context.ui.notice(
      autoyamlText('已自动生成 YAML 元数据', 'YAML metadata generated automatically'),
      'ok',
      2000,
    )
  } catch (e) {
    console.error('[autoyaml] 处理失败', e)
    try {
      context.ui.notice(
        autoyamlText('AutoYAML 处理失败', 'AutoYAML processing failed'),
        'err',
        2000,
      )
    } catch {
      // 忽略二次错误
    }
  }
}

// 注册右键菜单项
function registerContextMenu(context) {
  if (
    !context ||
    typeof context.addContextMenuItem !== 'function'
  ) {
    return
  }
  try {
    AUTOYAML_CTX_MENU_DISPOSER = context.addContextMenuItem({
      label: autoyamlText('AutoYAML：生成元数据', 'AutoYAML: Generate metadata'),
      // 在源码、预览、所见三种模式下都提供右键入口
      condition: (ctx) =>
        ctx.mode === 'edit' ||
        ctx.mode === 'preview' ||
        ctx.mode === 'wysiwyg',
      onClick: () => {
        void applyAutoYaml(context)
      },
    })
  } catch (e) {
    console.error('[autoyaml] 注册右键菜单失败', e)
  }
}

// 确保设置样式只注入一次
function ensureSettingsStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById('autoyaml-settings-style')) return
  const style = document.createElement('style')
  style.id = 'autoyaml-settings-style'
  style.textContent = `
.autoyaml-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 需要高于扩展市场 ext-overlay (z-index: 80000) */
  z-index: 90010;
}
.autoyaml-dialog {
  background: var(--flymd-panel-bg, #fff);
  color: inherit;
  min-width: 360px;
  max-width: 480px;
  border-radius: 8px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
  padding: 16px 20px 14px;
  font-size: 14px;
}
.autoyaml-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  font-weight: 600;
}
.autoyaml-body {
  margin-bottom: 12px;
}
.autoyaml-row {
  margin-bottom: 10px;
}
.autoyaml-row label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.autoyaml-row input[type="checkbox"] {
  width: 15px;
  height: 15px;
}
.autoyaml-tip {
  margin-left: 22px;
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.8;
}
.autoyaml-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.autoyaml-btn {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.2);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
.autoyaml-btn-primary {
  background: #2d7ff9;
  border-color: #2d7ff9;
  color: #fff;
}
.autoyaml-btn:hover {
  opacity: 0.92;
}
`
  document.head.appendChild(style)
}

// 打开 AutoYAML 设置对话框（JS 绘制窗口）
async function openAutoYamlSettingsDialog(context, cfg) {
  if (typeof document === 'undefined') return null
  ensureSettingsStyle()

  return await new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'autoyaml-overlay'

    const dialog = document.createElement('div')
    dialog.className = 'autoyaml-dialog'

    const header = document.createElement('div')
    header.className = 'autoyaml-header'
    const title = document.createElement('div')
    title.textContent = autoyamlText('AutoYAML 设置', 'AutoYAML Settings')
    const btnClose = document.createElement('button')
    btnClose.textContent = '×'
    btnClose.className = 'autoyaml-btn'
    btnClose.style.padding = '0 6px'
    btnClose.style.fontSize = '16px'

    header.appendChild(title)
    header.appendChild(btnClose)

    const body = document.createElement('div')
    body.className = 'autoyaml-body'

    // AI 元数据开关
    const rowAi = document.createElement('div')
    rowAi.className = 'autoyaml-row'
    const labelAi = document.createElement('label')
    const inputAi = document.createElement('input')
    inputAi.type = 'checkbox'
    inputAi.checked = !!cfg.enableAI
    const spanAi = document.createElement('span')
    spanAi.textContent = autoyamlText('启用 AI 生成标签和摘要（需安装并配置 AI 助手插件）', 'Enable AI to generate tags and summary (requires AI Assistant plugin installed and configured)')
    labelAi.appendChild(inputAi)
    labelAi.appendChild(spanAi)
    const tipAi = document.createElement('div')
    tipAi.className = 'autoyaml-tip'
    tipAi.textContent =
      autoyamlText('开启后，AutoYAML 会调用 AI 助手插件生成 tags/category/summary，失败时自动退回本地规则。', 'When enabled, AutoYAML will call the AI Assistant plugin to generate tags/category/summary, and fall back to local rules on failure.')
    rowAi.appendChild(labelAi)
    rowAi.appendChild(tipAi)

    // 右键菜单开关
    const rowCtx = document.createElement('div')
    rowCtx.className = 'autoyaml-row'
    const labelCtx = document.createElement('label')
    const inputCtx = document.createElement('input')
    inputCtx.type = 'checkbox'
    inputCtx.checked = !!cfg.enableContextMenu
    const spanCtx = document.createElement('span')
    spanCtx.textContent = autoyamlText('在编辑器右键菜单中显示 AutoYAML', 'Show AutoYAML in editor context menu')
    labelCtx.appendChild(inputCtx)
    labelCtx.appendChild(spanCtx)
    const tipCtx = document.createElement('div')
    tipCtx.className = 'autoyaml-tip'
    tipCtx.textContent =
      autoyamlText('勾选后，在右键菜单中会出现“AutoYAML：生成元数据”入口。', 'When enabled, a "AutoYAML: Generate metadata" entry will appear in the editor context menu.')
    rowCtx.appendChild(labelCtx)
    rowCtx.appendChild(tipCtx)

    // tags 数量上限设置
    const rowMax = document.createElement('div')
    rowMax.className = 'autoyaml-row'
    const labelMax = document.createElement('label')
    const spanMax = document.createElement('span')
    spanMax.textContent = autoyamlText('单篇文档最多生成的标签数量', 'Maximum number of tags per document')
    spanMax.style.flex = '1'
    const inputMax = document.createElement('input')
    inputMax.type = 'number'
    inputMax.min = '0'
    inputMax.max = '64'
    inputMax.step = '1'
    inputMax.style.width = '72px'
    inputMax.style.padding = '2px 6px'
    inputMax.style.borderRadius = '4px'
    inputMax.style.border = '1px solid rgba(0,0,0,0.2)'
    inputMax.value = String(
      typeof cfg.maxTags === 'number' && Number.isFinite(cfg.maxTags)
        ? Math.min(Math.max(0, Math.floor(cfg.maxTags)), 64)
        : AUTOYAML_DEFAULT_CONFIG.maxTags,
    )
    labelMax.appendChild(spanMax)
    labelMax.appendChild(inputMax)
    const tipMax = document.createElement('div')
    tipMax.className = 'autoyaml-tip'
    tipMax.textContent =
      autoyamlText('0 表示不写入 tags，仅生成其他元数据；建议设置在 3~12 之间。', '0 means do not write tags, only generate other metadata; 3–12 is recommended.')
    rowMax.appendChild(labelMax)
    rowMax.appendChild(tipMax)

    // 属性视图快捷入口
    const rowPv = document.createElement('div')
    rowPv.className = 'autoyaml-row'
    const btnPv = document.createElement('button')
    btnPv.className = 'autoyaml-btn'
    btnPv.textContent = autoyamlText('打开属性视图', 'Open Property View')
    btnPv.onclick = async () => {
      try {
        if (!context || typeof context.getPluginAPI !== 'function') {
          if (context && context.ui && context.ui.notice) {
            context.ui.notice(
              autoyamlText(
                '当前环境不支持插件 API，无法打开属性视图。',
                'Plugin API is not available, cannot open Property View.',
              ),
              'err',
              2200,
            )
          }
          return
        }
        const api = context.getPluginAPI('property-view')
        if (!api || typeof api.openView !== 'function') {
          if (context && context.ui && context.ui.notice) {
            context.ui.notice(
              autoyamlText(
                '未找到“属性视图”扩展，请在扩展市场中安装并启用。',
                'Property View extension not found; please install and enable it in the extensions market.',
              ),
              'err',
              2600,
            )
          }
          return
        }
        await api.openView()
      } catch (e) {
        try {
          console.error('[autoyaml] 打开属性视图失败', e)
        } catch {}
        if (context && context.ui && context.ui.notice) {
          context.ui.notice(
            autoyamlText(
              '打开属性视图失败，请检查控制台日志。',
              'Failed to open Property View; please check console for details.',
            ),
            'err',
            2600,
          )
        }
      }
    }
    const tipPv = document.createElement('div')
    tipPv.className = 'autoyaml-tip'
    tipPv.textContent = autoyamlText(
      '需要安装并启用“属性视图”扩展，用于基于 YAML 元数据浏览文档列表。',
      'Requires the Property View extension to be installed and enabled to browse files by YAML metadata.',
    )
    rowPv.appendChild(btnPv)
    rowPv.appendChild(tipPv)

    body.appendChild(rowAi)
    body.appendChild(rowCtx)
    body.appendChild(rowMax)
    body.appendChild(rowPv)

    const footer = document.createElement('div')
    footer.className = 'autoyaml-footer'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'autoyaml-btn'
    btnCancel.textContent = autoyamlText('取消', 'Cancel')
    const btnOk = document.createElement('button')
    btnOk.className = 'autoyaml-btn autoyaml-btn-primary'
    btnOk.textContent = autoyamlText('保存', 'Save')
    footer.appendChild(btnCancel)
    footer.appendChild(btnOk)

    dialog.appendChild(header)
    dialog.appendChild(body)
    dialog.appendChild(footer)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    function close(result) {
      try {
        overlay.remove()
      } catch {}
      resolve(result)
    }

    btnClose.onclick = () => close(null)
    btnCancel.onclick = () => close(null)
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null)
    }

    btnOk.onclick = () => {
      const rawMax = parseInt(inputMax.value || '', 10)
      let maxTags = AUTOYAML_DEFAULT_CONFIG.maxTags
      if (Number.isFinite(rawMax) && rawMax >= 0) {
        maxTags = Math.min(Math.max(0, rawMax), 64)
      }
      const next = {
        enableAI: !!inputAi.checked,
        enableContextMenu: !!inputCtx.checked,
        maxTags,
      }
      close(next)
    }
  })
}

export async function activate(context) {
  AUTOYAML_RUNTIME_CTX = context

  const cfg = await autoyamlLoadConfig(context)

  // 在“插件”菜单中添加入口
  if (typeof context.addMenuItem === 'function') {
    context.addMenuItem({
      label: 'AutoYAML',
      title: autoyamlText(
        '为当前文档自动补全 YAML 元数据',
        'Automatically add YAML metadata to the current document',
      ),
      onClick: () => {
        void applyAutoYaml(context)
      },
    })
  }

  // 按配置决定是否注册右键菜单
  if (cfg.enableContextMenu) {
    registerContextMenu(context)
  }
}

export async function openSettings(context) {
  const cfg = await autoyamlLoadConfig(context)
  const next = await openAutoYamlSettingsDialog(context, cfg)
  if (!next) return

  await autoyamlSaveConfig(context, next)
  if (context.ui && context.ui.notice) {
    context.ui.notice(
      autoyamlText('AutoYAML 设置已保存', 'AutoYAML settings saved'),
      'ok',
      1800,
    )
  }

  // 根据最新配置更新右键菜单（使用运行期上下文，不依赖设置页上下文）
  if (AUTOYAML_RUNTIME_CTX) {
    if (next.enableContextMenu) {
      if (!AUTOYAML_CTX_MENU_DISPOSER) {
        registerContextMenu(AUTOYAML_RUNTIME_CTX)
      }
    } else if (AUTOYAML_CTX_MENU_DISPOSER) {
      try {
        AUTOYAML_CTX_MENU_DISPOSER()
      } catch {}
      AUTOYAML_CTX_MENU_DISPOSER = null
    }
  }
}

export function deactivate() {
  // 清理右键菜单
  if (AUTOYAML_CTX_MENU_DISPOSER) {
    try {
      AUTOYAML_CTX_MENU_DISPOSER()
    } catch {}
    AUTOYAML_CTX_MENU_DISPOSER = null
  }
  AUTOYAML_RUNTIME_CTX = null
}

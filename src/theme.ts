// 主题系统（中文注释）
// - 目标：
//   1) 提供“主题”入口（按钮由 main.ts 注入），显示一个面板选择颜色与排版
//   2) 支持编辑/所见/阅读三种模式独立背景色
//   3) 预留扩展 API：注册颜色、注册排版、注册整套主题
//   4) 首次启动应用保存的主题自动生效
// - 实现策略：
//   使用 .container 作用域内的 CSS 变量覆盖（--bg / --wysiwyg-bg / --preview-bg），避免影响标题栏等外围 UI。

export type TypographyId = 'default' | 'serif' | 'modern' | 'reading' | 'academic'
export type MdStyleId = 'standard' | 'github' | 'notion' | 'journal'

export interface ThemePrefs {
  editBg: string
  readBg: string
  wysiwygBg: string
  typography: TypographyId
  mdStyle: MdStyleId
  themeId?: string
}

export interface ThemeDefinition {
  id: string
  label: string
  colors?: Partial<Pick<ThemePrefs, 'editBg' | 'readBg' | 'wysiwygBg'>>
  typography?: TypographyId
  mdStyle?: MdStyleId
}

const STORE_KEY = 'flymd:theme:prefs'

const DEFAULT_PREFS: ThemePrefs = {
  editBg: '#ffffff',
  readBg: getCssVar('--preview-bg') || '#fbf5e6',
  wysiwygBg: getCssVar('--wysiwyg-bg') || '#e9edf5',
  typography: 'default',
  mdStyle: 'standard',
}

const _themes = new Map<string, ThemeDefinition>()
const _palettes: Array<{ id: string; label: string; color: string }> = []

// 工具：读当前 :root/.container 上的变量（若无则返回空串）
function getCssVar(name: string): string {
  try {
    const el = document.documentElement
    const v = getComputedStyle(el).getPropertyValue(name)
    return (v || '').trim()
  } catch { return '' }
}

function getContainer(): HTMLElement | null {
  return document.querySelector('.container') as HTMLElement | null
}

export function applyThemePrefs(prefs: ThemePrefs): void {
  try {
    const c = getContainer()
    if (!c) return
    // 仅作用于容器作用域，避免 titlebar/弹窗等也跟随变色
    c.style.setProperty('--bg', prefs.editBg)
    c.style.setProperty('--preview-bg', prefs.readBg)
    c.style.setProperty('--wysiwyg-bg', prefs.wysiwygBg)

    // 排版：通过类名挂到 .container 上，覆盖 .preview-body 与 .ProseMirror
    c.classList.remove('typo-serif', 'typo-modern', 'typo-reading', 'typo-academic')
    if (prefs.typography === 'serif') c.classList.add('typo-serif')
    else if (prefs.typography === 'modern') c.classList.add('typo-modern')
    else if (prefs.typography === 'reading') c.classList.add('typo-reading')
    else if (prefs.typography === 'academic') c.classList.add('typo-academic')

    // Markdown 风格类名
    c.classList.remove('md-standard', 'md-github', 'md-notion', 'md-journal')
    const mdClass = `md-${prefs.mdStyle || 'standard'}`
    c.classList.add(mdClass)

    // 触发主题变更事件（扩展可监听）
    try {
      const ev = new CustomEvent('flymd:theme:changed', { detail: { prefs } })
      window.dispatchEvent(ev)
    } catch {}
  } catch {}
}

export function saveThemePrefs(prefs: ThemePrefs): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)) } catch {}
}

export function loadThemePrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const obj = JSON.parse(raw)
    return {
      editBg: obj.editBg || DEFAULT_PREFS.editBg,
      readBg: obj.readBg || DEFAULT_PREFS.readBg,
      wysiwygBg: obj.wysiwygBg || DEFAULT_PREFS.wysiwygBg,
      typography: (['default','serif','modern','reading','academic'] as string[]).includes(obj.typography) ? obj.typography : 'default',
      mdStyle: (['standard','github','notion','journal'] as string[]).includes(obj.mdStyle) ? obj.mdStyle : 'standard',
      themeId: obj.themeId || undefined,
    }
  } catch { return { ...DEFAULT_PREFS } }
}

export function applySavedTheme(): void {
  const prefs = loadThemePrefs()
  applyThemePrefs(prefs)
}

// ===== 扩展 API（对外暴露到 window.flymdTheme）=====
function registerTheme(def: ThemeDefinition): void {
  if (!def || !def.id) return
  _themes.set(def.id, def)
}
function registerPalette(label: string, color: string, id?: string): void {
  const _id = id || `ext-${Math.random().toString(36).slice(2, 8)}`
  _palettes.push({ id: _id, label, color })
}
function registerTypography(id: TypographyId, label: string, css?: string): void {
  // 仅允许 'default' | 'serif' | 'modern' 三选；如需更多可扩展此处分支
  if (!['default', 'serif', 'modern', 'reading', 'academic'].includes(id)) return
  if (css) {
    try {
      const style = document.createElement('style')
      style.dataset.themeTypo = id
      style.textContent = css
      document.head.appendChild(style)
    } catch {}
  }
}

function registerMdStyle(id: MdStyleId, label: string, css?: string): void {
  if (!['standard','github','notion','journal'].includes(id)) return
  if (css) {
    try {
      const style = document.createElement('style')
      style.dataset.themeMd = id
      style.textContent = css
      document.head.appendChild(style)
    } catch {}
  }
}

export const themeAPI = { registerTheme, registerPalette, registerTypography, registerMdStyle, applyThemePrefs, loadThemePrefs, saveThemePrefs }
;(window as any).flymdTheme = themeAPI

// ===== 主题 UI =====

function buildColorList(): Array<{ id: string; label: string; color: string }> {
  // 从当前 CSS 读取“所见模式当前颜色”
  const curW = getCssVar('--wysiwyg-bg') || '#e9edf5'
  const base = [
    { id: 'sys-wys', label: '所见色', color: curW },
    { id: 'pure', label: '纯白', color: '#ffffff' },
    { id: 'parch', label: '羊皮纸', color: '#fbf5e6' },
    { id: 'soft-blue', label: '淡蓝', color: '#f7f9fc' },
    // 自增几种柔和色
    { id: 'warm-gray', label: '暖灰', color: '#f6f5f1' },
    { id: 'mist-blue', label: '雾蓝', color: '#eef3f9' },
    { id: 'mint', label: '薄荷', color: '#eef8f1' },
    { id: 'ivory', label: '象牙', color: '#fffaf0' },
  ]
  return base.concat(_palettes)
}

function createPanel(): HTMLDivElement {
  const panel = document.createElement('div')
  panel.className = 'theme-panel hidden'
  panel.id = 'theme-panel'
  panel.innerHTML = `
    <div class="theme-section">
      <div class="theme-title">编辑背景</div>
      <div class="theme-swatches" data-target="edit"></div>
    </div>
    <div class="theme-section">
      <div class="theme-title">阅读背景</div>
      <div class="theme-swatches" data-target="read"></div>
    </div>
    <div class="theme-section">
      <div class="theme-title">所见背景</div>
      <div class="theme-swatches" data-target="wysiwyg"></div>
    </div>
    <div class="theme-section">
      <div class="theme-title">排版风格</div>
      <div class="theme-typos">
        <button class="typo-btn" data-typo="default">标准</button>
        <button class="typo-btn" data-typo="serif">经典（衬线）</button>
        <button class="typo-btn" data-typo="modern">现代（紧凑）</button>
        <button class="typo-btn" data-typo="reading">阅读增强</button>
        <button class="typo-btn" data-typo="academic">学术风</button>
      </div>
    </div>
    <div class="theme-section">
      <div class="theme-title">Markdown 风格</div>
      <div class="theme-md">
        <button class="md-btn" data-md="standard">标准</button>
        <button class="md-btn" data-md="github">GitHub</button>
        <button class="md-btn" data-md="notion">Notion</button>
        <button class="md-btn" data-md="journal">出版风</button>
      </div>
    </div>
  `
  return panel
}

function fillSwatches(panel: HTMLElement, prefs: ThemePrefs) {
  const colors = buildColorList()
  panel.querySelectorAll('.theme-swatches').forEach((wrap) => {
    const el = wrap as HTMLElement
    const tgt = el.dataset.target || 'edit'
    const cur = tgt === 'edit' ? prefs.editBg : (tgt === 'read' ? prefs.readBg : prefs.wysiwygBg)
    el.innerHTML = colors.map(({ id, label, color }) => {
      const active = (color.toLowerCase() === (cur || '').toLowerCase()) ? 'active' : ''
      const title = `${label} ${color}`
      return `<div class="theme-swatch ${active}" title="${title}" data-color="${color}" data-for="${tgt}" style="background:${color}"></div>`
    }).join('')
  })

  // 排版激活态
  panel.querySelectorAll('.typo-btn').forEach((b) => {
    const el = b as HTMLButtonElement
    const v = el.dataset.typo as TypographyId
    if (v === prefs.typography) el.classList.add('active'); else el.classList.remove('active')
  })
  // MD 风格激活态
  panel.querySelectorAll('.md-btn').forEach((b) => {
    const el = b as HTMLButtonElement
    const v = el.dataset.md as MdStyleId
    if (v === prefs.mdStyle) el.classList.add('active'); else el.classList.remove('active')
  })
}

export function initThemeUI(): void {
  try {
    const menu = document.querySelector('.menubar')
    const container = getContainer()
    if (!menu || !container) return

    let panel = document.getElementById('theme-panel') as HTMLDivElement | null
    if (!panel) {
      panel = createPanel()
      container.appendChild(panel)
    }

    const prefs = loadThemePrefs()
    fillSwatches(panel, prefs)

    // 点击颜色：更新、保存、应用
    panel.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement
      if (t.classList.contains('theme-swatch')) {
        const color = t.dataset.color || '#ffffff'
        const forWhich = t.dataset.for || 'edit'
        const cur = loadThemePrefs()
        if (forWhich === 'edit') cur.editBg = color
        else if (forWhich === 'read') cur.readBg = color
        else cur.wysiwygBg = color
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
      } else if (t.classList.contains('typo-btn')) {
        const id = (t.dataset.typo as TypographyId) || 'default'
        const cur = loadThemePrefs()
        cur.typography = id
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
      } else if (t.classList.contains('md-btn')) {
        const id = (t.dataset.md as MdStyleId) || 'standard'
        const cur = loadThemePrefs()
        cur.mdStyle = id
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
      }
    })

    // 主题按钮：切换面板显隐
    const btn = document.getElementById('btn-theme') as HTMLDivElement | null
    if (btn) {
      btn.addEventListener('click', () => {
        try {
          // 将面板对齐到右上角，靠近按钮区域
          panel!.style.left = 'auto'
          panel!.style.right = '10px'
          panel!.style.top = '38px'
          panel!.classList.toggle('hidden')
        } catch {}
      })
    }

    // 点击外部关闭
    document.addEventListener('click', (ev) => {
      try {
        const t = ev.target as HTMLElement
        if (!panel || panel.classList.contains('hidden')) return
        if (t.closest('#theme-panel') || t.closest('#btn-theme')) return
        panel.classList.add('hidden')
      } catch {}
    })
  } catch {}
}

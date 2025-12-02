// 主题系统（中文注释）
// - 目标：
//   1) 提供“主题”入口（按钮由 main.ts 注入），显示一个面板选择颜色与排版
//   2) 支持编辑/所见/阅读三种模式独立背景色
//   3) 预留扩展 API：注册颜色、注册排版、注册整套主题
//   4) 首次启动应用保存的主题自动生效
// - 实现策略：
//   使用 .container 作用域内的 CSS 变量覆盖（--bg / --wysiwyg-bg / --preview-bg），避免影响标题栏等外围 UI。

export type TypographyId = 'default' | 'serif' | 'modern' | 'reading' | 'academic' | 'compact' | 'elegant' | 'minimal' | 'tech' | 'literary'
// 运行期依赖（仅在需要时使用）
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile, mkdir, exists, remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import { homeDir, desktopDir, join } from '@tauri-apps/api/path'
export type MdStyleId = 'standard' | 'github' | 'notion' | 'journal' | 'card' | 'docs' | 'typora' | 'obsidian' | 'bear' | 'minimalist'

export interface ThemePrefs {
  editBg: string
  readBg: string
  wysiwygBg: string
  /** 夜间模式编辑背景 */
  editBgDark?: string
  /** 夜间模式阅读背景 */
  readBgDark?: string
  typography: TypographyId
  mdStyle: MdStyleId
  themeId?: string
  /** 自定义正文字体（预览/WYSIWYG 正文），为空则使用默认/排版风格 */
  bodyFont?: string
  /** 自定义等宽字体（编辑器与代码），为空则使用系统等宽栈 */
  monoFont?: string
  /** 编辑模式网格背景 */
  gridBackground?: boolean
  /** 文件夹图标 */
  folderIcon?: string
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
  editBgDark: '#0b0c0e',
  readBgDark: '#12100d',
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

// 工具：解析颜色字符串（十六进制或 rgb/rgba），用于计算菜单栏/标签栏/侧栏等“外圈 UI”的衍生色
function parseColor(input: string): { r: number; g: number; b: number } | null {
  try {
    if (!input) return null
    let s = input.trim().toLowerCase()

    // 十六进制形式
    if (s.startsWith('#')) {
      s = s.slice(1)
      if (s.length === 3) {
        const r3 = s[0]
        const g3 = s[1]
        const b3 = s[2]
        s = r3 + r3 + g3 + g3 + b3 + b3
      }
      if (s.length !== 6) return null
      const r16 = Number.parseInt(s.slice(0, 2), 16)
      const g16 = Number.parseInt(s.slice(2, 4), 16)
      const b16 = Number.parseInt(s.slice(4, 6), 16)
      if ([r16, g16, b16].some(v => Number.isNaN(v))) return null
      return { r: r16, g: g16, b: b16 }
    }

    // rgb / rgba 形式
    if (s.startsWith('rgb')) {
      const m = s.match(/rgba?\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/)
      if (!m) return null
      const r = Number.parseFloat(m[1])
      const g = Number.parseFloat(m[2])
      const b = Number.parseFloat(m[3])
      if ([r, g, b].some(v => !Number.isFinite(v))) return null
      return { r, g, b }
    }

    // 其它格式暂不支持
    return null

  } catch {
    return null
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  const to2 = (v: number) => clamp(v).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

function deriveChromeColors(baseColor: string): { chromeBg: string; chromePanelBg: string } | null {
  const rgb = parseColor(baseColor)
  if (!rgb) return null

  // 简单亮度估算：区分“偏亮/偏暗”，以决定往深/浅微调
  const brightness = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b
  const isDark = brightness < 128

  // 外圈背景比内容区只略微拉开亮度，避免对比度过大
  const surfaceDelta = isDark ? 8 : -6   // 标题栏/标签栏
  const panelDelta = isDark ? 14 : -10  // 侧栏等面板

  const chromeBg = rgbToHex(rgb.r + surfaceDelta, rgb.g + surfaceDelta, rgb.b + surfaceDelta)
  const chromePanelBg = rgbToHex(rgb.r + panelDelta, rgb.g + panelDelta, rgb.b + panelDelta)
  return { chromeBg, chromePanelBg }
}

// 根据当前容器背景色更新“外圈 UI”变量；若计算失败则回退到可选的备用颜色
function updateChromeColorsFromContainer(container: HTMLElement, fallbackBase?: string): void {
  try {
    const root = document.body
    let base = ''
    try {
      const cs = window.getComputedStyle(container)
      base = cs.backgroundColor || ''
    } catch {}

    if (!base && fallbackBase) base = fallbackBase
    const derived = base ? deriveChromeColors(base) : null

    if (derived) {
      root.style.setProperty('--chrome-bg', derived.chromeBg)
      root.style.setProperty('--chrome-panel-bg', derived.chromePanelBg)
    } else {
      root.style.removeProperty('--chrome-bg')
      root.style.removeProperty('--chrome-panel-bg')
    }
  } catch {}
}

export function applyThemePrefs(prefs: ThemePrefs): void {
  try {
    const c = getContainer()
    if (!c) return

    // 检测是否为夜间模式（系统深色或用户手动开启）
    const isDarkMode = document.body.classList.contains('dark-mode')

    if (isDarkMode) {
      // 夜间模式：应用用户设置的夜间背景色（如果已设置），否则使用默认深色
      const editDark = prefs.editBgDark || DEFAULT_PREFS.editBgDark || '#0b0c0e'
      const readDark = prefs.readBgDark || DEFAULT_PREFS.readBgDark || '#12100d'
      c.style.setProperty('--bg', editDark)
      c.style.setProperty('--preview-bg', readDark)
      // 夜间模式下，所见模式背景固定使用 CSS 定义的颜色，不支持用户调整
    } else {
      // 日间模式：应用用户设置的背景色
      c.style.setProperty('--bg', prefs.editBg)
      c.style.setProperty('--preview-bg', prefs.readBg)
      c.style.setProperty('--wysiwyg-bg', prefs.wysiwygBg)
    }

    // 统一在容器更新完背景变量之后，再基于“实际背景色”推导外圈 UI 颜色
    // 这样无论当前是编辑 / 所见 / 阅读模式，只要容器背景变化，1/2/3 区域都会跟随
    updateChromeColorsFromContainer(c, isDarkMode ? (prefs.editBgDark || DEFAULT_PREFS.editBgDark) : prefs.editBg)

    // 阅读模式"纯白背景"特殊处理：当阅读背景为纯白且非夜间模式时，移除羊皮纸纹理，让预览真正呈现纯白纸面
    try {
      const readColor = (prefs.readBg || '').trim().toLowerCase()
      const isPureWhite = readColor === '#ffffff' || readColor === '#fff'
      c.classList.toggle('preview-plain', !isDarkMode && isPureWhite)
    } catch {}

    // 字体变量（为空则移除，回退默认）
    try {
      const bodyFont = (prefs.bodyFont || '').trim()
      const monoFont = (prefs.monoFont || '').trim()
      if (bodyFont) c.style.setProperty('--font-body', bodyFont)
      else c.style.removeProperty('--font-body')
      if (monoFont) c.style.setProperty('--font-mono', monoFont)
      else c.style.removeProperty('--font-mono')
    } catch {}

    // 排版：通过类名挂到 .container 上，覆盖 .preview-body 与 .ProseMirror
    c.classList.remove('typo-serif', 'typo-modern', 'typo-reading', 'typo-academic', 'typo-compact', 'typo-elegant', 'typo-minimal', 'typo-tech', 'typo-literary')
    if (prefs.typography && prefs.typography !== 'default') {
      c.classList.add(`typo-${prefs.typography}`)
    }

    // Markdown 风格类名
    c.classList.remove('md-standard', 'md-github', 'md-notion', 'md-journal', 'md-card', 'md-docs', 'md-typora', 'md-obsidian', 'md-bear', 'md-minimalist')
    const mdClass = `md-${prefs.mdStyle || 'standard'}`
    c.classList.add(mdClass)

    // 网格背景
    if (prefs.gridBackground) c.classList.add('edit-grid-bg')
    else c.classList.remove('edit-grid-bg')

    // 触发主题变更事件（扩展可监听）
    try {
      const ev = new CustomEvent('flymd:theme:changed', { detail: { prefs } })
      window.dispatchEvent(ev)
    } catch {}

    // 专注模式下更新侧栏背景色
    setTimeout(() => {
      const updateFunc = (window as any).updateFocusSidebarBg
      if (typeof updateFunc === 'function') {
        updateFunc()
      }
    }, 50)
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
    let mdStyle: any = obj.mdStyle
    // 兼容：若历史保存为 terminal，则回退为 standard
    if (mdStyle === 'terminal') mdStyle = 'standard'
    return {
      editBg: obj.editBg || DEFAULT_PREFS.editBg,
      readBg: obj.readBg || DEFAULT_PREFS.readBg,
      wysiwygBg: obj.wysiwygBg || DEFAULT_PREFS.wysiwygBg,
      editBgDark: obj.editBgDark || DEFAULT_PREFS.editBgDark,
      readBgDark: obj.readBgDark || DEFAULT_PREFS.readBgDark,
      typography: (['default','serif','modern','reading','academic','compact','elegant','minimal','tech','literary'] as string[]).includes(obj.typography) ? obj.typography : 'default',
      mdStyle: (['standard','github','notion','journal','card','docs','typora','obsidian','bear','minimalist'] as string[]).includes(mdStyle) ? mdStyle : 'standard',
      themeId: obj.themeId || undefined,
      bodyFont: (typeof obj.bodyFont === 'string') ? obj.bodyFont : undefined,
      monoFont: (typeof obj.monoFont === 'string') ? obj.monoFont : undefined,
      gridBackground: (typeof obj.gridBackground === 'boolean') ? obj.gridBackground : false,
      folderIcon: (typeof obj.folderIcon === 'string') ? obj.folderIcon : '🗂️',
    }
  } catch { return { ...DEFAULT_PREFS } }
}

export function applySavedTheme(): void {
  // 首先检测系统深色模式，如果是则强制启用夜间模式
  try {
    const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (isSystemDark) {
      document.body.classList.add('dark-mode')
    } else {
      // 非系统深色模式时，读取用户保存的设置
      const savedDark = localStorage.getItem('flymd:darkmode') === 'true'
      document.body.classList.toggle('dark-mode', savedDark)
    }
  } catch {}

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
  // 允许的排版风格
  if (!['default', 'serif', 'modern', 'reading', 'academic', 'compact', 'elegant', 'minimal', 'tech', 'literary'].includes(id)) return
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
  if (!['standard','github','notion','journal','card','docs','typora','obsidian','bear','minimalist'].includes(id)) return
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

// 监听模式切换事件（编辑 / 阅读 / 所见），在模式变化时也重新推导一遍外圈 UI 颜色
try {
  window.addEventListener('flymd:mode:changed', () => {
    const c = getContainer()
    if (!c) return
    updateChromeColorsFromContainer(c)
  })
} catch {}

// ===== 主题 UI =====

function buildColorList(): Array<{ id: string; label: string; color: string }> {
  // 从当前 CSS 读取"所见模式当前颜色"
  const curW = getCssVar('--wysiwyg-bg') || '#e9edf5'
  const base = [
    { id: 'sys-wys', label: '所见色', color: curW },
    { id: 'pure', label: '纯白', color: '#ffffff' },
    { id: 'parch', label: '羊皮纸', color: '#fbf5e6' },
    { id: 'soft-blue', label: '淡蓝', color: '#f7f9fc' },
    // 柔和护眼色系
    { id: 'warm-gray', label: '暖灰', color: '#f6f5f1' },
    { id: 'mist-blue', label: '雾蓝', color: '#eef3f9' },
    { id: 'mint', label: '薄荷', color: '#eef8f1' },
    { id: 'ivory', label: '象牙', color: '#fffaf0' },
    // 新增护眼色系
    { id: 'beige', label: '米色', color: '#f5f5dc' },
    { id: 'sand', label: '沙色', color: '#faf8f3' },
    { id: 'cream', label: '奶油', color: '#fffef9' },
    { id: 'pearl', label: '珍珠', color: '#fafaf8' },
    // 新增冷色调
    { id: 'sky', label: '天蓝', color: '#e8f4f8' },
    { id: 'frost', label: '冰霜', color: '#f0f8ff' },
    { id: 'lavender', label: '薰衣草', color: '#f5f3ff' },
    // 新增暖色调
    { id: 'peach', label: '蜜桃', color: '#fff5ee' },
    { id: 'rose', label: '玫瑰', color: '#fff5f7' },
    { id: 'apricot', label: '杏色', color: '#fff8f0' },
    // 自然色系
    { id: 'sage', label: '鼠尾草', color: '#f0f4f0' },
    { id: 'bamboo', label: '竹青', color: '#f2f6f0' },
    { id: 'cloud', label: '云白', color: '#f8fafc' },
    // 文艺色系
    { id: 'sepia', label: '复古黄', color: '#fdf6e3' },
    { id: 'latte', label: '拿铁', color: '#f9f5f0' },
    { id: 'mocha', label: '摩卡', color: '#f7f3ed' },
    // 新增护眼色系
    { id: 'tea-green', label: '茶绿', color: '#e8f5e3' },
    { id: 'paper-white', label: '纸白', color: '#fffef7' },
    { id: 'soft-pink', label: '柔粉', color: '#fff0f5' },
  ]
  return base.concat(_palettes)
}

// 夜间模式色板
function buildDarkColorList(): Array<{ id: string; label: string; color: string }> {
  const darkBase = [
    // 经典深色系
    { id: 'dark-pure', label: '纯黑', color: '#000000' },
    { id: 'dark-charcoal', label: '木炭', color: '#0b0c0e' },
    { id: 'dark-midnight', label: '午夜', color: '#12100d' },
    { id: 'dark-slate', label: '石板', color: '#0f1114' },
    // 暖色调深色
    { id: 'dark-coffee', label: '咖啡', color: '#1a1410' },
    { id: 'dark-brown', label: '棕褐', color: '#1c1410' },
    { id: 'dark-sepia', label: '深褐', color: '#1a1612' },
    // 冷色调深色
    { id: 'dark-navy', label: '深蓝', color: '#0d1117' },
    { id: 'dark-ocean', label: '海洋', color: '#0e1419' },
    { id: 'dark-steel', label: '钢青', color: '#111418' },
    // 中性深色
    { id: 'dark-graphite', label: '石墨', color: '#14161a' },
    { id: 'dark-ash', label: '灰烬', color: '#16181c' },
    { id: 'dark-smoke', label: '烟灰', color: '#18191d' },
    // 柔和深色（护眼）
    { id: 'dark-olive', label: '橄榄', color: '#15160f' },
    { id: 'dark-forest', label: '森林', color: '#0f1510' },
    { id: 'dark-moss', label: '苔藓', color: '#12140f' },
    // 暖灰深色
    { id: 'dark-pewter', label: '暖锡', color: '#1a1816' },
    { id: 'dark-taupe', label: '驼灰', color: '#1c1816' },
    { id: 'dark-umber', label: '土褐', color: '#1a1512' },
  ]
  return darkBase.concat(_palettes)
}

function createPanel(): HTMLDivElement {
  const panel = document.createElement('div')
  panel.className = 'theme-panel hidden'
  panel.id = 'theme-panel'
  panel.innerHTML = `
    <div class="theme-panel-header">
      <span class="theme-panel-title">主题设置</span>
      <button class="theme-panel-close" title="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="theme-panel-content">
    <div class="theme-section theme-focus-section">
      <div class="theme-focus-row">
        <label class="theme-toggle-label theme-toggle-third theme-toggle-boxed" for="focus-mode-toggle">
          <span class="theme-toggle-text">专注模式</span>
          <div class="theme-toggle-switch">
            <input type="checkbox" id="focus-mode-toggle" class="theme-toggle-input" />
            <span class="theme-toggle-slider"></span>
          </div>
        </label>
        <label class="theme-toggle-label theme-toggle-third theme-toggle-boxed" for="wysiwyg-default-toggle">
          <span class="theme-toggle-text">所见模式</span>
          <div class="theme-toggle-switch">
            <input type="checkbox" id="wysiwyg-default-toggle" class="theme-toggle-input" />
            <span class="theme-toggle-slider"></span>
          </div>
        </label>
        <label class="theme-toggle-label theme-toggle-third theme-toggle-boxed" for="dark-mode-toggle">
          <span class="theme-toggle-text">夜间模式</span>
          <div class="theme-toggle-switch">
            <input type="checkbox" id="dark-mode-toggle" class="theme-toggle-input" />
            <span class="theme-toggle-slider"></span>
          </div>
        </label>
        <label class="theme-toggle-label theme-toggle-third theme-toggle-boxed" for="compact-titlebar-toggle">
          <span class="theme-toggle-text">紧凑标题栏</span>
          <div class="theme-toggle-switch">
            <input type="checkbox" id="compact-titlebar-toggle" class="theme-toggle-input" />
            <span class="theme-toggle-slider"></span>
          </div>
        </label>
      </div>
    </div>
    <div class="theme-section">
      <div class="theme-title">编辑背景</div>
      <div class="theme-swatches" data-target="edit"></div>
      <div class="theme-option">
        <label class="theme-checkbox-label">
          <input type="checkbox" id="grid-bg-toggle" class="theme-checkbox" />
          <span>网格背景</span>
        </label>
      </div>
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
        <button class="typo-btn" data-typo="serif">经典</button>
        <button class="typo-btn" data-typo="modern">现代</button>
        <button class="typo-btn" data-typo="reading">阅读</button>
        <button class="typo-btn" data-typo="academic">学术</button>
        <button class="typo-btn" data-typo="compact">紧凑</button>
        <button class="typo-btn" data-typo="elegant">优雅</button>
        <button class="typo-btn" data-typo="minimal">极简</button>
        <button class="typo-btn" data-typo="tech">科技</button>
        <button class="typo-btn" data-typo="literary">文学</button>
      </div>
    </div>
    <div class="theme-section">
      <div class="theme-title">Markdown 风格</div>
      <div class="theme-md">
        <button class="md-btn" data-md="standard">标准</button>
        <button class="md-btn" data-md="github">GitHub</button>
        <button class="md-btn" data-md="notion">Notion</button>
        <button class="md-btn" data-md="journal">出版风</button>
        <button class="md-btn" data-md="card">卡片风</button>
        <button class="md-btn" data-md="docs">Docs</button>
        <button class="md-btn" data-md="typora">Typora</button>
        <button class="md-btn" data-md="obsidian">Obsidian</button>
        <button class="md-btn" data-md="bear">Bear</button>
        <button class="md-btn" data-md="minimalist">极简风</button>
      </div>
    </div>
    <div class="theme-section theme-fonts-section">
      <div class="theme-title">字体选择</div>
      <div class="theme-fonts">
        <label for="font-body-select">正文字体</label>
        <select id="font-body-select"></select>
        <label for="font-mono-select">等宽字体</label>
        <select id="font-mono-select"></select>
        <div class="font-actions">
      </div>
    </div>
    </div>
  `
  return panel
}

function fillSwatches(panel: HTMLElement, prefs: ThemePrefs) {
  // 检测当前是否为夜间模式
  const isDarkMode = document.body.classList.contains('dark-mode')
  // 根据模式选择色板
  const colors = isDarkMode ? buildDarkColorList() : buildColorList()

  panel.querySelectorAll('.theme-swatches').forEach((wrap) => {
    const el = wrap as HTMLElement
    const tgt = el.dataset.target || 'edit'

    // 夜间模式下隐藏所见背景选择
    if (isDarkMode && tgt === 'wysiwyg') {
      el.parentElement?.classList.add('hidden')
      return
    } else {
      el.parentElement?.classList.remove('hidden')
    }

    // 根据当前模式选择对应的背景色
    const cur = isDarkMode
      ? (tgt === 'edit' ? (prefs.editBgDark || DEFAULT_PREFS.editBgDark)
        : (prefs.readBgDark || DEFAULT_PREFS.readBgDark))
      : (tgt === 'edit' ? prefs.editBg : (tgt === 'read' ? prefs.readBg : prefs.wysiwygBg))

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
  // 网格背景复选框状态
  const gridToggle = panel.querySelector('#grid-bg-toggle') as HTMLInputElement | null
  if (gridToggle) gridToggle.checked = !!prefs.gridBackground
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
    let lastSaved = { ...prefs }
    fillSwatches(panel, prefs)

    // 字体选项：内置常见字体栈，首项为空表示使用默认/随排版
    const bodyOptions: Array<{ label: string; stack: string }> = [
      { label: '跟随排版（默认）', stack: '' },
      { label: '系统无衬线（系统默认）', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'" },
      { label: '现代（Inter 优先）', stack: "Inter, Roboto, 'Noto Sans', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '衬线（Georgia/思源宋体）', stack: "Georgia, 'Times New Roman', Times, 'Source Han Serif SC', serif" },
    ]
    // 扩展：追加常见系统/开源字体（仅引用名称，不随包分发）
    const moreBodyOptions: Array<{ label: string; stack: string }> = [
      { label: 'Windows 中文（微软雅黑）', stack: "'Microsoft YaHei', 'Segoe UI', 'Noto Sans', Arial, sans-serif" },
      { label: 'macOS 中文（苹方/Hiragino）', stack: "'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Source Han Sans SC', -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '开源中文（思源黑体）', stack: "'Source Han Sans SC', 'Noto Sans CJK SC', 'Noto Sans', -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '开源中文（思源宋体）', stack: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Noto Serif', Georgia, 'Times New Roman', serif" },
      { label: 'Android/通用（Roboto）', stack: "Roboto, 'Noto Sans', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" },
      { label: '经典无衬线（Tahoma/Verdana）', stack: "Tahoma, Verdana, Arial, Helvetica, sans-serif" },
      { label: '经典衬线（Times/宋体回退）', stack: "'Times New Roman', Times, 'SimSun', serif" },
    ]
    const moreMonoOptions: Array<{ label: string; stack: string }> = [
      { label: 'Cascadia Code', stack: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Menlo/Monaco（macOS）', stack: "Menlo, Monaco, ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Ubuntu Mono', stack: "'Ubuntu Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'DejaVu Sans Mono', stack: "'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Source Code Pro', stack: "'Source Code Pro', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
    ]
    const monoOptions: Array<{ label: string; stack: string }> = [
      { label: '系统等宽（默认）', stack: '' },
      { label: 'JetBrains Mono', stack: "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Fira Code', stack: "'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { label: 'Consolas 系', stack: "Consolas, 'Courier New', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Liberation Mono', monospace" },
    ]

    const bodySel = panel.querySelector('#font-body-select') as HTMLSelectElement | null
    const monoSel = panel.querySelector('#font-mono-select') as HTMLSelectElement | null
    const resetBtn = panel.querySelector('#font-reset') as HTMLButtonElement | null
    const fontsWrap = panel.querySelector('.theme-fonts') as HTMLDivElement | null
    // 构造“安装字体”按钮并重组操作区（避免直接改 HTML 模板造成编码问题）
    let installBtn: HTMLButtonElement | null = null
    if (fontsWrap) {
      const actions = document.createElement('div')
      actions.className = 'font-actions'
      installBtn = document.createElement('button')
      installBtn.className = 'font-install'
      installBtn.id = 'font-install'
      installBtn.textContent = '安装字体'
      actions.appendChild(installBtn)
      if (resetBtn) actions.appendChild(resetBtn)
      fontsWrap.appendChild(actions)
    }

    // 自定义字体数据库（保存在 localStorage，仅记录元数据，文件存放于 AppLocalData/fonts）
    type CustomFont = { id: string; name: string; rel: string; ext: string; family: string }
    const FONT_DB_KEY = 'flymd:theme:fonts'
    const FONTS_DIR = 'fonts'
    function loadFontDb(): CustomFont[] {
      try { const raw = localStorage.getItem(FONT_DB_KEY); if (!raw) return []; const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr as CustomFont[] } catch {} return []
    }
    function saveFontDb(list: CustomFont[]) { try { localStorage.setItem(FONT_DB_KEY, JSON.stringify(list)) } catch {} }
    function sanitizeId(s: string): string { return s.replace(/[^a-zA-Z0-9_-]+/g, '-') }
    function getFormat(ext: string): string { const e = ext.toLowerCase(); if (e === 'ttf') return 'truetype'; if (e === 'otf') return 'opentype'; if (e === 'woff2') return 'woff2'; return 'woff' }
    async function ensureFontsDir() { try { await mkdir(FONTS_DIR as any, { baseDir: BaseDirectory.AppLocalData, recursive: true } as any) } catch {} }
    async function injectFontFace(f: CustomFont): Promise<void> {
      try {
        const bytes = await readFile(`${FONTS_DIR}/${f.rel}` as any, { baseDir: BaseDirectory.AppLocalData } as any) as Uint8Array
        const fmt = getFormat(f.ext)
        const blob = new Blob([bytes as any], { type: fmt === 'woff2' ? 'font/woff2' : (fmt === 'woff' ? 'font/woff' : 'font/ttf') })
        const url = URL.createObjectURL(blob)
        const css = `@font-face{font-family:'${f.family}';src:url(${url}) format('${fmt}');font-weight:normal;font-style:normal;font-display:swap;}`
        const style = document.createElement('style')
        style.dataset.userFont = f.id
        style.textContent = css
        document.head.appendChild(style)
      } catch {}
    }
    // 启动时恢复已安装字体：将数据库中的字体全部注册为 @font-face，
    // 确保升级或重启应用后，"本地: XXX" 选项仍然真实指向对应字体文件
    try {
      const list = loadFontDb()
      for (const f of list) {
        void injectFontFace(f)
      }
    } catch {}
    function mergeCustomOptions(): { body: Array<{label:string; stack:string}>, mono: Array<{label:string;stack:string}> } {
      const outB: Array<{label:string; stack:string}> = []
      const outM: Array<{label:string; stack:string}> = []
      const list = loadFontDb()
      for (const f of list) {
        outB.push({ label: `本地: ${f.name}`, stack: `'${f.family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif` })
        outM.push({ label: `本地: ${f.name}`, stack: `'${f.family}', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace` })
      }
      return { body: outB, mono: outM }
    }

    function rebuildFontSelects(cur: ThemePrefs) {
      try {
        const extras = mergeCustomOptions()
        if (bodySel) {
          const all = bodyOptions.concat(moreBodyOptions).concat(extras.body)
          bodySel.innerHTML = all
            .map(({ label, stack }) => `<option value="${stack.replace(/\"/g, '&quot;')}">${label}</option>`)
            .join('')
          bodySel.value = (cur.bodyFont || '')
        }
        if (monoSel) {
          const all = monoOptions.concat(moreMonoOptions).concat(extras.mono)
          monoSel.innerHTML = all
            .map(({ label, stack }) => `<option value="${stack.replace(/\"/g, '&quot;')}">${label}</option>`)
            .join('')
          monoSel.value = (cur.monoFont || '')
        }
      } catch {}
    }
    rebuildFontSelects(prefs)

    function applyBodyFont(v: string) {
      const cur = loadThemePrefs()
      cur.bodyFont = v || undefined
      saveThemePrefs(cur)
      applyThemePrefs(cur)
      lastSaved = { ...cur }
    }
    function applyMonoFont(v: string) {
      const cur = loadThemePrefs()
      cur.monoFont = v || undefined
      saveThemePrefs(cur)
      applyThemePrefs(cur)
      lastSaved = { ...cur }
    }

    if (bodySel) bodySel.addEventListener('change', () => applyBodyFont(bodySel!.value))
    if (monoSel) monoSel.addEventListener('change', () => applyMonoFont(monoSel!.value))
    if (resetBtn) resetBtn.addEventListener('click', () => {
      const cur = loadThemePrefs()
      cur.bodyFont = undefined
      cur.monoFont = undefined
      saveThemePrefs(cur)
      applyThemePrefs(cur)
      rebuildFontSelects(cur)
      lastSaved = { ...cur }
    })

    // 简单的操作系统识别（仅用于选择系统字体目录）
    function detectOS(): 'windows' | 'mac' | 'linux' | 'other' {
      try {
        const ua = navigator.userAgent || ''
        if (/Windows/i.test(ua)) return 'windows'
        if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
        if (/Linux/i.test(ua)) return 'linux'
      } catch {}
      return 'other'
    }
    // 返回系统字体目录（优先用户目录，其次系统目录），尽量确保真实存在
    async function getSystemFontsDir(): Promise<string | undefined> {
      const os = detectOS()
      const candidates: string[] = []
      try {
        if (os === 'windows') {
          const h = await homeDir()
          // Windows 用户字体目录（按用户安装）
          candidates.push(await join(h, 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'))
          // Windows 系统字体目录（可能不在 C 盘，但 C 盘是最常见，找不到则忽略）
          candidates.push('C\\Windows\\Fonts')
        } else if (os === 'mac') {
          const h = await homeDir()
          // macOS 用户字体目录
          candidates.push(await join(h, 'Library', 'Fonts'))
          // macOS 系统字体目录
          candidates.push('/Library/Fonts')
        } else if (os === 'linux') {
          const h = await homeDir()
          // Linux 常见字体目录（优先用户目录）
          candidates.push(await join(h, '.local', 'share', 'fonts'))
          candidates.push(await join(h, '.fonts'))
          candidates.push('/usr/share/fonts')
          candidates.push('/usr/local/share/fonts')
        }
      } catch {}
      // 依次尝试，找到第一个存在的目录
      for (const p of candidates) {
        try { if (await exists(p as any)) return p } catch {}
      }
      // 兜底：桌面目录（保证存在）
      try { return await desktopDir() } catch {}
      return undefined
    }

    // 安装字体：拷贝到 AppLocalData/fonts，并注册 @font-face
    if (installBtn) installBtn.addEventListener('click', async () => {
      try {
        const start = await getSystemFontsDir()
        const picked = await openDialog({
          multiple: true,
          // 默认打开系统字体目录，方便用户挑选已安装字体文件
          defaultPath: start,
          filters: [{ name: '字体', extensions: ['ttf','otf','woff','woff2'] }],
        } as any)
        const files: string[] = Array.isArray(picked) ? picked as any : (picked ? [picked as any] : [])
        if (!files.length) return
        await ensureFontsDir()
        let db = loadFontDb()
        for (const p of files) {
          try {
            const nameFull = (p.split(/[\\/]+/).pop() || '').trim()
            if (!nameFull) continue
            const m = nameFull.match(/^(.*?)(\.[^.]+)?$/) || [] as any
            const stem = (m?.[1] || 'font').trim()
            const ext = ((m?.[2] || '').replace('.', '') || 'ttf').toLowerCase()
            const id = sanitizeId(stem + '-' + Math.random().toString(36).slice(2,6))
            const family = 'UserFont-' + sanitizeId(stem)
            const rel = `${id}.${ext}`
            const bytes = await readFile(p as any)
            await writeFile(`${FONTS_DIR}/${rel}` as any, bytes as any, { baseDir: BaseDirectory.AppLocalData } as any)
            const rec: CustomFont = { id, name: stem, rel, ext, family }
            db.push(rec)
            await injectFontFace(rec)
          } catch {}
        }
        saveFontDb(db)
        rebuildFontSelects(loadThemePrefs())
      } catch {}
    })

    // 悬停预览：在颜色块上悬停时即时预览对应背景色，离开当前分组时还原
    const applyPreview = (forWhich: string, color: string) => {
      try {
        const c = getContainer(); if (!c) return
        if (forWhich === 'edit') c.style.setProperty('--bg', color)
        else if (forWhich === 'read') c.style.setProperty('--preview-bg', color)
        else c.style.setProperty('--wysiwyg-bg', color)
      } catch {}
    }
    const revertPreview = (forWhich: string) => {
      try {
        const c = getContainer(); if (!c) return
        // 根据当前模式还原对应的背景色
        const isDarkMode = document.body.classList.contains('dark-mode')
        if (isDarkMode) {
          if (forWhich === 'edit') c.style.setProperty('--bg', lastSaved.editBgDark || DEFAULT_PREFS.editBgDark || '#0b0c0e')
          else if (forWhich === 'read') c.style.setProperty('--preview-bg', lastSaved.readBgDark || DEFAULT_PREFS.readBgDark || '#12100d')
          // 夜间模式下所见背景不需要还原（不支持调整）
        } else {
          if (forWhich === 'edit') c.style.setProperty('--bg', lastSaved.editBg)
          else if (forWhich === 'read') c.style.setProperty('--preview-bg', lastSaved.readBg)
          else if (forWhich === 'wysiwyg') c.style.setProperty('--wysiwyg-bg', lastSaved.wysiwygBg)
        }
      } catch {}
    }
    // 还原所有预览变量到已保存值
    const revertAllPreviews = () => {
      try {
        const c = getContainer(); if (!c) return
        const isDarkMode = document.body.classList.contains('dark-mode')
        if (isDarkMode) {
          c.style.setProperty('--bg', lastSaved.editBgDark || DEFAULT_PREFS.editBgDark || '#0b0c0e')
          c.style.setProperty('--preview-bg', lastSaved.readBgDark || DEFAULT_PREFS.readBgDark || '#12100d')
          // 夜间模式下所见背景不需要还原（不支持调整）
        } else {
          c.style.setProperty('--bg', lastSaved.editBg)
          c.style.setProperty('--preview-bg', lastSaved.readBg)
          c.style.setProperty('--wysiwyg-bg', lastSaved.wysiwygBg)
        }
      } catch {}
    }
    // 事件委托：在 swatch 上方时应用预览色
    panel.addEventListener('mouseover', (ev) => {
      const t = ev.target as HTMLElement
      const sw = t.closest('.theme-swatch') as HTMLElement | null
      if (!sw) return
      const color = sw.dataset.color || '#ffffff'
      const forWhich = sw.dataset.for || 'edit'
      applyPreview(forWhich, color)
    })
    // 离开每个分组（编辑/阅读/所见）时还原该分组的原值，避免在分组内部移动造成闪烁
    panel.querySelectorAll('.theme-swatches').forEach((wrap) => {
      const el = wrap as HTMLElement
      const target = el.dataset.target || 'edit'
      el.addEventListener('mouseleave', () => revertPreview(target))
    })

    // 点击颜色：更新、保存、应用
    panel.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement
      if (t.classList.contains('theme-swatch')) {
        const color = t.dataset.color || '#ffffff'
        const forWhich = t.dataset.for || 'edit'
        const cur = loadThemePrefs()
        // 根据当前模式保存到对应的字段
        const isDarkMode = document.body.classList.contains('dark-mode')
        if (isDarkMode) {
          // 夜间模式：只保存编辑和阅读背景（所见模式背景不支持调整）
          if (forWhich === 'edit') cur.editBgDark = color
          else if (forWhich === 'read') cur.readBgDark = color
        } else {
          // 日间模式：保存到亮色背景字段
          if (forWhich === 'edit') cur.editBg = color
          else if (forWhich === 'read') cur.readBg = color
          else if (forWhich === 'wysiwyg') cur.wysiwygBg = color
        }
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
        lastSaved = { ...cur }
      } else if (t.classList.contains('typo-btn')) {
        const id = (t.dataset.typo as TypographyId) || 'default'
        const cur = loadThemePrefs()
        cur.typography = id
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
        lastSaved = { ...cur }
      } else if (t.classList.contains('md-btn')) {
        const id = (t.dataset.md as MdStyleId) || 'standard'
        const cur = loadThemePrefs()
        cur.mdStyle = id
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        fillSwatches(panel!, cur)
        lastSaved = { ...cur }
      }
    })

    // 网格背景切换
    const gridToggle = panel.querySelector('#grid-bg-toggle') as HTMLInputElement | null
    if (gridToggle) {
      gridToggle.addEventListener('change', () => {
        const cur = loadThemePrefs()
        cur.gridBackground = gridToggle.checked
        saveThemePrefs(cur)
        applyThemePrefs(cur)
        lastSaved = { ...cur }
      })
      }

      // 专注模式开关
      const focusToggle = panel.querySelector('#focus-mode-toggle') as HTMLInputElement | null
      if (focusToggle) {
      // 初始化开关状态：同步当前 body 上的 focus-mode 类
      focusToggle.checked = document.body.classList.contains('focus-mode')
      // 监听开关变化
      focusToggle.addEventListener('change', async () => {
        const enabled = focusToggle.checked
        // 调用 main.ts 中的 toggleFocusMode 函数
        const toggleFunc = (window as any).flymdToggleFocusMode
        if (typeof toggleFunc === 'function') {
          await toggleFunc(enabled)
        } else {
          // 降级：如果函数不存在，至少切换 CSS 类
          document.body.classList.toggle('focus-mode', enabled)
          // 通过自定义事件通知 main.ts 保存状态
          const ev = new CustomEvent('flymd:focus:toggle', { detail: { enabled } })
          window.dispatchEvent(ev)
        }
      })
      // 监听外部专注模式变化（如快捷键触发），同步开关状态
      const syncFocusToggle = () => {
        focusToggle.checked = document.body.classList.contains('focus-mode')
      }
      // 使用 MutationObserver 监听 body 的 class 变化
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            syncFocusToggle()
          }
        }
      })
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
      }

      // 紧凑标题栏开关
      const compactToggle = panel.querySelector('#compact-titlebar-toggle') as HTMLInputElement | null
      if (compactToggle) {
        // 初始化：同步 body 上的 compact-titlebar 类（第一次打开面板时）
        const syncCompactToggle = () => {
          try {
            compactToggle.checked = document.body.classList.contains('compact-titlebar')
          } catch {}
        }
        syncCompactToggle()

        // 监听 body.class 变化：当主进程根据 Store 恢复紧凑标题栏时，自动更新开关状态
        try {
          const compactObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
              if (m.type === 'attributes' && m.attributeName === 'class') {
                syncCompactToggle()
                break
              }
            }
          })
          compactObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
        } catch {}

        compactToggle.addEventListener('change', async () => {
          const enabled = compactToggle.checked
          const setFunc = (window as any).flymdSetCompactTitlebar
        if (typeof setFunc === 'function') {
          await setFunc(enabled)
        } else {
          // 降级：仅切换 CSS 类并广播事件
          document.body.classList.toggle('compact-titlebar', enabled)
          const ev = new CustomEvent('flymd:compact-titlebar:toggle', { detail: { enabled } })
          window.dispatchEvent(ev)
        }
      })
    }

    // 默认使用所见模式开关
    const wysiwygDefaultToggle = panel.querySelector('#wysiwyg-default-toggle') as HTMLInputElement | null
    if (wysiwygDefaultToggle) {
      // 从 localStorage 读取设置
      const WYSIWYG_DEFAULT_KEY = 'flymd:wysiwyg:default'
      const getWysiwygDefault = (): boolean => {
        try {
          const v = localStorage.getItem(WYSIWYG_DEFAULT_KEY)
          return v === 'true'
        } catch { return false }
      }
      const setWysiwygDefault = (enabled: boolean) => {
        try {
          localStorage.setItem(WYSIWYG_DEFAULT_KEY, enabled ? 'true' : 'false')
          // 触发事件，通知 main.ts
          const ev = new CustomEvent('flymd:wysiwyg:default', { detail: { enabled } })
          window.dispatchEvent(ev)
        } catch {}
      }
      // 初始化开关状态
      wysiwygDefaultToggle.checked = getWysiwygDefault()
      // 监听开关变化
      wysiwygDefaultToggle.addEventListener('change', () => {
        setWysiwygDefault(wysiwygDefaultToggle.checked)
      })
    }

    // 夜间模式开关
    const darkModeToggle = panel.querySelector('#dark-mode-toggle') as HTMLInputElement | null
    if (darkModeToggle) {
      const DARK_MODE_KEY = 'flymd:darkmode'
      // 检测系统是否为深色模式
      const isSystemDarkMode = (): boolean => {
        try {
          return window.matchMedia('(prefers-color-scheme: dark)').matches
        } catch { return false }
      }
      const getDarkMode = (): boolean => {
        // 如果系统是深色模式，强制启用夜间模式
        if (isSystemDarkMode()) return true
        try {
          const v = localStorage.getItem(DARK_MODE_KEY)
          return v === 'true'
        } catch { return false }
      }
      const setDarkMode = (enabled: boolean) => {
        try {
          localStorage.setItem(DARK_MODE_KEY, enabled ? 'true' : 'false')
          document.body.classList.toggle('dark-mode', enabled)
          // 重新应用主题设置（切换模式时使用对应的背景色）
          const cur = loadThemePrefs()
          applyThemePrefs(cur)
          // 刷新色板显示（切换到对应模式的色板）
          fillSwatches(panel!, cur)
          lastSaved = { ...cur }
          // 触发事件，通知其他组件
          const ev = new CustomEvent('flymd:darkmode:changed', { detail: { enabled } })
          window.dispatchEvent(ev)
        } catch {}
      }
      // 初始化开关状态（系统深色模式会强制开启）
      const isDark = getDarkMode()
      darkModeToggle.checked = isDark
      darkModeToggle.disabled = isSystemDarkMode() // 系统深色模式时禁用开关
      document.body.classList.toggle('dark-mode', isDark)
      // 监听开关变化
      darkModeToggle.addEventListener('change', () => {
        setDarkMode(darkModeToggle.checked)
      })
    }

    // 关闭按钮
    const closeBtn = panel.querySelector('.theme-panel-close') as HTMLButtonElement | null
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        revertAllPreviews()
        panel!.classList.add('hidden')
      })
    }

    // 主题按钮：切换面板显隐
    const btn = document.getElementById('btn-theme') as HTMLDivElement | null
    if (btn) {
      btn.addEventListener('click', () => {
        try {
          const wasHidden = panel!.classList.contains('hidden')
          panel!.classList.toggle('hidden')
          // 面板关闭时，确保预览被还原为已保存值
          if (!wasHidden && panel!.classList.contains('hidden')) {
            revertAllPreviews()
          }
        } catch {}
      })
    }

    // 点击外部关闭
    document.addEventListener('click', (ev) => {
      try {
        const t = ev.target as HTMLElement
        if (!panel || panel.classList.contains('hidden')) return
        if (t.closest('#theme-panel') || t.closest('#btn-theme')) return
        revertAllPreviews()
        panel.classList.add('hidden')
      } catch {}
    })

    // ESC 键关闭
    document.addEventListener('keydown', (ev) => {
      try {
        if (ev.key === 'Escape' && panel && !panel.classList.contains('hidden')) {
          revertAllPreviews()
          panel.classList.add('hidden')
          ev.preventDefault()
          ev.stopPropagation()
        }
      } catch {}
    })
  } catch {}
}

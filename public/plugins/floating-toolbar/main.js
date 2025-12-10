// 富文本悬浮工具条插件

const TOOLBAR_ID = 'flymd-floating-toolbar';
const SETTINGS_KEY = 'floatingToolbarSettings';

// 默认标题快捷键配置
const DEFAULT_HEADING_HOTKEYS = {
  h1: { ctrl: true, shift: false, alt: false, meta: false, code: 'Digit1' },
  h2: { ctrl: true, shift: false, alt: false, meta: false, code: 'Digit2' },
  h3: { ctrl: true, shift: false, alt: false, meta: false, code: 'Digit3' },
  h4: { ctrl: true, shift: false, alt: false, meta: false, code: 'Digit4' },
  h5: { ctrl: true, shift: false, alt: false, meta: false, code: 'Digit5' },
  h6: { ctrl: true, shift: false, alt: false, meta: false, code: 'Digit6' }
};

// 明确禁止占用的快捷键（宿主 + 常见编辑操作）
const FORBIDDEN_HOTKEYS = [
  // README 中列出的
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyN' },   // Ctrl+N 新建
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyO' },   // Ctrl+O 打开
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyS' },   // Ctrl+S 保存
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyW' },   // Ctrl+W 所见模式
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyE' },   // Ctrl+E 编辑/预览
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyT' },   // Ctrl+T 新标签
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyH' },   // Ctrl+H 查找
  { ctrl: true, shift: true,  alt: false, meta: false, code: 'KeyF' },   // Ctrl+Shift+F 专注
  { ctrl: true, shift: false, alt: false, meta: false, code: 'Tab' },    // Ctrl+Tab 标签切换
  { ctrl: true, shift: true,  alt: false, meta: false, code: 'Tab' },    // Ctrl+Shift+Tab 反向切换
  // 典型编辑快捷键
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyZ' },   // Ctrl+Z 撤销
  { ctrl: true, shift: true,  alt: false, meta: false, code: 'KeyZ' },   // Ctrl+Shift+Z / 重做
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyY' },   // Ctrl+Y 重做
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyC' },   // Ctrl+C 复制
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyV' },   // Ctrl+V 粘贴
  { ctrl: true, shift: false, alt: false, meta: false, code: 'KeyX' }    // Ctrl+X 剪切
];

const HEADING_IDS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

const defaultPrefs = {
  autoStart: true,
  showOnActivate: true,
  enableHeadingHotkeys: true,
  headingHotkeys: DEFAULT_HEADING_HOTKEYS
};

const state = {
  context: null,
  prefs: { ...defaultPrefs },
  toolbarEl: null,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  barStartLeft: 0,
  barStartTop: 0,
  keydownHandler: null
};

const COMMANDS = [
  {
    id: 'h1',
    label: 'H1',
    title: '一级标题',
    run: (ctx) => applyHeading(ctx, 1)
  },
  {
    id: 'h2',
    label: 'H2',
    title: '二级标题',
    run: (ctx) => applyHeading(ctx, 2)
  },
  {
    id: 'h3',
    label: 'H3',
    title: '三级标题',
    run: (ctx) => applyHeading(ctx, 3)
  },
  {
    id: 'h4',
    label: 'H4',
    title: '四级标题',
    run: (ctx) => applyHeading(ctx, 4)
  },
  {
    id: 'h5',
    label: 'H5',
    title: '五级标题',
    run: (ctx) => applyHeading(ctx, 5)
  },
  {
    id: 'h6',
    label: 'H6',
    title: '六级标题',
    run: (ctx) => applyHeading(ctx, 6)
  },
  {
    id: 'bold',
    label: 'B',
    title: '加粗',
    run: (ctx) => applyBold(ctx)
  },
  {
    id: 'italic',
    label: 'I',
    title: '斜体',
    run: (ctx) => applyItalic(ctx)
  },
  {
    id: 'ul',
    label: '•',
    title: '无序列表',
    run: (ctx) => applyList(ctx, '- ')
  },
  {
    id: 'link',
    label: '🔗',
    title: '插入链接',
    run: (ctx) => applyLink(ctx)
  },
  {
    id: 'image',
    label: '🖼',
    title: '插入图片',
    run: (ctx) => applyImage(ctx)
  }
];

async function loadPrefs(context) {
  try {
    const saved = (await context.storage.get(SETTINGS_KEY)) || {};
    const savedHeading = saved.headingHotkeys || {};
    state.prefs = {
      autoStart: saved.autoStart !== undefined ? saved.autoStart : defaultPrefs.autoStart,
      showOnActivate: saved.showOnActivate !== undefined ? saved.showOnActivate : defaultPrefs.showOnActivate,
      enableHeadingHotkeys:
        saved.enableHeadingHotkeys !== undefined ? saved.enableHeadingHotkeys : defaultPrefs.enableHeadingHotkeys,
      headingHotkeys: { ...DEFAULT_HEADING_HOTKEYS, ...savedHeading }
    };
  } catch {
    state.prefs = {
      autoStart: defaultPrefs.autoStart,
      showOnActivate: defaultPrefs.showOnActivate,
      enableHeadingHotkeys: defaultPrefs.enableHeadingHotkeys,
      headingHotkeys: { ...DEFAULT_HEADING_HOTKEYS }
    };
  }
}

function savePrefs(context, prefs) {
  const next = { ...state.prefs, ...prefs };
  if (prefs.headingHotkeys) {
    next.headingHotkeys = { ...DEFAULT_HEADING_HOTKEYS, ...prefs.headingHotkeys };
  }
  state.prefs = next;
  return context.storage.set(SETTINGS_KEY, state.prefs);
}

export async function activate(context) {
  state.context = context;
  await loadPrefs(context);

  if (state.prefs.autoStart) {
    createToolbarIfNeeded();
    registerHotkeys();
    if (!state.prefs.showOnActivate) {
      hideToolbar();
    }
  }

  context.addMenuItem({
    label: '富文本工具条',
    children: [
      {
        label: '显示/隐藏工具条',
        onClick: () => {
          if (!state.toolbarEl) {
            createToolbarIfNeeded();
          }
          if (!state.keydownHandler) {
            registerHotkeys();
          }
          const style = window.getComputedStyle(state.toolbarEl);
          if (style.display === 'none') {
            showToolbar();
          } else {
            hideToolbar();
          }
        }
      },
      {
        label: '设置...',
        onClick: () => {
          openSettings(context);
        }
      }
    ]
  });
}

export function deactivate() {
  if (state.keydownHandler) {
    window.removeEventListener('keydown', state.keydownHandler);
    state.keydownHandler = null;
  }
  if (state.toolbarEl && state.toolbarEl.parentNode) {
    state.toolbarEl.parentNode.removeChild(state.toolbarEl);
  }
  state.toolbarEl = null;
  state.context = null;
}

function createToolbarIfNeeded() {
  if (state.toolbarEl) return;

  const bar = document.createElement('div');
  bar.id = TOOLBAR_ID;
  bar.style.position = 'fixed';
  bar.style.top = '80px';
  bar.style.right = '40px';
  bar.style.zIndex = '9999';
  bar.style.display = 'flex';
  bar.style.alignItems = 'center';
  bar.style.gap = '4px';
  bar.style.padding = '4px 8px';
  bar.style.borderRadius = '6px';
  bar.style.background = 'rgba(30, 30, 30, 0.9)';
  bar.style.color = '#fff';
  bar.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
  bar.style.userSelect = 'none';
  bar.style.cursor = 'move';

  const title = document.createElement('span');
  title.textContent = '富文本';
  title.style.fontSize = '12px';
  title.style.opacity = '0.8';
  title.style.marginRight = '4px';
  bar.appendChild(title);

  COMMANDS.forEach((cmd) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = cmd.label;
    btn.title = cmd.title || cmd.label;
    btn.dataset.commandId = cmd.id;
    btn.style.border = 'none';
    btn.style.padding = '2px 6px';
    btn.style.margin = '0';
    btn.style.borderRadius = '4px';
    btn.style.background = '#444';
    btn.style.color = '#fff';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '12px';
    btn.style.lineHeight = '1.4';
    btn.style.minWidth = '28px';
    btn.style.textAlign = 'center';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runCommandById(cmd.id);
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#666';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#444';
    });

    bar.appendChild(btn);
  });

  bar.addEventListener('mousedown', onToolbarMouseDown);

  document.body.appendChild(bar);
  state.toolbarEl = bar;
}

function showToolbar() {
  if (state.toolbarEl) {
    state.toolbarEl.style.display = 'flex';
  }
}

function hideToolbar() {
  if (state.toolbarEl) {
    state.toolbarEl.style.display = 'none';
  }
}

function onToolbarMouseDown(e) {
  if (e.button !== 0) return;

  const bar = state.toolbarEl;
  if (!bar) return;

  state.dragging = true;
  const rect = bar.getBoundingClientRect();
  state.dragStartX = e.clientX;
  state.dragStartY = e.clientY;
  state.barStartLeft = rect.left;
  state.barStartTop = rect.top;

  if (bar.dataset.docked === 'top') {
    bar.style.width = 'auto';
    bar.style.left = `${rect.left}px`;
    bar.style.top = `${rect.top}px`;
    bar.style.right = '';
    bar.dataset.docked = '';
  }

  const onMove = (ev) => {
    if (!state.dragging) return;
    const dx = ev.clientX - state.dragStartX;
    const dy = ev.clientY - state.dragStartY;

    const nextLeft = state.barStartLeft + dx;
    const nextTop = state.barStartTop + dy;

    bar.style.left = `${nextLeft}px`;
    bar.style.top = `${nextTop}px`;
    bar.style.right = '';
  };

  const onUp = (ev) => {
    state.dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    snapToTop(bar);
    ev.stopPropagation();
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  e.preventDefault();
}

function snapToTop(bar) {
  const rect = bar.getBoundingClientRect();
  if (rect.top < 40) {
    bar.style.top = '0px';
    bar.style.left = '0px';
    bar.style.right = '0px';
    bar.style.width = '100%';
    bar.dataset.docked = 'top';
  } else {
    bar.dataset.docked = '';
  }
}

function runCommandById(id) {
  const ctx = state.context;
  if (!ctx) return;
  const cmd = COMMANDS.find((c) => c.id === id);
  if (!cmd || typeof cmd.run !== 'function') return;
  try {
    cmd.run(ctx);
  } catch (e) {
    ctx.ui.notice('工具条执行失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

function matchHotkeyEvent(e, hotkey) {
  if (!hotkey) return false;
  return !!e.ctrlKey === !!hotkey.ctrl &&
    !!e.shiftKey === !!hotkey.shift &&
    !!e.altKey === !!hotkey.alt &&
    !!e.metaKey === !!hotkey.meta &&
    e.code === hotkey.code;
}

function isForbiddenHotkey(hotkey) {
  if (!hotkey) return false;
  return FORBIDDEN_HOTKEYS.some((f) => matchHotkeyEvent(
    { ctrlKey: f.ctrl, shiftKey: f.shift, altKey: f.alt, metaKey: f.meta, code: f.code },
    hotkey
  ));
}

function codeToKey(code) {
  if (!code) return '';
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  return code;
}

function hotkeyToLabel(hotkey) {
  if (!hotkey || !hotkey.code) return '';
  const parts = [];
  if (hotkey.ctrl) parts.push('Ctrl');
  if (hotkey.shift) parts.push('Shift');
  if (hotkey.alt) parts.push('Alt');
  if (hotkey.meta) parts.push('Meta');
  parts.push(codeToKey(hotkey.code) || hotkey.code);
  return parts.join('+');
}

function registerHotkeys() {
  if (state.keydownHandler) return;

  const handler = (e) => {
    if (!state.context) return;

    // 标题快捷键总是包含 Ctrl，避免影响正常输入
    if (!e.ctrlKey) return;

    if (state.prefs.enableHeadingHotkeys) {
      const map = state.prefs.headingHotkeys || DEFAULT_HEADING_HOTKEYS;
      for (const id of HEADING_IDS) {
        const hk = map[id] || DEFAULT_HEADING_HOTKEYS[id];
        if (hk && matchHotkeyEvent(e, hk)) {
          // 防御：不允许运行被标记为禁止的组合（即便存储里有旧数据）
          if (isForbiddenHotkey(hk)) return;
          e.preventDefault();
          runCommandById(id);
          return;
        }
      }
    }
  };

  window.addEventListener('keydown', handler);
  state.keydownHandler = handler;
}

function getSelectionRange(context) {
  const doc = context.getEditorValue() || '';
  let start = 0;
  let end = 0;
  let text = '';

  try {
    const sel = context.getSelection && context.getSelection();
    if (sel) {
      start = sel.start >>> 0;
      end = sel.end >>> 0;
      if (typeof sel.text === 'string') {
        text = sel.text;
      }
    }
  } catch {
    // 忽略 selection 错误，后面用 getSelectedMarkdown 兜底
  }

  if ((!text || !text.length) && typeof context.getSelectedMarkdown === 'function') {
    try {
      const md = context.getSelectedMarkdown();
      if (md) text = md;
    } catch {
      // 忽略
    }
  }

  // 所见模式下，优先从 DOM 选区兜底一次，拿到纯文本
  if (!text || !text.length) {
    try {
      const domSel = window.getSelection && window.getSelection();
      if (domSel && domSel.rangeCount > 0) {
        const domText = domSel.toString();
        if (domText && domText.trim().length) {
          text = domText;
        }
      }
    } catch {
      // 忽略 DOM 选区错误
    }
  }

  if (text && (end <= start || doc.slice(start, end) !== text)) {
    const idx = doc.indexOf(text);
    if (idx !== -1) {
      start = idx;
      end = idx + text.length;
    }
  }

  const hasSelection = !!text && end > start;
  return { doc, start, end, text, hasSelection };
}

function applyHeading(context, level) {
  try {
    const { doc, start, end } = getSelectionRange(context);

    const lineStart = doc.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = doc.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = doc.length;

    const line = doc.slice(lineStart, lineEnd);
    const stripped = line.replace(/^#{1,6}\s+/, '');
    const prefix = '#'.repeat(Math.max(1, Math.min(6, level))) + ' ';
    const newLine = prefix + stripped;

    const nextDoc = doc.slice(0, lineStart) + newLine + doc.slice(lineEnd);
    context.setEditorValue(nextDoc);
  } catch (e) {
    context.ui.notice('设置标题失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

function applyBold(context) {
  try {
    const { doc, start, end, hasSelection } = getSelectionRange(context);
    if (!hasSelection) {
      context.ui.notice('请先选中要加粗的文本', 'err');
      return;
    }

    const before = doc.slice(0, start);
    const selected = doc.slice(start, end);
    const after = doc.slice(end);
    const next = before + '**' + selected + '**' + after;
    context.setEditorValue(next);
  } catch (e) {
    context.ui.notice('加粗失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

function applyItalic(context) {
  try {
    const { doc, start, end, hasSelection } = getSelectionRange(context);
    if (!hasSelection) {
      context.ui.notice('请先选中要设为斜体的文本', 'err');
      return;
    }

    const before = doc.slice(0, start);
    const selected = doc.slice(start, end);
    const after = doc.slice(end);
    const next = before + '*' + selected + '*' + after;
    context.setEditorValue(next);
  } catch (e) {
    context.ui.notice('斜体失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

function applyList(context, marker) {
  try {
    const { doc, start, end, hasSelection } = getSelectionRange(context);
    if (!hasSelection) {
      context.ui.notice('请先选中要转换为列表的内容', 'err');
      return;
    }

    const before = doc.slice(0, start);
    const body = doc.slice(start, end);
    const after = doc.slice(end);

    const lines = body.split('\n');
    const trimmedLines = lines.map((l) => l.replace(/^\s+/, ''));
    const allMarked = trimmedLines.every((l) => !l || l.startsWith(marker));

    const nextLines = trimmedLines.map((l) => {
      if (!l) return l;
      if (allMarked && l.startsWith(marker)) {
        return l.slice(marker.length);
      }
      return marker + l;
    });

    const nextBody = nextLines.join('\n');
    const nextDoc = before + nextBody + after;
    context.setEditorValue(nextDoc);
  } catch (e) {
    context.ui.notice('列表转换失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

function applyLink(context) {
  try {
    const { doc, start, end, text, hasSelection } = getSelectionRange(context);
    const currentText = hasSelection ? text || doc.slice(start, end) : '';

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.zIndex = '10000';

    const panel = document.createElement('div');
    panel.style.position = 'absolute';
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';
    panel.style.background = '#fff';
    panel.style.padding = '16px 20px';
    panel.style.borderRadius = '8px';
    panel.style.minWidth = '320px';
    panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
    panel.style.fontSize = '14px';

    panel.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:16px;">插入链接</h3>
      <div style="margin:6px 0;">
        <div style="margin-bottom:4px;">链接地址</div>
        <input id="ft-link-url" type="text" value="https://"
          style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;">
      </div>
      <div style="margin:6px 0;">
        <div style="margin-bottom:4px;">链接文本</div>
        <input id="ft-link-label" type="text" value="${currentText ? currentText.replace(/"/g, '') : '链接文本'}"
          style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;">
      </div>
      <div style="margin-top:14px;text-align:right;">
        <button id="ft-link-cancel" style="margin-right:8px;">取消</button>
        <button id="ft-link-ok">确定</button>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const urlInput = panel.querySelector('#ft-link-url');
    const labelInput = panel.querySelector('#ft-link-label');
    const cancelBtn = panel.querySelector('#ft-link-cancel');
    const okBtn = panel.querySelector('#ft-link-ok');

    urlInput.focus();
    urlInput.select();

    const cleanup = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    cancelBtn.onclick = () => {
      cleanup();
    };

    okBtn.onclick = () => {
      const url = (urlInput.value || '').trim();
      let label = (labelInput.value || '').trim();
      if (!url) {
        context.ui.notice('链接地址不能为空', 'err');
        return;
      }
      if (!label) label = '链接文本';

      const before = doc.slice(0, start);
      const after = doc.slice(end);
      const md = `[${label}](${url})`;
      const next = before + md + after;
      context.setEditorValue(next);
      cleanup();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
      }
    });
  } catch (e) {
    context.ui.notice('插入链接失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

function applyImage(context) {
  try {
    const { doc, start, end, text, hasSelection } = getSelectionRange(context);
    const currentText = hasSelection ? text || doc.slice(start, end) : '';

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.zIndex = '10000';

    const panel = document.createElement('div');
    panel.style.position = 'absolute';
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';
    panel.style.background = '#fff';
    panel.style.padding = '16px 20px';
    panel.style.borderRadius = '8px';
    panel.style.minWidth = '320px';
    panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
    panel.style.fontSize = '14px';

    panel.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:16px;">插入图片</h3>
      <div style="margin:6px 0;">
        <div style="margin-bottom:4px;">图片地址</div>
        <input id="ft-img-url" type="text" value="https://"
          style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;">
      </div>
      <div style="margin:6px 0;">
        <div style="margin-bottom:4px;">图片说明（可留空）</div>
        <input id="ft-img-alt" type="text" value="${currentText ? currentText.replace(/"/g, '') : ''}"
          style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;">
      </div>
      <div style="margin-top:14px;text-align:right;">
        <button id="ft-img-cancel" style="margin-right:8px;">取消</button>
        <button id="ft-img-ok">确定</button>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const urlInput = panel.querySelector('#ft-img-url');
    const altInput = panel.querySelector('#ft-img-alt');
    const cancelBtn = panel.querySelector('#ft-img-cancel');
    const okBtn = panel.querySelector('#ft-img-ok');

    urlInput.focus();
    urlInput.select();

    const cleanup = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    cancelBtn.onclick = () => {
      cleanup();
    };

    okBtn.onclick = () => {
      const url = (urlInput.value || '').trim();
      const alt = (altInput.value || '').trim();
      if (!url) {
        context.ui.notice('图片地址不能为空', 'err');
        return;
      }
      const before = doc.slice(0, start);
      const after = doc.slice(end);
      const md = `![${alt}](${url})`;
      const next = before + md + after;
      context.setEditorValue(next);
      cleanup();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
      }
    });
  } catch (e) {
    context.ui.notice('插入图片失败: ' + (e && e.message ? e.message : String(e)), 'err');
  }
}

export async function openSettings(context) {
  await loadPrefs(context);

  const headingHotkeys = { ...(state.prefs.headingHotkeys || DEFAULT_HEADING_HOTKEYS) };

  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.35)';
  overlay.style.zIndex = '10000';

  const panel = document.createElement('div');
  panel.style.position = 'absolute';
  panel.style.top = '50%';
  panel.style.left = '50%';
  panel.style.transform = 'translate(-50%, -50%)';
  panel.style.background = '#fff';
  panel.style.padding = '16px 20px';
  panel.style.borderRadius = '8px';
  panel.style.minWidth = '260px';
  panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
  panel.style.fontSize = '14px';

  panel.innerHTML = `
    <h3 style="margin:0 0 12px;font-size:16px;">悬浮工具条设置</h3>
    <div style="margin:6px 0;">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
        <input id="ft-auto-start" type="checkbox" ${state.prefs.autoStart ? 'checked' : ''} style="cursor:pointer;">
        <span>启动时注册快捷键</span>
      </label>
    </div>
    <div style="margin:6px 0;">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
        <input id="ft-show-on-activate" type="checkbox" ${state.prefs.showOnActivate ? 'checked' : ''} style="cursor:pointer;">
        <span>启动时自动显示工具条</span>
      </label>
    </div>
    <div style="margin:6px 0;">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
        <input id="ft-heading-hotkeys" type="checkbox" ${state.prefs.enableHeadingHotkeys ? 'checked' : ''} style="cursor:pointer;">
        <span>启用标题快捷键 (Ctrl+1~6)</span>
      </label>
    </div>
    <div style="margin:8px 0 4px;font-weight:500;">各级标题快捷键</div>
    <div style="font-size:12px;color:#666;margin-bottom:6px;">
      点击输入框后按下新的组合键。快捷键必须包含 Ctrl，且不能与 FlyMD 已有快捷键冲突。
    </div>
    <div style="display:grid;grid-template-columns:46px 1fr;row-gap:4px;column-gap:8px;margin-bottom:8px;">
      <span style="line-height:26px;text-align:right;font-weight:500;">H1</span>
      <input id="ft-key-h1" type="text" readonly
        style="width:100%;padding:3px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;cursor:pointer;">
      <span style="line-height:26px;text-align:right;font-weight:500;">H2</span>
      <input id="ft-key-h2" type="text" readonly
        style="width:100%;padding:3px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;cursor:pointer;">
      <span style="line-height:26px;text-align:right;font-weight:500;">H3</span>
      <input id="ft-key-h3" type="text" readonly
        style="width:100%;padding:3px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;cursor:pointer;">
      <span style="line-height:26px;text-align:right;font-weight:500;">H4</span>
      <input id="ft-key-h4" type="text" readonly
        style="width:100%;padding:3px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;cursor:pointer;">
      <span style="line-height:26px;text-align:right;font-weight:500;">H5</span>
      <input id="ft-key-h5" type="text" readonly
        style="width:100%;padding:3px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;cursor:pointer;">
      <span style="line-height:26px;text-align:right;font-weight:500;">H6</span>
      <input id="ft-key-h6" type="text" readonly
        style="width:100%;padding:3px 6px;border-radius:4px;border:1px solid #ddd;box-sizing:border-box;cursor:pointer;">
    </div>
    <div style="margin-top:14px;text-align:right;">
      <button id="ft-cancel" style="margin-right:8px;padding:4px 10px;border-radius:4px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer;">取消</button>
      <button id="ft-save" style="padding:4px 12px;border-radius:4px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer;">保存</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const $ = (id) => panel.querySelector(id);

  const startRecord = (id, input) => {
    const original = headingHotkeys[id] || DEFAULT_HEADING_HOTKEYS[id];
    input.value = '按下新的快捷键...';

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        input.value = hotkeyToLabel(original);
        panel.removeEventListener('keydown', onKey, true);
        input.blur();
        return;
      }

      if (!e.ctrlKey) {
        context.ui.notice('标题快捷键必须包含 Ctrl', 'err');
        input.value = hotkeyToLabel(original);
        panel.removeEventListener('keydown', onKey, true);
        input.blur();
        return;
      }

      const hotkey = {
        ctrl: !!e.ctrlKey,
        shift: !!e.shiftKey,
        alt: !!e.altKey,
        meta: !!e.metaKey,
        code: e.code
      };

      if (isForbiddenHotkey(hotkey)) {
        context.ui.notice('该组合与 FlyMD 内置快捷键冲突，请换一个', 'err');
        input.value = hotkeyToLabel(original);
        panel.removeEventListener('keydown', onKey, true);
        input.blur();
        return;
      }

      headingHotkeys[id] = hotkey;
      input.value = hotkeyToLabel(hotkey);
      panel.removeEventListener('keydown', onKey, true);
      input.blur();
    };

    panel.addEventListener('keydown', onKey, true);
  };

  // 初始化各级标题的显示值和录制逻辑
  HEADING_IDS.forEach((id) => {
    const input = $(`#ft-key-${id}`);
    if (!input) return;
    const hotkey = headingHotkeys[id] || DEFAULT_HEADING_HOTKEYS[id];
    input.value = hotkeyToLabel(hotkey);
    input.addEventListener('click', () => startRecord(id, input));
  });

  $('#ft-cancel').onclick = () => {
    document.body.removeChild(overlay);
  };

  $('#ft-save').onclick = async () => {
    const next = {
      autoStart: $('#ft-auto-start').checked,
      showOnActivate: $('#ft-show-on-activate').checked,
      enableHeadingHotkeys: $('#ft-heading-hotkeys').checked,
      headingHotkeys
    };
    await savePrefs(context, next);
    document.body.removeChild(overlay);
    context.ui.notice('工具条设置已保存', 'ok');
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
    }
  });
}

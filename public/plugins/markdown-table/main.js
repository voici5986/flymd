// Markdown 表格插入插件

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const MT_LOCALE_LS_KEY = 'flymd.locale';
function mtDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en';
    const lower = String(lang || '').toLowerCase();
    if (lower.startsWith('zh')) return 'zh';
  } catch {}
  return 'en';
}
function mtGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    const v = ls && ls.getItem(MT_LOCALE_LS_KEY);
    if (v === 'zh' || v === 'en') return v;
  } catch {}
  return mtDetectLocale();
}
function mtText(zh, en) {
  return mtGetLocale() === 'en' ? en : zh;
}

// 生成 Markdown 表格字符串
function buildTable(colCount, rowCount) {
  const cols = Math.max(1, Math.min(10, colCount | 0));
  const rows = Math.max(1, Math.min(20, rowCount | 0));

  const headerCells = [];
  const alignCells = [];

  for (let i = 1; i <= cols; i++) {
    headerCells.push(mtText('列', 'Col ') + i);
    alignCells.push('---');
  }

  const lines = [];
  lines.push('| ' + headerCells.join(' | ') + ' |');
  lines.push('| ' + alignCells.join(' | ') + ' |');

  for (let r = 0; r < rows; r++) {
    const cells = new Array(cols).fill('');
    lines.push('| ' + cells.join(' | ') + ' |');
  }

  return lines.join('\n');
}

// 将表格插入到当前选区或光标处
function insertTable(context, cols, rows) {
  const table = buildTable(cols, rows);
  const sel = context.getSelection && context.getSelection();

  if (sel && sel.text && sel.text.length > 0) {
    context.replaceRange(sel.start, sel.end, table);
  } else if (context.insertAtCursor) {
    const prefix = '\n';
    const suffix = '\n';
    context.insertAtCursor(prefix + table + suffix);
  } else {
    const content = context.getEditorValue();
    const next = (content || '') + '\n\n' + table + '\n';
    context.setEditorValue(next);
  }

  context.ui.notice(
    mtText('已插入 ', 'Inserted ') + cols + '×' + rows + mtText(' 表格', ' table'),
    'ok',
    2000,
  );
}

// 解析用户输入的行列数
function parseSize(input, fallback, min, max) {
  if (input == null) return fallback;
  const n = parseInt(String(input).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

// 使用输入框方式选择表格大小（降级方案）
function openTablePickerWithPrompt(context) {
  const colInput = prompt(mtText('请输入列数（1-10）', 'Enter number of columns (1-10)'), '3');
  if (colInput === null) return;

  const rowInput = prompt(mtText('请输入数据行数（1-20）', 'Enter number of data rows (1-20)'), '3');
  if (rowInput === null) return;

  const cols = parseSize(colInput, 3, 1, 10);
  const rows = parseSize(rowInput, 3, 1, 20);

  insertTable(context, cols, rows);
}

let tablePickerState = null;

// 打开类似 Word 的表格选择网格
function openTablePicker(context) {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    openTablePickerWithPrompt(context);
    return;
  }

  if (!document.body) {
    openTablePickerWithPrompt(context);
    return;
  }

  if (tablePickerState && tablePickerState.overlay) {
    tablePickerState.overlay.remove();
    window.removeEventListener('keydown', tablePickerState.keyHandler);
    tablePickerState = null;
  }

  const maxCols = 10;
  const maxRows = 8;

  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.background = 'rgba(15,23,42,0.35)';
  overlay.style.zIndex = '999999';

  const panel = document.createElement('div');
  panel.style.background = 'var(--bg, #ffffff)';
  panel.style.color = 'var(--fg, #0f172a)';
  panel.style.borderRadius = '8px';
  panel.style.boxShadow = '0 20px 40px rgba(15,23,42,0.30)';
  panel.style.padding = '12px 16px';
  panel.style.fontSize = '13px';
  panel.style.fontFamily = 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  const label = document.createElement('div');
  label.textContent = mtText('选择表格大小：1 × 1', 'Table size: 1 × 1');
  label.style.marginBottom = '8px';

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(' + maxCols + ', 18px)';
  grid.style.gridTemplateRows = 'repeat(' + maxRows + ', 18px)';
  grid.style.gap = '2px';

  const cells = [];
  for (let r = 1; r <= maxRows; r++) {
    for (let c = 1; c <= maxCols; c++) {
      const cell = document.createElement('div');
      cell.style.width = '18px';
      cell.style.height = '18px';
      cell.style.border = '1px solid #cbd5f5';
      cell.style.borderRadius = '2px';
      cell.style.boxSizing = 'border-box';
      cell.style.background = '#ffffff';
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      grid.appendChild(cell);
      cells.push(cell);
    }
  }

  let currentRows = 1;
  let currentCols = 1;

  const updateHighlight = (rows, cols) => {
    currentRows = rows;
    currentCols = cols;
    label.textContent =
      mtText('选择表格大小：', 'Table size: ') + cols + ' × ' + rows;
    for (const cell of cells) {
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      if (r <= rows && c <= cols) {
        cell.style.background = '#3b82f6';
        cell.style.borderColor = '#1d4ed8';
      } else {
        cell.style.background = '#ffffff';
        cell.style.borderColor = '#cbd5f5';
      }
    }
  };

  for (const cell of cells) {
    cell.addEventListener('mouseover', () => {
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      updateHighlight(r, c);
    });
    cell.addEventListener('click', () => {
      if (currentCols > 0 && currentRows > 0) {
        if (tablePickerState && tablePickerState.overlay) {
          tablePickerState.overlay.remove();
          window.removeEventListener('keydown', tablePickerState.keyHandler);
          tablePickerState = null;
        }
        insertTable(context, currentCols, currentRows);
      }
    });
  }

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      if (tablePickerState && tablePickerState.overlay) {
        tablePickerState.overlay.remove();
        window.removeEventListener('keydown', keyHandler);
        tablePickerState = null;
      }
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      if (tablePickerState && tablePickerState.overlay) {
        tablePickerState.overlay.remove();
        window.removeEventListener('keydown', keyHandler);
        tablePickerState = null;
      }
    }
  });

  panel.appendChild(label);
  panel.appendChild(grid);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  tablePickerState = { overlay, keyHandler };
  window.addEventListener('keydown', keyHandler);

  updateHighlight(1, 1);
}

export function activate(context) {
  context.addMenuItem({
    label: mtText('表格', 'Table'),
    title: mtText('插入 Markdown 表格', 'Insert Markdown table'),
    onClick: () => {
      openTablePicker(context);
    }
  });

  // 右键菜单：在当前光标处插入表格
  context.addContextMenuItem({
    label: mtText('插入表格…', 'Insert table…'),
    icon: '📊',
    condition: (ctx) => ctx.mode === 'edit' || ctx.mode === 'wysiwyg',
    onClick: () => {
      openTablePicker(context);
    }
  });

  context.ui.notice(
    mtText('Markdown 表格助手已激活', 'Markdown Table Helper activated'),
    'ok',
    1600,
  );
}

export function deactivate() {
  // 无需特殊清理
}

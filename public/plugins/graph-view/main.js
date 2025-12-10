// 关系图谱插件：基于 backlinks 索引绘制当前文档的局部关系图

let _panelRoot = null
let _pollTimer = null
let _ctxMenuDisposer = null
let _lastContext = null

// 规范化路径：与 backlinks 插件保持一致
function normalizePath(path) {
  if (!path) return ''
  const s = String(path).trim()
  if (!s) return ''
  return s.replace(/\\/g, '/')
}

// 从 backlinks 插件获取索引快照（只读对象）
function getBacklinksIndexSnapshot(context) {
  try {
    if (!context || typeof context.getPluginAPI !== 'function') return null
    const api = context.getPluginAPI('backlinks-index')
    if (!api || typeof api.getIndexSnapshot !== 'function') return null
    const snap = api.getIndexSnapshot()
    if (!snap || typeof snap !== 'object') return null
    if (!snap.docs || typeof snap.docs !== 'object') return null
    return snap
  } catch (e) {
    console.error('[graph-view] 获取 backlinks 索引失败', e)
    return null
  }
}

// 基于索引和当前文档，构建“中心 + 一层邻居”的局部图
function buildLocalGraph(snapshot, currentNormPath) {
  if (!snapshot || !snapshot.docs || !currentNormPath) return null
  const docs = snapshot.docs || {}
  const forward = snapshot.forward || {}
  const backward = snapshot.backward || {}
  if (!docs[currentNormPath]) return null

  const nodes = []
  const edges = []
  const nodeMap = new Map()

  function addNode(norm, kind) {
    if (!norm) return null
    if (nodeMap.has(norm)) return nodeMap.get(norm)
    const info = docs[norm]
    if (!info) return null
    const label = info.title || info.name || info.path || norm
    const node = {
      id: norm,
      path: info.path || norm,
      label,
      kind: kind || 'neighbor',
      x: 0,
      y: 0,
    }
    nodeMap.set(norm, node)
    nodes.push(node)
    return node
  }

  // 中心节点
  addNode(currentNormPath, 'center')

  // 一层邻居：出链 + 入链
  const neighborSet = new Set()
  const outArr = forward[currentNormPath]
  if (Array.isArray(outArr)) {
    for (const to of outArr) {
      if (to && typeof to === 'string') neighborSet.add(to)
    }
  }
  const inArr = backward[currentNormPath]
  if (Array.isArray(inArr)) {
    for (const from of inArr) {
      if (from && typeof from === 'string') neighborSet.add(from)
    }
  }

  const MAX_NEIGHBOR = 40
  let count = 0
  for (const norm of neighborSet) {
    if (!docs[norm]) continue
    count++
    if (count > MAX_NEIGHBOR) break
    addNode(norm, 'neighbor')
    edges.push({ from: currentNormPath, to: norm })
  }

  return { nodes, edges }
}

// 简单圆形布局：中心在中间，邻居环绕
function layoutGraph(nodes, panelWidth, panelHeight) {
  if (!Array.isArray(nodes) || nodes.length === 0) return
  const w = Math.max(120, Number(panelWidth) || 260)
  const h = Math.max(160, Number(panelHeight) || 260)
  const cx = w / 2
  const cy = h / 2

  let center = null
  for (const n of nodes) {
    if (n.kind === 'center') {
      center = n
      break
    }
  }
  if (!center) center = nodes[0]
  center.x = cx
  center.y = cy

  const others = nodes.filter((n) => n !== center)
  const n = others.length
  if (!n) return
  const radius = Math.max(40, Math.min(w, h) / 2 - 40)
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n
    const x = cx + radius * Math.cos(angle)
    const y = cy + radius * Math.sin(angle)
    others[i].x = x
    others[i].y = y
  }
}

// 统一控制 Panel 显隐
function setPanelVisible(visible) {
  if (!_panelRoot) return
  const v = !!visible
  _panelRoot.style.display = v ? 'flex' : 'none'
}

// 在 Panel 中渲染关系图
function renderGraphPanel(context, panelRoot) {
  if (!panelRoot) return

  // 清空内容
  while (panelRoot.firstChild) {
    panelRoot.removeChild(panelRoot.firstChild)
  }

  // 头部：标题 + 操作
  const header = document.createElement('div')
  header.style.flex = '0 0 auto'
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.padding = '6px 8px'
  header.style.fontSize = '12px'
  header.style.borderBottom = '1px solid rgba(0,0,0,0.06)'
  header.style.background = 'rgba(255,255,255,0.9)'
  header.style.cursor = 'move'

  const titleSpan = document.createElement('span')
  titleSpan.textContent = '关系图谱'
  titleSpan.style.fontWeight = '600'

  const btnBox = document.createElement('div')
  btnBox.style.display = 'flex'
  btnBox.style.gap = '4px'

  const btnRefresh = document.createElement('button')
  btnRefresh.textContent = '刷新'
  btnRefresh.style.fontSize = '11px'
  btnRefresh.style.padding = '2px 6px'
  btnRefresh.style.cursor = 'pointer'

  const btnHide = document.createElement('button')
  btnHide.textContent = '隐藏'
  btnHide.style.fontSize = '11px'
  btnHide.style.padding = '2px 6px'
  btnHide.style.cursor = 'pointer'

  btnRefresh.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    renderGraphPanel(context, panelRoot)
  })
  btnHide.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    setPanelVisible(false)
  })

  btnBox.appendChild(btnRefresh)
  btnBox.appendChild(btnHide)
  header.appendChild(titleSpan)
  header.appendChild(btnBox)
  panelRoot.appendChild(header)

  // 悬浮窗拖动：按住头部空白区域拖动
  header.addEventListener('mousedown', (e) => {
    try {
      if (e.button !== 0) return
      const target = e.target
      if (
        target &&
        target.tagName &&
        (target.tagName.toLowerCase() === 'button' ||
          target.closest('button'))
      ) {
        return
      }
      const rect = panelRoot.getBoundingClientRect()
      const startX = e.clientX
      const startY = e.clientY
      let startLeft = rect.left
      let startTop = rect.top

      panelRoot.style.transform = 'none'
      panelRoot.style.left = startLeft + 'px'
      panelRoot.style.top = startTop + 'px'

      const move = (ev) => {
        try {
          const dx = ev.clientX - startX
          const dy = ev.clientY - startY
          let nextLeft = startLeft + dx
          let nextTop = startTop + dy
          const vw = window.innerWidth || 1280
          const vh = window.innerHeight || 720
          const w = rect.width
          const h = rect.height
          const margin = 24
          const minLeft = margin - w
          const maxLeft = vw - margin
          const minTop = margin - h
          const maxTop = vh - margin
          if (nextLeft < minLeft) nextLeft = minLeft
          if (nextLeft > maxLeft) nextLeft = maxLeft
          if (nextTop < minTop) nextTop = minTop
          if (nextTop > maxTop) nextTop = maxTop
          panelRoot.style.left = nextLeft + 'px'
          panelRoot.style.top = nextTop + 'px'
        } catch {}
      }
      const up = () => {
        try {
          window.removeEventListener('mousemove', move, true)
          window.removeEventListener('mouseup', up, true)
        } catch {}
      }
      window.addEventListener('mousemove', move, true)
      window.addEventListener('mouseup', up, true)
      e.preventDefault()
    } catch {}
  })

  // 当前文档信息
  const infoBar = document.createElement('div')
  infoBar.style.flex = '0 0 auto'
  infoBar.style.padding = '4px 8px'
  infoBar.style.fontSize = '11px'
  infoBar.style.borderBottom = '1px dashed rgba(0,0,0,0.06)'
  infoBar.style.color = 'rgba(0,0,0,0.6)'

  const curPathRaw =
    context.getCurrentFilePath && context.getCurrentFilePath()
  const curNorm = normalizePath(curPathRaw)

  const snapshot = getBacklinksIndexSnapshot(context)
  const docs = snapshot && snapshot.docs ? snapshot.docs : {}
  const curDoc = curNorm && docs ? docs[curNorm] : null

  if (curDoc) {
    infoBar.textContent =
      '当前：' +
      (curDoc.title || curDoc.name || curDoc.path || curNorm)
  } else if (curNorm) {
    infoBar.textContent =
      '当前文档尚未出现在索引中，请先保存并在文档中使用 [[名称]] 链接。'
  } else {
    infoBar.textContent = '当前没有已保存的文档。'
  }

  panelRoot.appendChild(infoBar)

  const body = document.createElement('div')
  body.style.position = 'relative'
  body.style.flex = '1 1 auto'
  body.style.overflow = 'hidden'
  body.style.background = 'var(--bg-color, #fafafa)'
  body.style.borderTop = '1px solid rgba(0,0,0,0.03)'
  panelRoot.appendChild(body)

  if (!snapshot) {
    const msg = document.createElement('div')
    msg.style.padding = '8px'
    msg.style.fontSize = '12px'
    msg.style.color = 'rgba(0,0,0,0.6)'
    msg.style.whiteSpace = 'pre-line'
    msg.textContent =
      '未检测到双向链接索引。\n请先启用“双向链接”插件，并在其菜单中执行“重建双向链接索引”。'
    body.appendChild(msg)
    return
  }

  if (!curNorm || !curDoc) {
    const msg = document.createElement('div')
    msg.style.padding = '8px'
    msg.style.fontSize = '12px'
    msg.style.color = 'rgba(0,0,0,0.6)'
    msg.style.whiteSpace = 'pre-line'
    msg.textContent =
      '当前文档未在索引中。\n请确认已保存，并使用 [[名称]] 语法建立链接，然后在“双向链接”插件中重建索引。'
    body.appendChild(msg)
    return
  }

  const graph = buildLocalGraph(snapshot, curNorm)
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    const msg = document.createElement('div')
    msg.style.padding = '8px'
    msg.style.fontSize = '12px'
    msg.style.color = 'rgba(0,0,0,0.6)'
    msg.style.whiteSpace = 'pre-line'
    msg.textContent =
      '没有找到与当前文档的链接关系。\n请在其他文档中使用 [[当前文档名称]] 建立链接，或在当前文档中链接其他文档。'
    body.appendChild(msg)
    return
  }

  const nodeById = {}
  for (const n of graph.nodes) {
    nodeById[n.id] = n
  }

  const panelWidth = panelRoot.clientWidth || 260
  const panelHeight =
    panelRoot.clientHeight - header.clientHeight - infoBar.clientHeight || 260

  layoutGraph(graph.nodes, panelWidth, panelHeight)

  // 绘制边
  for (const e of graph.edges || []) {
    const a = nodeById[e.from]
    const b = nodeById[e.to]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (!Number.isFinite(dist) || dist <= 0) continue
    const angle = Math.atan2(dy, dx)

    // 让连线只连接到节点"边缘"，而不是穿过节点中心
    const r1 = a.kind === 'center' ? 18 : 14
    const r2 = b.kind === 'center' ? 18 : 14
    const minGap = r1 + r2 + 4
    if (dist <= minGap) continue
    const ux = dx / dist
    const uy = dy / dist
    const startX = a.x + ux * r1
    const startY = a.y + uy * r1
    const segLen = dist - r1 - r2

    const line = document.createElement('div')
    line.style.position = 'absolute'
    line.style.left = startX + 'px'
    line.style.top = startY + 'px'
    line.style.width = segLen + 'px'
    line.style.height = '1px'
    line.style.background = 'rgba(0,0,0,0.22)'
    line.style.transformOrigin = '0 50%'
    line.style.transform = 'rotate(' + angle + 'rad)'
    line.style.pointerEvents = 'none'
    body.appendChild(line)
  }

  // 绘制节点
  for (const n of graph.nodes) {
    const el = document.createElement('div')
    el.className = 'flymd-graph-node'
    el.textContent = n.label
    el.title = n.path || ''

    const isCenter = n.kind === 'center'
    const radius = isCenter ? 18 : 14

    el.style.position = 'absolute'
    el.style.left = n.x + 'px'
    el.style.top = n.y + 'px'
    el.style.transform = 'translate(-50%, -50%)'
    el.style.minWidth = '40px'
    el.style.maxWidth = '160px'
    el.style.padding = '2px 6px'
    el.style.borderRadius = '999px'
    el.style.fontSize = isCenter ? '12px' : '11px'
    el.style.textAlign = 'center'
    el.style.whiteSpace = 'nowrap'
    el.style.overflow = 'hidden'
    el.style.textOverflow = 'ellipsis'
    el.style.cursor = 'pointer'
    el.style.boxSizing = 'border-box'
    el.style.border = isCenter
      ? '1px solid rgba(0,120,215,0.8)'
      : '1px solid rgba(0,0,0,0.18)'
    el.style.background = isCenter
      ? 'rgba(0,120,215,0.1)'
      : 'rgba(255,255,255,0.9)'
    el.style.color = isCenter
      ? 'rgba(0,70,150,0.95)'
      : 'rgba(0,0,0,0.85)'
    el.style.boxShadow = isCenter
      ? '0 0 0 1px rgba(0,120,215,0.15)'
      : '0 1px 2px rgba(0,0,0,0.08)'
    el.style.lineHeight = radius * 2 + 'px'
    el.style.height = radius * 2 + 'px'

    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const targetPath = n.path
      if (!targetPath || !context || !context.openFileByPath) return
      try {
        context.openFileByPath(targetPath)
      } catch {}
    })

    body.appendChild(el)
  }

  // 右下角拖拽缩放
  try {
    const resizer = document.createElement('div')
    resizer.style.position = 'absolute'
    resizer.style.right = '6px'
    resizer.style.bottom = '6px'
    resizer.style.width = '16px'
    resizer.style.height = '16px'
    resizer.style.cursor = 'se-resize'
    resizer.style.borderRight = '2px solid rgba(0,0,0,0.3)'
    resizer.style.borderBottom = '2px solid rgba(0,0,0,0.3)'
    resizer.style.borderLeft = 'transparent'
    resizer.style.borderTop = 'transparent'
    resizer.style.boxSizing = 'border-box'
    resizer.style.background = 'rgba(255,255,255,0.7)'
    resizer.style.borderRadius = '3px'

    resizer.addEventListener('mousedown', (e) => {
      try {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const rect = panelRoot.getBoundingClientRect()
        const startX = e.clientX
        const startY = e.clientY
        const startW = rect.width
        const startH = rect.height
        const minW = 520
        const minH = 380
        const maxW = Math.min((window.innerWidth || 1280) - 40, 980)
        const maxH = Math.min((window.innerHeight || 720) - 40, 720)

        const move = (ev) => {
          try {
            const dx = ev.clientX - startX
            const dy = ev.clientY - startY
            let w = startW + dx
            let h = startH + dy
            if (w < minW) w = minW
            if (h < minH) h = minH
            if (w > maxW) w = maxW
            if (h > maxH) h = maxH
            panelRoot.style.width = w + 'px'
            panelRoot.style.height = h + 'px'
          } catch {}
        }
        const up = () => {
          try {
            window.removeEventListener('mousemove', move, true)
            window.removeEventListener('mouseup', up, true)
            if (_lastContext && _panelRoot) {
              renderGraphPanel(_lastContext, _panelRoot)
            }
          } catch {}
        }
        window.addEventListener('mousemove', move, true)
        window.addEventListener('mouseup', up, true)
      } catch {}
    })

    body.appendChild(resizer)
  } catch {}
}

export async function activate(context) {
  _lastContext = context
  // 悬浮窗口：默认隐藏，由用户手动打开
  const panelVisible = false
  const panelWidth = 640
  const panelHeight = 420

  try {
    const container = document.querySelector('.container') || document.body
    const root = document.createElement('div')
    root.id = 'flymd-graph-view-panel'
    // 居中悬浮窗口
    root.style.position = 'fixed'
    root.style.left = '50%'
    root.style.top = '50%'
    root.style.transform = 'translate(-50%, -50%)'
    root.style.width = panelWidth + 'px'
    root.style.maxWidth = 'min(90vw, 720px)'
    root.style.height = panelHeight + 'px'
    root.style.maxHeight = 'min(80vh, 520px)'
    root.style.overflow = 'hidden'
    root.style.borderRadius = '10px'
    root.style.border = '1px solid rgba(0,0,0,0.12)'
    root.style.background = 'var(--bg-color, #ffffff)'
    root.style.boxShadow = '0 10px 30px rgba(0,0,0,0.18)'
    root.style.display = panelVisible ? 'flex' : 'none'
    root.style.flexDirection = 'column'
    root.style.zIndex = '9999'

    if (container) {
      container.appendChild(root)
      _panelRoot = root
    } else if (context.ui && typeof context.ui.notice === 'function') {
      context.ui.notice(
        '未找到工作区容器，关系图谱面板无法挂载',
        'err',
        2500,
      )
    }
  } catch (e) {
    console.error('[graph-view] 创建 Panel 失败', e)
  }

  if (_panelRoot) {
    renderGraphPanel(context, _panelRoot)
  }

  // 定时检测当前文档变化，自动刷新关系图
  try {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
    let lastPath = normalizePath(
      context.getCurrentFilePath && context.getCurrentFilePath(),
    )
    _pollTimer = window.setInterval(() => {
      try {
        const cur = normalizePath(
          context.getCurrentFilePath && context.getCurrentFilePath(),
        )
        if (cur && cur !== lastPath) {
          lastPath = cur
          if (_panelRoot && _panelRoot.style.display !== 'none') {
            renderGraphPanel(context, _panelRoot)
          }
        }
      } catch {}
    }, 1500)
  } catch {}

  // 在“插件”菜单中增加入口：刷新 + 显示/隐藏面板
  try {
    context.addMenuItem({
      label: '关系图谱',
      children: [
        {
          label: '刷新当前关系图',
          onClick: () => {
            if (_panelRoot) {
              renderGraphPanel(context, _panelRoot)
              setPanelVisible(true)
            }
          },
        },
        {
          label: '显示/隐藏关系图谱面板',
          onClick: () => {
            if (!_panelRoot) return
            const visible =
              !_panelRoot.style.display ||
              _panelRoot.style.display !== 'none'
            const next = !visible
            setPanelVisible(next)
            if (next) {
              renderGraphPanel(context, _panelRoot)
            }
          },
        },
      ],
    })
  } catch (e) {
    console.error('[graph-view] 注册菜单失败', e)
  }

  // 编辑区 / 所见模式右键：快速打开关系图谱
  try {
    if (context.addContextMenuItem) {
      _ctxMenuDisposer = context.addContextMenuItem({
        label: '关系图谱',
        icon: '🕸️',
        condition: (ctx) => {
          return (
            ctx.mode === 'edit' ||
            ctx.mode === 'preview' ||
            ctx.mode === 'wysiwyg'
          )
        },
        onClick: () => {
          try {
            if (!_panelRoot) return
            const visible =
              !_panelRoot.style.display ||
              _panelRoot.style.display !== 'none'
            const next = !visible
            setPanelVisible(next)
            if (next) {
              renderGraphPanel(context, _panelRoot)
            }
          } catch (e) {
            console.error('[graph-view] 右键打开关系图谱失败', e)
          }
        },
      })
    }
  } catch (e) {
    console.error('[graph-view] 注册右键菜单失败', e)
  }
}

export function deactivate() {
  try {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
    if (_ctxMenuDisposer && typeof _ctxMenuDisposer === 'function') {
      try {
        _ctxMenuDisposer()
      } catch {}
    }
    if (_panelRoot && _panelRoot.parentNode) {
      _panelRoot.parentNode.removeChild(_panelRoot)
    }
  } catch {}
  _panelRoot = null
  _ctxMenuDisposer = null
}

// 所见模式切换的“无感/后台”辅助：只做 UI 状态（CSS class）
// 注意：这里刻意不依赖 main.ts 的全局变量，避免耦合进一步扩散

// 后台预热：让 #md-wysiwyg-root 可创建并参与布局，但保持透明不拦截交互
export function setWysiwygPreload(container: HTMLElement | null, enabled: boolean) {
  if (!container) return
  try {
    if (enabled) container.classList.add('wysiwyg-v2-preload')
    else container.classList.remove('wysiwyg-v2-preload')
  } catch {}
}

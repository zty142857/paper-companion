// 加载指示基座：Spinner 用于按钮/行内等待，Skeleton 用于整块内容占位。
// 动画都是标准 CSS animation，会被 base.css 的全局 prefers-reduced-motion 规则关掉。

export function Spinner({ size = 16 }: { size?: number }) {
  // 边框粗细随尺寸缩放，大圈不会显得细若游丝；颜色继承 currentColor，随文字色走
  return (
    <span className="spinner" role="status" aria-label="加载中"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 8)) }} />
  )
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    // 纯装饰占位，对读屏器隐藏，避免朗读一堆空块
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        // 最后一行短一截，模拟真实文本的收尾，更像"内容加载中"而非表格
        <div key={i} className="skeleton-line"
          style={lines > 1 && i === lines - 1 ? { width: '60%' } : undefined} />
      ))}
    </div>
  )
}

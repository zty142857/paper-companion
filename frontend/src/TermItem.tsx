import { useRef, useState } from 'react'
import type { Card } from './api'
import Markdown from './Markdown'

interface Props {
  term: string
  zh: string
  top: number
  card?: Card                       // 已持久化的术语解释卡（存在则显示已生成内容）
  onExpand: () => void              // 展开（首次展开时按需生成解释）
  onCollapse: () => void
  onDelete: () => void              // 删除术语卡片（隐藏该术语）
  onTop: (t: number) => void        // 拖拽中/结束的位置
  onDrop: (t: number) => void       // 松手：重新锚定
  onJump: (page: number) => void
}

const WIDTH = 300

/**
 * 术语元素，两种形态：
 * - 未点击过（无卡）：琥珀色小卡（chip），用于区分"尚未查看的术语"。
 * - 点击过（有卡）：与翻译卡同一形态——折叠时只显示卡片头，展开时显示解释正文。
 */
export default function TermItem({
  term, zh, top, card, onExpand, onCollapse, onDelete, onTop, onDrop, onJump,
}: Props) {
  const [confirmDel, setConfirmDel] = useState(false)
  const drag = useRef<{ startY: number; startTop: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const expanded = !!card && !card.data.collapsed
  const d = card?.data ?? {}
  const loading = expanded && !!d.pending
  const error = expanded && !!d.error

  const toggle = () => { expanded ? onCollapse() : onExpand() }

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragged.current = false
    drag.current = { startY: e.clientY, startTop: top, moved: false }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return
    if (Math.abs(e.clientY - drag.current.startY) > 4) { drag.current.moved = true; dragged.current = true }
    if (!drag.current.moved) return
    onTop(Math.max(0, drag.current.startTop + e.clientY - drag.current.startY))
  }
  const up = () => {
    if (!drag.current) return
    const moved = drag.current.moved
    drag.current = null
    if (moved) onDrop(top)
  }
  const clickHead = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (!dragged.current) toggle()
  }

  // 未点击过：琥珀色小卡
  if (!card) {
    return (
      <div className="term-chip" data-term={term} style={{ top }} onClick={onExpand}
        title={`点击生成「${term}」的解释`}>
        <span className="tc-t">{term}</span>
        {zh && <span className="tc-zh">{zh}</span>}
        {confirmDel ? (
          <span className="del-confirm">
            <span className="del-ask">删除？</span>
            <button className="x del-yes" title="确认删除" onClick={(e) => { e.stopPropagation(); setConfirmDel(false); onDelete() }}>✓</button>
            <button className="x" title="取消" onClick={(e) => { e.stopPropagation(); setConfirmDel(false) }}>✕</button>
          </span>
        ) : (
          <button className="x" title="删除术语小卡" onClick={(e) => { e.stopPropagation(); setConfirmDel(true) }}>✕</button>
        )}
      </div>
    )
  }

  return (
    <div className={`card term${expanded ? ' active' : ''}`} data-id={card?.id || `term:${term}`} data-term={term}
      style={{ top, width: card?.data.width ?? WIDTH }}>
      <div className="ch" onPointerDown={down} onPointerMove={move} onPointerUp={up} onClick={clickHead}>
        <span className="ico">📚</span>
        <span className="ct">{term}{zh ? <span className="ct-zh">{zh}</span> : null}</span>
        <button className="x toggle" title={expanded ? '收起' : '展开并生成解释'} onClick={toggle}>{expanded ? '▾' : '▸'}</button>
        {confirmDel ? (
          <span className="del-confirm">
            <span className="del-ask">删除？</span>
            <button className="x del-yes" title="确认删除" onClick={() => { setConfirmDel(false); onDelete() }}>✓</button>
            <button className="x" title="取消" onClick={() => setConfirmDel(false)}>✕</button>
          </span>
        ) : (
          <button className="x" title="删除术语卡" onClick={() => setConfirmDel(true)}>✕</button>
        )}
      </div>
      {expanded && <div className="cb">
        {d.zh && <div className="term-zh">{d.zh}</div>}
        {error ? <div className="err">解释生成失败：{d.error}</div>
          : loading ? <div className="loading">正在生成解释…</div>
          : <Markdown className="tr" text={d.expl || ''} />}
        {!!d.pages?.length && <div className="src">
          {d.pages.map((p: number) => <button key={p} onClick={() => onJump(p)}>📄 第{p}页</button>)}
        </div>}
      </div>}
    </div>
  )
}

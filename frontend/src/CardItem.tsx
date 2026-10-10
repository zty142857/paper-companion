import { useRef, useState } from 'react'
import type { Card } from './api'
import Markdown from './Markdown'

interface Props {
  card: Card
  top: number
  active: boolean
  onActivate: () => void
  onTop: (top: number) => void           // 拖拽中/结束的位置
  onDrop: (top: number) => void          // 松手：重新锚定
  onDelete: () => void
  onAsk: (q: string) => Promise<void>    // 发送子对话问题
  onJump: (page: number) => void
  onResize: (w: number) => void          // 拖拽右边缘调整宽度（实时）
  onResizeEnd: (w: number) => void       // 松手：落库
}

const CARD_DEFAULT_W = 288
const CARD_MIN_W = 220
const CARD_MAX_W = 640
const CARD_W_STEP = 1.08      // 双击缩放宽/高

const clampW = (w: number) => Math.round(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, w)))

const TYPE_ICON: Record<string, string> = { translation: '🈶', chat: '💬', term: '📚' }

export default function CardItem({ card, top, active, onActivate, onTop, onDrop, onDelete, onAsk, onJump, onResize, onResizeEnd }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const width = card.data.width ?? CARD_DEFAULT_W
  const drag = useRef<{ startY: number; startTop: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const resize = useRef<{ startX: number; startW: number } | null>(null)
  const d = card.data
  const isGlobalChat = card.type === 'chat' && !!d.global
  const title = card.type === 'translation' ? (d.pending ? '译文 · 翻译中…' : d.error ? '译文 · 失败' : `译文 · 第${d.page ?? '?'}页`)
    : card.type === 'term' ? `术语 · ${d.term}` : isGlobalChat ? '子对话 · 🌐全文' : '子对话'
  // 收起时也显示一段预览，避免用户以为卡片是空的
  const preview = card.type === 'translation'
    ? (d.error ? `翻译失败：${d.error}` : d.pending ? '翻译中…' : (d.translation || d.orig || ''))
    : ((d.messages ?? []).slice(-1)[0]?.content || '点开输入你的问题')

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
    if (!dragged.current) setOpen((o) => !o)
  }

  const rdown = (e: React.PointerEvent) => {
    e.stopPropagation()
    resize.current = { startX: e.clientX, startW: width }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const rmove = (e: React.PointerEvent) => {
    if (!resize.current) return
    onResize(clampW(resize.current.startW + e.clientX - resize.current.startX))
  }
  const rup = (e: React.PointerEvent) => {
    if (!resize.current) return
    resize.current = null
    // 双击右边缘：在默认/放宽之间切换
    const w = e.detail === 2
      ? clampW(width > CARD_DEFAULT_W ? CARD_DEFAULT_W : CARD_DEFAULT_W * CARD_W_STEP * CARD_W_STEP)
      : width
    if (w !== width) onResize(w)
    onResizeEnd(w)
  }

  const ask = async () => {
    const t = q.trim()
    if (!t || busy) return
    setBusy(true); setQ('')
    try { await onAsk(t) } finally { setBusy(false) }
  }

  return (
    <div className={`card ${card.type}${active ? ' active' : ''}`} data-id={card.id} style={{ top, width }}
      onPointerDownCapture={onActivate}>
      <div className="ch" onPointerDown={down} onPointerMove={move} onPointerUp={up} onClick={clickHead}>
        <span className="ico">{isGlobalChat ? '🌐' : (TYPE_ICON[card.type] ?? '📌')}</span>
        <span className="ct">{title}</span>
        <button className="x toggle" title={open ? '收起' : '展开'} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
        {confirmDel ? (
          <span className="del-confirm">
            <span className="del-ask">删除？</span>
            <button className="x del-yes" title="确认删除" onClick={() => { setConfirmDel(false); onDelete() }}>✓</button>
            <button className="x" title="取消" onClick={() => setConfirmDel(false)}>✕</button>
          </span>
        ) : (
          <button className="x" title="删除卡片" onClick={() => setConfirmDel(true)}>✕</button>
        )}
      </div>
      {!open && preview && <div className="preview">{preview}</div>}
      {open && <div className="cb">
        {card.type === 'translation' && <>
          <div className="orig">{d.orig}</div>
          {d.error ? <div className="err">翻译失败：{d.error}</div>
            : d.pending ? <div className="loading">翻译中…</div>
            : <Markdown className="tr" text={d.translation} />}
        </>}
        {(card.type === 'chat' || card.type === 'term') && <>
          {card.type === 'term' && <>
            {card.data.zh && <div className="term-zh">{d.zh}</div>}
            {d.error ? <div className="err">解释生成失败：{d.error}</div>
              : d.pending ? <div className="loading">正在生成解释…</div>
              : <Markdown className="tr" text={d.expl} />}
          </>}
          {(d.messages ?? []).map((m: any, i: number) => (
            <div key={i} className={m.role === 'user' ? 'msg u' : 'msg a'}>
              {m.role === 'user' ? m.content : <>
                <Markdown text={m.content} />
                {m.pages?.length > 0 && <div className="src">
                  {m.pages.map((p: number) => <button key={p} onClick={() => onJump(p)}>📄 第{p}页</button>)}
                </div>}
              </>}
            </div>
          ))}
          <div className="ask">
            <input value={q} placeholder={busy ? '思考中…' : isGlobalChat ? '就整篇论文提问…' : '继续追问…'} disabled={busy}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
            <button className="btn small primary" onClick={ask} disabled={busy}>发送</button>
          </div>
        </>}
      </div>}
      <div className="resizer" title="拖动调整宽度（双击复位）"
        onPointerDown={rdown} onPointerMove={rmove} onPointerUp={rup} />
    </div>
  )
}

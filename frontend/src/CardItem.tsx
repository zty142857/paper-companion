import { useEffect, useRef, useState } from 'react'
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
  onPatch: (data: Record<string, any>) => void   // 笔记等就地编辑后落库
}

const TYPE_ICON: Record<string, string> = { translation: '🈶', chat: '💬', term: '📚', note: '📝' }

export default function CardItem({ card, top, active, onActivate, onTop, onDrop, onDelete, onAsk, onJump, onPatch }: Props) {
  const [open, setOpen] = useState(card.type === 'note' && !card.data?.text)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [noteText, setNoteText] = useState<string>(card.data?.text ?? '')
  const drag = useRef<{ startY: number; startTop: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const d = card.data
  useEffect(() => { setNoteText(d.text ?? '') }, [card.id, d.text])
  const isGlobalChat = card.type === 'chat' && !!d.global
  const isTableChat = card.type === 'chat' && !!d.table_id
  const title = card.type === 'translation' ? (d.pending ? '译文 · 翻译中…' : d.error ? '译文 · 失败' : `译文 · 第${d.page ?? '?'}页`)
    : card.type === 'term' ? `术语 · ${d.term}` : card.type === 'note' ? '笔记'
      : isTableChat ? `表格 · ${String(d.table_caption || d.table_id).slice(0, 36)}`
        : isGlobalChat ? '子对话 · 🌐全文' : '子对话'
  // 收起时也显示一段预览，避免用户以为卡片是空的
  const preview = card.type === 'translation'
    ? (d.error ? `翻译失败：${d.error}` : d.pending ? '翻译中…' : (d.translation || d.orig || ''))
    : card.type === 'note' ? (d.text || '点开写笔记…')
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

  const ask = async () => {
    const t = q.trim()
    if (!t || busy) return
    setBusy(true); setQ('')
    try { await onAsk(t) } finally { setBusy(false) }
  }

  const saveNote = () => {
    if (noteText !== (d.text ?? '')) onPatch({ ...d, text: noteText })
  }

  return (
    <div className={`card ${card.type}${active ? ' active' : ''}`} data-id={card.id} style={{ top }}
      onPointerDownCapture={onActivate}>
      <div className="ch" onPointerDown={down} onPointerMove={move} onPointerUp={up} onClick={clickHead}>
        <span className="ico">{isTableChat ? '▦' : isGlobalChat ? '🌐' : (TYPE_ICON[card.type] ?? '📌')}</span>
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
        {card.type === 'note' && (
          <>
            <textarea className="note-editor" rows={5} autoFocus={!d.text}
              placeholder="写下你的笔记…（失焦自动保存；支持 $公式$）"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onBlur={saveNote}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }} />
            {/\$|\\\(|\\\[/.test(noteText) && (
              <div className="note-preview"><Markdown text={noteText} /></div>
            )}
          </>
        )}
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
              {m.role === 'user' ? <Markdown text={m.content} /> : <>
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
    </div>
  )
}

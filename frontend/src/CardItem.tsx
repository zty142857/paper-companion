import { useEffect, useRef, useState } from 'react'
import {
  BookOpen, Check, ChevronDown, ChevronRight, FileText, Globe, Languages,
  MessageCircle, NotebookPen, Pin, RefreshCw, Search, Table2, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Card } from './api'
import Markdown from './Markdown'
import { Spinner } from './components/Loading'

/** 流式回答的本地态（不落库）：delta 增量文本 + 实时检索步骤 */
export interface ChatStreamView {
  text: string
  steps: string[]
}

interface Props {
  card: Card
  top: number
  active: boolean
  stream?: ChatStreamView              // 有值=正在流式回答（含思考中/检索步骤）
  onActivate: () => void
  onTop: (top: number) => void           // 拖拽中/结束的位置
  onDrop: (top: number) => void          // 松手：重新锚定
  onDelete: () => void
  onAsk: (q: string) => Promise<void>    // 发送子对话问题
  onRetry: () => Promise<void>           // 中断/失败后重发 pendingQuestion
  onCancelAsk?: () => void               // 取消在途回答
  onJump: (page: number) => void
  onPatch: (data: Record<string, any>) => Promise<void>   // 笔记等就地编辑后落库（失败抛错）
}

const TYPE_ICON: Record<string, LucideIcon> = { translation: Languages, chat: MessageCircle, term: BookOpen, note: NotebookPen }

export default function CardItem({ card, top, active, stream, onActivate, onTop, onDrop, onDelete, onAsk, onRetry, onCancelAsk, onJump, onPatch }: Props) {
  // 笔记空卡自动展开；刷新后加载到中断的对话卡也自动展开，让「重试」直接可见
  const [open, setOpen] = useState((card.type === 'note' && !card.data?.text)
    || (card.type === 'chat' && !!card.data?.pendingQuestion))
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [noteText, setNoteText] = useState<string>(card.data?.text ?? '')
  // 笔记保存状态：saving/saved 小字反馈；error 保留编辑态，失焦再试不丢稿
  const [noteState, setNoteState] = useState<'' | 'saving' | 'saved' | 'error'>('')
  const noteDirty = useRef(false)
  const noteTimer = useRef(0)
  const drag = useRef<{ startY: number; startTop: number; currentTop: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const d = card.data
  useEffect(() => { noteDirty.current = false; setNoteText(d.text ?? '') }, [card.id])
  // 有未保存草稿时不同步外部 data（保存失败回滚也不丢稿）
  useEffect(() => { if (!noteDirty.current) setNoteText(d.text ?? '') }, [d.text])
  useEffect(() => () => window.clearTimeout(noteTimer.current), [])
  const streaming = !!stream
  // 流式回答到达时自动展开卡片，保证用户看得到增量
  useEffect(() => { if (streaming) setOpen(true) }, [streaming])
  const isGlobalChat = card.type === 'chat' && !!d.global
  const isTableChat = card.type === 'chat' && !!d.table_id
  const isSelTrans = card.type === 'translation' && !!d.selection
  const title = card.type === 'translation'
    ? (d.pending ? '译文 · 翻译中…' : d.error ? '译文 · 失败'
      : `${isSelTrans ? '划词译文' : '译文'} · 第${d.page ?? '?'}页`)
    : card.type === 'term' ? `术语 · ${d.term}` : card.type === 'note' ? '笔记'
      : isTableChat ? `表格 · ${String(d.table_caption || d.table_id).slice(0, 36)}`
        : isGlobalChat ? '子对话 · 全文' : '子对话'
  // 收起时也显示一段预览，避免用户以为卡片是空的
  const rawPreview = card.type === 'translation'
    ? (d.error ? `翻译失败：${d.error}` : d.pending ? '翻译中…' : (d.translation || d.orig || ''))
    : card.type === 'note' ? (d.text || '点开写笔记…')
      : (d.pendingQuestion || (d.messages ?? []).slice(-1)[0]?.content || '点开输入你的问题')
  const preview = typeof rawPreview === 'string' ? rawPreview : String(rawPreview ?? '')

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragged.current = false
    drag.current = { startY: e.clientY, startTop: top, currentTop: top, moved: false }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const move = (e: React.PointerEvent) => {
    if (!drag.current) return
    if (Math.abs(e.clientY - drag.current.startY) > 4) { drag.current.moved = true; dragged.current = true }
    if (!drag.current.moved) return
    // 用 ref 记录当前位置：pointerup 与最后一次 pointermove 同帧时，props.top 还是旧值
    const next = Math.max(0, drag.current.startTop + e.clientY - drag.current.startY)
    drag.current.currentTop = next
    onTop(next)
  }
  const up = () => {
    if (!drag.current) return
    const { moved, currentTop } = drag.current
    drag.current = null
    if (moved) onDrop(currentTop)
  }
  const clickHead = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (!dragged.current) setOpen((o) => !o)
  }

  const ask = async () => {
    const t = q.trim()
    if (!t || busy || streaming) return
    setBusy(true); setQ('')
    try { await onAsk(t) } finally { setBusy(false) }
  }
  const retry = async () => {
    if (busy || streaming || !d.pendingQuestion) return
    setBusy(true)
    try { await onRetry() } finally { setBusy(false) }
  }

  const saveNote = async () => {
    if (noteText === (d.text ?? '')) return
    setNoteState('saving')
    try {
      await onPatch({ ...d, text: noteText })
      noteDirty.current = false
      setNoteState('saved')
      window.clearTimeout(noteTimer.current)
      noteTimer.current = window.setTimeout(() => setNoteState(''), 2000)
    } catch {
      // 失败保留编辑态（noteDirty 不复位），toast 由 PaperView 发；再次失焦即重试
      setNoteState('error')
    }
  }

  const HeadIcon = isTableChat ? Table2 : isGlobalChat ? Globe : (TYPE_ICON[card.type] ?? Pin)

  return (
    <div className={`card ${card.type}${active ? ' active' : ''}`} data-id={card.id} style={{ top }}
      onPointerDownCapture={onActivate}>
      <div className="ch" onPointerDown={down} onPointerMove={move} onPointerUp={up} onClick={clickHead}>
        <span className="ico"><HeadIcon size={16} strokeWidth={2} /></span>
        <span className="ct">{title}</span>
        <button className="x toggle" title={open ? '收起' : '展开'} onClick={() => setOpen(!open)}>
          <span className="ico">{open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}</span>
        </button>
        {confirmDel ? (
          <span className="del-confirm">
            <span className="del-ask">删除？</span>
            <button className="x del-yes" title="确认删除" onClick={() => { setConfirmDel(false); onDelete() }}>
              <span className="ico"><Check size={14} strokeWidth={2} /></span>
            </button>
            <button className="x" title="取消" onClick={() => setConfirmDel(false)}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>
          </span>
        ) : (
          <button className="x" title="删除卡片" onClick={() => setConfirmDel(true)}>
            <span className="ico"><X size={14} strokeWidth={2} /></span>
          </button>
        )}
      </div>
      {!open && preview && <div className="preview">{preview}</div>}
      {open && <div className="cb">
        {card.type === 'note' && (
          <>
            <textarea className="note-editor" rows={5} autoFocus={!d.text}
              placeholder="写下你的笔记…（失焦自动保存；支持 $公式$）"
              value={noteText}
              onChange={(e) => { noteDirty.current = true; setNoteText(e.target.value) }}
              onBlur={saveNote}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }} />
            {noteState && (
              <div className={`note-status${noteState === 'error' ? ' err' : noteState === 'saved' ? ' ok' : ''}`}>
                {noteState === 'saving' ? '保存中…' : noteState === 'saved' ? '已保存' : '保存失败，失焦重试'}
              </div>
            )}
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
            {typeof d.zh === 'string' && d.zh && <div className="term-zh">{d.zh}</div>}
            {d.error ? <div className="err">解释生成失败：{d.error}</div>
              : d.pending ? <div className="loading">正在生成解释…</div>
              : <Markdown className="tr" text={d.expl} />}
          </>}
          {(d.messages ?? []).map((m: any, i: number) => (
            <div key={i} className={m.role === 'user' ? 'msg u' : 'msg a'}>
              {m.role === 'user' ? <Markdown text={m.content} /> : <>
                <Markdown text={m.content} />
                {m.pages?.length > 0 && <div className="src">
                  {m.pages.map((p: number) => (
                    <button key={p} onClick={() => onJump(p)}>
                      <span className="ico"><FileText size={12} strokeWidth={2} /></span>第{p}页
                    </button>
                  ))}
                </div>}
              </>}
            </div>
          ))}
          {/* 提问立即落库为 pendingQuestion：流式中/中断后都先显示用户问题气泡 */}
          {d.pendingQuestion && <div className="msg u"><Markdown text={d.pendingQuestion} /></div>}
          {stream ? (
            <div className="msg a chat-stream">
              {stream.steps.map((s, i) => (
                <div key={i} className="agent-step">
                  <span className="ico"><Search size={12} strokeWidth={2} /></span>{s}
                </div>
              ))}
              {stream.text
                ? <Markdown text={stream.text} />
                : <div className="chat-thinking"><Spinner size={14} /><span>思考中…</span></div>}
              {onCancelAsk && (
                <button className="x chat-cancel" title="取消回答" onClick={onCancelAsk}>
                  <span className="ico"><X size={12} strokeWidth={2} /></span>取消
                </button>
              )}
            </div>
          ) : d.pendingQuestion ? (
            <div className="chat-interrupted">
              <span>上次回答中断</span>
              <button className="btn small" disabled={busy} onClick={retry}>
                <span className="ico"><RefreshCw size={12} strokeWidth={2} /></span>重试
              </button>
            </div>
          ) : null}
          <div className="ask">
            <input value={q} placeholder={busy || streaming ? '思考中…' : isGlobalChat ? '就整篇论文提问…' : '继续追问…'}
              disabled={busy || streaming}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
            <button className="btn small primary" onClick={ask} disabled={busy || streaming}>发送</button>
          </div>
        </>}
      </div>}
    </div>
  )
}
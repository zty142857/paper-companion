/** 行内 markdown：**粗体**、`代码`，其余原样 */
function inline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean)
  return parts.map((s, i) => {
    if (s.startsWith('**') && s.endsWith('**')) return <b key={i}>{s.slice(2, -2)}</b>
    if (s.startsWith('`') && s.endsWith('`')) return <code key={i}>{s.slice(1, -1)}</code>
    return s
  })
}

/**
 * 轻量 markdown 渲染：段落、有序/无序列表、标题、行内粗体/代码。无第三方依赖。
 * 用于子对话/术语卡消息与文献综述展示。
 */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = (text || '').split('\n')
  const out: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>)
    out.push(list.ordered
      ? <ol key={out.length} className="md-list">{items}</ol>
      : <ul key={out.length} className="md-list">{items}</ul>)
    list = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const ul = line.match(/^\s*[-*•]\s+(.*)$/)
    const h = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (ol) { if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] } } list.items.push(ol[1]) }
    else if (ul) { if (!list || list.ordered) { flush(); list = { ordered: false, items: [] } } list.items.push(ul[1]) }
    else if (h) { flush(); out.push(<div key={out.length} className="md-h">{inline(h[1])}</div>) }
    else if (!line.trim()) flush()
    else { flush(); out.push(<p key={out.length} className="md-p">{inline(line)}</p>) }
  }
  flush()
  return <div className={className ? `md ${className}` : 'md'}>{out}</div>
}

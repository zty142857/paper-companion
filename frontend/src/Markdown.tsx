import katex from 'katex'

function mathNode(expr: string, display: boolean, key: number): React.ReactNode {
  try {
    const html = katex.renderToString(expr, { displayMode: display, throwOnError: false, strict: false })
    return <span key={key} className={display ? 'math-display' : 'math-inline'}
      dangerouslySetInnerHTML={{ __html: html }} />
  } catch {
    return <code key={key}>{expr}</code>
  }
}

/** 行内 markdown：**粗体**、`代码`、$公式$，其余原样 */
function inline(text: string, mathBlocks: string[] = []): React.ReactNode[] {
  const parts = text.split(/(\u0001MATH\d+\u0001|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g).filter(Boolean)
  const out: React.ReactNode[] = []
  for (const part of parts) {
    let expr = ''
    let display = false
    if (part.startsWith('\u0001MATH')) {
      const block = mathBlocks[Number(part.slice(5, -1))] || ''
      if (block.startsWith('$$')) { expr = block.slice(2, -2); display = true }
      else if (block.startsWith('\\[')) { expr = block.slice(2, -2); display = true }
      else expr = block
    } else if (part.startsWith('$$') && part.endsWith('$$')) { expr = part.slice(2, -2); display = true }
    else if (part.startsWith('$') && part.endsWith('$')) expr = part.slice(1, -1)
    else if (part.startsWith('\\[') && part.endsWith('\\]')) { expr = part.slice(2, -2); display = true }
    else if (part.startsWith('\\(') && part.endsWith('\\)')) expr = part.slice(2, -2)
    if (expr || (part.startsWith('$') && part.endsWith('$') && part.length === 2)) {
      out.push(mathNode(expr, display, out.length))
      continue
    }
    const md = part.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean)
    for (const s of md) {
      if (s.startsWith('**') && s.endsWith('**')) out.push(<b key={out.length}>{s.slice(2, -2)}</b>)
      else if (s.startsWith('`') && s.endsWith('`')) out.push(<code key={out.length}>{s.slice(1, -1)}</code>)
      else out.push(s)
    }
  }
  return out
}

/**
 * 轻量 markdown 渲染：段落、有序/无序列表、标题、行内粗体/代码。无第三方依赖。
 * 用于子对话/术语卡消息与文献综述展示。
 */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  // 多行 $$...$$ / \[...\] 先替换成单行占位符，避免被按行拆开后找不到闭合符。
  const mathBlocks: string[] = []
  const body = (text || '').replace(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\])/g, (m) => {
    mathBlocks.push(m)
    return `\u0001MATH${mathBlocks.length - 1}\u0001`
  })
  const lines = body.split('\n')
  const out: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{inline(it, mathBlocks)}</li>)
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
    else if (h) { flush(); out.push(<div key={out.length} className="md-h">{inline(h[1], mathBlocks)}</div>) }
    else if (!line.trim()) flush()
    else { flush(); out.push(<p key={out.length} className="md-p">{inline(line, mathBlocks)}</p>) }
  }
  flush()
  return <div className={className ? `md ${className}` : 'md'}>{out}</div>
}

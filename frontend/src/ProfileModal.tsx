import { useEffect, useState } from 'react'
import { api } from './api'
import type { ProfileResponse } from './api'

const LEVELS = ['新手', '进阶', '熟手']

export default function ProfileModal({ pid, onDone, onClose }: {
  pid: string
  onDone: () => void
  onClose: () => void
}) {
  const [data, setData] = useState<ProfileResponse | null>(null)
  const [domain, setDomain] = useState('')
  const [level, setLevel] = useState('新手')
  const [known, setKnown] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.profile(pid).then((d) => {
      setData(d)
      const prior = d.prior
      setDomain(prior?.domain || d.guess.domain)
      setLevel(prior?.familiarity || '新手')
      setKnown(prior?.known_terms || [])
    }).catch((e) => setErr(String(e?.message || e)))
  }, [pid])

  const terms = data?.guess.terms ?? []
  const reuse = !!data?.prior
  const toggle = (t: string) =>
    setKnown((k) => k.includes(t) ? k.filter((x) => x !== t) : [...k, t])

  const submit = async (useHistory: boolean) => {
    setBusy(true); setErr('')
    try {
      await api.survey(pid, { domain, familiarity: level, known_terms: known, reuse: useHistory && reuse })
      onDone()
    } catch (e: any) { setErr(String(e?.message || e)); setBusy(false) }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>开始前，先了解一下你</h2>
        {!data && !err && <div className="loading">正在识别论文领域…</div>}
        {err && <div className="err">{err}</div>}
        {data && <>
          <p className="empty" style={{ marginBottom: 10 }}>
            我判断这篇论文属于「<b>{data.guess.domain}</b>」。{data.guess.reason}
            {reuse && <span className="ok" style={{ marginLeft: 6 }}>同领域已有档案</span>}
          </p>
          <label>研究领域（可修改）</label>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} />

          <label>你对这个领域的熟悉程度</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {LEVELS.map((l) => (
              <button key={l} className={`btn small${level === l ? ' primary' : ''}`}
                onClick={() => setLevel(l)}>{l}</button>
            ))}
          </div>

          <label>以下术语你已经懂了（勾选后我不再解释）</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {terms.map((t) => (
              <button key={t} className={`btn small${known.includes(t) ? ' primary' : ''}`}
                onClick={() => toggle(t)}>{t}</button>
            ))}
            {!terms.length && <span className="empty">（未识别到术语）</span>}
          </div>

          <div className="row">
            <button className="btn" onClick={onClose}>稍后再说</button>
            {reuse && <button className="btn" disabled={busy} onClick={() => submit(true)}>沿用上次摸底</button>}
            <button className="btn primary" disabled={busy || !domain} onClick={() => submit(false)}>
              {busy ? '提交中…' : '提交并生成阅读计划'}
            </button>
          </div>
        </>}
      </div>
    </div>
  )
}

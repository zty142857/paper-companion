import { useCallback, useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { api } from './api'
import type { ProfileResponse } from './api'
import Modal from './components/Modal'
import { Spinner } from './components/Loading'
import { useToast } from './components/Toast'

const LEVELS = ['新手', '进阶', '熟手']

export default function ProfileModal({ pid, onDone, onClose }: {
  pid: string
  onDone: () => void
  onClose: () => void
}) {
  const toast = useToast()
  const [data, setData] = useState<ProfileResponse | null>(null)
  const [domain, setDomain] = useState('')
  const [level, setLevel] = useState('新手')
  const [known, setKnown] = useState<string[]>([])
  const [loadErr, setLoadErr] = useState(false)
  const [busy, setBusy] = useState(false)

  const fetchProfile = useCallback(() => {
    setLoadErr(false)
    api.profile(pid).then((d) => {
      setData(d)
      const prior = d.prior
      setDomain(prior?.domain || d.guess.domain)
      setLevel(prior?.familiarity || '新手')
      setKnown(prior?.known_terms || [])
    }).catch((e) => {
      // 识别失败给可重试的入口，而不是一行红字死胡同
      setLoadErr(true)
      toast.error(`领域识别失败：${e?.message || e}`)
    })
  }, [pid, toast])
  useEffect(() => { fetchProfile() }, [fetchProfile])

  // 同领域旧档案里已勾选的术语也要显示出来，否则用户没法取消勾选
  const terms = Array.from(new Set([
    ...(data?.guess.terms ?? []),
    ...(data?.prior?.known_terms ?? []),
  ]))
  const reuse = !!data?.prior
  const domainValid = domain.trim().length > 0
  const toggle = (t: string) =>
    setKnown((k) => k.includes(t) ? k.filter((x) => x !== t) : [...k, t])

  const submit = async (useHistory: boolean) => {
    setBusy(true)
    const prior = data?.prior
    // 「沿用上次摸底」= 原样复用同领域档案，不把本次表单里的临时修改带进去
    const body = useHistory && prior
      ? { domain: prior.domain, familiarity: prior.familiarity, known_terms: prior.known_terms, reuse: true }
      : { domain: domain.trim(), familiarity: level, known_terms: known, reuse: false }
    try {
      await api.survey(pid, body)
      onDone()
    } catch (e: any) {
      // 失败只 toast，表单内容与勾选原样保留，可直接再提交
      toast.error(`摸底提交失败：${e?.message || e}`)
      setBusy(false)
    }
  }

  return (
    <Modal className="profile-modal" onClose={onClose}
      title={<span className="profile-title"><span className="ico"><UserRound size={18} /></span>开始前，先了解一下你</span>}
      footer={data ? <>
        <button className="btn" onClick={onClose}>稍后再说</button>
        {reuse && <button className="btn" disabled={busy} onClick={() => submit(true)}>沿用上次摸底</button>}
        <button className="btn primary" disabled={busy || !domainValid} onClick={() => submit(false)}>
          {busy && <Spinner size={12} />}
          {busy ? '提交中…' : '提交并生成阅读计划'}
        </button>
      </> : undefined}>
      {!data && !loadErr && (
        <div className="loading profile-loading"><Spinner size={14} />正在识别论文领域…</div>
      )}
      {loadErr && !data && (
        <div className="empty profile-loaderr">
          没能识别出论文领域。
          <button className="btn small" onClick={fetchProfile}>重试</button>
        </div>
      )}
      {data && <>
        <p className="empty profile-lead">
          我判断这篇论文属于「<b>{data.guess.domain}</b>」。{data.guess.reason}
          {reuse && <span className="profile-reuse">同领域已有档案</span>}
        </p>
        <label>研究领域（可修改）</label>
        <input value={domain} onChange={(e) => setDomain(e.target.value)}
          placeholder="例如：计算机视觉 / 凝聚态物理" />
        {!domainValid && <div className="field-hint">填写研究领域后才能提交</div>}

        <label>你对这个领域的熟悉程度</label>
        <div className="level-row">
          {LEVELS.map((l) => (
            <button key={l} className={`btn small${level === l ? ' primary' : ''}`}
              onClick={() => setLevel(l)}>{l}</button>
          ))}
        </div>

        <label>以下术语你已经懂了（勾选后我不再解释）</label>
        <div className="term-row">
          {terms.map((t) => (
            <button key={t} className={`btn small${known.includes(t) ? ' primary' : ''}`}
              onClick={() => toggle(t)}>{t}</button>
          ))}
          {!terms.length && <span className="empty">（未识别到术语）</span>}
        </div>
      </>}
    </Modal>
  )
}
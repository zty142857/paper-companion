import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, FileText, X } from 'lucide-react'
import { api } from './api'
import type { QuizGrade, QuizQuestion } from './api'
import Modal from './components/Modal'
import { Skeleton, Spinner } from './components/Loading'
import { useConfirm } from './components/ConfirmDialog'
import { useToast } from './components/Toast'

// 出题约 20 秒：分阶段轮换文案，让用户知道流程在推进而不是卡死
const MAKE_PHASES = ['正在通读全文…', '正在构思题目…', '正在生成选项与解析…']

export default function QuizModal({ pid, onJump, onClose }: {
  pid: string
  onJump: (page: number) => void
  onClose: () => void
}) {
  const confirm = useConfirm()
  const toast = useToast()
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [grade, setGrade] = useState<QuizGrade | null>(null)
  const [busy, setBusy] = useState(false)        // 判分中
  const [making, setMaking] = useState(false)    // 出题中
  const [preparing, setPreparing] = useState(true) // 打开时读取上次题目
  const [phase, setPhase] = useState(0)
  const answersRef = useRef<string[]>([])
  const gradedRef = useRef(false)
  // 出题/判分共用一个 AbortController：取消按钮与卸载都靠它中止在途请求
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => { answersRef.current = answers }, [answers])
  useEffect(() => { gradedRef.current = !!grade }, [grade])

  const gen = useCallback(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setMaking(true); setGrade(null); setQuestions(null); setAnswers([]); setPhase(0)
    api.makeQuiz(pid, ctrl.signal).then((d) => {
      if (ctrl.signal.aborted) return
      if (d.error || !d.questions?.length) toast.error(d.error || '出题失败，请重试')
      else { setQuestions(d.questions); setAnswers(d.questions.map(() => '')) }
    }).catch((e) => {
      // 主动取消不算错误，不打扰用户
      if (!ctrl.signal.aborted) toast.error(String(e?.message || e))
    }).finally(() => {
      // 只有最新一次请求能收口状态，避免旧请求晚到把新一轮出题打断
      if (abortRef.current === ctrl) { abortRef.current = null; setMaking(false) }
    })
  }, [pid, toast])

  // 出题文案每 7 秒推进一档，停在最后一档
  useEffect(() => {
    if (!making) return
    const t = window.setInterval(() => setPhase((p) => Math.min(p + 1, MAKE_PHASES.length - 1)), 7000)
    return () => window.clearInterval(t)
  }, [making])

  // 打开时先恢复上次那套题（含作答与判分结果），没有才出题
  useEffect(() => {
    let alive = true
    api.getQuiz(pid).then((d) => {
      if (!alive) return
      const q = d.quiz
      if (q?.questions?.length) {
        setQuestions(q.questions)
        setAnswers(q.answers?.length === q.questions.length ? q.answers : q.questions.map(() => ''))
        setGrade(q.grade || null)
      } else gen()
    }).catch(() => { if (alive) gen() })
      .finally(() => { if (alive) setPreparing(false) })
    return () => { alive = false }
  }, [pid, gen])

  // 关闭时中止在途请求，并把未判分的作答存回去（已判分的在判分时存过）
  useEffect(() => () => {
    abortRef.current?.abort()
    if (answersRef.current.length && !gradedRef.current)
      api.saveQuizAnswers(pid, answersRef.current).catch(() => { /* 尽力而为 */ })
  }, [pid])

  const set = (i: number, v: string) =>
    setAnswers((a) => a.map((x, j) => (j === i ? v : x)))

  /** 取消出题/判分：abort 后回到可重新出题 / 继续作答的状态 */
  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setMaking(false)
    setBusy(false)
  }

  const submit = async () => {
    if (!questions) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(true)
    try {
      const g = await api.gradeQuiz(pid, questions, answers, ctrl.signal)
      if (ctrl.signal.aborted) return
      setGrade(g)
      toast.success(`判分完成：得分 ${g.score}/${g.total}`)
    } catch (e: any) {
      if (!ctrl.signal.aborted) toast.error(String(e?.message || e))
    } finally {
      if (abortRef.current === ctrl) { abortRef.current = null; setBusy(false) }
    }
  }

  /** 重新出题：有作答或成绩时先确认覆盖，不再用原生 confirm */
  const regen = async () => {
    if (grade || answers.some((a) => a.trim())) {
      const ok = await confirm({
        title: '重新出题？',
        message: '再测一次将重新出题，当前作答与成绩会被覆盖。',
        confirmText: '重新出题',
        danger: true,
      })
      if (!ok) return
    }
    gen()
  }

  const working = making || busy

  return (
    <Modal className="quiz" onClose={onClose} dismissable={!working && !preparing}
      title={<>全篇自测{grade && <span className="quiz-score">得分 {grade.score}/{grade.total}</span>}</>}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={working || preparing}>关闭</button>
          {working && <button className="btn" onClick={cancel}>{making ? '取消出题' : '取消判分'}</button>}
          {questions && !working && (
            <button className="btn" onClick={regen}
              title="重新出一套题，当前题目与作答会被覆盖">再测一次</button>
          )}
          {questions && !grade && !working && (
            <button className="btn primary" onClick={submit}>提交并判分</button>
          )}
          {grade && <button className="btn primary" onClick={onClose}>完成</button>}
        </>
      }>
      {preparing && !making && (
        <div className="quiz-status"><Spinner size={16} />正在准备题目…</div>
      )}
      {making && (
        <div className="quiz-making">
          <div className="quiz-status"><Spinner size={16} />{MAKE_PHASES[phase]}（约 20 秒，可随时取消）</div>
          <Skeleton lines={6} />
        </div>
      )}
      {/* 取消出题 / 出题失败后落在这里，可以立刻重来 */}
      {!preparing && !making && !questions && (
        <div className="quiz-idle">
          <span>还没有题目，依据全文生成一套自测题吧。</span>
          <button className="btn primary" onClick={gen}>开始出题</button>
        </div>
      )}
      {busy && <div className="quiz-status"><Spinner size={16} />正在逐题判分…</div>}
      {questions && <div className="quiz-body">
        {questions.map((q, i) => {
          const r = grade?.results[i]
          return (
            <div key={i} className={`q${r ? (r.correct ? ' right' : ' wrong') : ''}`}>
              <div className="qt">
                {i + 1}. {String(q.q ?? '')}
                {r && <span className={`mark ${r.correct ? 'ok' : 'no'}`}>
                  {r.correct ? <Check size={16} /> : <X size={16} />}{r.correct ? '正确' : '错误'}
                </span>}
              </div>
              {q.type === 'choice' ? (
                <div className="opts">
                  {(Array.isArray(q.options) ? q.options : []).map((o) => (
                    <label key={o} className={`opt${answers[i] === o ? ' on' : ''}${grade && o === q.answer ? ' ans' : ''}`}>
                      <input type="radio" name={`q${i}`} disabled={!!grade || busy}
                        checked={answers[i] === o} onChange={() => set(i, o)} />
                      {o}
                    </label>
                  ))}
                </div>
              ) : (
                <textarea className="qa" rows={3} disabled={!!grade || busy} placeholder="简要作答…"
                  value={answers[i]} onChange={(e) => set(i, e.target.value)} />
              )}
              {r && <div className="qfb">
                {q.type === 'choice' && !r.correct && <div>正确答案：{String(q.answer ?? '')}</div>}
                {r.feedback && <div>{String(r.feedback)}{r.hit ? `（要点 ${String(r.hit)}）` : ''}</div>}
                {q.explain && <div className="qexp">{String(q.explain)}</div>}
                {q.reference && <div className="qexp">参考：{String(q.reference)}</div>}
                {Array.isArray(q.pages) && q.pages.length > 0 && <div className="src">
                  {q.pages.map((p) => (
                    <button key={p} onClick={() => onJump(p)}><FileText size={16} />回原文第{p}页</button>
                  ))}
                </div>}
              </div>}
            </div>
          )
        })}
      </div>}
    </Modal>
  )
}
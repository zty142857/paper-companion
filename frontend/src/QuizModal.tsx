import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { QuizQuestion, QuizGrade } from './api'

export default function QuizModal({ pid, onJump, onClose }: {
  pid: string
  onJump: (page: number) => void
  onClose: () => void
}) {
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [grade, setGrade] = useState<QuizGrade | null>(null)
  const [busy, setBusy] = useState(false)
  const [making, setMaking] = useState(false)
  const [err, setErr] = useState('')
  const answersRef = useRef<string[]>([])
  answersRef.current = answers
  const gradedRef = useRef(false)
  gradedRef.current = !!grade

  // 打开时先恢复上次那套题（含作答与判分结果），没有才出题
  const gen = useCallback(() => {
    setMaking(true); setErr(''); setGrade(null); setQuestions(null); setAnswers([])
    api.makeQuiz(pid).then((d) => {
      if (d.error || !d.questions?.length) setErr(d.error || '出题失败，请重试')
      else { setQuestions(d.questions); setAnswers(d.questions.map(() => '')) }
    }).catch((e) => setErr(String(e?.message || e)))
      .finally(() => setMaking(false))
  }, [pid])

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
    return () => { alive = false }
  }, [pid, gen])

  // 关闭时把未判分的作答存回去（已判分的在判分时存过）
  useEffect(() => () => {
    if (answersRef.current.length && !gradedRef.current)
      api.saveQuizAnswers(pid, answersRef.current).catch(() => { /* 尽力而为 */ })
  }, [pid])

  const set = (i: number, v: string) =>
    setAnswers((a) => a.map((x, j) => (j === i ? v : x)))

  const submit = async () => {
    if (!questions) return
    setBusy(true); setErr('')
    try { setGrade(await api.gradeQuiz(pid, questions, answers)) }
    catch (e: any) { setErr(String(e?.message || e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal quiz" onClick={(e) => e.stopPropagation()}>
        <h2>全篇自测 {grade && <span className="ok">得分 {grade.score}/{grade.total}</span>}</h2>
        {!questions && !err && <div className="loading">{making ? '正在依据全文出题（约 20 秒）…' : '正在准备题目…'}</div>}
        {err && <div className="err">{err}</div>}
        {questions && <div className="quiz-body">
          {questions.map((q, i) => {
            const r = grade?.results[i]
            return (
              <div key={i} className={`q${r ? (r.correct ? ' right' : ' wrong') : ''}`}>
                <div className="qt">
                  {i + 1}. {q.q}
                  {r && <span className={`mark ${r.correct ? 'ok' : 'no'}`}>{r.correct ? '✓ 正确' : '✗ 错误'}</span>}
                </div>
                {q.type === 'choice' ? (
                  <div className="opts">
                    {q.options?.map((o) => (
                      <label key={o} className={`opt${answers[i] === o ? ' on' : ''}${grade && o === q.answer ? ' ans' : ''}`}>
                        <input type="radio" name={`q${i}`} disabled={!!grade}
                          checked={answers[i] === o} onChange={() => set(i, o)} />
                        {o}
                      </label>
                    ))}
                  </div>
                ) : (
                  <textarea className="qa" rows={3} disabled={!!grade} placeholder="简要作答…"
                    value={answers[i]} onChange={(e) => set(i, e.target.value)} />
                )}
                {r && <div className="qfb">
                  {q.type === 'choice' && !r.correct && <div>正确答案：{q.answer}</div>}
                  {r.feedback && <div>{r.feedback}{r.hit ? `（要点 ${r.hit}）` : ''}</div>}
                  {q.explain && <div className="qexp">{q.explain}</div>}
                  {q.reference && <div className="qexp">参考：{q.reference}</div>}
                  {!!q.pages?.length && <div className="src">
                    {q.pages.map((p) => <button key={p} onClick={() => onJump(p)}>📄 回原文第{p}页</button>)}
                  </div>}
                </div>}
              </div>
            )
          })}
        </div>}
        <div className="row">
          <button className="btn" onClick={onClose}>关闭</button>
          {questions && <button className="btn" disabled={making}
            title="重新出一套题，当前题目与作答会被覆盖"
            onClick={() => { if (grade || answers.some((a) => a.trim())) { if (confirm('再测一次将重新出题，当前作答与成绩会被覆盖。继续？')) gen() } else gen() }}>
            {making ? '出题中…' : '再测一次'}</button>}
          {questions && !grade && !making && <button className="btn primary" disabled={busy} onClick={submit}>
            {busy ? '判分中…' : '提交并判分'}</button>}
          {grade && <button className="btn primary" onClick={onClose}>完成</button>}
        </div>
      </div>
    </div>
  )
}

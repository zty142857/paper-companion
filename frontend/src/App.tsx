import { lazy, Suspense, useEffect, useState } from 'react'
import { ToastProvider } from './components/Toast'
import { ConfirmProvider } from './components/ConfirmDialog'

// 首页与工作台懒加载：pdf.js / KaTeX / 工作台逻辑整体拆出首屏主包
const Home = lazy(() => import('./Home'))
const PaperView = lazy(() => import('./PaperView'))

function useHash() {
  const [h, setH] = useState(location.hash)
  useEffect(() => {
    const f = () => setH(location.hash)
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return h
}

export default function App() {
  const h = useHash()
  const m = h.match(/^#\/paper\/(\w+)/)
  // key 让切换论文时直接重建工作台，彻底丢掉上一篇的卡片/异步请求状态
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Suspense fallback={<div className="app-loading">加载中…</div>}>
          {m ? <PaperView key={m[1]} id={m[1]} /> : <Home />}
        </Suspense>
      </ConfirmProvider>
    </ToastProvider>
  )
}

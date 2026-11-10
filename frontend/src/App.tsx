import { useEffect, useState } from 'react'
import Home from './Home'
import PaperView from './PaperView'

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
  return m ? <PaperView key={m[1]} id={m[1]} /> : <Home />
}

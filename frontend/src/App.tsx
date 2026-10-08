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
  return m ? <PaperView id={m[1]} /> : <Home />
}

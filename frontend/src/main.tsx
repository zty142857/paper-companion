import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './polyfills'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

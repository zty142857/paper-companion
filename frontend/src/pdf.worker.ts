// pdf.js 的自定义 worker 入口：先补齐它需要的新内置方法，再启动 pdf.js 的 worker。
// worker 是独立 realm，主线程打的 polyfill 管不到它，所以必须在 worker 里再跑一遍。
import './polyfills'
import 'pdfjs-dist/build/pdf.worker.min.mjs'

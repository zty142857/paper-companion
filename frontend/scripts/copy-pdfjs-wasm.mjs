// pdf.js 6.x 把 CCITT/JBIG2/JPEG2000 图像解码器搬进了 WASM，缺文件时整页扫描图会渲染失败。
// vite 不会打包 node_modules 里的裸文件，故构建前把官方 wasm 目录复制进 public/wasm/：
// vite dev 能直接 serve，vite build 也会自动带进 dist/wasm/（前端以 wasmUrl 指向它，
// 拼接规则是 `${wasmUrl}${filename}`，目录必须带尾斜杠）。public/wasm 已 gitignore，不进仓库。
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist', 'wasm')
if (!existsSync(src)) {
  console.error(`[copy-pdfjs-wasm] 找不到 ${src}，请先 npm install`)
  process.exit(1)
}

const targets = [join(root, 'public', 'wasm')]
// 打包脚本用 --skip-npm 复用旧 dist 时不会跑 vite build，public 里的东西不会被自动带过去，
// 所以 dist 已存在时再直写一份，保证任何路径下 dist 都自带 wasm。
if (existsSync(join(root, 'dist'))) targets.push(join(root, 'dist', 'wasm'))

let n = 0
for (const dest of targets) {
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(src)) {
    if (!/\.(wasm|js)$/.test(f) && !f.startsWith('LICENSE')) continue
    cpSync(join(src, f), join(dest, f))
    n++
  }
}
console.log(`[copy-pdfjs-wasm] 复制 ${n} 个文件 → ${targets.map((t) => relative(root, t)).join(' , ')}`)

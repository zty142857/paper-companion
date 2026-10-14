/**
 * pdf.js 6.x 直接使用 Map.prototype.getOrInsertComputed() / getOrInsert()。
 * 这两个方法是 TC39「upsert」提案的新内置，2026-02 才进 Baseline：
 *   Chrome/Edge 145+、Firefox 144+、Safari 26.2+。
 * 更早的内核（未更新的 Edge/Chrome、企业锁版本的 Edge、国产套壳浏览器…）上
 * Map.prototype 没有它们，pdf.js 会抛
 *   "xxx.getOrInsertComputed is not a function"
 * 且因为发生在 getDocument 阶段，整篇 PDF 直接渲染失败（页面全白）。
 *
 * 这里只在内置缺失时补上。主线程和 pdf.js 的 worker 是两个独立 realm，
 * 两边都要各 import 一份本文件（见 main.tsx 与 pdf.worker.ts）。
 */

interface UpsertMap {
  getOrInsert?: (key: unknown, defaultValue: unknown) => unknown
  getOrInsertComputed?: (key: unknown, callback: (key: unknown) => unknown) => unknown
}

const proto = Map.prototype as unknown as UpsertMap

if (typeof proto.getOrInsertComputed !== 'function') {
  Object.defineProperty(proto, 'getOrInsertComputed', {
    configurable: true,
    writable: true,
    value(this: Map<unknown, unknown>, key: unknown, callback: (key: unknown) => unknown) {
      if (this.has(key)) return this.get(key)
      const value = callback(key)
      this.set(key, value)
      return value
    },
  })
}

if (typeof proto.getOrInsert !== 'function') {
  Object.defineProperty(proto, 'getOrInsert', {
    configurable: true,
    writable: true,
    value(this: Map<unknown, unknown>, key: unknown, defaultValue: unknown) {
      if (this.has(key)) return this.get(key)
      this.set(key, defaultValue)
      return defaultValue
    },
  })
}

export {}

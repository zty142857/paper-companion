// 公式图片 → LaTeX。模型来自开源项目 Texo（alephpi/FormulaNet，20M 参数）。
// 这里借用它的浏览器推理方式：VisionEncoderDecoderModel + onnxruntime-web，
// 输入 384×384 灰度公式图，输出 KaTeX 可用的 LaTeX。
import {
  env,
  Tensor,
  VisionEncoderDecoderModel,
  PreTrainedTokenizer,
  type ProgressInfo,
} from '@huggingface/transformers'

// 模型放在 public/models/formulanet，随应用本地提供，不依赖 HuggingFace 网络。
env.allowLocalModels = true
env.allowRemoteModels = false
env.localModelPath = `${self.location.origin}/models/`
env.useBrowserCache = true
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = true
}

const MODEL = 'formulanet'
const SIZE = 384
const MEAN = 0.7931
const STD = 0.1738
const PAD = 2

let model: VisionEncoderDecoderModel | null = null
let tokenizer: PreTrainedTokenizer | null = null
let loading: Promise<void> | null = null

function progress(id: string, data: ProgressInfo) {
  if (data.status !== 'progress') return
  self.postMessage({
    type: 'progress',
    id,
    file: data.file,
    loaded: data.loaded,
    total: data.total,
    progress: data.progress,
  })
}

async function init(id: string) {
  if (model && tokenizer) return
  if (loading) return loading
  loading = (async () => {
    model = await VisionEncoderDecoderModel.from_pretrained(MODEL, {
      dtype: 'fp32',
      progress_callback: (p: ProgressInfo) => progress(id, p),
    })
    tokenizer = await PreTrainedTokenizer.from_pretrained(MODEL)
  })()
  try {
    await loading
  } catch (e) {
    loading = null
    model = null
    tokenizer = null
    throw e
  }
}

/** 把选区截图处理成 Texo 训练时的输入：白底、灰度、反色、裁边、等比缩放、归一化。 */
async function imageToTensor(blob: Blob): Promise<Tensor> {
  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height
  const src = new OffscreenCanvas(w, h)
  const sctx = src.getContext('2d')!
  sctx.fillStyle = '#fff'
  sctx.fillRect(0, 0, w, h)
  sctx.drawImage(bitmap, 0, 0)

  const img = sctx.getImageData(0, 0, w, h)
  const px = img.data
  const gray = new Uint8Array(w * h)
  let dark = 0
  let light = 0
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = Math.round(0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2])
    gray[i] = v
    if (v < 128) dark++
    else light++
  }
  if (dark > light) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i]
  }

  // 去掉截图四周的空白/页边，避免公式在输入里过小。
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] >= 245) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0; minY = 0; maxX = w - 1; maxY = h - 1
  }
  minX = Math.max(0, minX - PAD); minY = Math.max(0, minY - PAD)
  maxX = Math.min(w - 1, maxX + PAD); maxY = Math.min(h - 1, maxY + PAD)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1

  // 构造裁边后的灰度图，再等比放进 384×384 白底画布。
  const gc = new OffscreenCanvas(w, h)
  const gctx = gc.getContext('2d')!
  const gd = gctx.createImageData(w, h)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gd.data[p] = gd.data[p + 1] = gd.data[p + 2] = gray[i]
    gd.data[p + 3] = 255
  }
  gctx.putImageData(gd, 0, 0)

  const out = new OffscreenCanvas(SIZE, SIZE)
  const octx = out.getContext('2d')!
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, SIZE, SIZE)
  octx.imageSmoothingEnabled = true
  octx.imageSmoothingQuality = 'high'
  const scale = Math.min(SIZE / cw, SIZE / ch)
  const dw = Math.max(1, Math.round(cw * scale))
  const dh = Math.max(1, Math.round(ch * scale))
  const dx = Math.floor((SIZE - dw) / 2)
  const dy = Math.floor((SIZE - dh) / 2)
  octx.drawImage(gc, minX, minY, cw, ch, dx, dy, dw, dh)

  const data = octx.getImageData(0, 0, SIZE, SIZE).data
  const arr = new Float32Array(3 * SIZE * SIZE)
  const plane = SIZE * SIZE
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    const v = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255
    const n = (v - MEAN) / STD
    arr[i] = n
    arr[i + plane] = n
    arr[i + plane * 2] = n
  }
  bitmap.close()
  return new Tensor('float32', arr, [1, 3, SIZE, SIZE])
}

async function recognize(id: string, blob: Blob) {
  await init(id)
  if (!model || !tokenizer) throw new Error('公式模型未加载')
  const input = await imageToTensor(blob)
  const output = await (model as any).generate({ inputs: input })
  const text = tokenizer.batch_decode(output, { skip_special_tokens: true })[0] || ''
  return text.trim()
}

self.onmessage = async (event: MessageEvent<{ type: string; id: string; image: Blob }>) => {
  if (event.data.type !== 'recognize') return
  try {
    const latex = await recognize(event.data.id, event.data.image)
    self.postMessage({ type: 'result', id: event.data.id, latex })
  } catch (e) {
    self.postMessage({
      type: 'error',
      id: event.data.id,
      error: String((e as Error)?.message || e),
    })
  }
}

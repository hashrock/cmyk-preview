/// <reference lib="webworker" />
import {
  instantiate,
  TYPE_RGB_8,
  TYPE_CMYK_8,
  INTENT_RELATIVE_COLORIMETRIC,
  INTENT_ABSOLUTE_COLORIMETRIC,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
  cmsFLAGS_NOCACHE,
  cmsInfoDescription,
  PT_Lab,
  FLOAT_SH,
  COLORSPACE_SH,
  CHANNELS_SH,
  BYTES_SH,
} from 'lcms-wasm'
import wasmUrl from 'lcms-wasm/dist/lcms.wasm?url'
import type { WorkerRequest, WorkerResponse } from './protocol'

const TYPE_Lab_FLT =
  FLOAT_SH(1) | COLORSPACE_SH(PT_Lab) | CHANNELS_SH(3) | BYTES_SH(4)

const lToY = (l: number) => (l > 8 ? ((l + 16) / 116) ** 3 : l / 903.3)
const yToL = (y: number) => (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y)

const lcmsPromise = instantiate({ locateFile: () => wasmUrl })

const profiles = new Map<string, number>()
let srgb = 0
let lab = 0

// 現在の画像（白合成済み RGB）
let rgb: Uint8Array | null = null
let srcProf = 0 // 入力 RGB プロファイル
let width = 0
let height = 0

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

const CHUNK = 1 << 17 // 一度に変換するピクセル数
const yieldToEvents = () => new Promise((r) => setTimeout(r))

class Cancelled extends Error {}
let latestRender = 0

function srcProfileOf(id: string) {
  if (id === 'srgb') return srgb
  const h = profiles.get(id)
  if (!h) throw new Error(`入力プロファイル ${id} が未ロードです`)
  return h
}

async function handle(msg: WorkerRequest) {
  const lcms = await lcmsPromise
  if (!srgb) {
    srgb = lcms.cmsCreate_sRGBProfile()
    lab = lcms.cmsCreateLab4Profile(null)
  }

  switch (msg.type) {
    case 'loadProfile': {
      const bytes = new Uint8Array(msg.bytes)
      const h = lcms.cmsOpenProfileFromMem(bytes, bytes.byteLength)
      if (!h) throw new Error('ICCプロファイルを読み込めませんでした')
      const space = lcms.cmsGetColorSpaceASCII(h)
      const expected = msg.kind === 'rgb' ? 'RGB' : 'CMYK'
      if (space !== expected) {
        lcms.cmsCloseProfile(h)
        throw new Error(`${expected}プロファイルではありません（${space}）`)
      }
      const old = profiles.get(msg.id)
      if (old) lcms.cmsCloseProfile(old)
      profiles.set(msg.id, h)
      const name = lcms
        .cmsGetProfileInfoASCII(h, cmsInfoDescription, 'en', 'US')
        .replace(/\0/g, '')
        .trim()
      post({ type: 'profileLoaded', reqId: msg.reqId, id: msg.id, name })
      return
    }

    case 'setImage': {
      const src = srcProfileOf(msg.srcProfileId)
      rgb = new Uint8Array(msg.rgb)
      width = msg.width
      height = msg.height
      srcProf = src
      // 表示用：入力プロファイル → sRGB
      let display: Uint8Array
      if (src === srgb) display = rgb.slice()
      else {
        const t = lcms.cmsCreateTransform(src, TYPE_RGB_8, srgb, TYPE_RGB_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_NOCACHE | cmsFLAGS_BLACKPOINTCOMPENSATION)
        display = new Uint8Array(rgb.length)
        const n = width * height
        for (let s = 0; s < n; s += CHUNK) {
          const e = Math.min(n, s + CHUNK)
          display.set(lcms.cmsDoTransform(t, rgb.subarray(s * 3, e * 3), e - s), s * 3)
        }
        lcms.cmsDeleteTransform(t)
      }
      post({ type: 'imageSet', reqId: msg.reqId, display }, [display.buffer])
      return
    }

    case 'render': {
      if (!rgb) throw new Error('画像がありません')
      const prof = profiles.get(msg.profileId)
      if (!prof) throw new Error('プロファイルが未ロードです')
      const renderId = ++latestRender
      const src = rgb
      const inProf = srcProf
      const w = width
      const h = height
      const n = w * h
      const flags = cmsFLAGS_NOCACHE | (msg.bpc ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0)

      // 進捗：各ステージ n ピクセル分を 1 単位として数える
      const total = n * (msg.gamut ? 5 : 2)
      let done = 0
      let lastPost = 0
      const tick = async (count: number) => {
        done += count
        const now = performance.now()
        if (now - lastPost > 30) {
          lastPost = now
          post({ type: 'progress', reqId: msg.reqId, value: done / total })
        }
        await yieldToEvents()
        // 新しい render が来ていたら打ち切る
        if (renderId !== latestRender) throw new Cancelled('cancelled')
      }

      // 画像を CHUNK ごとに分けて変換する
      const run = async <T extends Uint8Array | Float32Array>(
        transform: number,
        input: Uint8Array,
        inCh: number,
        outCh: number,
        Out: { new (len: number): T },
      ): Promise<T> => {
        const out = new Out(n * outCh)
        for (let s = 0; s < n; s += CHUNK) {
          const e = Math.min(n, s + CHUNK)
          out.set(lcms.cmsDoTransform(transform, input.subarray(s * inCh, e * inCh), e - s), s * outCh)
          await tick(e - s)
        }
        return out
      }

      const transforms: number[] = []
      const create = (...args: number[]) => {
        const t: number = lcms.cmsCreateTransform(...args)
        transforms.push(t)
        return t
      }

      try {
        // 1) sRGB → CMYK（分版）
        const toCmyk = create(inProf, TYPE_RGB_8, prof, TYPE_CMYK_8, msg.intent, flags)
        const cmyk = await run(toCmyk, src, 3, 4, Uint8Array)

        // 2) CMYK → sRGB（モニタ上の見え方）
        const outIntent = msg.paperWhite ? INTENT_ABSOLUTE_COLORIMETRIC : INTENT_RELATIVE_COLORIMETRIC
        const toRgb = create(prof, TYPE_CMYK_8, srgb, TYPE_RGB_8, outIntent, cmsFLAGS_NOCACHE)
        const proof = await run(toRgb, cmyk, 4, 3, Uint8Array)
        const paperPx: Uint8Array = lcms.cmsDoTransform(toRgb, new Uint8Array([0, 0, 0, 0]), 1)
        const paper: [number, number, number] = [paperPx[0], paperPx[1], paperPx[2]]

        // 3) 色域外判定：相対的な色域を維持（+黒点補正）で変換したときの ΔE
        //    インキの黒は #000 より明るいので、元画像の明度を印刷の黒点に合わせて
        //    圧縮してから比較する（暗部のグレーが誤判定されないように）
        let deltaE: Float32Array | null = null
        if (msg.gamut) {
          const rel = create(inProf, TYPE_RGB_8, prof, TYPE_CMYK_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_NOCACHE | cmsFLAGS_BLACKPOINTCOMPENSATION)
          const relCmyk = await run(rel, src, 3, 4, Uint8Array)
          const blackCmyk: Uint8Array = lcms.cmsDoTransform(rel, new Uint8Array([0, 0, 0]), 1)
          const c2l = create(prof, TYPE_CMYK_8, lab, TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_NOCACHE)
          const labA = await run(c2l, relCmyk, 4, 3, Float32Array)
          const blackL: number = lcms.cmsDoTransform(c2l, blackCmyk, 1)[0]
          const r2l = create(inProf, TYPE_RGB_8, lab, TYPE_Lab_FLT, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_NOCACHE)
          const labB = await run(r2l, src, 3, 3, Float32Array)
          // BPC は XYZ 上の線形スケールなので、Y で黒点を合わせてから L* に戻す
          const yBlack = lToY(blackL)
          deltaE = new Float32Array(n)
          for (let i = 0, j = 0; i < n; i++, j += 3) {
            const dl = labA[j] - yToL(yBlack + lToY(labB[j]) * (1 - yBlack))
            const da = labA[j + 1] - labB[j + 1]
            const db = labA[j + 2] - labB[j + 2]
            deltaE[i] = Math.sqrt(dl * dl + da * da + db * db)
          }
        }

      const transfer: Transferable[] = [cmyk.buffer, proof.buffer]
      if (deltaE) transfer.push(deltaE.buffer)
      post(
        {
          type: 'rendered',
          reqId: msg.reqId,
          width: w,
          height: h,
          cmyk,
          proof,
          deltaE,
          paper,
        },
        transfer,
      )
      } finally {
        for (const t of transforms) lcms.cmsDeleteTransform(t)
      }
      return
    }
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  handle(e.data).catch((err: unknown) =>
    post({
      cancelled: err instanceof Cancelled,
      type: 'error',
      reqId: e.data.reqId,
      message: err instanceof Error ? err.message : String(err),
    }),
  )
}

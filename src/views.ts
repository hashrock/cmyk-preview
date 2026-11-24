export type ViewMode = 'split' | 'original' | 'proof' | 'c' | 'm' | 'y' | 'k' | 'tac' | 'gamut' | 'magazine'

export type RenderResult = {
  width: number
  height: number
  rgb: Uint8Array // 白合成済みの元画像
  cmyk: Uint8Array
  proof: Uint8Array
  alpha: Uint8Array
  deltaE: Float32Array | null
  paper: [number, number, number]
}

const INK: Record<'c' | 'm' | 'y' | 'k', [number, number, number]> = {
  c: [0, 160, 233],
  m: [228, 0, 127],
  y: [255, 241, 0],
  k: [35, 24, 21],
}
const PLATE_INDEX = { c: 0, m: 1, y: 2, k: 3 } as const

function luma(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** 表示モードに応じた RGBA ピクセル列を作る */
export function buildView(
  res: RenderResult,
  mode: Exclude<ViewMode, 'split' | 'magazine'>,
  opts: { tacLimit: number; deltaE: number },
): ImageData {
  const { width, height, cmyk, proof, rgb, alpha } = res
  const n = width * height
  const out = new ImageData(width, height)
  const d = out.data

  switch (mode) {
    case 'original':
    case 'proof': {
      const src = mode === 'original' ? rgb : proof
      for (let i = 0; i < n; i++) {
        d[i * 4] = src[i * 3]
        d[i * 4 + 1] = src[i * 3 + 1]
        d[i * 4 + 2] = src[i * 3 + 2]
        d[i * 4 + 3] = 255
      }
      break
    }
    case 'c':
    case 'm':
    case 'y':
    case 'k': {
      const [ir, ig, ib] = INK[mode]
      const off = PLATE_INDEX[mode]
      for (let i = 0; i < n; i++) {
        const t = cmyk[i * 4 + off] / 255
        d[i * 4] = 255 + (ir - 255) * t
        d[i * 4 + 1] = 255 + (ig - 255) * t
        d[i * 4 + 2] = 255 + (ib - 255) * t
        d[i * 4 + 3] = 255
      }
      break
    }
    case 'tac': {
      const limit = (opts.tacLimit / 100) * 255
      for (let i = 0; i < n; i++) {
        const j = i * 4
        const sum = cmyk[j] + cmyk[j + 1] + cmyk[j + 2] + cmyk[j + 3]
        if (sum > limit) {
          d[j] = 255
          d[j + 1] = 30
          d[j + 2] = 60
        } else {
          const g = 255 - (sum / limit) * 200
          d[j] = d[j + 1] = d[j + 2] = g
        }
        d[j + 3] = 255
      }
      break
    }
    case 'gamut': {
      const de = res.deltaE
      for (let i = 0; i < n; i++) {
        const j = i * 4
        if (de && de[i] > opts.deltaE && alpha[i] > 0) {
          d[j] = 0
          d[j + 1] = 200
          d[j + 2] = 255
        } else {
          const g = 128 + luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) / 2
          d[j] = d[j + 1] = d[j + 2] = g
        }
        d[j + 3] = 255
      }
      break
    }
  }
  return out
}

export function computeStats(res: RenderResult, opts: { tacLimit: number; deltaE: number }) {
  const { cmyk, alpha, deltaE } = res
  const n = res.width * res.height
  const limit = (opts.tacLimit / 100) * 255
  let maxSum = 0
  let over = 0
  let outGamut = 0
  let opaque = 0
  for (let i = 0; i < n; i++) {
    if (alpha[i] === 0) continue
    opaque++
    const j = i * 4
    const sum = cmyk[j] + cmyk[j + 1] + cmyk[j + 2] + cmyk[j + 3]
    if (sum > maxSum) maxSum = sum
    if (sum > limit) over++
    if (deltaE && deltaE[i] > opts.deltaE) outGamut++
  }
  const denom = Math.max(opaque, 1)
  return {
    maxTac: (maxSum / 255) * 100,
    overRatio: over / denom,
    outGamutRatio: deltaE ? outGamut / denom : null,
  }
}

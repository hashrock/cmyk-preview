/**
 * 行列 + トーンカーブ型の RGB ICC プロファイル（v2）を生成する。
 * Adobe RGB (1998) 互換と Display P3 は原色・白色点・トーンカーブの数値定義だけで
 * 決まるので、ライセンスのあるファイルを配布せずに済む。
 */

type XY = [number, number]
type Mat3 = [number, number, number, number, number, number, number, number, number]

export type RgbSpace = {
  description: string
  red: XY
  green: XY
  blue: XY
  white: XY
  trc: { type: 'gamma'; gamma: number } | { type: 'srgb' }
}

export const RGB_SPACES = {
  adobergb: {
    description: 'Adobe RGB (1998) compatible (generated)',
    red: [0.64, 0.33],
    green: [0.21, 0.71],
    blue: [0.15, 0.06],
    white: [0.3127, 0.329],
    trc: { type: 'gamma', gamma: 563 / 256 }, // 2.19921875
  },
  p3: {
    description: 'Display P3 (generated)',
    red: [0.68, 0.32],
    green: [0.265, 0.69],
    blue: [0.15, 0.06],
    white: [0.3127, 0.329],
    trc: { type: 'srgb' },
  },
} satisfies Record<string, RgbSpace>

const D50: [number, number, number] = [0.9642, 1.0, 0.8249]

const xyToXYZ = ([x, y]: XY): [number, number, number] => [x / y, 1, (1 - x - y) / y]

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return r
}
const apply = (m: Mat3, v: [number, number, number]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
function inv(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}
const diag = (v: [number, number, number]): Mat3 => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]

/** RGB → XYZ(D50) の行列（列が R, G, B の colorant） */
function colorants(s: RgbSpace): Mat3 {
  const [r, g, b] = [xyToXYZ(s.red), xyToXYZ(s.green), xyToXYZ(s.blue)]
  const P: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]
  const W = xyToXYZ(s.white)
  const S = apply(inv(P), W)
  const M = mul(P, diag(S)) // RGB → XYZ(白色点 = s.white)
  // Bradford で D50 に順応
  const src = apply(BRADFORD, W)
  const dst = apply(BRADFORD, D50)
  const adapt = mul(inv(BRADFORD), mul(diag([dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]]), BRADFORD))
  return mul(adapt, M)
}

// ---- バイナリ書き出し ----

class Writer {
  bytes: number[] = []
  u8(v: number) {
    this.bytes.push(v & 0xff)
  }
  u16(v: number) {
    this.u8(v >> 8)
    this.u8(v)
  }
  u32(v: number) {
    this.u16(v >>> 16)
    this.u16(v & 0xffff)
  }
  s15f16(v: number) {
    this.u32(Math.round(v * 65536) | 0)
  }
  ascii(s: string) {
    for (const ch of s) this.u8(ch.charCodeAt(0))
  }
  pad4() {
    while (this.bytes.length % 4) this.u8(0)
  }
}

function xyzTag(v: [number, number, number]) {
  const w = new Writer()
  w.ascii('XYZ ')
  w.u32(0)
  v.forEach((x) => w.s15f16(x))
  return w.bytes
}

function textTag(s: string) {
  const w = new Writer()
  w.ascii('text')
  w.u32(0)
  w.ascii(s)
  w.u8(0)
  return w.bytes
}

function descTag(s: string) {
  const w = new Writer()
  w.ascii('desc')
  w.u32(0)
  w.u32(s.length + 1)
  w.ascii(s)
  w.u8(0)
  w.u32(0) // Unicode language code
  w.u32(0) // Unicode count
  w.u16(0) // ScriptCode code
  w.u8(0) // ScriptCode count
  for (let i = 0; i < 67; i++) w.u8(0)
  return w.bytes
}

function curvTag(trc: RgbSpace['trc']) {
  const w = new Writer()
  w.ascii('curv')
  w.u32(0)
  if (trc.type === 'gamma') {
    w.u32(1)
    w.u16(Math.round(trc.gamma * 256)) // u8Fixed8
  } else {
    const n = 4096
    w.u32(n)
    for (let i = 0; i < n; i++) {
      const v = i / (n - 1)
      const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      w.u16(Math.round(lin * 65535))
    }
  }
  return w.bytes
}

export function makeRgbProfile(s: RgbSpace): ArrayBuffer {
  const m = colorants(s)
  const curve = curvTag(s.trc)
  const tags: [string, number[]][] = [
    ['desc', descTag(s.description)],
    ['cprt', textTag('No copyright, generated from public colorimetric definitions')],
    ['wtpt', xyzTag(D50)],
    ['rXYZ', xyzTag([m[0], m[3], m[6]])],
    ['gXYZ', xyzTag([m[1], m[4], m[7]])],
    ['bXYZ', xyzTag([m[2], m[5], m[8]])],
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
  ]

  // タグデータの配置（同じ curve は共有）
  const headerSize = 128
  const tableSize = 4 + tags.length * 12
  let offset = headerSize + tableSize
  const placed = new Map<number[], number>()
  const entries: { sig: string; off: number; size: number }[] = []
  const data = new Writer()
  for (const [sig, bytes] of tags) {
    let off = placed.get(bytes)
    if (off === undefined) {
      off = offset
      placed.set(bytes, off)
      data.bytes.push(...bytes)
      data.pad4()
      offset = headerSize + tableSize + data.bytes.length
    }
    entries.push({ sig, off, size: bytes.length })
  }
  const total = headerSize + tableSize + data.bytes.length

  const w = new Writer()
  // ヘッダ
  w.u32(total)
  w.ascii('lcms') // CMM
  w.u32(0x02100000) // v2.1
  w.ascii('mntr')
  w.ascii('RGB ')
  w.ascii('XYZ ')
  for (let i = 0; i < 6; i++) w.u16(0) // 日時
  w.ascii('acsp')
  w.u32(0) // platform
  w.u32(0) // flags
  w.u32(0) // manufacturer
  w.u32(0) // model
  w.u32(0)
  w.u32(0) // attributes
  w.u32(0) // intent
  D50.forEach((x) => w.s15f16(x)) // PCS illuminant
  w.u32(0) // creator
  while (w.bytes.length < headerSize) w.u8(0)
  // タグテーブル
  w.u32(entries.length)
  for (const e of entries) {
    w.ascii(e.sig)
    w.u32(e.off)
    w.u32(e.size)
  }
  w.bytes.push(...data.bytes)
  return new Uint8Array(w.bytes).buffer
}

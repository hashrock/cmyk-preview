/** 画像ファイルに埋め込まれた ICC プロファイルを取り出す（PNG / JPEG / WebP） */
export async function extractIcc(file: Blob): Promise<ArrayBuffer | null> {
  const buf = new Uint8Array(await file.arrayBuffer())
  try {
    if (isPng(buf)) return await fromPng(buf)
    if (buf[0] === 0xff && buf[1] === 0xd8) return fromJpeg(buf)
    if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return fromWebp(buf)
  } catch {
    /* 壊れたチャンクなどは「埋め込みなし」として扱う */
  }
  return null
}

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0

function isPng(b: Uint8Array) {
  return b[0] === 0x89 && ascii(b, 1, 3) === 'PNG'
}

async function fromPng(b: Uint8Array) {
  let p = 8
  while (p + 8 <= b.length) {
    const len = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    const data = b.subarray(p + 8, p + 8 + len)
    if (type === 'iCCP') {
      const nul = data.indexOf(0)
      // [name]\0[compression method=0][zlib data]
      const zlib = data.slice(nul + 2)
      const stream = new Blob([zlib]).stream().pipeThrough(new DecompressionStream('deflate'))
      return await new Response(stream).arrayBuffer()
    }
    if (type === 'IDAT' || type === 'IEND') break
    p += 12 + len
  }
  return null
}

function fromJpeg(b: Uint8Array) {
  const parts: { seq: number; data: Uint8Array }[] = []
  let p = 2
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1]
    if (marker === 0xda || marker === 0xd9) break // SOS / EOI
    const len = (b[p + 2] << 8) | b[p + 3]
    if (marker === 0xe2 && ascii(b, p + 4, 12) === 'ICC_PROFILE\0') {
      parts.push({ seq: b[p + 16], data: b.subarray(p + 18, p + 2 + len) })
    }
    p += 2 + len
  }
  if (!parts.length) return null
  parts.sort((a, c) => a.seq - c.seq)
  const out = new Uint8Array(parts.reduce((s, x) => s + x.data.length, 0))
  let o = 0
  for (const x of parts) {
    out.set(x.data, o)
    o += x.data.length
  }
  return out.buffer
}

function fromWebp(b: Uint8Array) {
  let p = 12
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4)
    const len = u32le(b, p + 4)
    if (type === 'ICCP') return b.slice(p + 8, p + 8 + len).buffer
    p += 8 + len + (len & 1)
  }
  return null
}

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import type { Layout, Paper } from './paper'

type Lighting = 'daylight' | 'indoor' | 'window'

const PAPER_LOOK: Record<Paper, { roughness: number; clearcoat: number; bump: number }> = {
  coated: { roughness: 0.32, clearcoat: 0.25, bump: 0.15 },
  matte: { roughness: 0.62, clearcoat: 0, bump: 0.25 },
  uncoated: { roughness: 0.88, clearcoat: 0, bump: 0.6 },
  newsprint: { roughness: 0.95, clearcoat: 0, bump: 0.9 },
}

const LIGHTS: Record<Lighting, { label: string; key: string; fill: string; keyI: number; fillI: number; dir: [number, number, number] }> = {
  daylight: { label: '昼光', key: '#ffffff', fill: '#eef2ff', keyI: 0.85, fillI: 0.3, dir: [-1.2, 3, 1.4] },
  indoor: { label: '室内灯', key: '#ffe3bf', fill: '#fff1de', keyI: 0.8, fillI: 0.3, dir: [0.6, 3, 0.4] },
  window: { label: '窓際', key: '#fffaf2', fill: '#c9d6ff', keyI: 1.15, fillI: 0.18, dir: [-3, 1.6, 0.2] },
}

// A4 縦の 1 ページ = 幅 1, 高さ √2
const PAGE_W = 1
const PAGE_H = Math.SQRT2

type Props = {
  width: number
  height: number
  proof: Uint8Array
  original: Uint8Array
  paperRgb: [number, number, number]
  paper: Paper
  layout: Layout
  showOriginal: boolean
  onToggleOriginal: () => void
}

function bytesToCanvas(rgb: Uint8Array, w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const img = new ImageData(w, h)
  for (let i = 0, n = w * h; i < n; i++) {
    img.data[i * 4] = rgb[i * 3]
    img.data[i * 4 + 1] = rgb[i * 3 + 1]
    img.data[i * 4 + 2] = rgb[i * 3 + 2]
    img.data[i * 4 + 3] = 255
  }
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c
}

/** 画像を枠いっぱいに（はみ出しはトリミング）描く */
function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / src.width, h / src.height)
  const sw = w / s
  const sh = h / s
  ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, h)
}

/** 見開きの紙面テクスチャを作る */
function composeSpread(image: HTMLCanvasElement, paper: string, spread: boolean, maxW: number) {
  const W = Math.min(maxW, 4096)
  const H = Math.round((W / 2) * PAGE_H)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, W, H)
  const pw = W / 2
  if (spread) {
    drawCover(ctx, image, 0, 0, W, H)
  } else {
    drawCover(ctx, image, pw, 0, pw, H)
    // 左ページ：それっぽい記事
    const m = pw * 0.11
    ctx.fillStyle = 'rgba(30,30,30,0.88)'
    ctx.font = `700 ${pw * 0.075}px "Hiragino Mincho ProN", "Yu Mincho", serif`
    ctx.fillText('特集 イラストレーション', m, m + pw * 0.08)
    ctx.font = `400 ${pw * 0.028}px "Hiragino Sans", sans-serif`
    ctx.fillStyle = 'rgba(30,30,30,0.6)'
    ctx.fillText('SPECIAL FEATURE — 色と光の表現', m, m + pw * 0.14)
    ctx.fillStyle = 'rgba(30,30,30,0.85)'
    ctx.fillRect(m, m + pw * 0.17, pw * 0.12, pw * 0.006)
    const cols = 2
    const gap = pw * 0.05
    const colW = (pw - m * 2 - gap) / cols
    const lineH = pw * 0.032
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let col = 0; col < cols; col++) {
      let y = m + pw * 0.26
      while (y < H - m) {
        const para = rand() < 0.1
        const len = para ? 0.3 + rand() * 0.5 : 0.92 + rand() * 0.08
        ctx.fillStyle = 'rgba(40,40,40,0.55)'
        ctx.fillRect(m + col * (colW + gap), y, colW * len, lineH * 0.38)
        y += para ? lineH * 1.8 : lineH
      }
    }
    ctx.font = `400 ${pw * 0.022}px "Hiragino Sans", sans-serif`
    ctx.fillStyle = 'rgba(30,30,30,0.5)'
    ctx.fillText('42', m, H - m * 0.45)
  }
  return c
}

/** 紙の繊維っぽいノイズ */
function paperNoise(size = 512) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    const v = 128 + (Math.random() - 0.5) * 70
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  // 繊維
  ctx.globalAlpha = 0.08
  for (let i = 0; i < 1400; i++) {
    ctx.strokeStyle = Math.random() < 0.5 ? '#fff' : '#000'
    ctx.beginPath()
    const x = Math.random() * size
    const y = Math.random() * size
    const a = Math.random() * Math.PI
    const l = 4 + Math.random() * 14
    ctx.moveTo(x, y)
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
    ctx.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(6, 4)
  return t
}

/** 閉じた雑誌の 1 ページ（ほぼ平らで、小口側がわずかに反る） */
function singleGeometry() {
  const geo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, 60, 60)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / PAGE_W + 0.5 // 0 = 背, 1 = 小口
    const v = pos.getY(i) / PAGE_H
    pos.setZ(i, 0.018 * u ** 3 + 0.004 * Math.cos(v * Math.PI) * u)
  }
  geo.computeVertexNormals()
  return geo
}

/** 片面（1 ページ）の紙面テクスチャ */
function composeSingle(image: HTMLCanvasElement, paper: string, maxTex: number) {
  const H = Math.min(maxTex, 4096)
  const W = Math.round(H / PAGE_H)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = paper
  ctx.fillRect(0, 0, W, H)
  drawCover(ctx, image, 0, 0, W, H)
  return c
}

/** 開いた雑誌の紙面（ノドに向かってたわむ） */
function spreadGeometry() {
  const geo = new THREE.PlaneGeometry(PAGE_W * 2, PAGE_H, 240, 8)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const ax = Math.abs(x)
    // ノドで沈み、外側に向かってゆるく持ち上がって平らになる
    const z = 0.075 * (1 - Math.exp(-ax / 0.09)) + 0.012 * Math.sin((ax / PAGE_W) * Math.PI) - 0.01 * (ax / PAGE_W) ** 3
    // ノド付近では紙が中央へ巻き込まれる分、少し内側に寄る
    pos.setX(i, Math.sign(x) * (ax - 0.02 * Math.exp(-ax / 0.06)))
    pos.setZ(i, z)
  }
  geo.computeVertexNormals()
  return geo
}

function woodTexture() {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 1024
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#6b4a33'
  ctx.fillRect(0, 0, 1024, 1024)
  for (let i = 0; i < 260; i++) {
    const y = Math.random() * 1024
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? '40,24,14' : '140,100,70'},${0.05 + Math.random() * 0.12})`
    ctx.lineWidth = 1 + Math.random() * 4
    ctx.beginPath()
    ctx.moveTo(0, y)
    for (let x = 0; x <= 1024; x += 64) ctx.lineTo(x, y + Math.sin(x / 140 + i) * 6)
    ctx.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(2, 2)
  return t
}

const CAMERA_PRESETS = {
  angle: { label: '斜め', pos: [0.4, 2.1, 2.3] },
  top: { label: '真上', pos: [0, 3.4, 0.001] },
  close: { label: '手元', pos: [0.9, 0.9, 1.1] },
} as const
type CameraPreset = keyof typeof CAMERA_PRESETS

export default function MagazineView(props: Props) {
  const { width, height, proof, original, paperRgb, paper, layout, showOriginal, onToggleOriginal } = props
  const mountRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    surface: THREE.MeshPhysicalMaterial
    under: THREE.MeshStandardMaterial[]
    keyLight: THREE.DirectionalLight
    fillLight: THREE.HemisphereLight
    spreadBook: THREE.Group
    singleBook: THREE.Group
  } | null>(null)
  const [lighting, setLighting] = useState<Lighting>('daylight')

  // シーン構築（1 回だけ）
  useEffect(() => {
    const mount = mountRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // 色を正しく見たいのでトーンマッピングはかけない
    renderer.toneMapping = THREE.NoToneMapping
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#1d1b1a')
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.25

    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 50)
    camera.position.fromArray(CAMERA_PRESETS.angle.pos)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.maxPolarAngle = Math.PI * 0.47
    controls.minDistance = 0.4
    controls.maxDistance = 6
    controls.target.set(0, 0.03, 0)

    // ライト
    const fillLight = new THREE.HemisphereLight('#ffffff', '#5a4a40', 0.3)
    scene.add(fillLight)
    const keyLight = new THREE.DirectionalLight('#ffffff', 0.85)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.camera.left = -2
    keyLight.shadow.camera.right = 2
    keyLight.shadow.camera.top = 2
    keyLight.shadow.camera.bottom = -2
    keyLight.shadow.bias = -0.0004
    keyLight.shadow.normalBias = 0.02
    keyLight.shadow.radius = 6
    scene.add(keyLight)

    // 机
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.75 }),
    )
    table.rotation.x = -Math.PI / 2
    table.receiveShadow = true
    scene.add(table)

    // 雑誌（見開き用と片面用を作って切り替える）
    const noise = paperNoise()
    const surface = new THREE.MeshPhysicalMaterial({ bumpMap: noise, roughnessMap: noise })
    const under: THREE.MeshStandardMaterial[] = []
    for (let i = 1; i <= 5; i++) under.push(new THREE.MeshStandardMaterial({ roughness: 0.9 }))
    const coverMat = new THREE.MeshStandardMaterial({ color: '#2b3a55', roughness: 0.4 })

    const buildBook = (geo: THREE.BufferGeometry, rotZ: number) => {
      const book = new THREE.Group()
      book.rotation.x = -Math.PI / 2
      book.position.y = 0.012
      book.rotation.z = rotZ
      scene.add(book)
      const top = new THREE.Mesh(geo, surface)
      top.castShadow = true
      top.receiveShadow = true
      book.add(top)
      // 下のページ（小口に紙の重なりが見えるように少しずつずらす）
      under.forEach((mat, idx) => {
        const i = idx + 1
        const page = new THREE.Mesh(geo, mat)
        page.position.z = -0.0022 * i
        page.scale.set(1 + 0.0016 * i, 1 - 0.0008 * i, 1 - 0.07 * i)
        page.receiveShadow = true
        page.castShadow = true
        book.add(page)
      })
      // 表紙
      const cover = new THREE.Mesh(geo, coverMat)
      cover.position.z = -0.016
      cover.scale.set(1.012, 1.008, 0.4)
      cover.castShadow = true
      cover.receiveShadow = true
      book.add(cover)
      return book
    }
    const spreadBook = buildBook(spreadGeometry(), 0.06)
    const singleBook = buildBook(singleGeometry(), 0.1)

    ctxRef.current = { renderer, scene, camera, controls, surface, under, keyLight, fillLight, spreadBook, singleBook }

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(mount)
    resize()

    let raf = 0
    const loop = () => {
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(loop)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) {
            for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose()
            m.dispose()
          }
        }
      })
      pmrem.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      ctxRef.current = null
    }
  }, [])

  // 紙面テクスチャ
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const paperCss = `rgb(${paperRgb.join(',')})`
    const page = layout === 'page'
    const spread = layout === 'spread' || (layout === 'auto' && width / height > 1.15)
    ctx.spreadBook.visible = !page
    ctx.singleBook.visible = page
    const img = bytesToCanvas(showOriginal ? original : proof, width, height)
    const paperFill = showOriginal ? '#fff' : paperCss
    const maxTex = ctx.renderer.capabilities.maxTextureSize
    const canvas = page ? composeSingle(img, paperFill, maxTex) : composeSpread(img, paperFill, spread, maxTex)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy()
    const old = ctx.surface.map
    ctx.surface.map = tex
    ctx.surface.needsUpdate = true
    old?.dispose()
    // Color.set は CSS 色を sRGB として解釈し、リニアに変換してくれる
    for (const m of ctx.under) m.color.set(showOriginal ? '#ffffff' : paperCss)
  }, [width, height, proof, original, paperRgb, layout, showOriginal])

  // 紙質
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const look = PAPER_LOOK[paper]
    ctx.surface.roughness = look.roughness
    ctx.surface.clearcoat = look.clearcoat
    ctx.surface.clearcoatRoughness = 0.35
    ctx.surface.bumpScale = look.bump
    ctx.surface.needsUpdate = true
  }, [paper])

  // ライティング
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const l = LIGHTS[lighting]
    ctx.keyLight.color.set(l.key)
    ctx.keyLight.intensity = l.keyI
    ctx.keyLight.position.set(...l.dir)
    ctx.fillLight.color.set(l.fill)
    ctx.fillLight.intensity = l.fillI
  }, [lighting])

  const setCamera = (p: CameraPreset) => {
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.camera.position.fromArray(CAMERA_PRESETS[p].pos)
    ctx.controls.target.set(0, 0.03, 0)
  }

  const screenshot = () => {
    const ctx = ctxRef.current
    if (!ctx) return
    const a = document.createElement('a')
    a.download = `magazine_${showOriginal ? 'rgb' : 'cmyk'}.png`
    a.href = ctx.renderer.domElement.toDataURL('image/png')
    a.click()
  }

  return (
    <div className="magazine">
      <div className="magazine-canvas" ref={mountRef} />
      <div className="magazine-toolbar">
        <div className="seg">
          <button className={!showOriginal ? 'active' : ''} onClick={() => showOriginal && onToggleOriginal()}>
            CMYK
          </button>
          <button className={showOriginal ? 'active' : ''} onClick={() => !showOriginal && onToggleOriginal()}>
            RGB
          </button>
        </div>
        <div className="seg">
          {(Object.keys(LIGHTS) as Lighting[]).map((k) => (
            <button key={k} className={lighting === k ? 'active' : ''} onClick={() => setLighting(k)}>
              {LIGHTS[k].label}
            </button>
          ))}
        </div>
        <div className="seg">
          {(Object.keys(CAMERA_PRESETS) as CameraPreset[]).map((k) => (
            <button key={k} onClick={() => setCamera(k)}>
              {CAMERA_PRESETS[k].label}
            </button>
          ))}
        </div>
        <button onClick={screenshot}>📷 保存</button>
      </div>
      <p className="magazine-hint">ドラッグで回転 / ホイールでズーム / 右ドラッグで移動 / Space で RGB・CMYK 切替</p>
    </div>
  )
}

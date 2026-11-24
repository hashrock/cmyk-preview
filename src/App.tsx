import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extractIcc } from './icc'
import { makeRgbProfile, RGB_SPACES } from './icc-gen'
import { PAPERS, type Layout, type Paper } from './paper'
import { CancelledError, createClient } from './protocol'
import { buildView, computeStats, type RenderResult, type ViewMode } from './views'

const MagazineView = lazy(() => import('./MagazineView'))

const MAX_SIDE = 4096

// 先頭 2 つは再配布可能で同梱。残りは手元にあれば読み込む（public/profiles/LICENSES.md 参照）
const BUILTIN_PROFILES = [
  { id: 'jc2011c', file: 'JapanColor2011Coated.icc', label: 'Japan Color 2011 Coated', tac: 350 },
  { id: 'fogra39l', file: 'FOGRA39L_coated.icc', label: 'FOGRA39L Coated', tac: 330 },
  { id: 'jc2001c', file: 'JapanColor2001Coated.icc', label: 'Japan Color 2001 Coated', tac: 350 },
  { id: 'jc2001u', file: 'JapanColor2001Uncoated.icc', label: 'Japan Color 2001 Uncoated', tac: 310 },
  { id: 'jc2002n', file: 'JapanColor2002Newspaper.icc', label: 'Japan Color 2002 Newspaper', tac: 250 },
  { id: 'fogra39', file: 'CoatedFOGRA39.icc', label: 'Coated FOGRA39', tac: 330 },
]

const INTENTS = [
  { value: 0, label: '知覚的' },
  { value: 1, label: '相対的な色域を維持' },
  { value: 2, label: '彩度' },
]

const VIEWS: { mode: ViewMode; label: string; key: string }[] = [
  { mode: 'split', label: '比較', key: '1' },
  { mode: 'original', label: '元画像 (RGB)', key: '2' },
  { mode: 'proof', label: 'CMYK', key: '3' },
  { mode: 'c', label: 'C版', key: '4' },
  { mode: 'm', label: 'M版', key: '5' },
  { mode: 'y', label: 'Y版', key: '6' },
  { mode: 'k', label: 'K版', key: '7' },
  { mode: 'tac', label: '総インキ量', key: '8' },
  { mode: 'gamut', label: '色域外警告', key: '9' },
  { mode: 'magazine', label: '3D 雑誌プレビュー', key: '0' },
]

// 出力プロファイルから紙質を推定
const paperForProfile = (id: string): Paper =>
  id === 'jc2002n' ? 'newsprint' : id === 'jc2001u' ? 'uncoated' : 'coated'

const INPUT_MODES = [
  { value: 'embedded', label: '埋め込みプロファイルに従う' },
  { value: 'srgb', label: 'sRGB として扱う' },
  { value: 'adobergb', label: 'Adobe RGB として扱う' },
  { value: 'p3', label: 'Display P3 として扱う' },
] as const
type InputMode = (typeof INPUT_MODES)[number]['value']

type Profile = { id: string; label: string; tac: number }
type Source = {
  name: string
  width: number
  height: number
  scaled: boolean
  raw: Uint8Array // ファイルの RGB 値（白合成済み）
  rgb: Uint8Array // sRGB に変換した表示用
  alpha: Uint8Array
  srcLabel: string // どの入力プロファイルで解釈したか
}
type Hover = { x: number; y: number } | null

/** convert=false なら埋め込みプロファイルを無視してファイルの値をそのまま取り出す */
async function decodeImage(file: Blob, convert: boolean): Promise<{ data: ImageData; scaled: boolean }> {
  const bmp = await createImageBitmap(file, { colorSpaceConversion: convert ? 'default' : 'none' })
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return { data: ctx.getImageData(0, 0, w, h, { colorSpace: 'srgb' }), scaled: scale < 1 }
}

/** 透明部分を白い紙の上に合成した RGB とアルファを返す */
function flatten(img: ImageData) {
  const n = img.width * img.height
  const src = img.data
  const rgb = new Uint8Array(n * 3)
  const alpha = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3]
    alpha[i] = a
    const inv = 255 - a
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = (src[i * 4 + c] * a + 255 * inv + 127) / 255
  }
  return { rgb, alpha }
}

const isIcc = (f: File) => /\.(icc|icm)$/i.test(f.name)
const pct = (v: number) => `${Math.round((v / 255) * 100)}`

export default function App() {
  const client = useMemo(() => createClient(), [])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState('jc2011c')
  const [intent, setIntent] = useState(0)
  const [bpc, setBpc] = useState(true)
  const [paperWhite, setPaperWhite] = useState(false)
  const [view, setView] = useState<ViewMode>('split')
  const [tacLimit, setTacLimit] = useState(350)
  const [deltaE, setDeltaE] = useState(5)
  const [split, setSplit] = useState(0.5)
  const [fit, setFit] = useState(true)
  const [needGamut, setNeedGamut] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>('embedded')
  const [file, setFile] = useState<{ blob: Blob; name: string } | null>(null)
  const [magOriginal, setMagOriginal] = useState(false)
  const [paperOverride, setPaperOverride] = useState<Paper | null>(null)
  const [layout, setLayout] = useState<Layout>('auto')

  const [source, setSource] = useState<Source | null>(null)
  const [result, setResult] = useState<RenderResult | null>(null)
  // value が null のときは進捗不明（読み込み中など）
  const [progress, setProgress] = useState<{ label: string; value: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState<Hover>(null)

  const mainCanvas = useRef<HTMLCanvasElement>(null)
  const origCanvas = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // 同梱プロファイルを読み込む
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const loaded: Profile[] = []
      for (const p of BUILTIN_PROFILES) {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}profiles/${p.file}`)
          if (!res.ok) continue
          const bytes = await res.arrayBuffer()
          await client.call({ type: 'loadProfile', id: p.id, bytes, kind: 'cmyk' }, [bytes])
          loaded.push({ id: p.id, label: p.label, tac: p.tac })
        } catch {
          /* 見つからないプロファイルはスキップ */
        }
      }
      if (cancelled) return
      setProfiles((prev) => [...loaded, ...prev.filter((p) => !loaded.some((l) => l.id === p.id))])
      // 既定のプロファイルが無い環境では読み込めた最初のものを使う
      if (loaded.length && !loaded.some((p) => p.id === 'jc2011c')) {
        setProfileId((cur) => (loaded.some((p) => p.id === cur) ? cur : loaded[0].id))
        setTacLimit(loaded[0].tac)
      }
      if (loaded.length === 0) setError('同梱プロファイルが見つかりません。CMYK の .icc ファイルをドロップしてください。')
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  const addProfile = useCallback(
    async (file: File) => {
      const bytes = await file.arrayBuffer()
      const id = `user:${file.name}`
      const res = await client.call({ type: 'loadProfile', id, bytes, kind: 'cmyk' }, [bytes])
      if (res.type !== 'profileLoaded') return
      setProfiles((prev) => [...prev.filter((p) => p.id !== id), { id, label: res.name || file.name, tac: 350 }])
      setProfileId(id)
      setTacLimit(350)
    },
    [client],
  )

  // 入力 RGB プロファイル（Adobe RGB / P3）を必要になったときに読み込む
  const loadedRgb = useRef(new Map<string, Promise<string>>())
  const ensureRgbProfile = useCallback(
    (id: string) => {
      let p = loadedRgb.current.get(id)
      if (!p) {
        p = (async () => {
          const bytes = makeRgbProfile(RGB_SPACES[id as keyof typeof RGB_SPACES])
          const r = await client.call({ type: 'loadProfile', id, bytes, kind: 'rgb' }, [bytes])
          return r.type === 'profileLoaded' ? r.name : id
        })()
        p.catch(() => loadedRgb.current.delete(id))
        loadedRgb.current.set(id, p)
      }
      return p
    },
    [client],
  )

  // 画像の読み込み（ファイルか入力モードが変わったらやり直す）
  const embeddedSeq = useRef(0)
  useEffect(() => {
    if (!file) return
    let stale = false
    ;(async () => {
      setProgress({ label: '読み込み中', value: null })
      setError(null)
      try {
        let srcProfileId = 'srgb'
        let srcLabel = 'sRGB'
        let convert = false
        if (inputMode === 'embedded') {
          const icc = await extractIcc(file.blob)
          if (!icc) {
            srcLabel = '埋め込みなし → sRGB'
          } else {
            const id = `embedded:${++embeddedSeq.current}`
            try {
              const r = await client.call({ type: 'loadProfile', id, bytes: icc, kind: 'rgb' }, [icc])
              srcProfileId = id
              srcLabel = r.type === 'profileLoaded' && r.name ? r.name : '埋め込みプロファイル'
            } catch {
              // グレースケール等 RGB 以外のプロファイルはブラウザに sRGB へ変換してもらう
              convert = true
              srcLabel = '埋め込み（RGB 以外）→ ブラウザで sRGB 化'
            }
          }
        } else if (inputMode !== 'srgb') {
          srcLabel = await ensureRgbProfile(inputMode)
          srcProfileId = inputMode
        }
        const { data, scaled } = await decodeImage(file.blob, convert)
        const { rgb: raw, alpha } = flatten(data)
        const copy = raw.slice()
        const res = await client.call(
          { type: 'setImage', width: data.width, height: data.height, rgb: copy.buffer, srcProfileId },
          [copy.buffer],
        )
        if (stale || res.type !== 'imageSet') return
        setResult(null)
        setProgress(null)
        setSource({ name: file.name, width: data.width, height: data.height, scaled, raw, rgb: res.display, alpha, srcLabel })
      } catch (e) {
        if (stale) return
        setError(e instanceof Error ? e.message : String(e))
        setProgress(null)
      }
    })()
    return () => {
      stale = true
    }
  }, [client, file, inputMode, ensureRgbProfile])

  const openImage = useCallback(async (blob: Blob, name: string) => setFile({ blob, name }), [])

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null)
      const list = Array.from(files)
      try {
        for (const f of list.filter(isIcc)) await addProfile(f)
        const img = list.find((f) => f.type.startsWith('image/'))
        if (img) await openImage(img, img.name)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [addProfile, openImage],
  )

  // 設定変更で再変換
  const profileReady = profiles.some((p) => p.id === profileId)
  useEffect(() => {
    if (!source || !profileReady) return
    let stale = false
    setProgress({ label: '変換中', value: 0 })
    client
      .call({ type: 'render', profileId, intent, bpc, paperWhite, gamut: needGamut }, [], (value) => {
        if (!stale) setProgress({ label: '変換中', value })
      })
      .then((res) => {
        if (stale || res.type !== 'rendered') return
        setResult({ ...res, rgb: source.rgb, alpha: source.alpha })
        setError(null)
      })
      .catch((e: Error) => !stale && !(e instanceof CancelledError) && setError(e.message))
      .finally(() => !stale && setProgress(null))
    return () => {
      stale = true
    }
  }, [client, source, profileReady, profileId, intent, bpc, paperWhite, needGamut])

  const selectView = useCallback((mode: ViewMode | ((cur: ViewMode) => ViewMode)) => {
    setView((cur) => {
      const next = typeof mode === 'function' ? mode(cur) : mode
      if (next === 'gamut') setNeedGamut(true)
      return next
    })
  }, [])

  // プロファイル切替時は推奨 TAC に合わせる
  const selectProfile = (id: string, list = profiles) => {
    setProfileId(id)
    const p = list.find((p) => p.id === id)
    if (p) setTacLimit(p.tac)
  }

  // キャンバス描画
  useEffect(() => {
    if (!result || view === 'magazine') return
    const opts = { tacLimit, deltaE }
    const main = mainCanvas.current!
    main.width = result.width
    main.height = result.height
    main.getContext('2d')!.putImageData(buildView(result, view === 'split' ? 'proof' : view, opts), 0, 0)
    if (view === 'split') {
      const o = origCanvas.current!
      o.width = result.width
      o.height = result.height
      o.getContext('2d')!.putImageData(buildView(result, 'original', opts), 0, 0)
    }
  }, [result, view, tacLimit, deltaE])

  const stats = useMemo(() => (result ? computeStats(result, { tacLimit, deltaE }) : null), [result, tacLimit, deltaE])

  // ペースト・キーボード
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length) handleFiles(files)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const v = VIEWS.find((v) => v.key === e.key)
      if (v) selectView(v.mode)
      if (e.key === 'f') setFit((f) => !f)
      if (e.key === ' ') {
        e.preventDefault()
        if (view === 'magazine') setMagOriginal((v) => !v)
        else selectView((cur) => (cur === 'original' ? 'proof' : 'original'))
      }
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKey)
    }
  }, [handleFiles, selectView, view])

  const onPointerMove = (e: React.PointerEvent) => {
    if (!result) return
    const rect = mainCanvas.current!.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    if (view === 'split' && e.buttons === 1) setSplit(Math.min(1, Math.max(0, fx)))
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return setHover(null)
    setHover({ x: Math.floor(fx * result.width), y: Math.floor(fy * result.height) })
  }

  const download = () => {
    if (!result || !source) return
    const c = document.createElement('canvas')
    c.width = result.width
    c.height = result.height
    const mode = view === 'split' || view === 'magazine' ? 'proof' : view
    c.getContext('2d')!.putImageData(buildView(result, mode, { tacLimit, deltaE }), 0, 0)
    const a = document.createElement('a')
    a.download = `${source.name.replace(/\.[^.]+$/, '')}_${mode}.png`
    a.href = c.toDataURL('image/png')
    a.click()
  }

  const advancedChanged = inputMode !== 'embedded' || intent !== 0 || !bpc

  const px = hover && result ? hover.y * result.width + hover.x : -1
  const info =
    px >= 0 && result && source
      ? {
          raw: [source.raw[px * 3], source.raw[px * 3 + 1], source.raw[px * 3 + 2]],
          rgb: [result.rgb[px * 3], result.rgb[px * 3 + 1], result.rgb[px * 3 + 2]],
          proof: [result.proof[px * 3], result.proof[px * 3 + 1], result.proof[px * 3 + 2]],
          cmyk: [result.cmyk[px * 4], result.cmyk[px * 4 + 1], result.cmyk[px * 4 + 2], result.cmyk[px * 4 + 3]],
          de: result.deltaE?.[px] ?? null,
        }
      : null
  const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
    >
      <aside className="panel">
        <h1>CMYK Preview</h1>

        <section>
          <label className="field">
            <span>出力プロファイル</span>
            <select value={profileId} onChange={(e) => selectProfile(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={paperWhite} onChange={(e) => setPaperWhite(e.target.checked)} />
            紙色をシミュレート
          </label>
        </section>

        <section>
          <h2>表示</h2>
          <div className="views">
            {VIEWS.map((v) => (
              <button
                key={v.mode}
                className={`${view === v.mode ? 'active' : ''} ${v.mode === 'split' || v.mode === 'magazine' ? 'wide' : ''}`}
                onClick={() => selectView(v.mode)}
              >
                <kbd>{v.key}</kbd>
                {v.label}
              </button>
            ))}
          </div>
        </section>

        {view === 'magazine' && (
          <section>
            <label className="field">
              <span>紙質</span>
              <select value={paperOverride ?? paperForProfile(profileId)} onChange={(e) => setPaperOverride(e.target.value as Paper)}>
                {PAPERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>レイアウト</span>
              <select value={layout} onChange={(e) => setLayout(e.target.value as Layout)}>
                <option value="auto">自動（横長なら見開き）</option>
                <option value="spread">見開きいっぱい</option>
                <option value="single">右ページ＋記事</option>
                <option value="page">片面（1 ページ）</option>
              </select>
            </label>
            {!paperWhite && <p className="hint">「紙色をシミュレート」をオンにすると紙の色味も反映されます</p>}
          </section>
        )}
        {view === 'tac' && (
          <section>
            <label className="field">
              <span>総インキ量の上限: {tacLimit}%</span>
              <input type="range" min={200} max={400} step={5} value={tacLimit} onChange={(e) => setTacLimit(Number(e.target.value))} />
            </label>
          </section>
        )}
        {view === 'gamut' && (
          <section>
            <label className="field">
              <span>警告しきい値: ΔE {deltaE}</span>
              <input type="range" min={1} max={20} step={0.5} value={deltaE} onChange={(e) => setDeltaE(Number(e.target.value))} />
            </label>
          </section>
        )}

        {stats && (
          <section className="stats">
            <h2>統計</h2>
            <dl>
              <dt>最大インキ量</dt>
              <dd className={stats.maxTac > tacLimit ? 'warn' : ''}>{stats.maxTac.toFixed(0)}%</dd>
              <dt>上限超過 ({tacLimit}%)</dt>
              <dd className={stats.overRatio > 0 ? 'warn' : ''}>{(stats.overRatio * 100).toFixed(2)}%</dd>
              {stats.outGamutRatio !== null && (
                <>
                  <dt>色域外 (ΔE&gt;{deltaE})</dt>
                  <dd>{(stats.outGamutRatio * 100).toFixed(2)}%</dd>
                </>
              )}
            </dl>
          </section>
        )}

        <section className="pixel">
          <h2>ピクセル</h2>
          {info ? (
            <>
              <div className="swatches">
                <div>
                  <i style={{ background: hex(info.rgb) }} />
                  RGB
                </div>
                <div>
                  <i style={{ background: hex(info.proof) }} />
                  CMYK
                </div>
              </div>
              <table>
                <tbody>
                  <tr>
                    <th>RGB</th>
                    <td colSpan={4}>
                      {info.raw.join(', ')} <span className="dim">{hex(info.raw)}</span>
                    </td>
                  </tr>
                  <tr>
                    <th>CMYK</th>
                    <td className="c">{pct(info.cmyk[0])}</td>
                    <td className="m">{pct(info.cmyk[1])}</td>
                    <td className="y">{pct(info.cmyk[2])}</td>
                    <td className="k">{pct(info.cmyk[3])}</td>
                  </tr>
                  <tr>
                    <th>総量</th>
                    <td colSpan={4}>{pct(info.cmyk.reduce((a, b) => a + b, 0))}%</td>
                  </tr>
                  {info.de !== null && (
                    <tr>
                      <th>ΔE</th>
                      <td colSpan={4}>{info.de.toFixed(1)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          ) : (
            <p className="hint">画像にカーソルを乗せると値を表示</p>
          )}
        </section>

        <details className="advanced">
          <summary>
            詳細設定
            {advancedChanged && <span className="badge">変更あり</span>}
          </summary>
          <section>
            <label className="field">
              <span>入力 RGB の扱い</span>
              <select value={inputMode} onChange={(e) => setInputMode(e.target.value as InputMode)}>
                {INPUT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {source && <p className="hint">解釈: {source.srcLabel}</p>}
            <label className="field">
              <span>レンダリングインテント</span>
              <select value={intent} onChange={(e) => setIntent(Number(e.target.value))}>
                {INTENTS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={bpc} onChange={(e) => setBpc(e.target.checked)} />
              黒点の補正
            </label>
            <p className="hint">
              .icc / .icm をドロップでプロファイル追加
              <br />
              Space: RGB / CMYK 切替　F: フィット / 等倍
            </p>
          </section>
        </details>

        <section className="actions">
          <button onClick={() => fileInput.current?.click()}>画像を開く…</button>
          <button onClick={download} disabled={!result}>
            表示中の画像を保存
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.icc,.icm"
            multiple
            hidden
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </section>
      </aside>

      <main className={`stage ${fit ? 'fit' : 'actual'}`} ref={stageRef}>
        {source && view === 'magazine' ? (
          result && (
            <Suspense fallback={null}>
            <MagazineView
              width={result.width}
              height={result.height}
              proof={result.proof}
              original={result.rgb}
              paperRgb={result.paper}
              paper={paperOverride ?? paperForProfile(profileId)}
              layout={layout}
              showOriginal={magOriginal}
              onToggleOriginal={() => setMagOriginal((v) => !v)}
            />
            </Suspense>
          )
        ) : source ? (
          <div
            className="frame"
            onPointerMove={onPointerMove}
            onPointerDown={(e) => {
              if (view === 'split') {
                e.currentTarget.setPointerCapture(e.pointerId)
                onPointerMove(e)
              }
            }}
            onPointerLeave={() => setHover(null)}
            style={
              {
                aspectRatio: `${source.width} / ${source.height}`,
                '--ratio': source.width / source.height,
                width: fit ? undefined : source.width / window.devicePixelRatio,
              } as React.CSSProperties
            }
          >
            <canvas ref={mainCanvas} className={result ? '' : 'pending'} />
            {view === 'split' && result && (
              <>
                <canvas ref={origCanvas} className="overlay" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }} />
                <div className="divider" style={{ left: `${split * 100}%` }} />
                <span className="tag left" style={{ opacity: split > 0.08 ? 1 : 0 }}>
                  RGB
                </span>
                <span className="tag right" style={{ opacity: split < 0.92 ? 1 : 0 }}>
                  CMYK
                </span>
              </>
            )}
          </div>
        ) : (
          <div className="empty" onClick={() => fileInput.current?.click()}>
            <div className="drop-icon">⬇</div>
            <p>画像をドロップ</p>
            <p className="hint">クリックで選択 / ⌘V で貼り付け / .icc でプロファイル追加</p>
          </div>
        )}
        {source && (
          <div className="status">
            {source.name} — {source.width}×{source.height}
            {source.scaled && '（縮小表示）'}
          </div>
        )}
        {progress && (
          <div className="progress" role="progressbar" aria-valuenow={progress.value === null ? undefined : Math.round(progress.value * 100)}>
            <div className="progress-track">
              <div
                className={`progress-bar ${progress.value === null ? 'indeterminate' : ''}`}
                style={progress.value === null ? undefined : { transform: `scaleX(${progress.value})` }}
              />
            </div>
            <span className="progress-label">
              {progress.label}
              {progress.value !== null && ` ${Math.round(progress.value * 100)}%`}
            </span>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {dragging && <div className="dropzone">ドロップして開く</div>}
      </main>
    </div>
  )
}

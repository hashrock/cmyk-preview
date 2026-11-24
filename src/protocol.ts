export type WorkerRequest =
  | { type: 'loadProfile'; reqId: number; id: string; bytes: ArrayBuffer; kind: 'cmyk' | 'rgb' }
  | {
      type: 'setImage'
      reqId: number
      width: number
      height: number
      rgb: ArrayBuffer
      /** 'srgb' または loadProfile 済みの RGB プロファイル id */
      srcProfileId: string
    }
  | {
      type: 'render'
      reqId: number
      profileId: string
      intent: number
      bpc: boolean
      paperWhite: boolean
      gamut: boolean
    }

export type WorkerResponse =
  | { type: 'profileLoaded'; reqId: number; id: string; name: string }
  | { type: 'imageSet'; reqId: number; display: Uint8Array }
  | {
      type: 'rendered'
      reqId: number
      width: number
      height: number
      cmyk: Uint8Array
      proof: Uint8Array
      deltaE: Float32Array | null
      /** 紙（インキなし）の表示色 */
      paper: [number, number, number]
    }
  | { type: 'progress'; reqId: number; value: number }
  | { type: 'error'; reqId: number; message: string; cancelled?: boolean }

type Dist<T> = T extends unknown ? Omit<T, 'reqId'> : never
export type RequestBody = Dist<WorkerRequest>

export class CancelledError extends Error {}

/** Promise ベースで worker を呼び出す小さなクライアント */
export function createClient() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let seq = 0
  type Pending = {
    resolve: (v: WorkerResponse) => void
    reject: (e: Error) => void
    onProgress?: (v: number) => void
  }
  const pending = new Map<number, Pending>()
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const p = pending.get(e.data.reqId)
    if (!p) return
    if (e.data.type === 'progress') return p.onProgress?.(e.data.value)
    pending.delete(e.data.reqId)
    if (e.data.type === 'error') p.reject(e.data.cancelled ? new CancelledError() : new Error(e.data.message))
    else p.resolve(e.data)
  }
  return {
    call(
      body: RequestBody,
      transfer: Transferable[] = [],
      onProgress?: (v: number) => void,
    ): Promise<WorkerResponse> {
      const reqId = ++seq
      return new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject, onProgress })
        worker.postMessage({ ...body, reqId }, transfer)
      })
    },
  }
}

declare module 'lcms-wasm' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type LCMS = any
  export function instantiate(opts?: {
    locateFile?: (name: string) => string
  }): Promise<LCMS>
  export const TYPE_RGB_8: number
  export const TYPE_CMYK_8: number
  export const INTENT_PERCEPTUAL: number
  export const INTENT_RELATIVE_COLORIMETRIC: number
  export const INTENT_SATURATION: number
  export const INTENT_ABSOLUTE_COLORIMETRIC: number
  export const cmsFLAGS_BLACKPOINTCOMPENSATION: number
  export const cmsFLAGS_NOCACHE: number
  export const cmsInfoDescription: number
  export const PT_Lab: number
  export function FLOAT_SH(a: number): number
  export function COLORSPACE_SH(a: number): number
  export function CHANNELS_SH(a: number): number
  export function BYTES_SH(a: number): number
}

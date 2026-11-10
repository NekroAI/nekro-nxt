import * as jsqr from 'jsqr'

type Decode = (pixels: Uint8ClampedArray, width: number, height: number) => { readonly data: string } | null

/**
 * jsqr is CommonJS with an ES default export. Bundlers and Node's resolution nest that default at different depths,
 * so the function is found at runtime.
 */
const find = (value: unknown, depth = 0): Decode => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jsqr's only export is this function.
  if (typeof value === 'function') return value as Decode
  if (depth < 2 && typeof value === 'object' && value !== null && 'default' in value)
    return find(value.default, depth + 1)
  throw new Error('二维码识别组件没有加载。')
}
const decode = find(jsqr)

/** The text of a QR code in an RGBA image, or undefined. */
export const decodeQr = (pixels: Uint8ClampedArray, width: number, height: number): string | undefined =>
  decode(pixels, width, height)?.data

import sharp from 'sharp'

export interface ImageInfo {
  readonly mediaType: string
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly byteSize: number
  /** 64-bit difference hash of the first frame, 16 hex digits. */
  readonly dhash: string
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heif: 'image/heif',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
}

/**
 * Difference hash: the first frame in 9×8 grayscale, one bit per pixel brighter than its right neighbour. Re-encoded or
 * resized copies of a picture stay within a few bits of each other.
 */
export const differenceHash = async (file: string | Buffer): Promise<string> => {
  const pixels = await sharp(file, { pages: 1, limitInputPixels: false })
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer()
  let hash = 0n
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      hash = (hash << 1n) | (pixels[row * 9 + column]! > pixels[row * 9 + column + 1]! ? 1n : 0n)
    }
  }
  return hash.toString(16).padStart(16, '0')
}

/** Number of differing bits between two hashes from {@link differenceHash}. */
export const hashDistance = (left: string, right: string): number => {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let bits = 0
  while (value > 0n) {
    bits += Number(value & 1n)
    value >>= 1n
  }
  return bits
}

export const inspectImage = async (file: string, byteSize: number): Promise<ImageInfo> => {
  const metadata = await sharp(file, { limitInputPixels: false }).metadata()
  if (metadata.format === undefined || metadata.width === undefined || metadata.height === undefined) {
    throw new Error('这个文件不是可识别的图片。')
  }
  const frames = metadata.pages ?? 1
  return {
    mediaType: MEDIA_TYPES[metadata.format] ?? `image/${metadata.format}`,
    width: metadata.width,
    // Animated images report the whole strip height; one frame is `pageHeight`.
    height: frames > 1 ? (metadata.pageHeight ?? metadata.height) : metadata.height,
    frames,
    byteSize,
    dhash: await differenceHash(file),
  }
}

/** A still WebP preview at most `size` pixels on the long side, for pages listing library pictures. */
export const imageThumbnail = (file: string, size = 256): Promise<Buffer> =>
  sharp(file, { pages: 1, limitInputPixels: false })
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()

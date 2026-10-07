import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { z } from 'zod'
import { validateHostUiSvg } from './ui-assets.js'

/**
 * 扩展自身的图标：Manifest `icon` 指向包内 `assets/icon.{svg,png,webp}` 之一。包内（zip 与已保存的 Revision 目录）
 * 存原始字节；内存中的 `resources` 映射仍是文本，二进制图标的值是标准 base64，SVG 是原文。`sha256` 始终是原始
 * 字节的摘要。
 */
export const EXTENSION_ICON_PATHS = ['assets/icon.svg', 'assets/icon.png', 'assets/icon.webp'] as const
export type ExtensionIconPath = (typeof EXTENSION_ICON_PATHS)[number]

export const EXTENSION_ICON_MAX_BYTES = 128 * 1024
export const EXTENSION_ICON_MIN_SIZE = 64
export const EXTENSION_ICON_MAX_SIZE = 512

export const extensionIconSchema = z
  .object({
    path: z.enum(EXTENSION_ICON_PATHS),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
export type ExtensionIcon = z.output<typeof extensionIconSchema>

/** 以 base64 文本保存在 `resources` 中的二进制资源。 */
export const isBinaryResourcePath = (resourcePath: string): boolean => /\.(?:png|webp)$/u.test(resourcePath)

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Map([...BASE64_ALPHABET].map((character, index) => [character, index]))

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    output += BASE64_ALPHABET[(triple >> 18) & 63]
    output += BASE64_ALPHABET[(triple >> 12) & 63]
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '='
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '='
  }
  return output
}

/** 只接受规范的标准 base64（无空白、补齐正确），保证同一字节只有一种文本表示，摘要稳定。 */
export const base64ToBytes = (value: string): Uint8Array => {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error('资源不是有效的 base64。')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array((value.length / 4) * 3 - padding)
  let offset = 0
  for (let index = 0; index < value.length; index += 4) {
    const sextets = [0, 1, 2, 3].map((part) => BASE64_LOOKUP.get(value[index + part] ?? '=') ?? 0)
    const triple = (sextets[0]! << 18) | (sextets[1]! << 12) | (sextets[2]! << 6) | sextets[3]!
    for (const shift of [16, 8, 0]) {
      if (offset < bytes.length) bytes[offset++] = (triple >> shift) & 255
    }
  }
  if (bytesToBase64(bytes) !== value) throw new Error('资源不是规范的 base64。')
  return bytes
}

const textDecoder = new TextDecoder()

/** 资源在包内的原始字节：二进制图标解码 base64，其余资源按 UTF-8 编码。 */
export const resourceBytes = (resourcePath: string, content: string): Uint8Array =>
  isBinaryResourcePath(resourcePath) ? base64ToBytes(content) : utf8ToBytes(content)

/** 包内原始字节到内存 `resources` 文本的转换，与 `resourceBytes` 互逆。 */
export const resourceContent = (resourcePath: string, bytes: Uint8Array): string =>
  isBinaryResourcePath(resourcePath) ? bytesToBase64(bytes) : textDecoder.decode(bytes)

/** 资源原始字节的十六进制 SHA-256，Manifest 中声明的资源摘要都按它计算。 */
export const resourceDigest = (resourcePath: string, content: string): string =>
  bytesToHex(sha256(resourceBytes(resourcePath, content)))

export const extensionIconContentType = (iconPath: string): string =>
  iconPath.endsWith('.png') ? 'image/png' : iconPath.endsWith('.webp') ? 'image/webp' : 'image/svg+xml; charset=utf-8'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const readUint32BigEndian = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0

const readUint24LittleEndian = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

/** PNG 从 IHDR 读宽高；文件头不对时抛错。 */
export const pngDimensions = (bytes: Uint8Array): { readonly width: number; readonly height: number } => {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error('图标不是有效的 PNG 文件。')
  }
  if (ascii(bytes, 12, 4) !== 'IHDR') throw new Error('PNG 图标缺少 IHDR。')
  return { width: readUint32BigEndian(bytes, 16), height: readUint32BigEndian(bytes, 20) }
}

/** WebP 从 VP8 / VP8L / VP8X 头读宽高；文件头不对时抛错。 */
export const webpDimensions = (bytes: Uint8Array): { readonly width: number; readonly height: number } => {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    throw new Error('图标不是有效的 WebP 文件。')
  }
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) throw new Error('WebP 图标的 VP8 头无效。')
    return { width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) throw new Error('WebP 图标的 VP8L 头无效。')
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    return { width: readUint24LittleEndian(bytes, 24) + 1, height: readUint24LittleEndian(bytes, 27) + 1 }
  }
  throw new Error('WebP 图标使用了无法识别的格式。')
}

/**
 * 校验扩展图标资源（内存文本形式）。SVG 走页面图标同一套白名单；PNG / WebP 检查文件头、大小不超过 128 KiB、
 * 正方形且边长 64–512 像素。
 */
export const validateExtensionIcon = (iconPath: string, content: string): void => {
  if (!(EXTENSION_ICON_PATHS as readonly string[]).includes(iconPath)) throw new Error(`扩展图标路径无效：${iconPath}`)
  if (iconPath.endsWith('.svg')) {
    validateHostUiSvg(content)
    return
  }
  const bytes = resourceBytes(iconPath, content)
  if (bytes.byteLength > EXTENSION_ICON_MAX_BYTES) throw new Error('扩展图标不能超过 128 KiB。')
  const { width, height } = iconPath.endsWith('.png') ? pngDimensions(bytes) : webpDimensions(bytes)
  if (width !== height) throw new Error('扩展图标必须是正方形。')
  if (width < EXTENSION_ICON_MIN_SIZE || width > EXTENSION_ICON_MAX_SIZE) {
    throw new Error(`扩展图标边长必须在 ${EXTENSION_ICON_MIN_SIZE}–${EXTENSION_ICON_MAX_SIZE} 像素之间。`)
  }
}

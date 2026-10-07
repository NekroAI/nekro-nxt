import { useState } from 'react'
import { cssVars } from './css-vars.js'
import styles from './avatar.module.css'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'default' | 'lg'

const sizePx: Record<AvatarSize, number> = { xs: 18, sm: 22, md: 28, default: 34, lg: 48 }
const sizeClass: Record<AvatarSize, string | undefined> = {
  xs: styles.xs,
  sm: styles.sm,
  md: styles.md,
  default: undefined,
  lg: styles.lg,
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : undefined

/** First user-perceived character; never splits emoji or combining sequences. */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  if (segmenter) return segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment ?? '?'
  return Array.from(trimmed)[0] ?? '?'
}

/** Stable hue for identities without an explicit appearance. */
export function hueOf(seed: string): number {
  let hash = 7
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return hash
}

interface AvatarProps {
  readonly name: string
  readonly size?: AvatarSize
  readonly className?: string
}

/** Agent identity: gradient from its hue, optional live orbit while it actually works. */
export function AgentAvatar({
  name,
  hue,
  imageUrl,
  live = false,
  size = 'default',
  className,
}: AvatarProps & { readonly hue: number; readonly imageUrl?: string; readonly live?: boolean }) {
  const style = cssVars({ '--h': hue, '--size': `${sizePx[size]}px` })
  return (
    <span
      className={[styles.avatar, sizeClass[size], live ? styles.live : '', className ?? ''].join(' ')}
      style={style}
      aria-hidden="true"
    >
      {imageUrl ? <img src={imageUrl} alt="" /> : initialOf(name)}
    </span>
  )
}

/** Platform member or other person: soft tint derived from the name. */
export function MemberAvatar({ name, size = 'default', className }: AvatarProps) {
  const style = cssVars({ '--h': hueOf(name) })
  return (
    <span
      className={[styles.avatar, styles.member, sizeClass[size], className ?? ''].join(' ')}
      style={style}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  )
}

const tileSizePx: Record<AvatarSize, number> = { xs: 18, sm: 22, md: 28, default: 34, lg: 52 }

/**
 * 社区与扩展对象的方形图块：有图时显示图片（加载失败回退）；没有时用名称首字和由 `seed`（对象 ID）推出的
 * 稳定配色，同一对象在各处颜色一致。`fit` 决定图片是完整显示（图标）还是铺满（头像）。
 */
export function ObjectTile({
  seed,
  name,
  imageUrl,
  size = 'default',
  pixels,
  fit = 'contain',
  className,
}: {
  readonly seed: string
  readonly name: string
  readonly imageUrl?: string | null | undefined
  readonly size?: AvatarSize
  /** 覆盖预设尺寸的边长（像素）。 */
  readonly pixels?: number
  readonly fit?: 'contain' | 'cover'
  readonly className?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string>()
  const showImage = Boolean(imageUrl) && failedUrl !== imageUrl
  const style = cssVars({ '--h': hueOf(seed), '--size': `${pixels ?? tileSizePx[size]}px` })
  return (
    <span
      className={[styles.extensionIcon, className ?? ''].join(' ')}
      style={style}
      data-image={showImage ? fit : undefined}
      aria-hidden="true"
    >
      {showImage && imageUrl ? (
        <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(imageUrl)} />
      ) : (
        initialOf(name)
      )}
    </span>
  )
}

/** 扩展图标：包内图标或首字占位，配色由扩展 ID 决定。 */
export function ExtensionIcon({
  id,
  name,
  iconUrl,
  size = 'default',
  className,
}: {
  readonly id: string
  readonly name: string
  readonly iconUrl?: string | null | undefined
  readonly size?: AvatarSize
  readonly className?: string
}) {
  return (
    <ObjectTile
      seed={id}
      name={name}
      imageUrl={iconUrl}
      size={size}
      {...(className === undefined ? {} : { className })}
    />
  )
}

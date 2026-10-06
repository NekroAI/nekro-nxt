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

import type { CSSProperties } from 'react'

/** Inline style carrying CSS custom properties; undefined values are left out. */
export function cssVars(vars: Readonly<Record<`--${string}`, string | number | undefined>>): CSSProperties {
  const style: CSSProperties = {}
  for (const [name, value] of Object.entries(vars)) if (value !== undefined) Object.assign(style, { [name]: value })
  return style
}

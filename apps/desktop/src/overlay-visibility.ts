export type OverlayOpenIntent =
  { readonly kind: 'list' } | { readonly kind: 'reauthenticate'; readonly profileId: string }

/** Where the product's switcher button sits, in product-view pixels; the panel opens right below it. */
export interface OverlayAnchor {
  readonly left: number
}

export type OverlayVisibility =
  | { readonly state: 'open'; readonly intent: OverlayOpenIntent; readonly anchor?: OverlayAnchor }
  | { readonly state: 'closing' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Accepts only a finite, on-screen horizontal position; anything else falls back to the default placement. */
export const parseOverlayAnchor = (value: unknown): OverlayAnchor | undefined => {
  if (!isRecord(value)) return undefined
  const left = value['left']
  return typeof left === 'number' && Number.isFinite(left) && left >= 0 && left <= 20_000
    ? { left: Math.round(left) }
    : undefined
}

export const parseOverlayVisibility = (value: unknown): OverlayVisibility | undefined => {
  if (!isRecord(value)) return undefined
  if (value['state'] === 'closing') return { state: 'closing' }
  if (value['state'] !== 'open' || !isRecord(value['intent'])) return undefined
  const intent = value['intent']
  const anchor = parseOverlayAnchor(value['anchor'])
  const placement = anchor === undefined ? {} : { anchor }
  if (intent['kind'] === 'list') return { state: 'open', intent: { kind: 'list' }, ...placement }
  if (intent['kind'] === 'reauthenticate' && typeof intent['profileId'] === 'string' && intent['profileId'] !== '') {
    return { state: 'open', intent: { kind: 'reauthenticate', profileId: intent['profileId'] }, ...placement }
  }
  return undefined
}

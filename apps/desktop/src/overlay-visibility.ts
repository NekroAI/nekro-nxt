export type OverlayOpenIntent =
  { readonly kind: 'list' } | { readonly kind: 'reauthenticate'; readonly profileId: string }

export type OverlayVisibility =
  { readonly state: 'open'; readonly intent: OverlayOpenIntent } | { readonly state: 'closing' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const parseOverlayVisibility = (value: unknown): OverlayVisibility | undefined => {
  if (!isRecord(value)) return undefined
  if (value['state'] === 'closing') return { state: 'closing' }
  if (value['state'] !== 'open' || !isRecord(value['intent'])) return undefined
  const intent = value['intent']
  if (intent['kind'] === 'list') return { state: 'open', intent: { kind: 'list' } }
  if (intent['kind'] === 'reauthenticate' && typeof intent['profileId'] === 'string' && intent['profileId'] !== '') {
    return { state: 'open', intent: { kind: 'reauthenticate', profileId: intent['profileId'] } }
  }
  return undefined
}

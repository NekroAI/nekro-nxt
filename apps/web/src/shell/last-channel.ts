const LAST_CHANNEL_KEY = 'nekro-nxt.last-channel'

export const readLastChannelId = (): string => {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(LAST_CHANNEL_KEY) ?? ''
}

export const writeLastChannelId = (channelId: string): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LAST_CHANNEL_KEY, channelId)
}

export const workHomePath = (input: {
  readonly channels: readonly { readonly id: string }[]
  readonly agents: readonly { readonly id: string }[]
}): string => {
  const last = readLastChannelId()
  if (last && input.channels.some((channel) => channel.id === last)) return `/channels/${last}`
  if (input.channels[0]) return `/channels/${input.channels[0].id}`
  if (input.agents[0]) return `/agents/${input.agents[0].id}`
  return '/agents'
}

export const isWorkPath = (pathname: string): boolean =>
  pathname === '/' ||
  pathname === '/agents' ||
  pathname.startsWith('/agents/') ||
  pathname === '/channels' ||
  pathname.startsWith('/channels/') ||
  pathname === '/creator' ||
  pathname.startsWith('/creator')

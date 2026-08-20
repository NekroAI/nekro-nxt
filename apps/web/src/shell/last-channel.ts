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
  if (last && input.channels.some((channel) => channel.id === last)) return `/work/channels/${last}`
  if (input.channels[0]) return `/work/channels/${input.channels[0].id}`
  if (input.agents[0]) return `/work/agents/${input.agents[0].id}`
  return '/work/agents/new'
}

export const isWorkPath = (pathname: string): boolean => pathname === '/work' || pathname.startsWith('/work/')

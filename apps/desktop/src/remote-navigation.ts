import { InstanceOperationError } from './instance-operation-error.js'

export type RemoteFetch = (url: string, init?: RequestInit) => Promise<Response>

export const assertSameOriginRemoteUrl = (origin: string, target: string, expected?: string): void => {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    throw new InstanceOperationError('unsafe-redirect', '服务器返回了不安全的跳转地址。')
  }
  if (parsed.origin !== origin || (expected !== undefined && parsed.href !== expected)) {
    throw new InstanceOperationError('unsafe-redirect', '服务器尝试跳转到其他地址，已停止连接。')
  }
}

export const fetchSameOriginRemote = async (
  fetcher: RemoteFetch,
  origin: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> => {
  const expected = new URL(pathname, origin).href
  const response = await fetcher(expected, { ...init, redirect: 'error' })
  assertSameOriginRemoteUrl(origin, response.url, expected)
  return response
}

interface NavigationEvent {
  preventDefault(): void
}

interface NavigationContents {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: NavigationEvent, target: string) => void): unknown
}

export const installSameOriginNavigationGuard = (
  contents: NavigationContents,
  origin: string,
  onBlockedNavigation?: (target: string) => void,
): void => {
  contents.on('will-navigate', (event, target) => {
    try {
      assertSameOriginRemoteUrl(origin, target)
    } catch {
      event.preventDefault()
      onBlockedNavigation?.(target)
    }
  })
  contents.on('will-redirect', (event, target) => {
    try {
      assertSameOriginRemoteUrl(origin, target)
    } catch {
      event.preventDefault()
    }
  })
}

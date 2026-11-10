import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'

/**
 * Browser push on this device: the push worker, the permission and the subscription. Desktop shows system
 * notifications itself and never registers the worker.
 */
export type PushState =
  /** The connection is not HTTPS with a trusted certificate. */
  | 'insecure'
  /** iPhone and iPad offer push only to apps added to the home screen. */
  | 'needs-install'
  | 'unsupported'
  | 'denied'
  | 'off'
  | 'on'

const OPEN_ROUTE_MESSAGE = 'nekro-nxt:open-route'

const standalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { readonly standalone?: boolean }).standalone === true

const appleTouchDevice = (): boolean =>
  /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const inDesktopShell = (): boolean => window.nekroDesktopShell !== undefined

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined

/** Registers the push worker once per page; resolves to nothing where it cannot run, e.g. an untrusted certificate. */
export const registerPushWorker = (): Promise<ServiceWorkerRegistration | undefined> => {
  registration ??=
    inDesktopShell() || !window.isSecureContext || !('serviceWorker' in navigator)
      ? Promise.resolve(undefined)
      : navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(
          async () => await navigator.serviceWorker.ready,
          () => undefined,
        )
  return registration
}

/** The id the server lists a subscription under; the endpoint itself never leaves this browser and the server. */
export const pushSubscriptionId = async (endpoint: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

/** This device's state, given the ids the server holds for it. */
export const readPushState = async (serverIds: ReadonlySet<string>): Promise<PushState> => {
  if (!window.isSecureContext) return 'insecure'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return appleTouchDevice() && !standalone() ? 'needs-install' : 'unsupported'
  }
  const worker = await registerPushWorker()
  // A secure origin whose certificate the browser does not trust still refuses the worker.
  if (worker === undefined) return 'insecure'
  if (Notification.permission === 'denied') return 'denied'
  const subscription = await worker.pushManager.getSubscription()
  return subscription !== null && serverIds.has(await pushSubscriptionId(subscription.endpoint)) ? 'on' : 'off'
}

const base64Url = (buffer: ArrayBuffer | null): string =>
  buffer === null
    ? ''
    : btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '')

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}

/** 「iPhone · 主屏幕」, 「Mac · Chrome」: tells the subscriptions apart in the list. */
export const pushDeviceName = (): string => {
  const agent = navigator.userAgent
  const device =
    /iPad/u.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /iPhone|iPod/u.test(agent)
        ? 'iPhone'
        : /Android/u.test(agent)
          ? 'Android'
          : /Mac/u.test(agent)
            ? 'Mac'
            : /Windows/u.test(agent)
              ? 'Windows'
              : /Linux/u.test(agent)
                ? 'Linux'
                : '设备'
  const app = standalone()
    ? '主屏幕'
    : /Edg\//u.test(agent)
      ? 'Edge'
      : /Firefox\//u.test(agent)
        ? 'Firefox'
        : /Chrome\//u.test(agent)
          ? 'Chrome'
          : /Safari\//u.test(agent)
            ? 'Safari'
            : '浏览器'
  return `${device} · ${app}`
}

/** Asks for permission (only from a click) and registers this browser with the server. */
export const enablePush = async (): Promise<void> => {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied' ? '通知权限被拒绝了，需要在浏览器或系统设置里重新允许。' : '没有拿到通知权限。',
    )
  }
  const worker = await registerPushWorker()
  if (worker === undefined) throw new Error('这个页面不能使用推送。')
  const { publicKey } = await callHostApi(HostApiContracts.getWebPushKey, {}, undefined)
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) }))
  await callHostApi(
    HostApiContracts.registerPushSubscription,
    {},
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: base64Url(subscription.getKey('p256dh')), auth: base64Url(subscription.getKey('auth')) },
      label: pushDeviceName(),
    },
  )
}

/** Removes this browser from the server, then drops the browser's own subscription. */
export const disablePush = async (): Promise<void> => {
  const worker = await registerPushWorker()
  const subscription = await worker?.pushManager.getSubscription()
  if (subscription === null || subscription === undefined) return
  const subscriptionId = await pushSubscriptionId(subscription.endpoint)
  await callHostApi(HostApiContracts.deletePushSubscription, { subscriptionId }, undefined).catch(() => undefined)
  await subscription.unsubscribe()
}

/** Opens the page a clicked push notification points to, inside the running app. */
export const usePushNotificationRoutes = (): void => {
  const navigate = useNavigate()
  useEffect(() => {
    if (inDesktopShell() || !('serviceWorker' in navigator)) return
    void registerPushWorker()
    const open = (event: MessageEvent<unknown>) => {
      const data: unknown = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === OPEN_ROUTE_MESSAGE &&
        'route' in data &&
        typeof data.route === 'string' &&
        data.route.startsWith('/')
      ) {
        void navigate(data.route)
      }
    }
    navigator.serviceWorker.addEventListener('message', open)
    return () => navigator.serviceWorker.removeEventListener('message', open)
  }, [navigate])
}

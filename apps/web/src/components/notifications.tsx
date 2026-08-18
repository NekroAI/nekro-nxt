import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '../ui-kit/index.js'
import styles from './notifications.module.css'

export type NotificationTone = 'info' | 'success' | 'warning' | 'error'

interface NotificationItem {
  readonly id: number
  readonly tone: NotificationTone
  readonly message: string
  readonly group?: string | undefined
}

type NotificationListener = (item: NotificationItem) => void

const listeners = new Set<NotificationListener>()
let nextNotificationId = 0

export function notify(message: string, tone: NotificationTone = 'info', group?: string): number {
  const item = { id: ++nextNotificationId, tone, message, ...(group ? { group } : {}) }
  for (const listener of listeners) listener(item)
  return item.id
}

const iconForTone = (tone: NotificationTone) => {
  if (tone === 'success') return CheckCircle2
  if (tone === 'warning') return TriangleAlert
  if (tone === 'error') return AlertCircle
  return Info
}

export function NotificationCenter(): React.ReactNode {
  const [items, setItems] = useState<readonly NotificationItem[]>([])
  const timers = useRef(new Map<number, number>())
  const dismiss = (id: number): void => {
    const timer = timers.current.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.current.delete(id)
    setItems((current) => current.filter((item) => item.id !== id))
  }

  useEffect(() => {
    const receive: NotificationListener = (item) => {
      setItems((current) => {
        const replaced = current.filter((candidate) =>
          item.group ? candidate.group === item.group : candidate.message === item.message,
        )
        for (const candidate of replaced) {
          const timer = timers.current.get(candidate.id)
          if (timer !== undefined) window.clearTimeout(timer)
          timers.current.delete(candidate.id)
        }
        return [
          ...current.filter((candidate) =>
            item.group ? candidate.group !== item.group : candidate.message !== item.message,
          ),
          item,
        ].slice(-4)
      })
      const duration = item.tone === 'error' ? 6000 : item.tone === 'warning' ? 5000 : 3200
      timers.current.set(
        item.id,
        window.setTimeout(() => dismiss(item.id), duration),
      )
    }
    listeners.add(receive)
    const activeTimers = timers.current
    return () => {
      listeners.delete(receive)
      for (const timer of activeTimers.values()) window.clearTimeout(timer)
      activeTimers.clear()
    }
  }, [])

  return (
    <div className={styles.viewport} aria-label="操作通知">
      {items.map((item) => {
        const Icon = iconForTone(item.tone)
        return (
          <div
            className={[styles.notification, styles[item.tone]].join(' ')}
            role={item.tone === 'error' ? 'alert' : 'status'}
            key={item.id}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{item.message}</span>
            <IconButton className={styles.closeButton} label="关闭通知" onClick={() => dismiss(item.id)}>
              <X size={15} aria-hidden="true" />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import {
  hostLogStreamEventSchema,
  type HostLogEntry,
  type HostLogQuery,
  type HostLogStatus,
} from '@nekro-nxt/contracts'
import { logsApi, logUrl } from './logs-api.js'
import { mergeLogEntries } from './logs-model.js'

export function useLogFeed(query: HostLogQuery) {
  const [entries, setEntries] = useState<HostLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState<HostLogStatus>()
  const [following, setFollowing] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [revision, setRevision] = useState(0)
  const followingRef = useRef(true)
  const cursor = useRef<string>()
  const generation = useRef(0)
  const gapNotice = useRef('')
  const readOlder = useRef<AbortController>()
  const serialized = JSON.stringify(query)
  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    readOlder.current?.abort()
    let events: EventSource | undefined
    let lastFrame = Date.now()
    let active = true
    let pending: HostLogEntry[] = []
    let pendingCount = 0
    cursor.current = undefined
    const flush = setInterval(() => {
      if (!active || pendingCount === 0) return
      if (followingRef.current) {
        const batch = pending
        setEntries((old) => mergeLogEntries(old, batch))
      } else {
        const received = pendingCount
        setNewCount((count) => count + received)
      }
      pending = []
      pendingCount = 0
    }, 150)
    setLoading(true)
    setError('')
    setNotice(gapNotice.current)
    setNewCount(0)
    setEntries([])
    const connect = () => {
      if (!active || document.hidden) return
      events?.close()
      const afterCursor = cursor.current
      events = new EventSource(
        logUrl('/api/logs/events', { ...query, ...(afterCursor === undefined ? {} : { afterCursor }) }),
      )
      lastFrame = Date.now()
      events.addEventListener('heartbeat', () => {
        lastFrame = Date.now()
      })
      events.addEventListener('logs', (raw) => {
        if (!active || generation.current !== current) return
        lastFrame = Date.now()
        try {
          if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') return
          const event = hostLogStreamEventSchema.parse(JSON.parse(raw.data))
          if (event.type === 'status') {
            setStatus(event.status)
            return
          }
          if (event.type === 'gap') {
            if (event.reason === 'reset') {
              gapNotice.current = '日志存储已更新，已重新读取可用记录。'
              events?.close()
              generation.current++
              setRevision((value) => value + 1)
              return
            }
            setNotice('部分日志已过期或不可用，已从可用位置继续。')
            return
          }
          const previous = cursor.current
          cursor.current = event.cursor
          if (previous === event.cursor || event.entries.length === 0) return
          pending.push(...event.entries)
          pendingCount += event.entries.length
          if (pending.length > 5000) pending = pending.slice(-5000)
        } catch {
          setNotice('收到的日志数据无法读取，正在重新连接。')
          events?.close()
          connect()
        }
      })
      events.onopen = () => setNotice((old) => (old.includes('连接') ? '' : old))
      events.onerror = () => {
        if (active) setNotice('实时连接中断，正在重连；已加载日志仍可查看。')
      }
    }
    void logsApi
      .query(query, controller.signal)
      .then((page) => {
        if (!active || generation.current !== current) return
        setEntries(page.entries)
        setOlderCursor(page.olderCursor)
        setHasMore(page.hasMore)
        cursor.current = page.headCursor
        if (page.gap) setNotice('部分历史日志已过期或不可用。')
        connect()
      })
      .catch((cause: unknown) => {
        if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '日志读取失败。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    const visibility = () => {
      if (document.hidden) events?.close()
      else if (cursor.current) connect()
    }
    document.addEventListener('visibilitychange', visibility)
    const reconnect = setInterval(() => {
      if (!document.hidden && Date.now() - lastFrame > 45_000) connect()
    }, 15_000)
    return () => {
      active = false
      controller.abort()
      readOlder.current?.abort()
      events?.close()
      clearInterval(reconnect)
      clearInterval(flush)
      document.removeEventListener('visibilitychange', visibility)
    }
    // Serialized query is the identity; callers may construct the same object on each render.
  }, [serialized, revision])
  const pause = () => {
    followingRef.current = false
    setFollowing(false)
  }
  const resume = () => {
    generation.current++
    readOlder.current?.abort()
    followingRef.current = true
    setFollowing(true)
    setRevision((value) => value + 1)
  }
  const older = async () => {
    if (!hasMore || !olderCursor || loading) return
    pause()
    setLoading(true)
    const current = generation.current
    const controller = new AbortController()
    readOlder.current?.abort()
    readOlder.current = controller
    try {
      const page = await logsApi.query({ ...query, olderCursor }, controller.signal)
      if (current !== generation.current || controller.signal.aborted) return
      setEntries((old) => mergeLogEntries(old, page.entries, true))
      setOlderCursor(page.olderCursor)
      setHasMore(page.hasMore)
      if (page.gap) setNotice('更早的日志已经过期。')
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '日志读取失败。')
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }
  return {
    entries,
    loading,
    error,
    notice,
    status,
    following,
    newCount,
    hasMore,
    pause,
    resume,
    older,
    refresh: () => setRevision((value) => value + 1),
    setStatus,
  }
}

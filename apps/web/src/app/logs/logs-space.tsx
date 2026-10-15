import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Download,
  ListFilter,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Settings,
} from 'lucide-react'
import {
  hostLogQuerySchema,
  formatLogMessage,
  hostLogSourceSchema,
  InstanceDescriptorSchema,
  type HostLogEntry,
  type HostLogLevel,
  type HostLogQuery,
  type HostLogSource,
} from '@nekro-nxt/contracts'
import { useProductStore } from '../../product-runtime.js'
import { useDshCatalog, dshEntryStatus, dshPackageLabel } from '../../dsh-extension-settings.js'
import {
  Banner,
  Button,
  Chip,
  DetailPane,
  Diagnostics,
  EmptyState,
  Field,
  Input,
  ListPane,
  MainContent,
  Pressable,
  PropertyGroup,
  Select,
  Sheet,
  Switch,
  WorkbenchPage,
  toast,
  cssVars,
} from '../../ui-kit/index.js'
import { useCrumb } from '../shell/crumb.js'
import { extensionUsage } from '../workshop/workshop-model.js'
import { exportLogs, logsApi } from './logs-api.js'
import { groupLogs, logStacks, relatedLogQuery } from './logs-model.js'
import { useLogFeed } from './use-log-feed.js'
import styles from './logs.module.css'

const KIND: Record<HostLogSource['kind'], string> = {
  system: '系统',
  'dsh-plugin': 'DSH 插件',
  extension: '扩展',
  connection: '连接',
  unknown: '未识别来源',
}
const LEVEL: Record<HostLogLevel, string> = { debug: '调试', info: '信息', warn: '警告', error: '错误' }
const LEVELS: HostLogLevel[] = ['debug', 'info', 'warn', 'error']
const sourceName = (source: HostLogSource) =>
  source.kind === 'dsh-plugin' ? dshPackageLabel(source.name) : source.name
const defaults = (): HostLogQuery => ({ levels: ['info', 'warn', 'error'] })
const failure = (error: unknown) => toast(error instanceof Error ? error.message : '日志操作失败。', { tone: 'bad' })
const time = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3,
  })
const localDate = (value?: string) =>
  value ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
const copy = (text: string) => {
  if (!navigator.clipboard) {
    toast('当前浏览器不允许自动复制，请选择文字后复制。', { tone: 'bad' })
    return
  }
  void navigator.clipboard
    .writeText(text)
    .then(() => toast('已复制'))
    .catch(() => toast('复制失败，请选择文字后复制。', { tone: 'bad' }))
}

export default function LogsSpace() {
  useCrumb('日志')
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState<HostLogQuery>(() => {
    try {
      const parsed = hostLogQuerySchema.safeParse(JSON.parse(params.get('query') ?? '{}'))
      return parsed.success ? { ...defaults(), ...parsed.data } : defaults()
    } catch {
      return defaults()
    }
  })
  const [range, setRange] = useState(query.from || query.to ? 'custom' : '60')
  const [keyword, setKeyword] = useState(query.keyword ?? '')
  const [windowStart, setWindowStart] = useState(Date.now())
  const [sources, setSources] = useState<HostLogSource[]>([])
  const [selected, setSelected] = useState<HostLogEntry>()
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<string>>(new Set(['dsh-plugin']))
  const [showSources, setShowSources] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [compact, setCompact] = useState(false)
  const [narrow, setNarrow] = useState(window.innerWidth < 1100)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [viewport, setViewport] = useState({ top: 0, height: 500 })
  const [duration, setDuration] = useState<5 | 15 | 30>(15)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [preferenceKey, setPreferenceKey] = useState<string>()
  const list = useRef<HTMLDivElement>(null)
  const exportingController = useRef<AbortController>()
  const detailController = useRef<AbortController>()
  const retainedSelection = useRef<HostLogEntry>()
  const edited = useRef(false)
  const writtenQuery = useRef<string>()
  const anchor = useRef<{ height: number; top: number }>()
  const effective = useMemo<HostLogQuery>(
    () => ({
      ...query,
      ...(range === 'custom' ? {} : { from: new Date(windowStart - Number(range) * 60_000).toISOString() }),
    }),
    [query, range, windowStart],
  )
  const feed = useLogFeed(effective)
  const agents = useProductStore((state) => state.agents)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const extensions = useProductStore((state) => state.extensions)
  const contextLabel = (entry: HostLogEntry): string => {
    const agent = agents.find((item) => item.id === entry.scope?.agentId)?.name
    const channel = channels.find((item) => item.id === entry.scope?.channelId)?.name
    const fields =
      entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details) ? entry.details : undefined
    const tool =
      typeof fields?.['tool'] === 'string' && !entry.message.includes(fields['tool']) ? fields['tool'] : undefined
    return [agent, channel, tool, entry.code && !entry.message.includes(entry.code) ? entry.code : undefined]
      .filter(Boolean)
      .join(' · ')
  }
  const identifiedSource =
    query.sourceIds?.length === 1 ? sources.find((source) => source.id === query.sourceIds?.[0]) : undefined
  const sourceFilter =
    query.sources?.[0] ?? (identifiedSource ? { kind: identifiedSource.kind, id: identifiedSource.id } : undefined)
  const dsh = useDshCatalog(sourceFilter?.kind === 'dsh-plugin' || Boolean(query.sourceIds?.length))
  const currentDsh = dsh.entries.find(
    (entry) =>
      entry.id === sourceFilter?.id ||
      query.sourceIds?.includes(entry.id) ||
      entry.plugin?.entries?.some((item) => item.id === sourceFilter?.id || query.sourceIds?.includes(item.id)),
  )
  const currentSource = sources.find((item) => item.kind === sourceFilter?.kind && item.id === sourceFilter.id)
  const currentExtension = extensions.find(
    (item) => item.id === (sourceFilter?.kind === 'extension' ? sourceFilter.id : query.scope?.extensionId),
  )
  const currentConnection = connections.find(
    (item) => item.id === (sourceFilter?.kind === 'connection' ? sourceFilter.id : query.scope?.connectionId),
  )
  const currentName =
    currentExtension?.name ??
    currentConnection?.name ??
    currentDsh?.label ??
    (currentSource ? sourceName(currentSource) : undefined)
  const objectPath = currentExtension
    ? `/workshop/extensions/${currentExtension.id}`
    : currentConnection
      ? `/wiring/connections/${currentConnection.id}`
      : currentDsh
        ? `/settings/dsh?entry=${encodeURIComponent(currentDsh.id)}`
        : undefined
  const currentStatus = currentExtension
    ? extensionUsage(currentExtension).label
    : (currentConnection?.state ??
      (currentDsh
        ? dshEntryStatus(currentDsh).label
        : currentSource && ['extension', 'connection'].includes(currentSource.kind)
          ? '历史来源，对象已移除'
          : undefined))
  const currentRevision =
    currentExtension?.revisions.find((revision) => revision.id === currentExtension.installation?.revisionId) ??
    currentExtension?.revisions.at(-1)
  const currentVersion =
    currentDsh?.version ??
    (currentRevision
      ? new Date(currentRevision.createdAt).toLocaleString('zh-CN', {
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : undefined)
  const debugSource =
    sourceFilter ??
    (currentExtension
      ? { kind: 'extension' as const, id: currentExtension.id }
      : currentConnection
        ? { kind: 'connection' as const, id: currentConnection.id }
        : undefined)
  const groups = useMemo(() => groupLogs(feed.entries), [feed.entries])
  const rows = useMemo(
    () =>
      groups.flatMap((group) =>
        expanded.has(group.entry.id)
          ? group.entries.map((entry, index) => ({ entry, group: index === 0 ? group : undefined }))
          : [{ entry: group.entry, group }],
      ),
    [groups, expanded],
  )
  const rowHeight = compact ? 36 : 52
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - 8)
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowHeight) + 8)

  const update = (next: HostLogQuery, nextRange = range) => {
    edited.current = true
    setQuery(next)
    setRange(nextRange)
    setSelected(undefined)
    setWindowStart(Date.now())
    setExpanded(new Set())
    writtenQuery.current = JSON.stringify(next)
    setParams({ query: writtenQuery.current }, { replace: true })
  }
  useEffect(() => {
    if (params.get('query') === writtenQuery.current) return
    try {
      const parsed = hostLogQuerySchema.safeParse(JSON.parse(params.get('query') ?? '{}'))
      if (parsed.success) {
        setQuery({ ...defaults(), ...parsed.data })
        setKeyword(parsed.data.keyword ?? '')
        if (parsed.data.from || parsed.data.to) setRange('custom')
      }
    } catch {
      /* Invalid links fall back to the visible default filters. */
    }
  }, [params])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (keyword !== (query.keyword ?? '')) update({ ...query, keyword })
    }, 250)
    return () => clearTimeout(timer)
  }, [keyword, query])
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/.well-known/nekro-nxt', { signal: controller.signal })
      .then((response) => response.json())
      .then((value: unknown) => {
        const descriptor = InstanceDescriptorSchema.parse(value)
        const key = `nekro-nxt.logs:${descriptor.instanceId}`
        if (!params.has('query') && !edited.current) {
          try {
            const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
            if (typeof saved === 'object' && saved !== null && 'query' in saved) {
              const parsed = hostLogQuerySchema.safeParse(saved.query)
              if (parsed.success) {
                setQuery(parsed.data)
                setKeyword(parsed.data.keyword ?? '')
              }
              if (
                'range' in saved &&
                typeof saved.range === 'string' &&
                ['15', '60', '1440', '10080', 'custom'].includes(saved.range)
              )
                setRange(saved.range)
              if ('compact' in saved) setCompact(saved.compact === true)
              if ('showSources' in saved) setShowSources(saved.showSources !== false)
            }
          } catch {
            /* Preferences never block logs. */
          }
        }
        setPreferenceKey(key)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (preferenceKey) {
      try {
        localStorage.setItem(preferenceKey, JSON.stringify({ query, range, compact, showSources }))
      } catch {
        /* Optional persistence. */
      }
    }
  }, [preferenceKey, query, range, compact, showSources])
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      void logsApi
        .sources(controller.signal)
        .then((value) => setSources(value.sources))
        .catch(() => undefined)
    load()
    const timer = setInterval(load, 15_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    const media = matchMedia('(max-width: 1099px)')
    const change = () => setNarrow(media.matches)
    media.addEventListener('change', change)
    return () => {
      media.removeEventListener('change', change)
      exportingController.current?.abort()
      detailController.current?.abort()
    }
  }, [])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const observe = new ResizeObserver(() => setViewport({ top: element.scrollTop, height: element.clientHeight }))
    observe.observe(element)
    return () => observe.disconnect()
  }, [feed.loading])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    if (anchor.current) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height
      anchor.current = undefined
    } else if (feed.following) element.scrollTop = element.scrollHeight
  }, [rows, feed.following, compact])
  const select = (entry: HostLogEntry) => {
    feed.pause()
    retainedSelection.current = entry
    setSelected(entry)
    detailController.current?.abort()
    const controller = new AbortController()
    detailController.current = controller
    void logsApi
      .get(entry.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          retainedSelection.current = value.entry
          setSelected(value.entry)
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) failure(error)
      })
  }
  const chooseSource = (source?: { kind: HostLogSource['kind']; id: string }) => {
    const next = { ...query }
    delete next.sources
    delete next.sourceIds
    delete next.sourceKinds
    if (source) next.sources = [source]
    update(next)
  }
  const changeScope = (key: 'agentId' | 'connectionId' | 'channelId' | 'extensionId', value: string) => {
    const scope = { ...query.scope }
    if (value) scope[key] = value
    else delete scope[key]
    update({ ...query, scope })
  }
  const debug = async () => {
    setBusy(true)
    try {
      await logsApi.debug(debugSource, duration)
      feed.setStatus(await logsApi.status())
      toast('已开始采集调试日志。')
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  const download = async (format: 'text' | 'jsonl') => {
    const controller = new AbortController()
    exportingController.current = controller
    setExporting(true)
    try {
      await exportLogs(effective, format, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) failure(error)
    } finally {
      setExporting(false)
    }
  }
  const sourceItems = [
    { value: '', label: '全部来源' },
    ...sources.map((source) => ({
      value: JSON.stringify({ kind: source.kind, id: source.id }),
      label: `${KIND[source.kind]} · ${sourceName(source)}`,
    })),
  ]
  const filterControls = (
    <div className={styles.filters}>
      <Field label="来源">
        <Select
          value={sourceFilter ? JSON.stringify(sourceFilter) : ''}
          options={sourceItems}
          onValueChange={(value) => {
            const next = { ...query }
            if (value) next.sources = [hostLogSourceSchema.pick({ kind: true, id: true }).parse(JSON.parse(value))]
            else delete next.sources
            update(next)
          }}
        />
      </Field>
      <Field label="智能体">
        <Select
          value={query.scope?.agentId ?? ''}
          options={[
            { value: '', label: '全部智能体' },
            ...agents.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onValueChange={(value) => changeScope('agentId', value)}
        />
      </Field>
      <Field label="连接">
        <Select
          value={query.scope?.connectionId ?? ''}
          options={[
            { value: '', label: '全部连接' },
            ...connections.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onValueChange={(value) => changeScope('connectionId', value)}
        />
      </Field>
      <Field label="频道">
        <Select
          value={query.scope?.channelId ?? ''}
          options={[
            { value: '', label: '全部频道' },
            ...channels.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onValueChange={(value) => changeScope('channelId', value)}
        />
      </Field>
      <Field label="扩展">
        <Select
          value={query.scope?.extensionId ?? ''}
          options={[
            { value: '', label: '全部扩展' },
            ...extensions.map((item) => ({ value: item.id, label: item.name })),
          ]}
          onValueChange={(value) => changeScope('extensionId', value)}
        />
      </Field>
      {range === 'custom' ? (
        <>
          <Field label="开始时间">
            <Input
              type="datetime-local"
              value={localDate(query.from)}
              onChange={(event) => {
                const next = { ...query }
                if (event.target.value) next.from = new Date(event.target.value).toISOString()
                else delete next.from
                update(next)
              }}
            />
          </Field>
          <Field label="结束时间">
            <Input
              type="datetime-local"
              value={localDate(query.to)}
              onChange={(event) => {
                const next = { ...query }
                if (event.target.value) next.to = new Date(event.target.value).toISOString()
                else delete next.to
                update(next)
              }}
            />
          </Field>
        </>
      ) : null}
    </div>
  )
  const detailsRecord = selected ?? retainedSelection.current
  const stacks = logStacks(detailsRecord?.details)
  const details = detailsRecord ? (
    <div className={styles.details}>
      <div className={styles.actions}>
        <Chip tone={detailsRecord.level === 'error' ? 'bad' : detailsRecord.level === 'warn' ? 'warn' : 'neutral'}>
          {LEVEL[detailsRecord.level]}
        </Chip>
        <span>{detailsRecord.source.name}</span>
      </div>
      <p className={styles.timestamp}>
        {new Date(detailsRecord.timestamp).toLocaleString('zh-CN', { hour12: false })}
        <br />
        {detailsRecord.timestamp}
      </p>
      <pre className={styles.message}>{formatLogMessage(detailsRecord.message)}</pre>
      {detailsRecord.redacted ? <Chip>已隐藏敏感字段</Chip> : null}
      {detailsRecord.truncated ? <Chip tone="warn">内容已截断</Chip> : null}
      <div className={styles.actions}>
        <Button size="small" onClick={() => copy(formatLogMessage(detailsRecord.message))}>
          复制消息
        </Button>
        <Button size="small" onClick={() => copy(JSON.stringify(detailsRecord, null, 2))}>
          复制详情
        </Button>
      </div>
      <Button
        onClick={() => {
          const next = relatedLogQuery(detailsRecord)
          update(next, 'custom')
          setKeyword('')
        }}
      >
        查看相关日志
      </Button>
      {stacks.length ? (
        <PropertyGroup title="异常堆栈">
          {stacks.map((stack, index) => (
            <pre className={styles.technical} key={index}>
              {stack}
            </pre>
          ))}
        </PropertyGroup>
      ) : null}
      <Diagnostics title="来源与关联标识">
        {detailsRecord.scope?.agentId && agents.some((item) => item.id === detailsRecord.scope?.agentId) ? (
          <Link to={`/agents/${detailsRecord.scope.agentId}`}>打开智能体</Link>
        ) : null}
        {detailsRecord.scope?.channelId && channels.some((item) => item.id === detailsRecord.scope?.channelId) ? (
          <Link to={`/channels/${detailsRecord.scope.channelId}`}>打开频道运行记录</Link>
        ) : null}
        {detailsRecord.scope?.connectionId &&
        connections.some((item) => item.id === detailsRecord.scope?.connectionId) ? (
          <Link to={`/wiring/connections/${detailsRecord.scope.connectionId}`}>打开连接</Link>
        ) : null}
        {detailsRecord.scope?.extensionId && extensions.some((item) => item.id === detailsRecord.scope?.extensionId) ? (
          <Link to={`/workshop/extensions/${detailsRecord.scope.extensionId}`}>打开扩展</Link>
        ) : null}
        <pre className={styles.technical}>
          {JSON.stringify(
            {
              source: detailsRecord.source,
              scope: detailsRecord.scope,
              runId: detailsRecord.runId,
              code: detailsRecord.code,
            },
            null,
            2,
          )}
        </pre>
      </Diagnostics>
      {detailsRecord.details !== undefined ? (
        <PropertyGroup title="诊断信息">
          <pre className={styles.technical}>{JSON.stringify(detailsRecord.details, null, 2)}</pre>
        </PropertyGroup>
      ) : null}
    </div>
  ) : null
  return (
    <WorkbenchPage
      list={
        showSources && !narrow ? (
          <ListPane title="日志来源" label="日志来源">
            <div className={styles.sourceList}>
              <Pressable
                className={styles.source}
                data-selected={!query.sources?.length && !query.sourceIds?.length && !query.sourceKinds?.length}
                onClick={() => chooseSource()}
              >
                全部来源
              </Pressable>
              {Object.entries(KIND).map(([kind, label]) => (
                <div key={kind}>
                  <Button
                    variant="ghost"
                    size="small"
                    className={styles.groupTitle}
                    aria-expanded={!collapsedKinds.has(kind)}
                    onClick={() =>
                      setCollapsedKinds((old) => {
                        const next = new Set(old)
                        if (next.has(kind)) next.delete(kind)
                        else next.add(kind)
                        return next
                      })
                    }
                  >
                    {collapsedKinds.has(kind) ? <ChevronRight size={12} /> : <ChevronDown size={12} />} {label}
                  </Button>
                  {sources
                    .filter((source) => source.kind === kind && !collapsedKinds.has(kind))
                    .map((source) => (
                      <Pressable
                        key={`${source.kind}:${source.id}`}
                        className={styles.source}
                        data-selected={sourceFilter?.kind === source.kind && sourceFilter.id === source.id}
                        title={source.name}
                        onClick={() => chooseSource({ kind: source.kind, id: source.id })}
                      >
                        {sourceName(source)}
                      </Pressable>
                    ))}
                </div>
              ))}
            </div>
          </ListPane>
        ) : undefined
      }
      detail={
        selected && !narrow ? (
          <DetailPane header="日志详情" label="日志详情" onClose={() => setSelected(undefined)}>
            {details}
          </DetailPane>
        ) : undefined
      }
    >
      <MainContent width="full" fill contained>
        <div className={styles.workspace}>
          <header className={styles.header}>
            <div>
              <h1>日志</h1>
              <p>
                {currentName
                  ? `${currentName}${currentStatus ? ` · ${currentStatus}` : ''}`
                  : '观察系统与扩展的运行过程'}
              </p>
              {currentVersion ? <p>版本 · {currentVersion}</p> : null}
              {objectPath ? <Link to={objectPath}>打开配置</Link> : null}
            </div>
            <div className={styles.actions}>
              <Button
                size="small"
                icon={<ListFilter size={15} />}
                onClick={() => (narrow ? setAdvanced(!advanced) : setShowSources(!showSources))}
              >
                {narrow ? '筛选' : showSources ? '收起来源' : '显示来源'}
              </Button>
              <Link to="/settings/logs" className={styles.settingsLink} aria-label="日志保存设置">
                <Settings size={17} />
              </Link>
            </div>
          </header>
          <div className={styles.toolbar}>
            <Input
              aria-label="搜索日志"
              placeholder="搜索消息、错误或详情…"
              value={keyword}
              onChange={(event) => {
                edited.current = true
                setKeyword(event.target.value)
              }}
            />
            <Select
              aria-label="日志时间范围"
              value={range}
              options={[
                { value: '15', label: '最近 15 分钟' },
                { value: '60', label: '最近 1 小时' },
                { value: '1440', label: '最近 24 小时' },
                { value: '10080', label: '最近 7 天' },
                { value: 'custom', label: '自定义时间' },
              ]}
              onValueChange={(value) => {
                const next = { ...query }
                delete next.from
                delete next.to
                update(next, value)
                if (value === 'custom') setAdvanced(true)
              }}
            />
            <Button size="small" variant="ghost" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
              更多筛选
            </Button>
            <Button size="small" onClick={() => update({ ...query, levels: ['warn', 'error'] })}>
              仅异常
            </Button>
            <Button
              size="small"
              variant="ghost"
              icon={<RotateCcw size={14} />}
              onClick={() => {
                setKeyword('')
                update(defaults(), '60')
              }}
            >
              重置
            </Button>
          </div>
          <div className={styles.levels}>
            {LEVELS.map((level) => (
              <Button
                key={level}
                size="small"
                variant={(query.levels ?? LEVELS).includes(level) ? 'default' : 'ghost'}
                aria-pressed={(query.levels ?? LEVELS).includes(level)}
                onClick={() => {
                  const current = query.levels ?? LEVELS
                  update({
                    ...query,
                    levels: current.includes(level) ? current.filter((value) => value !== level) : [...current, level],
                  })
                }}
              >
                {LEVEL[level]} <span className={styles.levelCode}>{level.toUpperCase()}</span>
              </Button>
            ))}
            <span className={styles.spacer} />
            <span className={styles.density}>
              <Switch checked={compact} onCheckedChange={setCompact} label="紧凑日志" />
              <span>紧凑</span>
            </span>
          </div>
          {!narrow && (advanced || range === 'custom') ? filterControls : null}
          {query.scope?.operationId ? (
            <Banner tone="info">
              正在查看同一次操作的相关日志。
              <Button
                size="small"
                onClick={() => {
                  const scope = { ...query.scope }
                  delete scope.operationId
                  update({ ...query, scope })
                }}
              >
                取消操作筛选
              </Button>
            </Banner>
          ) : null}
          {feed.notice ? <Banner tone="warn">{feed.notice}</Banner> : null}
          {feed.status?.state === 'degraded' ? (
            <Banner tone="bad">{feed.status.error ?? '日志保存暂时不可用。'} 聊天仍可继续。</Banner>
          ) : null}
          <div className={styles.logArea}>
            <div className={styles.listHead}>
              <span>
                {feed.following ? '实时日志' : '阅读历史'} · {feed.entries.length.toLocaleString()} 条已加载
              </span>
              <div className={styles.actions}>
                {feed.hasMore ? (
                  <Button
                    size="small"
                    busy={feed.loading}
                    onClick={() => {
                      if (list.current)
                        anchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop }
                      void feed.older()
                    }}
                  >
                    加载更早日志
                  </Button>
                ) : null}
                <Button
                  size="small"
                  variant="ghost"
                  icon={feed.following ? <Pause size={14} /> : <Play size={14} />}
                  disabled={feed.following && feed.loading}
                  onClick={() => {
                    if (feed.following) feed.pause()
                    else {
                      setSelected(undefined)
                      setWindowStart(Date.now())
                      feed.resume()
                    }
                  }}
                >
                  {feed.following ? '暂停跟随' : '回到最新'}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    setKeyword(keyword)
                    update({ ...query, from: new Date().toISOString() }, 'custom')
                  }}
                >
                  清空视图
                </Button>
              </div>
            </div>
            {feed.error ? (
              <EmptyState title="日志读取失败">
                <p>{feed.error}</p>
                <Button onClick={feed.refresh}>重试</Button>
              </EmptyState>
            ) : feed.loading && !feed.entries.length ? (
              <EmptyState title="正在读取日志…" />
            ) : !feed.entries.length ? (
              <EmptyState icon={<ScrollText />} title="当前条件下没有日志">
                <p>调整筛选条件，或等待新的运行记录。</p>
                {query.levels?.includes('debug') ? (
                  <Button busy={busy} onClick={() => void debug()}>
                    开启临时调试
                  </Button>
                ) : null}
              </EmptyState>
            ) : null}
            <div
              ref={list}
              className={styles.logScroll}
              role="grid"
              aria-label="运行日志"
              aria-rowcount={rows.length}
              onMouseUp={() => {
                if (window.getSelection()?.toString()) feed.pause()
              }}
              onScroll={(event) => {
                const element = event.currentTarget
                setViewport({ top: element.scrollTop, height: element.clientHeight })
                if (element.scrollHeight - element.scrollTop - element.clientHeight > rowHeight * 2) feed.pause()
              }}
            >
              <div className={styles.virtual} style={{ height: rows.length * rowHeight }}>
                {rows.slice(start, end).map(({ entry, group }, offset) => (
                  <div
                    key={entry.id}
                    role="row"
                    aria-rowindex={start + offset + 1}
                    aria-selected={selected?.id === entry.id}
                    className={styles.row}
                    data-level={entry.level}
                    data-selected={selected?.id === entry.id}
                    style={cssVars({
                      '--log-top': `${(start + offset) * rowHeight}px`,
                      '--log-height': `${rowHeight}px`,
                    })}
                  >
                    <Pressable
                      role="gridcell"
                      className={styles.rowMain}
                      onClick={() => {
                        if (!window.getSelection()?.toString()) select(entry)
                      }}
                      title={[formatLogMessage(entry.message), contextLabel(entry)].filter(Boolean).join(' · ')}
                      aria-label={`${LEVEL[entry.level]} ${entry.source.name} ${formatLogMessage(entry.message)}`}
                    >
                      <time title={entry.timestamp}>
                        {narrow ? time(entry.timestamp).slice(0, 8) : time(entry.timestamp)}
                      </time>
                      <span className={styles.level}>{LEVEL[entry.level]}</span>
                      <span className={styles.rowSource}>{sourceName(entry.source)}</span>
                      <span className={styles.rowMessage}>
                        <span>{formatLogMessage(entry.message)}</span>
                        {!compact && contextLabel(entry) ? <small>{contextLabel(entry)}</small> : null}
                      </span>
                    </Pressable>
                    {group && group.entries.length > 1 ? (
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`${expanded.has(entry.id) ? '折叠' : '展开'} ${group.entries.length} 条重复日志`}
                        title={`${group.entries[0]?.timestamp} — ${group.entries.at(-1)?.timestamp}`}
                        onClick={() => {
                          feed.pause()
                          setExpanded((old) => {
                            const next = new Set(old)
                            if (next.has(entry.id)) next.delete(entry.id)
                            else next.add(entry.id)
                            return next
                          })
                        }}
                      >
                        {expanded.has(entry.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}×
                        {group.entries.length}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            {feed.newCount ? (
              <div className={styles.newLogs}>
                <Button
                  icon={<ArrowDown size={14} />}
                  onClick={() => {
                    setSelected(undefined)
                    setWindowStart(Date.now())
                    feed.resume()
                  }}
                >
                  新增 {feed.newCount} 条 · 回到最新
                </Button>
              </div>
            ) : null}
          </div>
          <footer className={styles.footer}>
            <div className={styles.actions}>
              <Select
                aria-label="调试采集时长"
                value={String(duration)}
                options={[5, 15, 30].map((value) => ({ value: String(value), label: `${value} 分钟` }))}
                onValueChange={(value) => setDuration(value === '5' ? 5 : value === '30' ? 30 : 15)}
              />
              <Button size="small" busy={busy} onClick={() => void debug()}>
                {debugSource ? '调试此来源' : '全局临时调试'}
              </Button>
            </div>
            <div className={styles.actions}>
              <Button
                size="small"
                icon={<Download size={14} />}
                disabled={exporting}
                onClick={() => void download('text')}
              >
                导出文本
              </Button>
              <Button size="small" disabled={exporting} onClick={() => void download('jsonl')}>
                JSONL
              </Button>
              {exporting ? (
                <Button size="small" onClick={() => exportingController.current?.abort()}>
                  取消导出
                </Button>
              ) : null}
            </div>
          </footer>
          {feed.status?.debugLeases.map((lease) => (
            <div key={lease.id} className={styles.debugLease}>
              <span>
                {lease.source
                  ? (sources.find((item) => item.kind === lease.source?.kind && item.id === lease.source.id)?.name ??
                    '此来源')
                  : '全局'}
                调试已开启 · {new Date(lease.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 自动关闭
              </span>
              <Button
                size="small"
                busy={busy}
                onClick={() => {
                  setBusy(true)
                  void logsApi
                    .stopDebug(lease.id)
                    .then(() => logsApi.status())
                    .then(feed.setStatus)
                    .catch(failure)
                    .finally(() => setBusy(false))
                }}
              >
                结束调试
              </Button>
            </div>
          ))}
          <p className={styles.hint}>
            清空视图不删除历史。导出包含当前筛选的全部记录；分享前请检查第三方文本中的业务信息。
          </p>
        </div>
      </MainContent>
      <Sheet open={narrow && advanced} onOpenChange={setAdvanced} title="筛选日志">
        {filterControls}
      </Sheet>
      <Sheet
        open={narrow && selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
        title="日志详情"
      >
        {details}
      </Sheet>
    </WorkbenchPage>
  )
}

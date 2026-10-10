import { Check, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import { Button, IconButton, Spinner, toast } from '../../ui-kit/index.js'
import styles from './tool-detail.module.css'
import {
  commandOutput,
  finishOutcome,
  messageText,
  readArguments,
  searchQueries,
  searchSources,
  toolKind,
} from './tool-presenter.js'

type ToolCallDetail = HostApiResponse<'getChannelToolCall'>

export interface ToolDetailSource {
  readonly callId: string
  readonly name: string
  readonly state: 'running' | 'succeeded' | 'failed'
  readonly inputPreview?: string | undefined
  readonly resultPreview?: string | undefined
  readonly wroteToChannel?: boolean | undefined
  readonly deliveryState?: string | undefined
  /** Source of a `run_code` program, shown before the full call has loaded. */
  readonly code?: string | undefined
}

/** Full arguments and result, cached per call: a finished call does not change, a running one is read again. */
const cache = new Map<string, ToolCallDetail>()

function useToolCallDetail(channelId: string | undefined, tool: ToolDetailSource, enabled: boolean) {
  const key = `${channelId}:${tool.callId}`
  const [detail, setDetail] = useState<ToolCallDetail | undefined>(() => cache.get(key))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!channelId || !enabled) return
    const cached = cache.get(key)
    if (cached && tool.state !== 'running') {
      setDetail(cached)
      return
    }
    const controller = new AbortController()
    workspaceApi
      .getChannelToolCall(channelId, tool.callId, { signal: controller.signal })
      .then((value) => {
        if (tool.state !== 'running') cache.set(key, value)
        setDetail(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [channelId, enabled, key, tool.callId, tool.state])
  const full = detail?.available ? detail : undefined
  return {
    full,
    missing: failed || detail?.available === false,
    loading: enabled && channelId !== undefined && !detail && !failed,
  }
}

/** A preview the projection cut (it ends with an ellipsis). */
const cut = (value: string | undefined): boolean => value?.trimEnd().endsWith('…') === true

function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label={label}
      size="small"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          },
          () => toast('复制失败', { tone: 'bad' }),
        )
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  )
}

function Block({
  title,
  children,
  action,
}: {
  readonly title: string
  readonly children: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <section className={styles.block}>
      <div className={styles.blockHead}>
        <span>{title}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function Code({ value, empty }: { readonly value: string | undefined; readonly empty?: string }) {
  if (value === undefined) return null
  return value ? <pre className={styles.code}>{value}</pre> : <p className={styles.empty}>{empty ?? '没有内容'}</p>
}

const display = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/**
 * What one tool call did, laid out for its kind: search terms and sources, a command and its output, the message
 * sent. Previews show at once; the full call loads when the step is opened (Decision 2026-10-06 §8 频道).
 */
export function ToolDetail({
  tool,
  channelId,
  bare = false,
}: {
  readonly tool: ToolDetailSource
  readonly channelId?: string | undefined
  /**
   * Inside a card that already draws the frame (透视). X-ray opens every card at once, so the full call loads only
   * when asked; a step a person opens loads it right away.
   */
  readonly bare?: boolean
}) {
  const [requested, setRequested] = useState(!bare)
  const { full, missing, loading } = useToolCallDetail(channelId, tool, requested)
  const detail = full
  const inputText = detail?.input ?? tool.inputPreview
  const resultText = detail?.result ?? tool.resultPreview
  const shortened = !detail && (cut(tool.inputPreview) || cut(tool.resultPreview))
  const args = readArguments(inputText)
  const kind = tool.wroteToChannel ? 'message' : toolKind(tool.name)
  const truncated = (detail?.inputTruncated ?? false) || (detail?.resultTruncated ?? false)
  const running = tool.state === 'running'

  let body: ReactNode
  if (kind === 'search') {
    const queries = searchQueries(args)
    const sources = searchSources(resultText)
    body = (
      <>
        {queries.length ? (
          <Block title="搜索词">
            <div className={styles.pills}>
              {queries.map((query) => (
                <span key={query} className={styles.pill}>
                  {query}
                </span>
              ))}
            </div>
          </Block>
        ) : null}
        {running ? null : sources.length ? (
          <Block title={`找到的来源 ${sources.length}`}>
            <ol className={styles.sources}>
              {sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    <span className={styles.sourceTitle}>{source.title}</span>
                    <span className={styles.sourceHost}>
                      {source.host}
                      <ExternalLink size={12} aria-hidden="true" />
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </Block>
        ) : resultText ? (
          <Block title="结果">
            <Code value={resultText} />
          </Block>
        ) : null}
      </>
    )
  } else if (kind === 'command') {
    const command = typeof args?.['command'] === 'string' ? args['command'] : (inputText ?? '')
    const description = typeof args?.['description'] === 'string' ? args['description'] : undefined
    const output = commandOutput(resultText)
    body = (
      <>
        {description ? <p className={styles.lead}>{description}</p> : null}
        <Block title="命令" action={command ? <CopyButton value={command} label="复制命令" /> : undefined}>
          <pre className={[styles.code, styles.command].join(' ')}>{command}</pre>
        </Block>
        {running ? null : (
          <Block title="输出" action={output ? <CopyButton value={output} label="复制输出" /> : undefined}>
            <Code value={output ?? ''} empty="命令没有输出" />
          </Block>
        )}
      </>
    )
  } else if (kind === 'message') {
    const message = messageText(args, inputText)
    body = (
      <>
        {message ? (
          <Block title="发出的内容">
            <blockquote className={styles.quote}>{message}</blockquote>
          </Block>
        ) : null}
        {running ? null : (
          <p className={styles.lead}>
            {tool.deliveryState === 'sent'
              ? '已送达频道'
              : tool.deliveryState === 'unknown'
                ? '送达结果未确认'
                : tool.state === 'failed'
                  ? '没有发出'
                  : '已写入频道'}
          </p>
        )}
      </>
    )
  } else if (kind === 'script') {
    const code = typeof args?.['code'] === 'string' ? args['code'] : tool.code
    const description = typeof args?.['description'] === 'string' ? args['description'] : tool.inputPreview
    body = (
      <>
        {description ? <p className={styles.lead}>{description}</p> : null}
        {code ? (
          <Block title="程序" action={<CopyButton value={code} label="复制程序" />}>
            <pre className={styles.code}>{code}</pre>
          </Block>
        ) : null}
        {running ? null : (
          <Block title="输出" action={resultText ? <CopyButton value={resultText} label="复制输出" /> : undefined}>
            <Code value={resultText ?? ''} empty="程序没有输出" />
          </Block>
        )}
      </>
    )
  } else if (kind === 'finish') {
    const outcome = finishOutcome(args?.['outcome'])
    const reason = typeof args?.['reason'] === 'string' ? args['reason'] : undefined
    body = (
      <>
        {outcome ? <p className={styles.lead}>{outcome}</p> : null}
        {reason ? (
          <Block title="原因">
            <p className={styles.prose}>{reason}</p>
          </Block>
        ) : null}
      </>
    )
  } else {
    const entries = args ? Object.entries(args).filter(([, value]) => value !== undefined && value !== '') : []
    body = (
      <>
        {entries.length ? (
          <Block title="输入">
            <dl className={styles.fields}>
              {entries.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    {typeof value === 'string' && !value.includes('\n') ? value : <Code value={display(value)} />}
                  </dd>
                </div>
              ))}
            </dl>
          </Block>
        ) : inputText ? (
          <Block title="输入">
            <Code value={inputText} />
          </Block>
        ) : null}
        {running || !resultText ? null : (
          <Block title="结果" action={<CopyButton value={resultText} label="复制结果" />}>
            <Code value={resultText} />
          </Block>
        )}
      </>
    )
  }

  return (
    <div className={[styles.detail, bare ? styles.bare : ''].join(' ')} data-state={tool.state}>
      {body}
      {running ? (
        <p className={styles.note}>
          <Spinner /> 正在执行…
        </p>
      ) : loading ? (
        <p className={styles.note}>
          <Spinner /> 正在读取完整内容…
        </p>
      ) : missing ? (
        <p className={styles.note}>完整内容已不在当前会话中，这里显示的是摘要。</p>
      ) : !requested && shortened && channelId ? (
        <Button size="small" variant="ghost" className={styles.more} onClick={() => setRequested(true)}>
          显示完整内容
        </Button>
      ) : truncated ? (
        <p className={styles.note}>内容较长，只显示了前一部分。</p>
      ) : null}
    </div>
  )
}

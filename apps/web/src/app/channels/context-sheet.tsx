import { Check, ChevronRight, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HostApiResponse } from '@nekro-nxt/contracts'
import { workspaceApi } from '../../host-api-client.js'
import {
  EmptyState,
  IconButton,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Pressable,
  Sheet,
  Spinner,
  toast,
} from '../../ui-kit/index.js'
import { formatTokens } from './timeline-model.js'
import styles from './context-sheet.module.css'

type RuntimeContext = HostApiResponse<'getChannelRuntimeContext'>

const changeReason: Record<RuntimeContext['changes'][number]['reason'], string> = {
  initial: '会话开始',
  resume: '会话恢复',
  change: '工具或模型设置变化',
  series: '开始新的消息序列',
}

const dateTime = (at: number): string =>
  new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

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

function ToolRow({ tool }: { readonly tool: RuntimeContext['tools'][number] }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={styles.tool}>
      <Pressable className={styles.toolHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={styles.chevron} data-open={open} />
        <code className={styles.toolName}>{tool.name}</code>
      </Pressable>
      {open ? (
        <div className={styles.toolBody}>
          {tool.description ? <p className={styles.prose}>{tool.description}</p> : null}
          {tool.parameters ? <pre className={styles.code}>{tool.parameters}</pre> : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * What the agent's live session sends the model in this channel: route, instructions and tools. Loaded each time the
 * sheet opens, since extensions and settings change it between turns (issue #7).
 */
export function ContextSheet({
  open,
  onOpenChange,
  channelId,
  agentName,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly channelId: string
  readonly agentName: string
}) {
  const [context, setContext] = useState<RuntimeContext | undefined>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    setContext(undefined)
    setFailed(false)
    const controller = new AbortController()
    workspaceApi
      .getChannelRuntimeContext(channelId, { signal: controller.signal })
      .then(setContext)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [channelId, open])

  const route = context?.route
  const system = context?.instructions.map((item) => item.text).join('\n\n') ?? ''

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={`${agentName}看到的上下文`}>
      {failed ? (
        <EmptyState title="读取失败">稍后再试。</EmptyState>
      ) : !context ? (
        <div className={styles.loading}>
          <Spinner />
        </div>
      ) : !context.available ? (
        <EmptyState title="没有正在运行的会话">智能体在这个频道收到下一条消息后，这里会显示它看到的内容。</EmptyState>
      ) : (
        <>
          {route ? (
            <PropertyGroup title="模型">
              <PropertyList>
                <PropertyRow label="模型">
                  <span className={styles.value}>
                    {route.model}
                    <span className={styles.muted}> · {route.provider}</span>
                  </span>
                </PropertyRow>
                {route.contextWindow ? (
                  <PropertyRow label="上下文窗口">{formatTokens(route.contextWindow)}</PropertyRow>
                ) : null}
                {route.reasoningEffort ? (
                  <PropertyRow label="推理强度">
                    <code>{route.reasoningEffort}</code>
                  </PropertyRow>
                ) : null}
                {route.maxTokens ? (
                  <PropertyRow label="单次输出上限">{formatTokens(route.maxTokens)}</PropertyRow>
                ) : null}
              </PropertyList>
            </PropertyGroup>
          ) : null}

          <PropertyGroup
            title="系统提示词"
            description={system ? undefined : '还没有发出模型请求'}
            actions={system ? <CopyButton value={system} label="复制系统提示词" /> : undefined}
          >
            {context.instructions.map((item, index) => (
              <div key={index} className={styles.instruction}>
                {item.role === 'developer' ? <span className={styles.muted}>会话中追加的说明</span> : null}
                <pre className={styles.code}>{item.text}</pre>
                {item.truncated ? <span className={styles.muted}>内容过长，只显示开头部分</span> : null}
              </div>
            ))}
          </PropertyGroup>

          <PropertyGroup
            title={`工具 ${context.tools.length}`}
            description={context.tools.length ? undefined : '还没有发出模型请求'}
          >
            {context.tools.length ? (
              <ul className={styles.tools}>
                {context.tools.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
            ) : null}
          </PropertyGroup>

          {context.changes.length ? (
            <PropertyGroup title="变化记录">
              <PropertyList>
                {context.changes.toReversed().map((change, index) => (
                  <PropertyRow key={index} label={change.at === undefined ? '—' : dateTime(change.at)}>
                    <span className={styles.value}>
                      {changeReason[change.reason]}
                      <span className={styles.muted}> · {change.toolCount} 个工具</span>
                    </span>
                  </PropertyRow>
                ))}
              </PropertyList>
            </PropertyGroup>
          ) : null}
        </>
      )}
    </Sheet>
  )
}

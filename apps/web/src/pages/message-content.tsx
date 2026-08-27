import { File, Headphones, Quote } from 'lucide-react'
import { MessagePartSchema } from '@nekro-nxt/contracts'
import { useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { ChannelSummary, ConversationMessage, ConversationPart } from '../product-store.js'
import { Button } from '../ui-kit/index.js'
import contentStyles from './message-content.module.css'
import styles from './product-pages.module.css'
import { detectResourceKind, ResourcePreviewDialog, type PreviewResource } from './resource-preview.js'
import { AdapterRichMessageRenderer } from '../adapter-host-client.js'

export type MessageSide = 'left' | 'right' | 'system'

export const resolveMessageSide = (input: {
  readonly channelKind: ChannelSummary['kind']
  readonly role: ConversationMessage['role']
  readonly origin?: ConversationMessage['origin']
}): MessageSide => {
  if (input.role === 'system') return 'system'
  if (input.channelKind === 'web') return input.role === 'member' ? 'right' : 'left'
  return input.role === 'member' ? 'left' : 'right'
}

const markdownUrlTransform = (url: string): string => {
  const transformed = defaultUrlTransform(url)
  return /^(https?:|mailto:)/iu.test(transformed) ? transformed : ''
}

const safeExternalTargetUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

const markdownComponents: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

const inlineMarkdownComponents: Components = {
  ...markdownComponents,
  p: ({ children }) => <span>{children}</span>,
}

function SafeMarkdown({ text, inline = false }: { readonly text: string; readonly inline?: boolean }) {
  const markdown = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      skipHtml
      urlTransform={markdownUrlTransform}
      components={inline ? inlineMarkdownComponents : markdownComponents}
    >
      {text}
    </ReactMarkdown>
  )
  if (!inline) return <div className={styles.markdownPart}>{markdown}</div>
  return <span className={contentStyles.inlineMarkdown}>{markdown}</span>
}

function MentionChip({ displayName }: { readonly displayName: string }) {
  return <span className={styles.messageMention}>@{displayName}</span>
}

function HostRichCard({
  part,
  onPreview,
}: {
  readonly part: Extract<ConversationPart, { readonly type: 'rich' }>
  readonly onPreview: (resource: PreviewResource) => void
}) {
  const heading = part.title ?? part.summary
  const composed = [part.source, part.title].filter(Boolean).join(' · ')
  const showSummary = part.summary !== heading && part.summary !== composed
  const items = part.items ?? []
  const previewLines = part.kind === 'forward' && items.length === 0 ? part.preview?.trim() : undefined
  const cardContent = (
    <>
      {part.kind === 'forward' ? (
        <p className={contentStyles.richSource}>
          {part.title ?? '聊天记录'}
          {items.length > 0 ? ` · ${items.length} 条` : ''}
        </p>
      ) : part.source ? (
        <p className={contentStyles.richSource}>{part.source}</p>
      ) : null}
      {part.kind !== 'forward' ? <p className={contentStyles.richTitle}>{heading}</p> : null}
      {part.kind === 'forward' && items.length === 0 ? <p className={contentStyles.richTitle}>{part.summary}</p> : null}
      {part.kind !== 'forward' && showSummary ? <p className={contentStyles.richSummary}>{part.summary}</p> : null}
      {items.map((item, index) => (
        <div className={contentStyles.forwardItem} key={index}>
          {item.sender ? <p className={contentStyles.forwardSender}>{item.sender}</p> : null}
          {item.text ? <p className={contentStyles.richSummary}>{item.text}</p> : null}
          {item.card
            ? (() => {
                const nestedContent = (
                  <>
                    {item.card.source ? <p className={contentStyles.richSource}>{item.card.source}</p> : null}
                    <p className={contentStyles.richTitle}>{item.card.title ?? item.card.summary}</p>
                    {item.card.previewUrl ? (
                      <img
                        className={styles.messageImage}
                        src={item.card.previewUrl}
                        alt={item.card.title ?? item.card.summary}
                        loading="lazy"
                      />
                    ) : null}
                  </>
                )
                const targetUrl = safeExternalTargetUrl(item.card.targetUrl)
                return targetUrl ? (
                  <a
                    className={contentStyles.nestedCard}
                    href={targetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`打开卡片：${item.card.title ?? item.card.summary}`}
                  >
                    {nestedContent}
                  </a>
                ) : (
                  <div className={contentStyles.nestedCard}>{nestedContent}</div>
                )
              })()
            : null}
          {item.imageUrl ? (
            <Button
              variant="ghost"
              type="button"
              className={contentStyles.previewTrigger}
              onClick={() => onPreview({ name: item.imageName ?? '图片', url: item.imageUrl!, kind: 'image' })}
            >
              <img className={styles.messageImage} src={item.imageUrl} alt={item.imageName ?? '图片'} loading="lazy" />
            </Button>
          ) : null}
        </div>
      ))}
      {previewLines ? <pre className={contentStyles.forwardPreview}>{previewLines}</pre> : null}
      {part.previewUrl ? (
        <img className={styles.messageImage} src={part.previewUrl} alt={heading} loading="lazy" />
      ) : null}
    </>
  )
  const targetUrl = items.length === 0 ? safeExternalTargetUrl(part.targetUrl) : undefined
  return targetUrl ? (
    <a
      className={contentStyles.richCard}
      data-kind={part.kind}
      href={targetUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`打开卡片：${heading}`}
    >
      {cardContent}
    </a>
  ) : (
    <article className={contentStyles.richCard} data-kind={part.kind}>
      {cardContent}
    </article>
  )
}

function StructuredPart({
  part,
  onPreview,
  messageId,
  channelId,
}: {
  readonly part: Exclude<ConversationPart, { readonly type: 'text' | 'mention' }>
  readonly onPreview: (resource: PreviewResource) => void
  readonly messageId: string
  readonly channelId: string
}) {
  if (part.type === 'rich') {
    const fallback = <HostRichCard part={part} onPreview={onPreview} />
    const adapterPart = MessagePartSchema.safeParse({
      type: 'rich',
      adapterKey: part.adapterKey,
      kind: part.kind,
      summary: part.summary,
      ...(part.title === undefined ? {} : { title: part.title }),
      ...(part.source === undefined ? {} : { source: part.source }),
      ...(part.targetUrl === undefined ? {} : { targetUrl: part.targetUrl }),
      ...(part.extension === undefined ? {} : { extension: part.extension }),
    })
    if (!adapterPart.success || adapterPart.data.type !== 'rich') return fallback
    return (
      <AdapterRichMessageRenderer
        slotKey={`${part.adapterKey}:${part.kind}`}
        props={{ part: adapterPart.data, messageId, channelId }}
        fallback={fallback}
      />
    )
  }
  if (part.type === 'image') {
    return (
      <Button
        variant="ghost"
        type="button"
        className={contentStyles.previewTrigger}
        onClick={() => onPreview({ name: part.alt, url: part.url, kind: 'image' })}
      >
        <img className={styles.messageImage} src={part.url} alt={part.alt} loading="lazy" />
      </Button>
    )
  }
  if (part.type === 'audio') {
    return (
      <div className={styles.attachment}>
        <Headphones size={15} aria-hidden="true" />
        <audio controls preload="none" src={part.url}>
          你的浏览器不支持音频播放。
        </audio>
      </div>
    )
  }
  if (part.type === 'file') {
    return (
      <Button
        variant="ghost"
        type="button"
        className={contentStyles.fileTrigger}
        onClick={() => onPreview({ name: part.name, url: part.url, kind: detectResourceKind(part.name) })}
      >
        <File size={15} aria-hidden="true" /> {part.name}
      </Button>
    )
  }
  if (part.type === 'quote') {
    return (
      <span className={styles.messageQuote}>
        <Quote size={14} aria-hidden="true" /> 引用消息
      </span>
    )
  }
  return <span className={styles.messageUnsupported}>{part.label}</span>
}

type InlinePart = Extract<ConversationPart, { readonly type: 'text' | 'mention' }>
type MessageRun =
  | { readonly kind: 'inline'; readonly parts: readonly InlinePart[] }
  | { readonly kind: 'block'; readonly part: Exclude<ConversationPart, InlinePart> }

const groupMessageRuns = (parts: readonly ConversationPart[]): readonly MessageRun[] => {
  const runs: Array<
    { kind: 'inline'; parts: InlinePart[] } | { kind: 'block'; part: Exclude<ConversationPart, InlinePart> }
  > = []
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'mention') {
      const last = runs.at(-1)
      if (last?.kind === 'inline') last.parts.push(part)
      else runs.push({ kind: 'inline', parts: [part] })
      continue
    }
    runs.push({ kind: 'block', part })
  }
  return runs
}

export function MessageContent({ message }: { readonly message: ConversationMessage }) {
  const [preview, setPreview] = useState<PreviewResource | null>(null)
  return (
    <div className={styles.messageBody} data-message-bubble>
      {groupMessageRuns(message.parts).map((run, runIndex) => {
        if (run.kind === 'block') {
          return (
            <div className={contentStyles.contentRun} key={`${runIndex}:${run.part.type}`}>
              <StructuredPart
                part={run.part}
                onPreview={setPreview}
                messageId={message.id}
                channelId={message.channelId}
              />
            </div>
          )
        }
        const [only] = run.parts
        if (run.parts.length === 1 && only?.type === 'text') {
          return (
            <div className={contentStyles.contentRun} key={`${runIndex}:text`}>
              <SafeMarkdown text={only.text} />
            </div>
          )
        }
        return (
          <div className={contentStyles.contentRun} key={`${runIndex}:inline`}>
            <span className={contentStyles.inlineRun}>
              {run.parts.map((part, partIndex) =>
                part.type === 'text' ? (
                  <SafeMarkdown key={`${partIndex}:text`} text={part.text} inline />
                ) : (
                  <MentionChip key={`${partIndex}:mention`} displayName={part.displayName} />
                ),
              )}
            </span>
          </div>
        )
      })}
      <ResourcePreviewDialog
        open={preview !== null}
        resource={preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null)
        }}
      />
    </div>
  )
}

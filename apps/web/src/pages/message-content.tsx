import { File, Headphones, Image as ImageIcon, Quote } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { ChannelSummary, ConversationMessage, ConversationPart } from '../product-store.js'
import { Button } from '../ui-kit/index.js'
import contentStyles from './message-content.module.css'
import styles from './product-pages.module.css'
import { detectResourceKind, ResourcePreviewDialog, type PreviewResource } from './resource-preview.js'

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

function MarkdownText({ text }: { readonly text: string }) {
  return (
    <div className={styles.markdownPart}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={markdownUrlTransform}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function InlineMarkdownText({ text }: { readonly text: string }) {
  return (
    <span className={contentStyles.inlineMarkdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={markdownUrlTransform}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          p: ({ children }) => <span>{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </span>
  )
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
  return (
    <article className={contentStyles.richCard} data-kind={part.kind}>
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
          {item.card ? (
            <div className={contentStyles.nestedCard}>
              {item.card.source ? <p className={contentStyles.richSource}>{item.card.source}</p> : null}
              <p className={contentStyles.richTitle}>{item.card.title ?? item.card.summary}</p>
              {item.card.previewUrl ? (
                <Button
                  variant="ghost"
                  type="button"
                  className={contentStyles.previewTrigger}
                  onClick={() =>
                    onPreview({
                      name: item.card?.title ?? item.card?.summary ?? '卡片预览',
                      url: item.card!.previewUrl!,
                      kind: 'image',
                    })
                  }
                >
                  <img
                    className={styles.messageImage}
                    src={item.card.previewUrl}
                    alt={item.card.title ?? item.card.summary}
                    loading="lazy"
                  />
                </Button>
              ) : null}
            </div>
          ) : null}
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
        <Button
          variant="ghost"
          type="button"
          className={contentStyles.previewTrigger}
          onClick={() => onPreview({ name: heading, url: part.previewUrl!, kind: 'image' })}
        >
          <img className={styles.messageImage} src={part.previewUrl} alt={heading} loading="lazy" />
        </Button>
      ) : null}
    </article>
  )
}

function StructuredPart({
  part,
  onPreview,
}: {
  readonly part: Exclude<ConversationPart, { readonly type: 'text' | 'mention' }>
  readonly onPreview: (resource: PreviewResource) => void
}) {
  if (part.type === 'rich') return <HostRichCard part={part} onPreview={onPreview} />
  if (part.type === 'image') {
    return (
      <Button
        variant="ghost"
        type="button"
        className={contentStyles.previewTrigger}
        onClick={() => onPreview({ name: part.alt, url: part.url, kind: 'image' })}
      >
        <img className={styles.messageImage} src={part.url} alt={part.alt} loading="lazy" />
        <span>
          <ImageIcon size={14} aria-hidden="true" /> {part.alt}
        </span>
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
    <div className={styles.messageBody}>
      {groupMessageRuns(message.parts).map((run, runIndex) => {
        if (run.kind === 'block') {
          return <StructuredPart key={`${runIndex}:${run.part.type}`} part={run.part} onPreview={setPreview} />
        }
        const [only] = run.parts
        if (run.parts.length === 1 && only?.type === 'text') {
          return <MarkdownText key={`${runIndex}:text`} text={only.text} />
        }
        return (
          <span className={contentStyles.inlineRun} key={`${runIndex}:inline`}>
            {run.parts.map((part, partIndex) =>
              part.type === 'text' ? (
                <InlineMarkdownText key={`${partIndex}:text`} text={part.text} />
              ) : (
                <MentionChip key={`${partIndex}:mention`} displayName={part.displayName} />
              ),
            )}
          </span>
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

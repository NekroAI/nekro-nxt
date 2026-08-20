import { Download, File, Headphones, Image as ImageIcon, Quote } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { ChannelSummary, ConversationMessage, ConversationPart } from '../product-store.js'
import styles from './product-pages.module.css'

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

function StructuredPart({ part }: { readonly part: Exclude<ConversationPart, { readonly type: 'text' }> }) {
  if (part.type === 'mention') return <span className={styles.messageMention}>@{part.displayName}</span>
  if (part.type === 'image') {
    return (
      <a className={styles.messageImageLink} href={part.url} target="_blank" rel="noreferrer">
        <img className={styles.messageImage} src={part.url} alt={part.alt} loading="lazy" />
        <span>
          <ImageIcon size={14} aria-hidden="true" /> {part.alt}
        </span>
      </a>
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
      <a className={styles.attachment} href={part.url} download={part.name}>
        <File size={15} aria-hidden="true" /> {part.name}
        <Download size={14} aria-hidden="true" />
      </a>
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

export function MessageContent({ message }: { readonly message: ConversationMessage }) {
  return (
    <div className={styles.messageBody}>
      {message.mentionedConnectionAccount ? <span className={styles.messageMention}>@机器人账号</span> : null}
      {message.parts.map((part, index) =>
        part.type === 'text' ? (
          <MarkdownText key={`${index}:text`} text={part.text} />
        ) : (
          <StructuredPart key={`${index}:${part.type}`} part={part} />
        ),
      )}
    </div>
  )
}

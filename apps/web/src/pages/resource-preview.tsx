import { Download, File } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, Enter, Spinner } from '../ui-kit/index.js'
import styles from './resource-preview.module.css'

export type ResourceKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'file'

export interface PreviewResource {
  readonly name: string
  readonly url: string
  readonly kind?: ResourceKind
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov'])
const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'xml',
  'html',
  'htm',
  'log',
  'yaml',
  'yml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'py',
  'rs',
  'go',
  'java',
  'toml',
  'ini',
  'sh',
])

const extensionOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? ''

export const detectResourceKind = (name: string, fallback: ResourceKind = 'file'): ResourceKind => {
  const ext = extensionOf(name)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXT.has(ext)) return 'text'
  return fallback
}

const TEXT_PREVIEW_LIMIT = 512 * 1024

function TextPreview({ url, name }: { readonly url: string; readonly name: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'too-large'>('loading')
  const [text, setText] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error('preview-failed')
        const length = Number(response.headers.get('content-length') ?? '0')
        if (Number.isFinite(length) && length > TEXT_PREVIEW_LIMIT) {
          setState('too-large')
          return
        }
        const body = await response.text()
        if (controller.signal.aborted) return
        if (new TextEncoder().encode(body).byteLength > TEXT_PREVIEW_LIMIT) {
          setState('too-large')
          return
        }
        setText(body)
        setState('ready')
      } catch (error) {
        if (controller.signal.aborted) return
        setState(error instanceof Error && error.name === 'AbortError' ? 'loading' : 'error')
      }
    })()
    return () => controller.abort()
  }, [url])

  if (state === 'loading') {
    return (
      <div className={styles.status}>
        <Spinner size={18} /> 正在读取 {name}
      </div>
    )
  }
  if (state === 'too-large') return <p className={styles.status}>文件较大，请下载后查看。</p>
  if (state === 'error') return <p className={styles.status}>无法预览该文件，请下载后查看。</p>
  return <pre className={styles.textPreview}>{text}</pre>
}

export function ResourcePreviewDialog({
  open,
  resource,
  onOpenChange,
}: {
  readonly open: boolean
  readonly resource: PreviewResource | null
  readonly onOpenChange: (open: boolean) => void
}) {
  if (!resource) return null
  const kind = resource.kind ?? detectResourceKind(resource.name)
  const title = resource.name || (kind === 'image' ? '图片' : '文件')
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      className={styles.dialog}
      closeLabel="关闭预览"
      footer={
        <a className={styles.download} href={resource.url} download={resource.name || undefined}>
          <Download size={14} aria-hidden="true" /> 下载
        </a>
      }
    >
      <Enter kind="fade" className={styles.body}>
        {kind === 'image' ? <img className={styles.image} src={resource.url} alt={title} /> : null}
        {kind === 'audio' ? (
          <audio className={styles.media} controls src={resource.url}>
            你的浏览器不支持音频播放。
          </audio>
        ) : null}
        {kind === 'video' ? (
          <video className={styles.media} controls src={resource.url}>
            你的浏览器不支持视频播放。
          </video>
        ) : null}
        {kind === 'pdf' ? <iframe className={styles.frame} title={title} src={resource.url} /> : null}
        {kind === 'text' ? <TextPreview url={resource.url} name={title} /> : null}
        {kind === 'file' ? (
          <p className={styles.status}>
            <File size={16} aria-hidden="true" /> 此类型暂不在应用内预览，可下载后查看。
          </p>
        ) : null}
      </Enter>
    </Dialog>
  )
}

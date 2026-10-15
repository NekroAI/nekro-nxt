import { ArrowRight, FilePlus2, ImagePlus, Plug, RotateCcw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { commandApi, type CommandCatalog } from '../../command-api.js'
import { EMPTY_CHANNEL_DRAFT, isReadyAttachment, type ChannelAttachment } from '../../channel-drafts.js'
import {
  connectionDisplayName,
  useProductRuntime,
  useUiStateStore,
  type AgentSummary,
  type ChannelSummary,
  type ConnectionSummary,
} from '../../product-runtime.js'
import { FileChooser, Pressable, Textarea, toast } from '../../ui-kit/index.js'
import { connectionStatus } from '../model/connection-status.js'
import { useProductApi } from '../model/store.js'
import { ResourcePreviewDialog } from './resource-preview.js'
import styles from './channels.module.css'

const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`

function Attachment({
  item,
  channelId,
  sending,
}: {
  readonly item: ChannelAttachment
  readonly channelId: string
  readonly sending: boolean
}) {
  const ui = useProductRuntime().uiStore
  const [localUrl, setLocalUrl] = useState<string>()
  const [preview, setPreview] = useState(false)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!item.file || item.partType !== 'image') return
    const url = URL.createObjectURL(item.file)
    setLocalUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [item.file, item.partType])
  const url = item.assetId
    ? `/api/channels/${encodeURIComponent(channelId)}/assets/${encodeURIComponent(item.assetId)}`
    : item.file
      ? localUrl
      : undefined
  useEffect(() => {
    setBroken(false)
  }, [url])
  const image = item.partType === 'image'
  const status =
    item.status === 'uploading'
      ? '上传中…'
      : item.status === 'failed'
        ? '上传失败'
        : item.status === 'removing'
          ? '移除中…'
          : sizeLabel(item.byteSize)
  return (
    <div className={styles.attachment} role="listitem" aria-label={item.name}>
      <Pressable
        type="button"
        className={styles.attachmentPreview}
        aria-label={`预览${item.name}`}
        disabled={!url || broken}
        onClick={() => setPreview(true)}
      >
        {image && url && !broken ? (
          <img src={url} alt={item.name} onError={() => setBroken(true)} />
        ) : (
          <FilePlus2 aria-hidden="true" />
        )}
      </Pressable>
      <div className={styles.attachmentInfo}>
        <span title={item.name}>{item.name}</span>
        <small aria-live="polite">{status}</small>
        {broken ? <small>预览不可用，附件可能已过期，请重新添加。</small> : null}
        {item.error ? (
          <small className={styles.attachmentError} role="status">
            {item.error}
          </small>
        ) : null}
      </div>
      {item.status === 'failed' && item.file ? (
        <Pressable
          type="button"
          className={styles.attachmentAction}
          aria-label={`重试上传${item.name}`}
          title="重试上传"
          disabled={sending}
          onClick={() => ui.getState().retryChannelAttachment(channelId, item.id)}
        >
          <RotateCcw aria-hidden="true" />
        </Pressable>
      ) : null}
      <Pressable
        type="button"
        className={styles.attachmentAction}
        aria-label={`移除${item.name}`}
        title="移除附件"
        disabled={sending || item.status === 'removing'}
        onClick={() => void ui.getState().removeChannelAttachment(channelId, item.id)}
      >
        <X aria-hidden="true" />
      </Pressable>
      <ResourcePreviewDialog
        open={preview}
        onOpenChange={setPreview}
        resource={url ? { name: item.name, url, ...(image ? { kind: 'image' as const } : {}) } : null}
      />
    </div>
  )
}

export function Composer({
  channel,
  agent,
  connection,
}: {
  readonly channel: ChannelSummary
  readonly agent: AgentSummary | undefined
  readonly connection: ConnectionSummary | undefined
}) {
  const api = useProductApi()
  const ui = useProductRuntime().uiStore
  const state = useUiStateStore((current) => current.channelDrafts[channel.id] ?? EMPTY_CHANNEL_DRAFT)
  const draft = state.text
  const attachments = state.attachments ?? []
  const sending = state.pending !== undefined
  const incomplete = attachments.some((item) => !isReadyAttachment(item))
  const composing = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const imagePicker = useRef<HTMLInputElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const external = channel.kind !== 'internal'
  const commandRequest = useRef<{ channelId: string; revision: number; id: string } | undefined>(undefined)
  const commandList = useRef<HTMLDivElement>(null)
  const [commands, setCommands] = useState<CommandCatalog['commands']>([])
  const [commandError, setCommandError] = useState('')
  const [selected, setSelected] = useState(0)
  const [commandFocus, setCommandFocus] = useState(0)
  const trimmed = draft.trimStart()
  const commandMode = trimmed.startsWith('/') && !trimmed.startsWith('//') && attachments.length === 0
  const commandQuery = trimmed.slice(1)
  const completing = commandMode && !/\s/u.test(commandQuery)
  const suggestions = commands.filter(
    (command) =>
      command.available &&
      (command.fullName.startsWith(commandQuery) ||
        command.definition.name.startsWith(commandQuery) ||
        command.definition.aliases.some((alias) => alias.startsWith(commandQuery))),
  )
  const currentCommand = commands.find((command) => command.fullName === commandQuery.split(/\s/u)[0])
  useEffect(() => {
    if (!commandMode) return
    const controller = new AbortController()
    setCommandError('')
    void commandApi
      .list(channel.id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCommands(result.commands)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCommandError(error instanceof Error ? error.message : '读取命令失败。')
      })
    return () => controller.abort()
  }, [channel.id, commandMode, commandFocus])
  useEffect(() => setSelected(0), [commandQuery, channel.id])
  useLayoutEffect(() => {
    const list = commandList.current
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !option) return
    const viewport = list.getBoundingClientRect()
    const bounds = option.getBoundingClientRect()
    if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top
    else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom
  }, [selected, completing, commandQuery, commands])
  const choose = (index: number) => {
    const command = suggestions[index]
    if (command) ui.getState().setChannelDraft(channel.id, '/' + command.fullName + ' ')
    input.current?.focus()
  }
  const blocked = commandMode
    ? ''
    : !agent
      ? '还没有智能体响应这个频道'
      : connection && connectionStatus(connection).health === 'attention'
        ? `${connectionDisplayName(connection)}：${connectionStatus(connection).reason ?? '需要处理'}`
        : external && connection && !connection.proactiveSend
          ? `${connectionDisplayName(connection)} 不支持主动发送`
          : ''
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [draft])
  const send = async () => {
    if (blocked) return
    const token = ui.getState().beginChannelSend(channel.id)
    if (!token) return
    let success = false
    try {
      if (commandMode) {
        if (commandRequest.current?.channelId !== channel.id || commandRequest.current.revision !== token.revision)
          commandRequest.current = { channelId: channel.id, revision: token.revision, id: crypto.randomUUID() }
        await commandApi.execute(channel.id, token.text, commandRequest.current.id)
        commandRequest.current = undefined
      } else await api.getState().sendMessage(channel.id, token.text, token.attachments)
      success = true
    } catch (error) {
      toast(`${error instanceof Error ? error.message : String(error)}，草稿已保留`, { tone: 'bad' })
    } finally {
      ui.getState().finishChannelSend(channel.id, token.revision, token.request, success)
      input.current?.focus()
    }
  }
  const addFiles = (files: readonly File[]) => {
    if (blocked || sending) return
    try {
      ui.getState().addChannelFiles(channel.id, files)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completing && suggestions.length && !composing.current && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((index) => (index + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        choose(selected)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }
  return (
    <form
      className={[styles.composer, dragging ? styles.composerDragging : ''].join(' ')}
      aria-label="消息输入"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = blocked || sending ? 'none' : 'copy'
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        addFiles([...event.dataTransfer.files])
      }}
    >
      {attachments.length ? (
        <>
          <div className={styles.attachments} role="list" aria-label="待发送附件">
            {attachments.map((item) => (
              <Attachment key={item.id} item={item} channelId={channel.id} sending={sending} />
            ))}
          </div>
          <span className={styles.attachmentHint}>
            {attachments.length}/20 · 合计 {sizeLabel(attachments.reduce((sum, item) => sum + item.byteSize, 0))} ·
            未发送附件保留 7 天
          </span>
        </>
      ) : null}
      {blocked ? <span className={styles.blocked}>{blocked}；仍可输入 /help 或 /status</span> : null}
      {commandError ? <span role="alert">{commandError}</span> : null}
      {completing && suggestions.length ? (
        <div
          ref={commandList}
          className={styles.commandSuggestions}
          role="listbox"
          id={`commands-${channel.id}`}
          aria-label="可用命令"
        >
          {suggestions.map((command, index) => (
            <Pressable
              type="button"
              role="option"
              key={command.fullName}
              id={`command-${channel.id}-${index}`}
              aria-selected={selected === index}
              className={styles.commandOption}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <b>/{command.fullName}</b> · {command.definition.description}
            </Pressable>
          ))}
        </div>
      ) : null}
      {commandMode && currentCommand ? (
        <span role="status" className={styles.commandHint}>
          用法：{currentCommand.usage}
        </span>
      ) : null}
      <div className={styles.composerRow}>
        {commandMode ? (
          <span className={styles.as}>执行当前频道命令</span>
        ) : external && connection && !blocked ? (
          <span className={styles.as} title="以这个机器人账号发出，群成员可见">
            <Plug aria-hidden="true" />
            {connectionDisplayName(connection)}
          </span>
        ) : null}
        <Textarea
          bare
          ref={input}
          className={styles.input}
          rows={1}
          value={draft}
          onChange={(event) => ui.getState().setChannelDraft(channel.id, event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (files.length) {
              event.preventDefault()
              addFiles(files)
            }
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (commandMode) setCommandFocus((n) => n + 1)
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          placeholder={
            dragging
              ? '松开以添加附件'
              : external
                ? `发到 ${channel.name}，或输入 / 执行命令`
                : `给 ${agent?.name ?? '智能体'} 发消息，或输入 / 执行命令`
          }
          aria-label="消息"
          aria-autocomplete="list"
          aria-controls={completing ? `commands-${channel.id}` : undefined}
          aria-activedescendant={completing && suggestions.length ? `command-${channel.id}-${selected}` : undefined}
        />
        <FileChooser
          ref={imagePicker}
          accept="image/*"
          label="选择图片"
          disabled={Boolean(blocked) || sending}
          onFiles={(files) => addFiles(files)}
        />
        <FileChooser
          ref={filePicker}
          label="选择文件"
          disabled={Boolean(blocked) || sending}
          onFiles={(files) => addFiles(files)}
        />
        <Pressable
          type="button"
          className={styles.attach}
          disabled={Boolean(blocked) || sending}
          aria-label="添加图片"
          title="添加图片（也可粘贴或拖入，合计不超过 64 MiB）"
          onClick={() => imagePicker.current?.click()}
        >
          <ImagePlus aria-hidden="true" />
        </Pressable>
        <Pressable
          type="button"
          className={styles.attach}
          disabled={Boolean(blocked) || sending}
          aria-label="添加文件"
          title="添加文件（也可粘贴或拖入，合计不超过 64 MiB）"
          onClick={() => filePicker.current?.click()}
        >
          <FilePlus2 aria-hidden="true" />
        </Pressable>
        <Pressable
          type="submit"
          className={styles.send}
          disabled={Boolean(blocked) || (!draft.trim() && !attachments.length) || sending || incomplete}
          aria-label="发送"
          title={incomplete ? '请完成上传或移除未完成的附件' : '发送'}
        >
          <ArrowRight aria-hidden="true" />
        </Pressable>
      </div>
    </form>
  )
}

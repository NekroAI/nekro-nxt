import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { mergeRegister } from '@lexical/utils'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  DecoratorNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type EditorState,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import { Hash, PackageOpen, UserRound } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'
import {
  ChannelIdSchema,
  ExtensionIdSchema,
  PlatformIdentityIdSchema,
  normalizePromptDocument,
  promptDocumentPlainText,
  type HostApiResponse,
  type PromptDocumentV1,
  type PromptSegment,
} from '@nekro-nxt/contracts'
import { useProductStore } from '../product-store.js'
import { Button, Enter, Presence, Tooltip } from '../ui-kit/index.js'
import styles from './prompt-reference-editor.module.css'

type ReferenceSegment = Extract<PromptSegment, { type: 'reference' }>
type ReferenceKind = ReferenceSegment['kind']
type PlatformUser = HostApiResponse<'listPlatformUsers'>['items'][number]

type SerializedReferenceNode = Spread<
  {
    readonly kind: ReferenceKind
    readonly targetId: string
    readonly labelSnapshot: string
  },
  SerializedLexicalNode
>

interface ReferenceResolutionContextValue {
  readonly currentAgentId: string | undefined
  readonly knownUsers: ReadonlyMap<string, PlatformUser>
  readonly resolvedUserIds: ReadonlySet<string>
}

const ReferenceResolutionContext = createContext<ReferenceResolutionContextValue>({
  currentAgentId: undefined,
  knownUsers: new Map(),
  resolvedUserIds: new Set(),
})

const referenceKindLabel: Record<ReferenceKind, string> = {
  'platform-user': '平台用户',
  channel: '频道',
  extension: '扩展',
}

function ReferenceChip({
  kind,
  targetId,
  labelSnapshot,
}: {
  readonly kind: ReferenceKind
  readonly targetId: string
  readonly labelSnapshot: string
}) {
  const { currentAgentId, knownUsers, resolvedUserIds } = useContext(ReferenceResolutionContext)
  const channels = useProductStore((state) => state.channels)
  const extensions = useProductStore((state) => state.extensions)
  let label = labelSnapshot
  let detail = referenceKindLabel[kind]
  let invalid = false
  if (kind === 'platform-user') {
    const user = knownUsers.get(targetId)
    if (user) {
      label = user.displayName?.trim() || labelSnapshot
      detail = `${referenceKindLabel[kind]} · ${user.adapter.displayName} · ${user.connection.displayName}`
    } else {
      invalid = resolvedUserIds.has(targetId)
    }
  } else if (kind === 'channel') {
    const channel = channels.find((item) => item.id === targetId)
    if (channel) {
      label = channel.name
      detail = `${referenceKindLabel[kind]} · ${channel.connectionName}`
    } else invalid = true
  } else {
    const extension = extensions.find((item) => item.id === targetId)
    if (extension) {
      label = extension.name
      const active = currentAgentId
        ? extension.activations.some((activation) => activation.agentId === currentAgentId)
        : false
      detail = `${referenceKindLabel[kind]} · ${active ? '已启用' : '未启用'}`
    } else invalid = true
  }
  if (invalid) detail = `已失效的${kind === 'platform-user' ? '用户' : kind === 'channel' ? '频道' : '扩展'}`
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className={styles.referenceChip} data-invalid={invalid ? '' : undefined} contentEditable={false}>
          @{label}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6}>{detail}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

class ReferenceNode extends DecoratorNode<ReactElement> {
  __kind: ReferenceKind
  __targetId: string
  __labelSnapshot: string

  static override getType(): string {
    return 'nxt-reference'
  }

  static override clone(node: ReferenceNode): ReferenceNode {
    return new ReferenceNode(node.__kind, node.__targetId, node.__labelSnapshot, node.__key)
  }

  static override importJSON(serialized: SerializedReferenceNode): ReferenceNode {
    return new ReferenceNode(serialized.kind, serialized.targetId, serialized.labelSnapshot)
  }

  constructor(kind: ReferenceKind, targetId: string, labelSnapshot: string, key?: NodeKey) {
    super(key)
    this.__kind = kind
    this.__targetId = targetId
    this.__labelSnapshot = labelSnapshot
  }

  override createDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = styles.referenceNode
    return element
  }

  override updateDOM(): false {
    return false
  }

  override isInline(): true {
    return true
  }

  override getTextContent(): string {
    return `@${this.__labelSnapshot}`
  }

  override exportJSON(): SerializedReferenceNode {
    return {
      type: 'nxt-reference',
      version: 1,
      kind: this.__kind,
      targetId: this.__targetId,
      labelSnapshot: this.__labelSnapshot,
    }
  }

  override decorate(): ReactElement {
    return <ReferenceChip kind={this.__kind} targetId={this.__targetId} labelSnapshot={this.__labelSnapshot} />
  }
}

const $isReferenceNode = (node: LexicalNode | null | undefined): node is ReferenceNode => node instanceof ReferenceNode
const createReferenceSegment = (kind: ReferenceKind, targetId: string, labelSnapshot: string): ReferenceSegment => {
  if (kind === 'platform-user') {
    return { type: 'reference', kind, targetId: PlatformIdentityIdSchema.parse(targetId), labelSnapshot }
  }
  if (kind === 'channel') {
    return { type: 'reference', kind, targetId: ChannelIdSchema.parse(targetId), labelSnapshot }
  }
  return { type: 'reference', kind, targetId: ExtensionIdSchema.parse(targetId), labelSnapshot }
}

const $createReferenceNode = (reference: ReferenceSegment): ReferenceNode =>
  new ReferenceNode(reference.kind, reference.targetId, reference.labelSnapshot)

const appendDocumentToRoot = (document: PromptDocumentV1): void => {
  const root = $getRoot()
  root.clear()
  let paragraph = $createParagraphNode()
  root.append(paragraph)
  for (const segment of document.segments) {
    if (segment.type === 'reference') {
      paragraph.append($createReferenceNode(segment))
      continue
    }
    const lines = segment.text.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) {
        paragraph = $createParagraphNode()
        root.append(paragraph)
      }
      if (line) paragraph.append($createTextNode(line))
    })
  }
}

const documentFromEditorState = (state: EditorState): PromptDocumentV1 =>
  state.read(() => {
    const segments: PromptSegment[] = []
    const appendText = (text: string): void => {
      if (!text) return
      const last = segments.at(-1)
      if (last?.type === 'text') segments[segments.length - 1] = { type: 'text', text: last.text + text }
      else segments.push({ type: 'text', text })
    }
    const visit = (node: LexicalNode): void => {
      if ($isReferenceNode(node)) {
        segments.push(createReferenceSegment(node.__kind, node.__targetId, node.__labelSnapshot))
      } else if ($isTextNode(node)) appendText(node.getTextContent())
      else if ($isLineBreakNode(node)) appendText('\n')
      else if ($isElementNode(node)) node.getChildren().forEach(visit)
    }
    const children = $getRoot().getChildren()
    children.forEach((child, index) => {
      if (index > 0) appendText('\n')
      visit(child)
    })
    return normalizePromptDocument({ version: 1, segments })
  })

interface Candidate {
  readonly kind: ReferenceKind
  readonly targetId: string
  readonly label: string
  readonly detail: string
}

interface TriggerState {
  readonly nodeKey: NodeKey
  readonly start: number
  readonly length: number
  readonly query: string
  readonly top: number
  readonly left: number
  readonly originX: number
  readonly placement: 'above' | 'below'
}

const REFERENCE_MENU_ESTIMATED_HEIGHT = 334
const REFERENCE_MENU_GAP = 6
const REFERENCE_MENU_VIEWPORT_MARGIN = 8

function EditorController({
  value,
  onChange,
  wrapperRef,
  candidates,
  category,
  setCategory,
  setQuery,
}: {
  readonly value: PromptDocumentV1
  readonly onChange: (document: PromptDocumentV1, plainText: string) => void
  readonly wrapperRef: RefObject<HTMLDivElement>
  readonly candidates: readonly Candidate[]
  readonly category: 'all' | ReferenceKind
  readonly setCategory: (category: 'all' | ReferenceKind) => void
  readonly setQuery: (query: string) => void
}) {
  const [editor] = useLexicalComposerContext()
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const composing = useRef(false)
  const lastEmitted = useRef(JSON.stringify(value))

  const inspectTrigger = useCallback(
    (state: EditorState) => {
      state.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed() || composing.current) {
          setTrigger(null)
          return
        }
        const node = selection.anchor.getNode()
        if (!$isTextNode(node)) {
          setTrigger(null)
          return
        }
        const offset = selection.anchor.offset
        const before = node.getTextContent().slice(0, offset)
        const match = /(?:^|\s)@([^\s@]*)$/u.exec(before)
        if (!match) {
          setTrigger(null)
          return
        }
        const wrapper = wrapperRef.current
        const domSelection = window.getSelection()
        if (!wrapper || !domSelection || domSelection.rangeCount === 0) return
        const range = domSelection.getRangeAt(0).cloneRange()
        const rect = range.getBoundingClientRect()
        const wrapperRect = wrapper.getBoundingClientRect()
        const query = match[1] ?? ''
        const viewportHeight = window.innerHeight
        const menuHeight = Math.min(
          REFERENCE_MENU_ESTIMATED_HEIGHT,
          Math.max(0, viewportHeight - REFERENCE_MENU_VIEWPORT_MARGIN * 2),
        )
        const hasRoomBelow =
          rect.bottom + REFERENCE_MENU_GAP + menuHeight <= viewportHeight - REFERENCE_MENU_VIEWPORT_MARGIN
        const preferredViewportTop = hasRoomBelow
          ? rect.bottom + REFERENCE_MENU_GAP
          : rect.top - REFERENCE_MENU_GAP - menuHeight
        const viewportTop = Math.max(
          REFERENCE_MENU_VIEWPORT_MARGIN,
          Math.min(preferredViewportTop, viewportHeight - REFERENCE_MENU_VIEWPORT_MARGIN - menuHeight),
        )
        const left = Math.max(8, Math.min(rect.left - wrapperRect.left, wrapperRect.width - 320))
        const menuWidth = Math.min(360, Math.max(0, wrapperRect.width - 16))
        setTrigger({
          nodeKey: node.getKey(),
          start: offset - query.length - 1,
          length: query.length + 1,
          query,
          top: viewportTop - wrapperRect.top,
          left,
          originX: Math.max(16, Math.min(rect.left - wrapperRect.left - left, Math.max(16, menuWidth - 16))),
          placement: hasRoomBelow ? 'below' : 'above',
        })
        setQuery(query)
      })
    },
    [setQuery, wrapperRef],
  )

  const choose = useCallback(
    (candidate: Candidate) => {
      if (!trigger) return
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const node = selection.anchor.getNode()
        if (!$isTextNode(node) || node.getKey() !== trigger.nodeKey) return
        node.spliceText(trigger.start, trigger.length, '', true)
        selection.insertNodes([
          $createReferenceNode(createReferenceSegment(candidate.kind, candidate.targetId, candidate.label)),
          $createTextNode(' '),
        ])
      })
      setTrigger(null)
    },
    [editor, trigger],
  )

  useEffect(() => {
    const signature = JSON.stringify(value)
    if (signature === lastEmitted.current) return
    lastEmitted.current = signature
    editor.update(() => appendDocumentToRoot(value), { tag: 'external-prompt-document' })
  }, [editor, value])

  useEffect(
    () =>
      mergeRegister(
        editor.registerRootListener((root, previous) => {
          previous?.removeEventListener('compositionstart', onCompositionStart)
          previous?.removeEventListener('compositionend', onCompositionEnd)
          root?.addEventListener('compositionstart', onCompositionStart)
          root?.addEventListener('compositionend', onCompositionEnd)
        }),
        editor.registerCommand(
          KEY_ARROW_DOWN_COMMAND,
          (event) => {
            if (!trigger || candidates.length === 0 || composing.current) return false
            event?.preventDefault()
            setActiveIndex((index) => (index + 1) % candidates.length)
            return true
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ARROW_UP_COMMAND,
          (event) => {
            if (!trigger || candidates.length === 0 || composing.current) return false
            event?.preventDefault()
            setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length)
            return true
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event) => {
            if (!trigger || !candidates[activeIndex] || composing.current) return false
            event?.preventDefault()
            choose(candidates[activeIndex])
            return true
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_TAB_COMMAND,
          (event) => {
            if (!trigger || !candidates[activeIndex] || composing.current) return false
            event?.preventDefault()
            choose(candidates[activeIndex])
            return true
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ESCAPE_COMMAND,
          (event) => {
            if (!trigger) return false
            event?.preventDefault()
            setTrigger(null)
            return true
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_BACKSPACE_COMMAND,
          () => {
            const selection = $getSelection()
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
            const node = selection.anchor.getNode()
            if (!$isTextNode(node) || selection.anchor.offset !== 0) return false
            const previous = node.getPreviousSibling()
            if (!$isReferenceNode(previous)) return false
            previous.remove()
            return true
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [activeIndex, candidates, choose, editor, trigger],
  )

  useEffect(() => setActiveIndex(0), [category, trigger?.query])

  const onCompositionStart = (): void => {
    composing.current = true
  }
  const onCompositionEnd = (): void => {
    composing.current = false
    inspectTrigger(editor.getEditorState())
  }

  return (
    <>
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state, _editor, tags) => {
          if (!tags.has('external-prompt-document')) {
            const document = documentFromEditorState(state)
            lastEmitted.current = JSON.stringify(document)
            onChange(document, promptDocumentPlainText(document))
          }
          inspectTrigger(state)
        }}
      />
      <Presence>
        {trigger ? (
          <Enter
            key="reference-menu"
            kind="popover"
            className={styles.referenceMenu}
            style={{
              top: trigger.top,
              left: trigger.left,
              transformOrigin: `${trigger.originX}px ${trigger.placement === 'below' ? 'top' : 'bottom'}`,
            }}
            data-reference-menu-placement={trigger.placement}
            role="listbox"
            aria-label="可引用对象"
            aria-activedescendant={candidates[activeIndex] ? `prompt-reference-${activeIndex}` : undefined}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className={styles.referenceCategories} aria-label="引用分类">
              {(
                [
                  ['all', '全部'],
                  ['platform-user', '用户'],
                  ['channel', '频道'],
                  ['extension', '扩展'],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="small"
                  variant="ghost"
                  data-active={category === key ? '' : undefined}
                  onClick={() => setCategory(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className={styles.referenceOptions}>
              {candidates.length > 0 ? (
                candidates.map((candidate, index) => {
                  const Icon =
                    candidate.kind === 'platform-user' ? UserRound : candidate.kind === 'channel' ? Hash : PackageOpen
                  return (
                    <Button
                      id={`prompt-reference-${index}`}
                      type="button"
                      size="small"
                      variant="ghost"
                      role="option"
                      aria-selected={activeIndex === index}
                      data-active={activeIndex === index ? '' : undefined}
                      key={`${candidate.kind}:${candidate.targetId}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(candidate)}
                    >
                      <Icon size={15} aria-hidden="true" />
                      <span>
                        <strong>{candidate.label}</strong>
                        <small>{candidate.detail}</small>
                      </span>
                    </Button>
                  )
                })
              ) : (
                <p>没有匹配的可引用对象。</p>
              )}
            </div>
          </Enter>
        ) : null}
      </Presence>
    </>
  )
}

export function PromptReferenceEditor({
  value,
  onChange,
  currentAgentId,
  label = '人设',
  description = '引用会将所选对象加入人设。',
  placeholder,
}: {
  readonly value: PromptDocumentV1
  readonly onChange: (document: PromptDocumentV1, plainText: string) => void
  readonly currentAgentId?: string
  readonly label?: string
  readonly description?: string
  readonly placeholder?: string
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const channels = useProductStore((state) => state.channels)
  const connections = useProductStore((state) => state.connections)
  const extensions = useProductStore((state) => state.extensions)
  const [knownUsers, setKnownUsers] = useState<ReadonlyMap<string, PlatformUser>>(new Map())
  const [resolvedUserIds, setResolvedUserIds] = useState<ReadonlySet<string>>(new Set())
  const [userCandidates, setUserCandidates] = useState<readonly PlatformUser[]>([])
  const [category, setCategory] = useState<'all' | ReferenceKind>('all')
  const [query, setQuery] = useState('')
  const fieldId = useMemo(() => `prompt-reference-${crypto.randomUUID()}`, [])
  const descriptionId = `${fieldId}-description`

  const userReferences = useMemo(
    () =>
      value.segments.filter(
        (segment): segment is ReferenceSegment => segment.type === 'reference' && segment.kind === 'platform-user',
      ),
    [value],
  )
  const userReferenceSignature = userReferences
    .map((reference) => `${reference.targetId}:${reference.labelSnapshot}`)
    .join('|')

  useEffect(() => {
    let active = true
    void Promise.all(
      userReferences.map(async (reference) => {
        const result = await useProductStore
          .getState()
          .listPlatformUsers({ query: reference.labelSnapshot, limit: 100 })
        return { reference, user: result.items.find((item) => item.identityId === reference.targetId) }
      }),
    )
      .then((results) => {
        if (!active) return
        setKnownUsers((current) => {
          const next = new Map(current)
          for (const result of results) if (result?.user) next.set(result.reference.targetId, result.user)
          return next
        })
        setResolvedUserIds((current) => {
          const next = new Set(current)
          userReferences.forEach((reference) => next.add(reference.targetId))
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [userReferenceSignature])

  useEffect(() => {
    if (category !== 'all' && category !== 'platform-user') return
    let active = true
    const timer = window.setTimeout(() => {
      void useProductStore
        .getState()
        .listPlatformUsers({ ...(query ? { query } : {}), limit: 30 })
        .then((result) => {
          if (!active) return
          setUserCandidates(result.items)
          setKnownUsers(
            (current) => new Map([...current, ...result.items.map((item) => [item.identityId, item] as const)]),
          )
        })
        .catch(() => undefined)
    }, 160)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [category, query])

  const candidates = useMemo<readonly Candidate[]>(() => {
    const normalized = query.toLocaleLowerCase('zh-CN')
    const include = (label: string): boolean => !normalized || label.toLocaleLowerCase('zh-CN').includes(normalized)
    const users = userCandidates.map((user) => ({
      kind: 'platform-user' as const,
      targetId: user.identityId,
      label: user.displayName?.trim() || '未命名用户',
      detail: `${user.adapter.displayName} · ${user.connection.displayName}${user.historicalOnly ? ' · 仅历史记录' : ''}`,
    }))
    const channelItems = channels
      .filter((channel) => include(channel.name))
      .map((channel) => {
        const connection = connections.find((item) => item.id === channel.connectionId)
        return {
          kind: 'channel' as const,
          targetId: channel.id,
          label: channel.name,
          detail: `${connection?.adapter ?? '已移除的适配器'} · ${channel.connectionName}`,
        }
      })
    const extensionItems = extensions
      .filter((extension) => include(extension.name))
      .map((extension) => ({
        kind: 'extension' as const,
        targetId: extension.id,
        label: extension.name,
        detail:
          currentAgentId && extension.activations.some((activation) => activation.agentId === currentAgentId)
            ? '已启用'
            : '未启用',
      }))
    if (category === 'platform-user') return users
    if (category === 'channel') return channelItems
    if (category === 'extension') return extensionItems
    return [...users, ...channelItems, ...extensionItems]
  }, [category, channels, connections, currentAgentId, extensions, query, userCandidates])

  const initialConfig = useMemo(
    () => ({
      namespace: fieldId,
      nodes: [ReferenceNode],
      onError(error: Error) {
        throw error
      },
      editorState: () => appendDocumentToRoot(value),
      theme: {
        paragraph: styles.paragraph,
      },
    }),
    [],
  )

  return (
    <div className={styles.field}>
      <label id={`${fieldId}-label`} htmlFor={fieldId}>
        {label}
      </label>
      <p id={descriptionId}>{description}</p>
      <ReferenceResolutionContext.Provider value={{ currentAgentId, knownUsers, resolvedUserIds }}>
        <LexicalComposer initialConfig={initialConfig}>
          <div className={styles.editorFrame} ref={wrapperRef}>
            <RichTextPlugin
              contentEditable={
                <ContentEditable
                  id={fieldId}
                  className={styles.editor}
                  role="textbox"
                  aria-multiline="true"
                  aria-labelledby={`${fieldId}-label`}
                  aria-describedby={descriptionId}
                />
              }
              placeholder={placeholder ? <div className={styles.placeholder}>{placeholder}</div> : null}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <EditorController
              value={value}
              onChange={onChange}
              wrapperRef={wrapperRef}
              candidates={candidates}
              category={category}
              setCategory={setCategory}
              setQuery={setQuery}
            />
          </div>
        </LexicalComposer>
      </ReferenceResolutionContext.Provider>
    </div>
  )
}

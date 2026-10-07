import { callHostApi } from './host-api-client.js'
import { deletePath, getPath, rehydrateSchema, setPath, validateDraft, type SchemaNode } from './settings-schema.js'
import type { HostApiRequest, HostApiResponse } from '@nekro-nxt/contracts'
import {
  DshCredentialsChangedSseDataSchema,
  DshPluginOperationSseDataSchema,
  DshSettingsChangedSseDataSchema,
  HostApiContracts,
  JsonValueSchema,
  parseJsonValue,
} from '@nekro-nxt/contracts'
import { ChevronDown, ChevronUp, Download, KeyRound, Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useProductRuntime, useProductStore } from './product-runtime.js'
import { useUnsavedDraft } from './unsaved-drafts.js'
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Diagnostics,
  Dialog,
  EmptyState,
  Field,
  FileChooser,
  InfoTip,
  Input,
  ObjectHeader,
  PropertyGroup,
  SecretInput,
  Select,
  Skeleton,
  SwitchRow,
  Textarea,
  toast,
  type Tone,
} from './ui-kit/index.js'
import styles from './dsh-extension-settings.module.css'

type DshPluginCatalogEntry = HostApiResponse<'dshPlugins'>['plugins'][number]
type DshPluginEntry = NonNullable<DshPluginCatalogEntry['entries']>[number]
type DshPluginConfigInspection = HostApiResponse<'inspectDshPluginEntryConfig'>
type DshSettingsNamespaceView = HostApiResponse<'dshSettings'>['namespaces'][number]
type DshCredentialView = HostApiResponse<'dshCredentialsDescribe'>['credentials'][string]
type DshSettingsPathOperation = HostApiRequest<'dshSettingsMutate'>['ops'][number]

export interface DshSettingsCatalogEntry {
  readonly id: string
  readonly label: string
  readonly version: string
  /** Built-in, user-installed, or registered by the runtime without an owning plugin. */
  readonly group: 'builtin' | 'installed' | 'runtime'
  readonly namespaces: readonly DshSettingsNamespaceView[]
  readonly plugin?: DshPluginCatalogEntry
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const failure = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const parseDshSettingsChangedEvent = (text: string) => {
  try {
    return DshSettingsChangedSseDataSchema.parse(parseJsonValue(JSON.parse(text)))
  } catch {
    return undefined
  }
}

const parseDshCredentialsChangedEvent = (text: string) => {
  try {
    return DshCredentialsChangedSseDataSchema.parse(parseJsonValue(JSON.parse(text)))
  } catch {
    return undefined
  }
}

export const DSH_GROUP_LABEL: Record<DshSettingsCatalogEntry['group'], string> = {
  builtin: '内置',
  installed: '用户安装',
  runtime: '其他扩展',
}

const pluginGroup = (origin: DshPluginCatalogEntry['origin']): DshSettingsCatalogEntry['group'] =>
  origin === 'builtin' ? 'builtin' : 'installed'

/** State shown next to an entry in lists and headers. */
export const dshEntryStatus = (entry: DshSettingsCatalogEntry): { readonly label: string; readonly tone: Tone } =>
  entry.plugin?.loadError
    ? { label: '加载失败', tone: 'bad' }
    : entry.plugin?.entries?.some((item) => item.activations.length > 0)
      ? { label: '已启用', tone: 'ok' }
      : { label: DSH_GROUP_LABEL[entry.group], tone: 'neutral' }

const packageLabel = (name: string): string => {
  if (name === '@deepseek-ai/dsh-web-search-deepseek') return 'DeepSeek 网页搜索'
  if (name === '@deepseek-ai/dsh-agent-loop') return '思考与工具执行运行时'
  if (name === '@deepseek-ai/dsh-bash-sandbox') return '命令运行时'
  if (name === '@deepseek-ai/dsh-llm-pi-ai') return '模型供应商运行时'
  if (name === '@deepseek-ai/dsh-subagent') return '子智能体运行时'
  if (name === '@deepseek-ai/dsh-subagent-spawn-in-process') return '子智能体进程内启动'
  if (name === '@deepseek-ai/dsh-tool-subagent') return '子智能体委派工具'
  if (name === '@deepseek-ai/dsh-tool-subagent-control') return '子智能体控制工具'
  if (name.includes('llm-deepseek')) return 'DeepSeek 模型凭据'
  if (name.includes('subagent')) return '子智能体组件'
  if (name.includes('cordis-host-runner')) return '动态扩展运行组件'
  if (name.includes('compaction-tool-result-pruner')) return '工具结果裁剪'
  if (name.includes('llm-retry')) return '模型请求重试'
  if (name.includes('timeout-policy')) return '工具超时控制'
  if (name.includes('spill-policy')) return '大型结果持久化'
  if (name.includes('tool-web')) return '网页工具'
  if (name.endsWith('/dsh-web')) return '网页能力运行时'
  // Third-party packages keep their full name: it is the only identity their author gave them.
  return name.startsWith('@deepseek-ai/') ? name.slice('@deepseek-ai/'.length).replace(/^dsh-/u, '') : name
}

/** Common configuration keys shown with readable titles; the raw key stays in the field's tooltip. */
const KNOWN_FIELD_TITLES: Readonly<Record<string, string>> = {
  apiKey: 'API 密钥',
  apiKeyEnv: '凭据名称',
  baseURL: '接口地址',
  baseUrl: '接口地址',
  model: '模型',
  apiVersion: 'API 版本',
  maxTokens: '单次生成上限',
  maxUses: '每次请求最多搜索次数',
  maxResults: '最多返回条数',
  timeout: '超时',
  timeoutMs: '超时（毫秒）',
  enabled: '启用',
}

const fieldDescription = (node: SchemaNode): string | undefined => {
  const description = node.meta?.description
  if (typeof description === 'string') return description
  if (description && typeof description['zh'] === 'string') return description['zh']
  if (description && typeof description['zh-CN'] === 'string') return description['zh-CN']
  return node.meta?.comment
}

/** A readable title: a short description, a known key, or the key itself as a last resort. */
const fieldTitle = (name: string, node: SchemaNode): string => {
  const description = fieldDescription(node)
  if (description && [...description].length <= 16) return description
  return KNOWN_FIELD_TITLES[name] ?? name
}

const fieldHint = (name: string, node: SchemaNode): ReactNode => {
  const description = fieldDescription(node)
  const shown = description && description !== fieldTitle(name, node) ? description : undefined
  const badges = node.meta?.badges ?? []
  const link = node.meta?.link
  if (!shown && badges.length === 0 && !link) return undefined
  return (
    <span className={styles.hintMeta}>
      {shown ? <span>{shown}</span> : null}
      {badges.map((badge) => (
        <span className={styles.schemaBadge} data-type={badge.type} key={`${badge.type}:${badge.text}`}>
          {badge.text}
        </span>
      ))}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer">
          查看说明
        </a>
      ) : null}
    </span>
  )
}

const pathKey = (path: readonly string[]): string => path.join('\u0000')

const defaultValueForNode = (node: SchemaNode): unknown => {
  if (node.meta?.default !== undefined) return node.meta.default
  if (node.type === 'string') return ''
  if (node.type === 'number') return node.meta?.min ?? 0
  if (node.type === 'boolean') return false
  if (node.type === 'array' || node.type === 'tuple') return []
  if (node.type === 'object' || node.type === 'dict') return {}
  if (node.type === 'const') return node.value
  return null
}

const displayConstValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

const schemaChoiceLabel = (node: SchemaNode, index: number): string => {
  const description = fieldDescription(node)
  if (description) return description
  if (node.type === 'const') return displayConstValue(node.value)
  return `选项 ${index + 1}`
}

const containsSecretNode = (root: SchemaNode): boolean => {
  const seen = new Set<SchemaNode>()
  const visit = (node: SchemaNode): boolean => {
    if (seen.has(node)) return false
    seen.add(node)
    if (node.meta?.role === 'secret') return true
    if (node.inner && visit(node.inner)) return true
    if (node.list?.some(visit)) return true
    return Object.values(node.dict ?? {}).some(visit)
  }
  return visit(root)
}

const mergeSettingsLayers = (base: unknown, user: unknown): unknown => {
  if (!isRecord(base) || !isRecord(user)) return user === undefined ? base : user
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(user)) result[key] = mergeSettingsLayers(result[key], value)
  return result
}

const applySettingsOps = (user: unknown, ops: ReadonlyMap<string, DshSettingsPathOperation>): unknown => {
  let result: unknown = isRecord(user) ? { ...user } : {}
  for (const operation of ops.values()) {
    result =
      operation.op === 'set' ? setPath(result, operation.path, operation.value) : deletePath(result, operation.path)
  }
  return result
}

// —— 通用 Schema 字段 ——

interface GenericFieldProps {
  readonly name: string
  readonly node: SchemaNode
  readonly path: readonly string[]
  readonly value: unknown
  readonly disabled: boolean
  readonly onSet: (path: readonly string[], value: unknown) => void
  readonly onUnset: (path: readonly string[]) => void
}

/** Label + control + inherited-value reset, with the label bound to the control itself. */
function SchemaControl({
  name,
  node,
  disabled,
  onReset,
  children,
}: {
  readonly name: string
  readonly node: SchemaNode
  readonly disabled: boolean
  readonly onReset?: () => void
  readonly children: (id: string) => ReactNode
}) {
  const id = useId()
  const hint = fieldHint(name, node)
  return (
    <div className={styles.control}>
      <label className={styles.controlLabel} htmlFor={id} title={name}>
        {fieldTitle(name, node)}
      </label>
      <div className={styles.controlRow}>
        {children(id)}
        {onReset ? (
          <Button
            size="small"
            variant="ghost"
            icon={<RotateCcw size={13} aria-hidden="true" />}
            disabled={disabled}
            onClick={onReset}
          >
            恢复
          </Button>
        ) : null}
      </div>
      {hint ? <span className={styles.controlHint}>{hint}</span> : null}
    </div>
  )
}

function SchemaGroup({
  name,
  node,
  disabled,
  children,
}: {
  readonly name: string
  readonly node: SchemaNode
  readonly disabled: boolean
  readonly children: ReactNode
}) {
  const hint = fieldHint(name, node)
  if (node.meta?.collapse) {
    return (
      <details className={styles.group}>
        <summary className={styles.groupTitle} title={name}>
          {fieldTitle(name, node)}
        </summary>
        {hint ? <p className={styles.controlHint}>{hint}</p> : null}
        <div className={styles.groupBody} aria-disabled={disabled}>
          {children}
        </div>
      </details>
    )
  }
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className={styles.groupTitle} title={name}>
        {fieldTitle(name, node)}
      </legend>
      {hint ? <p className={styles.controlHint}>{hint}</p> : null}
      <div className={styles.groupBody}>{children}</div>
    </fieldset>
  )
}

function JsonField(props: GenericFieldProps) {
  const { name, node, path, value, disabled, onSet, onUnset } = props
  const secret = containsSecretNode(node)
  const [text, setText] = useState(() => JSON.stringify(value ?? defaultValueForNode(node), null, 2))
  const [error, setError] = useState('')
  if (secret) {
    return (
      <Banner tone="warn">
        “{fieldTitle(name, node)}”包含只写 Secret，无法安全拆分编辑；已禁止整体替换，避免清除或回显已保存的值。
      </Banner>
    )
  }
  return (
    <div className={styles.jsonField}>
      <Field
        label={fieldTitle(name, node)}
        hint={<>Schema 类型“{node.type}”使用高级 JSON 配置。</>}
        error={error || undefined}
      >
        <Textarea value={text} disabled={disabled} rows={6} onChange={(event) => setText(event.currentTarget.value)} />
      </Field>
      <div className={styles.inlineActions}>
        <Button
          size="small"
          disabled={disabled}
          onClick={() => {
            try {
              onSet(path, parseJsonValue(JSON.parse(text)))
              setError('')
            } catch (cause) {
              setError(failure(cause))
            }
          }}
        >
          应用 JSON 草稿
        </Button>
        <Button size="small" variant="ghost" disabled={disabled} onClick={() => onUnset(path)}>
          恢复继承值
        </Button>
      </div>
    </div>
  )
}

function DictField({ name, node, path, value, disabled, onSet, onUnset }: GenericFieldProps) {
  const [draftKey, setDraftKey] = useState('')
  const entries = isRecord(value) ? value : {}
  const inner = node.inner
  const newKey = draftKey.trim()
  const canAddKey = !disabled && newKey !== '' && !Object.prototype.hasOwnProperty.call(entries, newKey)
  if (!inner) return null
  const replaceKey = (currentKey: string, nextKey: string): void => {
    if (!nextKey || nextKey === currentKey || Object.prototype.hasOwnProperty.call(entries, nextKey)) return
    onSet(
      path,
      Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key === currentKey ? nextKey : key, entry])),
    )
  }
  return (
    <SchemaGroup name={name} node={node} disabled={disabled}>
      {Object.entries(entries).map(([key, entry]) => (
        <div className={styles.collectionRow} key={key}>
          <Field label="键名">
            <Input
              defaultValue={key}
              disabled={disabled}
              onBlur={(event) => replaceKey(key, event.currentTarget.value.trim())}
            />
          </Field>
          <GenericField
            name={key}
            node={inner}
            path={[...path, key]}
            value={entry}
            disabled={disabled}
            onSet={onSet}
            onUnset={onUnset}
          />
          <div className={styles.inlineActions}>
            <Button
              size="small"
              variant="danger"
              disabled={disabled}
              onClick={() =>
                onSet(path, Object.fromEntries(Object.entries(entries).filter(([entryKey]) => entryKey !== key)))
              }
            >
              删除此键
            </Button>
          </div>
        </div>
      ))}
      <div className={styles.addRow}>
        <Field label="新键名">
          <Input value={draftKey} disabled={disabled} onChange={(event) => setDraftKey(event.currentTarget.value)} />
        </Field>
        <Button
          size="small"
          icon={<Plus size={13} aria-hidden="true" />}
          disabled={!canAddKey}
          onClick={() => {
            const key = draftKey.trim()
            if (!key) return
            onSet(path, { ...entries, [key]: defaultValueForNode(inner) })
            setDraftKey('')
          }}
        >
          添加键值
        </Button>
      </div>
    </SchemaGroup>
  )
}

function GenericField(props: GenericFieldProps): ReactNode {
  const { name, node, path, value, disabled, onSet, onUnset } = props
  if (node.meta?.hidden) return null
  const locked = disabled || node.meta?.disabled === true

  if (node.type === 'object') {
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {Object.entries(node.dict ?? {}).map(([key, child]) => (
          <GenericField
            key={key}
            name={key}
            node={child}
            path={[...path, key]}
            value={isRecord(value) ? value[key] : undefined}
            disabled={locked}
            onSet={onSet}
            onUnset={onUnset}
          />
        ))}
      </SchemaGroup>
    )
  }

  if (node.type === 'string') {
    const role = node.meta?.role
    return (
      <SchemaControl name={name} node={node} disabled={locked} onReset={() => onUnset(path)}>
        {(id) =>
          role === 'textarea' ? (
            <Textarea
              id={id}
              value={typeof value === 'string' ? value : ''}
              required={node.meta?.required}
              disabled={locked}
              rows={5}
              onChange={(event) => onSet(path, event.currentTarget.value)}
            />
          ) : (
            <Input
              id={id}
              type={role === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              value={typeof value === 'string' ? value : ''}
              placeholder={role === 'secret' ? '输入新值；已保存的值无法查看' : undefined}
              pattern={node.meta?.pattern?.source}
              required={node.meta?.required}
              disabled={locked}
              spellCheck={false}
              onChange={(event) => onSet(path, event.currentTarget.value)}
            />
          )
        }
      </SchemaControl>
    )
  }

  if (node.type === 'number') {
    return (
      <SchemaControl name={name} node={node} disabled={locked} onReset={() => onUnset(path)}>
        {(id) => (
          <Input
            id={id}
            type="number"
            value={typeof value === 'number' ? value : ''}
            min={node.meta?.min}
            max={node.meta?.max}
            step={node.meta?.step}
            disabled={locked}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isFinite(next)) onSet(path, next)
            }}
          />
        )}
      </SchemaControl>
    )
  }

  if (node.type === 'boolean') {
    return (
      <SwitchRow
        title={fieldTitle(name, node)}
        description={fieldDescription(node) === fieldTitle(name, node) ? undefined : fieldDescription(node)}
        checked={value === true}
        disabled={locked}
        onCheckedChange={(checked) => onSet(path, checked)}
      />
    )
  }

  if (node.type === 'const') {
    return (
      <SchemaControl name={name} node={node} disabled={locked}>
        {(id) => <Input id={id} value={displayConstValue(node.value)} readOnly />}
      </SchemaControl>
    )
  }

  if (node.type === 'array' && node.inner) {
    const inner = node.inner
    if (containsSecretNode(inner)) {
      return (
        <Banner tone="warn">
          “{fieldTitle(name, node)}”的集合项包含只写 Secret，因此整体添加、删除和排序不可用，以免覆盖未回传的值。
        </Banner>
      )
    }
    const entries: readonly unknown[] = Array.isArray(value) ? value : []
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {entries.map((entry, index) => (
          <div className={styles.collectionRow} key={index}>
            <GenericField
              name={`第 ${index + 1} 项`}
              node={inner}
              path={[...path, String(index)]}
              value={entry}
              disabled={locked}
              onSet={onSet}
              onUnset={onUnset}
            />
            <div className={styles.inlineActions}>
              <Button
                size="small"
                variant="ghost"
                icon={<ChevronUp size={13} aria-hidden="true" />}
                disabled={locked || index === 0}
                onClick={() => {
                  const next = [...entries]
                  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                  onSet(path, next)
                }}
              >
                上移
              </Button>
              <Button
                size="small"
                variant="ghost"
                icon={<ChevronDown size={13} aria-hidden="true" />}
                disabled={locked || index === entries.length - 1}
                onClick={() => {
                  const next = [...entries]
                  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
                  onSet(path, next)
                }}
              >
                下移
              </Button>
              <Button
                size="small"
                variant="danger"
                disabled={locked}
                onClick={() => onSet(path, entries.toSpliced(index, 1))}
              >
                删除此项
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            size="small"
            icon={<Plus size={13} aria-hidden="true" />}
            disabled={locked}
            onClick={() => onSet(path, [...entries, defaultValueForNode(inner)])}
          >
            添加一项
          </Button>
        </div>
      </SchemaGroup>
    )
  }

  if (node.type === 'dict' && node.inner) {
    if (containsSecretNode(node.inner)) {
      return (
        <Banner tone="warn">
          “{fieldTitle(name, node)}”的键值包含只写 Secret，因此整体改名、添加和删除不可用，以免覆盖未回传的值。
        </Banner>
      )
    }
    return <DictField {...props} disabled={locked} />
  }

  if (node.type === 'tuple' && node.list) {
    const entries: readonly unknown[] = Array.isArray(value) ? value : []
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {node.list.map((child, index) => (
          <GenericField
            key={index}
            name={`第 ${index + 1} 项`}
            node={child}
            path={[...path, String(index)]}
            value={entries[index]}
            disabled={locked}
            onSet={onSet}
            onUnset={onUnset}
          />
        ))}
      </SchemaGroup>
    )
  }

  if (node.type === 'union' && node.list && node.list.length > 0) {
    const choices = node.list
    const matching = Math.max(
      0,
      choices.findIndex((candidate) => {
        try {
          return validateDraft(candidate, value) === undefined
        } catch {
          return false
        }
      }),
    )
    const current = choices[matching]
    return (
      <div className={styles.union}>
        <Field label={`${name}的配置类型`}>
          <Select
            value={String(matching)}
            disabled={locked}
            options={choices.map((candidate, index) => ({
              value: String(index),
              label: schemaChoiceLabel(candidate, index),
            }))}
            onValueChange={(value) => {
              const choice = choices[Number(value)]
              if (choice) onSet(path, defaultValueForNode(choice))
            }}
          />
        </Field>
        {current && current.type !== 'const' ? (
          <GenericField {...props} node={current} value={value} disabled={locked} />
        ) : null}
      </div>
    )
  }

  if (node.type === 'intersect' && node.list?.every((candidate) => candidate.type === 'object')) {
    const dict: Record<string, SchemaNode> = {}
    for (const candidate of node.list) Object.assign(dict, candidate.dict ?? {})
    return (
      <SchemaGroup name={name} node={node} disabled={locked}>
        {Object.entries(dict).map(([key, child]) => (
          <GenericField
            key={key}
            name={key}
            node={child}
            path={[...path, key]}
            value={isRecord(value) ? value[key] : undefined}
            disabled={locked}
            onSet={onSet}
            onUnset={onUnset}
          />
        ))}
      </SchemaGroup>
    )
  }

  return <JsonField {...props} disabled={locked} />
}

// —— 插件入口的启动配置 ——

function DshPluginConfigEditor({
  entry,
  inspection,
  onChange,
}: {
  readonly entry: DshPluginEntry
  readonly inspection: DshPluginConfigInspection | undefined
  readonly onChange: (value: unknown) => void
}) {
  const schema = useMemo(() => {
    if (inspection?.mode !== 'schema') return undefined
    try {
      return rehydrateSchema(inspection.schema)
    } catch {
      return undefined
    }
  }, [inspection])
  const [draft, setDraft] = useState<unknown>(entry.config)
  useEffect(() => setDraft(entry.config), [entry.config])
  if (!inspection) return null
  if (inspection.mode === 'incompatible') return <Banner tone="bad">{inspection.reason}</Banner>
  if (inspection.mode !== 'schema' || !schema) return null
  return (
    <GenericField
      name="启动配置"
      node={schema}
      path={[]}
      value={draft}
      disabled={false}
      onSet={(path, value) => {
        const next = path.length === 0 ? value : setPath(isRecord(draft) ? draft : {}, path, value)
        setDraft(next)
        onChange(next)
      }}
      onUnset={(path) => {
        const next = path.length === 0 ? {} : deletePath(isRecord(draft) ? draft : {}, path)
        setDraft(next)
        onChange(next)
      }}
    />
  )
}

// —— 凭据 ——

function CredentialEditor({ refName, onChanged }: { readonly refName: string; readonly onChanged: () => void }) {
  const [info, setInfo] = useState<DshCredentialView | null>(null)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [refocus, setRefocus] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const infoRevision = useRef(0)
  // The clear trigger is disabled once nothing is saved; hand focus to the value field instead of losing it.
  useEffect(() => {
    if (clearOpen || !refocus) return
    const timer = window.setTimeout(() => {
      input.current?.focus()
      setRefocus(false)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [clearOpen, refocus])
  const load = useCallback(async () => {
    const revision = ++infoRevision.current
    const result = await callHostApi(HostApiContracts.dshCredentialsDescribe, {}, { refs: [refName] })
    if (revision !== infoRevision.current) return
    setInfo(result.credentials[refName] ?? { configured: false, writable: false })
  }, [refName])
  useEffect(() => {
    void load().catch((cause: unknown) => setError(failure(cause)))
    return () => {
      infoRevision.current += 1
    }
  }, [load])
  const save = async (): Promise<void> => {
    if (!value || pending) return
    setPending(true)
    setError('')
    try {
      const next = await callHostApi(HostApiContracts.dshCredentialSet, { ref: refName }, { value })
      infoRevision.current += 1
      setInfo(next)
      setValue('')
      onChanged()
    } catch (cause) {
      setError(failure(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={styles.credential}>
      <div className={styles.credentialHead}>
        <KeyRound size={16} aria-hidden="true" />
        <span className={styles.credentialTitle}>
          <b>凭据</b>
          <code title="凭据名称">{refName}</code>
        </span>
        <Chip tone={info?.configured ? 'ok' : 'warn'}>{info?.configured ? '已保存' : '待配置'}</Chip>
      </div>
      <Field label="新的凭据值" tip="凭据只能覆盖，无法查看已保存的值。" error={error || undefined}>
        <SecretInput
          ref={input}
          configured={info?.configured === true}
          data-1p-ignore="true"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </Field>
      <div className={styles.inlineActions}>
        <Button
          variant="primary"
          busy={pending}
          disabled={!value || info?.writable === false}
          onClick={() => void save()}
        >
          保存凭据
        </Button>
        <Button
          variant="danger"
          disabled={pending || !info?.configured || info.writable === false}
          onClick={() => setClearOpen(true)}
        >
          清除凭据
        </Button>
      </div>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={`清除凭据“${refName}”？`}
        confirmLabel="清除该凭据"
        danger
        onConfirm={async () => {
          try {
            const next = await callHostApi(HostApiContracts.dshCredentialUnset, { ref: refName }, undefined)
            infoRevision.current += 1
            setInfo(next)
            setValue('')
            setRefocus(true)
            onChanged()
            toast('凭据已清除。', { group: `dsh-credential-clear:${refName}` })
          } catch (cause) {
            throw new Error(`清除失败：${failure(cause)}`)
          }
        }}
      >
        清除后，依赖这个凭据的功能将不可用；已保存的值无法从浏览器恢复。
      </ConfirmDialog>
    </div>
  )
}

// —— 配置区域 ——

function NamespaceEditor({
  namespace,
  onSaved,
}: {
  readonly namespace: DshSettingsNamespaceView
  readonly onSaved: () => void
}) {
  const [authority, setAuthority] = useState(namespace)
  const [ops, setOps] = useState<ReadonlyMap<string, DshSettingsPathOperation>>(() => new Map())
  useUnsavedDraft(`dsh-settings:${namespace.ns}`, ops.size > 0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const schema = useMemo(() => {
    try {
      return rehydrateSchema(namespace.schema)
    } catch {
      return undefined
    }
  }, [namespace.schema])
  useEffect(() => {
    if (namespace.ns !== authority.ns) {
      setAuthority(namespace)
      setOps(new Map())
      setError('')
      setNotice('')
      setConflict(false)
      return
    }
    if (namespace.revision !== authority.revision) {
      setAuthority(namespace)
      setConflict(ops.size > 0)
      if (ops.size === 0) setError('')
    }
  }, [namespace])
  const onSet = (path: readonly string[], value: unknown): void => {
    if (path.length === 0) {
      setError('只能逐项修改，这组配置无法整体替换。')
      return
    }
    const parsedValue = JsonValueSchema.safeParse(value)
    if (!parsedValue.success) {
      setError('修改值必须是合法 JSON。')
      return
    }
    setNotice('')
    setOps((current) => new Map(current).set(pathKey(path), { op: 'set', path: [...path], value: parsedValue.data }))
  }
  const onUnset = (path: readonly string[]): void => {
    if (path.length === 0) {
      setError('只能逐项修改，这组配置无法整体替换。')
      return
    }
    setNotice('')
    setOps((current) => new Map(current).set(pathKey(path), { op: 'unset', path: [...path] }))
  }
  const rootValue = useMemo(() => {
    if (!schema) return authority.resolved
    const user = applySettingsOps(authority.user, ops)
    try {
      return parseJsonValue(schema.parse(mergeSettingsLayers(authority.base ?? {}, user)))
    } catch {
      return mergeSettingsLayers(authority.resolved, user)
    }
  }, [authority, ops, schema])
  const save = async (): Promise<void> => {
    if (saving || ops.size === 0) return
    setSaving(true)
    setError('')
    setConflict(false)
    try {
      if (schema) {
        const validation = validateDraft(schema, rootValue)
        if (validation) throw new Error(validation)
      }
      const saved = await callHostApi(
        HostApiContracts.dshSettingsMutate,
        { namespace: authority.ns },
        { expectedRevision: authority.revision, ops: [...ops.values()] },
      )
      setAuthority(saved)
      setOps(new Map())
      setNotice(saved.applies === 'restart' ? '已保存，重启后生效。' : '已保存并实时生效。')
      onSaved()
    } catch (cause) {
      const status =
        cause instanceof Error && 'status' in cause && typeof cause.status === 'number' ? cause.status : undefined
      if (status === 409) {
        setConflict(true)
        try {
          const latest = await callHostApi(HostApiContracts.dshSettings, {}, undefined)
          const descriptor = latest.namespaces.find((item) => item.ns === authority.ns)
          if (descriptor) setAuthority(descriptor)
        } catch {
          // Keep the original conflict and draft; a later SSE refresh or save can update authority.
        }
      }
      setError(failure(cause))
    } finally {
      setSaving(false)
    }
  }
  const credentialRefs = useMemo(() => {
    if (!schema) return []
    const refs: string[] = []
    const walk = (node: SchemaNode, path: readonly string[]): void => {
      if (node.meta?.role === 'credential-ref') {
        const value = getPath(rootValue, path)
        if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) refs.push(value)
      }
      if (node.type === 'object')
        for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key])
      if (node.type === 'dict' && node.inner) {
        const current = getPath(rootValue, path)
        if (isRecord(current)) for (const key of Object.keys(current)) walk(node.inner, [...path, key])
      }
      if (node.type === 'array' && node.inner) {
        const current = getPath(rootValue, path)
        if (Array.isArray(current)) for (const index of current.keys()) walk(node.inner, [...path, String(index)])
      }
      if (node.type === 'tuple' && node.list) node.list.forEach((child, index) => walk(child, [...path, String(index)]))
    }
    walk(schema, [])
    return [...new Set(refs)]
  }, [rootValue, schema])

  return (
    <div className={styles.namespace}>
      {authority.ns === 'web-search-deepseek' ? (
        <Banner tone="warn">
          <span className={styles.bannerList}>
            <span>每次网页搜索都会产生额外的模型请求费用。</span>
            <span>网页内容来自外部，属于不可信输入。</span>
            <span>
              默认限制
              <InfoTip label="网页搜索默认限制">
                单次生成上限 1024 tokens、每次请求最多搜索 2 次、最多返回 5 条结果、工具 60 秒超时。
              </InfoTip>
            </span>
          </span>
        </Banner>
      ) : null}
      {schema ? (
        <div className={styles.schemaRoot}>
          {schema.type === 'object' ? (
            Object.entries(schema.dict ?? {}).map(([key, child]) => (
              <GenericField
                key={key}
                name={key}
                node={child}
                path={[key]}
                value={isRecord(rootValue) ? rootValue[key] : undefined}
                disabled={!authority.writable}
                onSet={onSet}
                onUnset={onUnset}
              />
            ))
          ) : (
            <GenericField
              name={namespace.ns}
              node={schema}
              path={[]}
              value={rootValue}
              disabled={!authority.writable}
              onSet={onSet}
              onUnset={onUnset}
            />
          )}
        </div>
      ) : (
        <Banner tone="bad">这组配置的结构无法安全读取，已停止编辑，避免写入错误配置。</Banner>
      )}
      {credentialRefs.map((refName) => (
        <CredentialEditor refName={refName} onChanged={onSaved} key={refName} />
      ))}
      {conflict ? <Banner tone="warn">配置已在其他位置更新；当前草稿已保留，请核对后重新保存。</Banner> : null}
      {error && !conflict ? <Banner tone="bad">{error}</Banner> : null}
      <div className={styles.saveRow}>
        <span className={notice ? styles.notice : styles.muted} role={notice ? 'status' : undefined}>
          {notice || (ops.size > 0 ? `${ops.size} 项未保存的修改` : '')}
        </span>
        <Button
          variant="primary"
          busy={saving}
          disabled={ops.size === 0 || !schema || !authority.writable}
          onClick={() => void save()}
        >
          保存扩展配置
        </Button>
      </div>
      <Diagnostics
        items={[
          { label: '配置区域', value: authority.ns },
          { label: '配置版本', value: String(authority.revision) },
          ...(authority.owner
            ? [{ label: '所属包', value: `${authority.owner.packageName}@${authority.owner.packageVersion}` }]
            : []),
        ]}
      />
    </div>
  )
}

// —— 目录 ——

const EMPTY_SETTINGS_CATALOG = { plugins: [], namespaces: [] } as const

/**
 * The DSH plugin catalog for the settings list and detail. While `active`, it loads and follows the Host's
 * settings, credential and plugin change signals.
 */
export function useDshCatalog(active: boolean) {
  const { events, store } = useProductRuntime()
  const catalogQuery = useProductStore((state) => state.dshCatalogQuery)
  const catalog = catalogQuery.data ?? EMPTY_SETTINGS_CATALOG
  const refresh = useCallback(async () => {
    await store
      .getState()
      .loadDshCatalog(true)
      .catch(() => undefined)
  }, [store])
  useEffect(() => {
    if (!active) return
    void refresh()
    return events.subscribe({
      'dsh-settings-changed': (event: unknown) => {
        if (event instanceof MessageEvent && typeof event.data === 'string' && parseDshSettingsChangedEvent(event.data))
          void refresh()
      },
      'dsh-credentials-changed': (event: unknown) => {
        if (
          event instanceof MessageEvent &&
          typeof event.data === 'string' &&
          parseDshCredentialsChangedEvent(event.data)
        )
          void refresh()
      },
      'dsh-plugins-changed': () => void refresh(),
    })
  }, [active, events, refresh])
  const entries = useMemo<readonly DshSettingsCatalogEntry[]>(() => {
    const claimed = new Set(catalog.plugins.flatMap((plugin) => plugin.settingsNamespaces))
    return [
      ...catalog.plugins.map((plugin) => ({
        id: `plugin:${plugin.packageId ?? plugin.packageName}`,
        label: packageLabel(plugin.packageName),
        version: plugin.packageVersion,
        group: pluginGroup(plugin.origin),
        namespaces: catalog.namespaces.filter((namespace) => plugin.settingsNamespaces.includes(namespace.ns)),
        plugin,
      })),
      ...catalog.namespaces
        .filter((namespace) => !claimed.has(namespace.ns))
        .map((namespace) => ({
          id: `namespace:${namespace.ns}`,
          label: namespace.owner ? packageLabel(namespace.owner.packageName) : namespace.ns,
          version: namespace.owner?.packageVersion ?? '运行时注册',
          group: 'runtime' as const,
          namespaces: [namespace],
        })),
    ]
  }, [catalog])
  /** The entry to show when none is chosen: web search, else the first with settings. */
  const fallbackId =
    entries.find((entry) => entry.plugin?.packageName === '@deepseek-ai/dsh-web-search-deepseek')?.id ??
    entries.find((entry) => entry.namespaces.length > 0)?.id ??
    entries[0]?.id ??
    ''
  return {
    entries,
    fallbackId,
    loading: catalogQuery.loading && !catalogQuery.data,
    error: catalog.plugins.length === 0 ? catalogQuery.error : '',
    refresh,
  }
}

/** Install flow: check a registry package or a local archive, approve build scripts, then install (disabled). */
export function InstallDshPluginDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onInstalled: () => void
}) {
  const { events } = useProductRuntime()
  const file = useRef<HTMLInputElement>(null)
  const [spec, setSpec] = useState('')
  const [inspection, setInspection] = useState<HostApiResponse<'inspectDshPluginInstall'> | null>(null)
  const [approvedBuilds, setApprovedBuilds] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<'' | 'inspect' | 'install'>('')
  const [operationId, setOperationId] = useState('')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!operationId) return
    return events.subscribe({
      'dsh-plugin-operation': (event: unknown) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return
        try {
          const update = DshPluginOperationSseDataSchema.parse(JSON.parse(event.data))
          if (update.operationId === operationId) setProgress(update.message)
        } catch {
          // Unrelated or malformed frames; the HTTP response stays authoritative.
        }
      },
    })
  }, [events, operationId])
  useEffect(() => {
    if (open) return
    setSpec('')
    setInspection(null)
    setApprovedBuilds({})
    setProgress('')
    setError('')
  }, [open])
  const begin = (message: string): string => {
    const id = crypto.randomUUID()
    setOperationId(id)
    setProgress(message)
    setError('')
    return id
  }
  const accept = (result: HostApiResponse<'inspectDshPluginInstall'>) => {
    setInspection(result)
    setApprovedBuilds(Object.fromEntries(result.blockedBuilds.map((name) => [name, false])))
  }
  const inspectRegistry = async () => {
    if (!spec.trim() || busy) return
    setBusy('inspect')
    try {
      accept(
        await callHostApi(
          HostApiContracts.inspectDshPluginInstall,
          {},
          { spec: spec.trim(), operationId: begin('正在检查安装内容…') },
        ),
      )
    } catch (cause) {
      setInspection(null)
      setError(failure(cause))
    } finally {
      setBusy('')
    }
  }
  const inspectArchive = async (archive: File) => {
    setBusy('inspect')
    try {
      accept(
        await callHostApi(
          HostApiContracts.inspectDshPluginTarball,
          {},
          {
            bytes: new Uint8Array(await archive.arrayBuffer()),
            fileName: archive.name,
            operationId: begin('正在上传安装包…'),
          },
        ),
      )
    } catch (cause) {
      setInspection(null)
      setError(failure(cause))
    } finally {
      setBusy('')
    }
  }
  const install = async () => {
    if (!inspection || busy) return
    setBusy('install')
    try {
      await callHostApi(
        HostApiContracts.commitDshPluginInstall,
        {},
        {
          token: inspection.token,
          approvedBuilds: inspection.blockedBuilds.filter((name) => approvedBuilds[name] === true),
          operationId: begin('正在安装…'),
        },
      )
      toast('插件已安装，当前未启用。', { group: 'dsh-plugin-install' })
      onOpenChange(false)
      onInstalled()
    } catch (cause) {
      setError(failure(cause))
    } finally {
      setBusy('')
    }
  }
  return (
    <Dialog
      open={open}
      wide
      onOpenChange={(next) => busy === '' && onOpenChange(next)}
      title="安装 DSH 插件"
      actions={
        <>
          <Button variant="ghost" disabled={busy !== ''} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            busy={busy === 'install'}
            disabled={!inspection || busy !== ''}
            onClick={() => void install()}
          >
            安装（不启用）
          </Button>
        </>
      }
    >
      <div className={styles.install}>
        <div className={styles.installRow}>
          <Field label="npm 包与版本" hint="例如 @scope/plugin@1.2.3；版本范围会在检查时解析为精确版本。">
            <Input
              value={spec}
              spellCheck={false}
              placeholder="package-name@1.2.3"
              disabled={busy !== ''}
              onChange={(event) => setSpec(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void inspectRegistry()
              }}
            />
          </Field>
          <Button
            busy={busy === 'inspect' && Boolean(spec.trim())}
            disabled={!spec.trim() || busy !== ''}
            onClick={() => void inspectRegistry()}
          >
            检查安装内容
          </Button>
        </div>
        <div className={styles.installOr}>
          <span>或者从本机选择 npm tgz 或 .nxt-extension 安装包</span>
          <Button
            icon={<Upload size={14} aria-hidden="true" />}
            disabled={busy !== ''}
            onClick={() => file.current?.click()}
          >
            选择安装包
          </Button>
          <FileChooser
            ref={file}
            accept=".tgz,.tar.gz,.nxt-extension,application/gzip,application/vnd.nekro-nxt.extension+zip"
            onFile={(archive) => void inspectArchive(archive)}
          />
        </div>
        {busy && progress ? (
          <p className={styles.muted} role="status">
            {progress}
          </p>
        ) : null}
        {error ? <Banner tone="bad">{error}</Banner> : null}
        {inspection ? (
          <div className={styles.inspection}>
            <div className={styles.inspectionHead}>
              <b>{packageLabel(inspection.packageName)}</b>
              <span className={styles.muted}>
                版本 {inspection.packageVersion} · {inspection.entries.length} 个入口 · 安装后不会自动启用
              </span>
            </div>
            {inspection.hostUi ? (
              <Banner tone="info">
                包含 {inspection.hostUi.pages.length} 个页面；在本机启用对应入口时会请你确认权限。
              </Banner>
            ) : null}
            {inspection.blockedBuilds.length > 0 ? (
              <>
                <Banner tone="warn">
                  以下依赖要执行安装构建脚本。未批准的依赖会按禁用脚本的方式安装；批准只对当前精确版本有效。
                </Banner>
                {inspection.blockedBuilds.map((name) => (
                  <SwitchRow
                    key={name}
                    title={name}
                    description="允许这个依赖执行安装构建脚本"
                    checked={approvedBuilds[name] === true}
                    onCheckedChange={(checked) => setApprovedBuilds((current) => ({ ...current, [name]: checked }))}
                  />
                ))}
              </>
            ) : (
              <p className={styles.muted}>依赖没有请求执行构建脚本。</p>
            )}
            <Diagnostics items={[{ label: '包名', value: `${inspection.packageName}@${inspection.packageVersion}` }]} />
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

/** One catalog entry: state, installed entry points, settings and credentials. */
export function DshPluginDetail({
  entry,
  onRefresh,
  onRemoved,
}: {
  readonly entry: DshSettingsCatalogEntry
  readonly onRefresh: () => Promise<void>
  readonly onRemoved: () => void
}): ReactNode {
  const agents = useProductStore((state) => state.agents)
  const plugin = entry.plugin
  const fallbackAgent = agents[0]?.id ?? ''
  const namespaces = entry.namespaces
  const [selectedNamespace, setSelectedNamespace] = useState('')
  const [entryScope, setEntryScope] = useState<Record<string, 'host' | 'agent'>>({})
  const [entryAgent, setEntryAgent] = useState<Record<string, string>>({})
  const [entryConfig, setEntryConfig] = useState<Record<string, string>>({})
  const [configInspections, setConfigInspections] = useState<Record<string, DshPluginConfigInspection>>({})
  const [configInspecting, setConfigInspecting] = useState<Record<string, boolean>>({})
  const [operationError, setOperationError] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [permissionApproval, setPermissionApproval] = useState<{
    readonly entryId: string
    readonly digest: string
  } | null>(null)
  useEffect(() => {
    setSelectedNamespace(namespaces[0]?.ns ?? '')
    setOperationError('')
  }, [entry.id])
  const activeNamespace = namespaces.find((item) => item.ns === selectedNamespace) ?? namespaces[0]
  const status = dshEntryStatus(entry)

  const activateEntry = async (item: DshPluginEntry, approvedPermissionDigest?: string): Promise<void> => {
    const inspection = configInspections[item.id]
    if (!inspection) {
      setOperationError('需要先检查入口的配置；检查会初始化第三方模块。')
      return
    }
    if (inspection.mode === 'incompatible') {
      setOperationError(inspection.reason)
      return
    }
    const target = entryScope[item.id] ?? item.selectedScope ?? item.suggestedScope
    const agentId = entryAgent[item.id] ?? agents[0]?.id
    if (target === 'agent' && !agentId) {
      setOperationError('当前没有可选择的智能体。创建智能体后可启用该入口。')
      return
    }
    setOperationError('')
    try {
      const config = parseJsonValue(JSON.parse(entryConfig[item.id] ?? JSON.stringify(item.config)))
      await callHostApi(
        HostApiContracts.activateDshPluginEntry,
        { entryId: item.id },
        {
          target,
          ...(target === 'agent' ? { agentId } : {}),
          config,
          ...(approvedPermissionDigest === undefined
            ? {}
            : { permissionApproval: { permissionDigest: approvedPermissionDigest } }),
        },
      )
      toast(target === 'host' ? '入口已在本机启用。' : '入口已给所选智能体启用。', { group: `dsh-entry:${item.id}` })
      await onRefresh()
    } catch (cause) {
      const message = failure(cause)
      const permissionMatch = /^permission-approval-required:([a-f0-9]{64})$/u.exec(message)
      if (permissionMatch?.[1]) {
        setPermissionApproval({ entryId: item.id, digest: permissionMatch[1] })
        return
      }
      setOperationError(message)
    }
  }

  const inspectEntryConfig = async (entryId: string): Promise<void> => {
    setConfigInspecting((current) => ({ ...current, [entryId]: true }))
    setOperationError('')
    try {
      const inspection = await callHostApi(HostApiContracts.inspectDshPluginEntryConfig, { entryId }, undefined)
      setConfigInspections((current) => ({ ...current, [entryId]: inspection }))
    } catch (cause) {
      setOperationError(failure(cause))
    } finally {
      setConfigInspecting((current) => ({ ...current, [entryId]: false }))
    }
  }

  const deactivateEntry = async (entryId: string, targetKey: string): Promise<void> => {
    setOperationError('')
    try {
      await callHostApi(HostApiContracts.deactivateDshPluginEntry, { entryId }, { targetKey })
      toast('入口已关闭，资源已清理。', { group: `dsh-entry:${entryId}` })
      await onRefresh()
    } catch (cause) {
      setOperationError(failure(cause))
    }
  }

  const applies = activeNamespace
    ? activeNamespace.applies === 'live'
      ? '保存后实时生效'
      : '保存后需要重启'
    : undefined

  return (
    <div className={styles.detail}>
      <ObjectHeader
        level={2}
        size="compact"
        title={entry.label}
        status={<Chip tone={status.tone}>{status.label}</Chip>}
        meta={
          <>
            {status.label === DSH_GROUP_LABEL[entry.group] ? null : <span>{DSH_GROUP_LABEL[entry.group]}</span>}
            <span>{entry.version}</span>
            {applies ? <span>{applies}</span> : null}
          </>
        }
        actions={
          plugin?.origin === 'installed' && plugin.packageId ? (
            <Button
              size="small"
              icon={<Download size={14} aria-hidden="true" />}
              onClick={() =>
                window.location.assign(`/api/dsh/plugin-installs/${encodeURIComponent(plugin.packageId ?? '')}/export`)
              }
            >
              导出分享包
            </Button>
          ) : undefined
        }
      />
      {entry.group === 'runtime' ? <Banner tone="info">这组配置由运行环境注册，不属于任何已安装的插件。</Banner> : null}
      {plugin?.loadError ? <Banner tone="bad">{plugin.loadError.message}</Banner> : null}
      {plugin?.clientUiDetected ? (
        <Banner tone="info">插件自带的原生界面没有接入；它的服务端能力和配置可以正常使用。</Banner>
      ) : null}
      {plugin?.hostUi ? (
        <Banner tone="info">插件提供 {plugin.hostUi.pages.length} 个页面，在本机启用对应入口后出现。</Banner>
      ) : null}

      {plugin?.origin === 'installed' && (plugin.entries ?? []).length > 0 ? (
        <PropertyGroup title="入口" tip="每个入口可以在本机或给某个智能体启用。">
          {(plugin.entries ?? []).map((item) => {
            const scope = entryScope[item.id] ?? item.selectedScope ?? item.suggestedScope
            const inspection = configInspections[item.id]
            return (
              <div className={styles.entry} key={item.id}>
                <div className={styles.entryHead}>
                  <b title={item.moduleName}>{item.entryKey}</b>
                  {item.activations.map((activation) => (
                    <Chip
                      key={activation.targetKey}
                      tone={activation.diagnostic?.status === 'active' ? 'ok' : 'warn'}
                      dot
                    >
                      {activation.target === 'host'
                        ? '本机已启用'
                        : `${agents.find((agent) => agent.id === activation.agentId)?.name ?? '智能体'}已启用`}
                    </Chip>
                  ))}
                </div>
                <div className={styles.entryFields}>
                  <Field label="启用范围">
                    <Select
                      value={scope}
                      disabled={item.activations.length > 0}
                      options={[
                        { value: 'host', label: item.suggestedScope === 'host' ? '本机（建议）' : '本机' },
                        {
                          value: 'agent',
                          label: item.suggestedScope === 'agent' ? '指定智能体（建议）' : '指定智能体',
                        },
                      ]}
                      onValueChange={(value) => {
                        if (value === 'host' || value === 'agent')
                          setEntryScope((current) => ({ ...current, [item.id]: value }))
                      }}
                    />
                  </Field>
                  {scope === 'agent' ? (
                    <Field label="智能体">
                      <Select
                        value={entryAgent[item.id] ?? fallbackAgent}
                        options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                        onValueChange={(value) => setEntryAgent((current) => ({ ...current, [item.id]: value }))}
                      />
                    </Field>
                  ) : null}
                </div>
                {!inspection ? (
                  <Banner
                    tone="warn"
                    action={
                      <Button
                        size="small"
                        busy={configInspecting[item.id] === true}
                        onClick={() => void inspectEntryConfig(item.id)}
                      >
                        检查配置界面
                      </Button>
                    }
                  >
                    检查配置和启用入口都会初始化第三方模块，表示你信任这个安装来源。
                  </Banner>
                ) : null}
                {inspection?.mode === 'schema' ? (
                  <DshPluginConfigEditor
                    entry={item}
                    inspection={inspection}
                    onChange={(value) =>
                      setEntryConfig((current) => ({ ...current, [item.id]: JSON.stringify(value, null, 2) }))
                    }
                  />
                ) : null}
                {inspection?.mode === 'json' ? (
                  <Field label="启动配置（高级 JSON）" hint="插件没有提供配置结构；不能在这里保存 Secret 或凭据。">
                    <Textarea
                      rows={6}
                      value={entryConfig[item.id] ?? JSON.stringify(item.config, null, 2)}
                      onChange={(event) =>
                        setEntryConfig((current) => ({ ...current, [item.id]: event.currentTarget.value }))
                      }
                    />
                  </Field>
                ) : null}
                {inspection?.mode === 'incompatible' ? <Banner tone="bad">{inspection.reason}</Banner> : null}
                <div className={styles.inlineActions}>
                  <Button
                    variant="primary"
                    disabled={!inspection || inspection.mode === 'incompatible'}
                    onClick={() => void activateEntry(item)}
                  >
                    {item.activations.length > 0 ? '应用配置 / 添加授权' : '启用入口'}
                  </Button>
                  {item.activations.map((activation) => (
                    <Button
                      key={activation.targetKey}
                      variant="danger"
                      onClick={() => void deactivateEntry(item.id, activation.targetKey)}
                    >
                      关闭
                      {activation.target === 'host'
                        ? '本机启用'
                        : `${agents.find((agent) => agent.id === activation.agentId)?.name ?? '智能体'}的启用`}
                    </Button>
                  ))}
                </div>
                {item.activations.some((activation) => activation.diagnostic?.message) ? (
                  <p className={styles.muted}>
                    {item.activations
                      .map((activation) => activation.diagnostic?.message)
                      .filter(Boolean)
                      .join('；')}
                  </p>
                ) : null}
              </div>
            )
          })}
        </PropertyGroup>
      ) : null}

      {operationError ? <Banner tone="bad">{operationError}</Banner> : null}

      <PropertyGroup
        title="配置"
        actions={
          namespaces.length > 1 ? (
            <Select
              aria-label="配置区域"
              value={activeNamespace?.ns ?? ''}
              options={namespaces.map((item) => ({ value: item.ns, label: item.ns }))}
              onValueChange={(value) => setSelectedNamespace(value)}
            />
          ) : undefined
        }
      >
        {activeNamespace ? (
          <NamespaceEditor namespace={activeNamespace} onSaved={() => void onRefresh()} />
        ) : (
          <p className={styles.muted}>这个组件没有可以在线修改的配置。</p>
        )}
      </PropertyGroup>

      {plugin ? (
        <Diagnostics items={[{ label: '包名', value: `${plugin.packageName}@${plugin.packageVersion}` }]} />
      ) : null}

      {plugin?.origin === 'installed' ? (
        <div className={styles.dangerRow}>
          <span className={styles.muted}>关闭全部入口并移除安装包。</span>
          <Button variant="danger" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => setRemoveOpen(true)}>
            移除这个插件
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`移除“${entry.label}”？`}
        confirmLabel="关闭并移除"
        danger
        onConfirm={async () => {
          if (!plugin?.packageId) return
          await callHostApi(HostApiContracts.removeDshPluginPackage, { packageId: plugin.packageId }, undefined)
          toast('插件已关闭并移除。', { group: 'dsh-plugin-remove' })
          onRemoved()
          await onRefresh()
        }}
      >
        会关闭 {plugin?.entries?.flatMap((item) => item.activations).length ?? 0}{' '}
        个启用关系；全部入口停止后，安装包移入回收目录。
      </ConfirmDialog>
      <ConfirmDialog
        open={permissionApproval !== null}
        onOpenChange={(open) => {
          if (!open) setPermissionApproval(null)
        }}
        title="批准页面权限"
        confirmLabel="批准并启用"
        onConfirm={async () => {
          const pending = permissionApproval
          const item = plugin?.entries?.find(({ id }) => id === pending?.entryId)
          if (!pending || !item) return
          await activateEntry(item, pending.digest)
          setPermissionApproval(null)
        }}
      >
        {plugin?.hostUi
          ? [
              ...plugin.hostUi.permissions.permissions,
              ...plugin.hostUi.permissions.networkOrigins.map((origin) => `访问 ${origin}`),
            ].join('、') || '这个页面没有申请产品数据权限。'
          : '无法读取页面的权限声明。'}
      </ConfirmDialog>
    </div>
  )
}

/** Loading or failure of the whole catalog. */
export function DshCatalogState({
  loading,
  error,
  onRetry,
}: {
  readonly loading: boolean
  readonly error: string
  readonly onRetry: () => void
}): ReactNode {
  if (loading) {
    return (
      <div className={styles.loading} role="status" aria-label="正在读取 DSH 插件">
        <Skeleton height={28} width="40%" />
        <Skeleton height={120} />
      </div>
    )
  }
  if (error) {
    return (
      <EmptyState title="无法读取 DSH 插件" action={<Button onClick={onRetry}>重新加载</Button>}>
        {error}
      </EmptyState>
    )
  }
  return <EmptyState title="当前没有已识别的 DSH 插件" />
}

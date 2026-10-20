import {
  CREDENTIAL_REDACTABLE_MIN_CHARS,
  HostApiContracts,
  type CredentialsView,
  type CreateCredentialRequest,
} from '@nekro-nxt/contracts'
import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { callHostApi } from '../host-api-client.js'
import { useProductStore } from '../product-runtime.js'
import {
  Button,
  Dialog,
  Disclosure,
  Field,
  Input,
  Pressable,
  SecretInput,
  Segmented,
  Select,
  SwitchRow,
  ToggleChip,
  toast,
} from '../ui-kit/index.js'
import {
  credentialDraftIssues,
  emptyCredentialDraft,
  errorText,
  parseDomains,
  scopeOfDraft,
  type CredentialDraft,
} from './credentials-data.js'
import styles from './credentials.module.css'

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'

export const USAGE_OPTIONS = [
  { value: 'request', label: '仅用于网络请求' },
  { value: 'program', label: '允许程序读取' },
] as const

/** A value too short to be hidden from what the agent reads back. */
export function ShortValueWarning({ value }: { readonly value: string }) {
  const length = value.trim().length
  return length > 0 && length < CREDENTIAL_REDACTABLE_MIN_CHARS ? (
    <p className={styles.warn}>少于 {CREDENTIAL_REDACTABLE_MIN_CHARS} 个字符，无法在智能体的上下文中隐藏。</p>
  ) : null
}

/** Which agents may use a credential: every agent, or the ones picked. */
export function AgentScopeField({
  draft,
  onChange,
}: {
  readonly draft: CredentialDraft
  readonly onChange: (draft: CredentialDraft) => void
}) {
  const agents = useProductStore((state) => state.agents)
  return (
    <div className={styles.form}>
      <Segmented
        className={styles.segmented}
        label="可用智能体"
        value={draft.allAgents ? 'all' : 'some'}
        options={[
          { value: 'all', label: '全部智能体' },
          { value: 'some', label: '指定智能体' },
        ]}
        onChange={(next) => onChange({ ...draft, allAgents: next === 'all' })}
      />
      {draft.allAgents ? null : agents.length === 0 ? (
        <p className={styles.note}>还没有智能体。</p>
      ) : (
        <div className={styles.agents} role="group" aria-label="指定智能体">
          {agents.map((agent) => (
            <ToggleChip
              key={agent.id}
              pressed={draft.agentIds.includes(agent.id)}
              onPressedChange={(pressed) =>
                onChange({
                  ...draft,
                  agentIds: pressed
                    ? [...draft.agentIds, agent.id]
                    : draft.agentIds.filter((agentId) => agentId !== agent.id),
                })
              }
            >
              {agent.name}
            </ToggleChip>
          ))}
        </div>
      )}
    </div>
  )
}

/** Collapsed section of a form; opens by itself when `open` is forced, e.g. to show an error inside. */
export function Advanced({ children, forced = false }: { readonly children: ReactNode; readonly forced?: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div>
      <Pressable
        className={styles.advancedToggle}
        aria-expanded={open || forced}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={14} aria-hidden="true" />
        高级
      </Pressable>
      <Disclosure open={open || forced} id={id}>
        <div className={styles.advancedBody}>{children}</div>
      </Disclosure>
    </div>
  )
}

/**
 * Usage, domains and variable of a generic credential. Choosing program use states its risk once, right there.
 */
export function CredentialUsageFields({
  draft,
  issues,
  onChange,
}: {
  readonly draft: CredentialDraft
  readonly issues: ReturnType<typeof credentialDraftIssues>
  readonly onChange: (draft: CredentialDraft) => void
}) {
  return (
    <>
      <div className={styles.picker}>
        <Segmented
          className={styles.segmented}
          label="使用方式"
          value={draft.usage}
          options={USAGE_OPTIONS}
          onChange={(usage) => onChange({ ...draft, usage })}
        />
        {draft.usage === 'program' ? <p className={styles.warn}>智能体运行的程序可以读到原文。</p> : null}
      </div>
      <Field label="允许的域名" hint="多个域名用逗号分隔" error={issues.domains}>
        <Input
          value={draft.domains}
          spellCheck={false}
          placeholder="api.example.com"
          onChange={(event) => onChange({ ...draft, domains: event.target.value })}
        />
      </Field>
      {draft.usage === 'program' ? (
        <Field label="环境变量名" tip="填写后，智能体运行的命令可以通过这个变量读取。" error={issues.envName}>
          <Input
            value={draft.envName}
            spellCheck={false}
            placeholder="EXAMPLE_API_KEY"
            onChange={(event) => onChange({ ...draft, envName: event.target.value.toUpperCase() })}
          />
        </Field>
      ) : null}
    </>
  )
}

export interface CreatedCredential {
  readonly view: CredentialsView
  readonly credentialId: string
}

/**
 * Adds a named credential. `initial` pre-fills the form, for example from an agent's request (`requestId`) or from
 * the secret field it is added for. The GitHub variant takes a token or a login of the local `gh`.
 */
export function AddCredentialDialog({
  open,
  onOpenChange,
  kind = 'generic',
  view,
  initial,
  requestId,
  onCreated,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly kind?: 'generic' | 'github'
  readonly view: CredentialsView | undefined
  readonly initial?: Partial<CredentialDraft> | undefined
  readonly requestId?: string | undefined
  readonly onCreated: (created: CreatedCredential) => void
}) {
  const [draft, setDraft] = useState<CredentialDraft>({ ...emptyCredentialDraft, ...initial })
  const [value, setValue] = useState('')
  const [source, setSource] = useState<'token' | 'gh-login'>('token')
  const [login, setLogin] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const initialKey = JSON.stringify(initial ?? {})
  useEffect(() => {
    if (!open) return
    setDraft({ ...emptyCredentialDraft, ...initial })
    setValue('')
    setSource('token')
    setLogin('')
    setSubmitted(false)
    setError('')
  }, [open, initialKey])

  const logins = view?.localGithubLogins ?? []
  const chosenLogin = login || (logins.find((entry) => entry.active)?.login ?? logins[0]?.login ?? '')
  const issues = kind === 'github' ? {} : credentialDraftIssues(draft, 'generic')
  const ready =
    kind === 'github'
      ? source === 'token'
        ? value.trim() !== ''
        : chosenLogin !== ''
      : draft.name.trim() !== '' && value.trim() !== ''

  const submit = async () => {
    setSubmitted(true)
    if (Object.keys(issues).length > 0) return
    setBusy(true)
    setError('')
    const shared = {
      description: draft.description.trim(),
      agentScope: scopeOfDraft(draft),
      autoUse: draft.autoUse,
      ...(requestId === undefined ? {} : { requestId }),
    }
    const request: CreateCredentialRequest =
      kind === 'github'
        ? {
            kind: 'github',
            ...shared,
            github: source === 'token' ? { source, token: value.trim() } : { source, login: chosenLogin },
          }
        : {
            kind: 'generic',
            ...shared,
            name: draft.name.trim(),
            usage: draft.usage,
            domains: [...parseDomains(draft.domains)],
            ...(draft.usage === 'program' && draft.envName.trim() !== '' ? { envName: draft.envName.trim() } : {}),
            value: value.trim(),
          }
    try {
      const known = new Set(view?.credentials.map((credential) => credential.id) ?? [])
      const next = await callHostApi(HostApiContracts.createCredential, {}, request)
      const added =
        next.credentials.find((credential) => !known.has(credential.id)) ??
        next.credentials.find((credential) => credential.name === draft.name.trim())
      toast('凭据已添加')
      onOpenChange(false)
      if (added !== undefined) onCreated({ view: next, credentialId: added.id })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const shownIssues = submitted ? issues : {}
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={kind === 'github' ? '添加 GitHub 账号' : '添加凭据'}
      wide
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void submit()}>
            添加
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {kind === 'github' ? (
          <>
            <Segmented
              className={styles.segmented}
              label="账号来源"
              value={source}
              options={[
                { value: 'token', label: '填写 token' },
                { value: 'gh-login', label: '本机 gh 已登录账号' },
              ]}
              onChange={(next) => {
                setSource(next)
                setError('')
              }}
            />
            {source === 'token' ? (
              <Field
                label="Token"
                hint={
                  <>
                    建议
                    <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">
                      创建专用 token
                    </a>
                    ，只开启需要的权限。
                  </>
                }
              >
                <SecretInput
                  configured={false}
                  value={value}
                  placeholder="github_pat_…"
                  onChange={(event) => setValue(event.target.value)}
                />
              </Field>
            ) : logins.length === 0 ? (
              <p className={styles.note}>这台设备上没有已登录的 gh 账号。</p>
            ) : (
              <Field label="账号" hint="该账号在 gh 里的全部权限都会交给智能体。">
                <Select
                  aria-label="gh 账号"
                  value={chosenLogin}
                  options={logins.map((entry) => ({ value: entry.login, label: entry.login }))}
                  onValueChange={setLogin}
                />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="名称" error={shownIssues.name}>
              <Input
                value={draft.name}
                placeholder="例如：天气服务"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="说明">
              <Input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
            <Field label="值">
              <SecretInput
                configured={false}
                value={value}
                autoComplete="off"
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
            <ShortValueWarning value={value} />
            <CredentialUsageFields draft={draft} issues={shownIssues} onChange={setDraft} />
          </>
        )}
        <SwitchRow
          title="自动使用"
          tip="关闭后，智能体每次使用前要先申请。"
          checked={draft.autoUse}
          onCheckedChange={(autoUse) => setDraft({ ...draft, autoUse })}
        />
        <Advanced>
          <AgentScopeField draft={draft} onChange={setDraft} />
        </Advanced>
        {error ? (
          <p role="alert" className={styles.warn}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

/** Replaces a credential's value; a GitHub credential takes a token of the same account. */
export function ReplaceCredentialValueDialog({
  credential,
  onOpenChange,
  onReplaced,
}: {
  readonly credential: { readonly id: string; readonly name: string; readonly kind: 'generic' | 'github' } | undefined
  readonly onOpenChange: (open: boolean) => void
  readonly onReplaced: (view: CredentialsView) => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setValue('')
    setError('')
  }, [credential?.id])
  const submit = async () => {
    if (credential === undefined) return
    setBusy(true)
    setError('')
    try {
      const view = await callHostApi(
        HostApiContracts.replaceCredentialValue,
        { credentialId: credential.id },
        credential.kind === 'github' ? { github: { source: 'token', token: value.trim() } } : { value: value.trim() },
      )
      toast('值已更换')
      onReplaced(view)
      onOpenChange(false)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={credential !== undefined}
      onOpenChange={(open) => !busy && onOpenChange(open)}
      title={credential === undefined ? '' : `更换「${credential.name}」的值`}
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" busy={busy} disabled={value.trim() === ''} onClick={() => void submit()}>
            更换
          </Button>
        </>
      }
    >
      <Field
        label={credential?.kind === 'github' ? '新的 token' : '新的值'}
        hint={credential?.kind === 'github' ? '需要属于同一个 GitHub 账号。' : undefined}
        error={error || undefined}
      >
        <SecretInput
          configured={false}
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      {credential?.kind === 'github' ? null : <ShortValueWarning value={value} />}
    </Dialog>
  )
}

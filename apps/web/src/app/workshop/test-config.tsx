import { HostApiContracts, type HostApiResponse, type JsonValue } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { AddCredentialDialog } from '../../credentials/credential-form.js'
import { CredentialPicker, type SecretSource } from '../../credentials/credential-picker.js'
import { credentialOpenTo, useCredentials } from '../../credentials/credentials-data.js'
import { callHostApi } from '../../host-api-client.js'
import { Button, Field, Input, PropertyGroup, SecretInput, toast } from '../../ui-kit/index.js'
import styles from './workshop.module.css'

type TestConfig = NonNullable<HostApiResponse<'getAuthoringTask'>['testConfig']>

const shown = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)

/**
 * Configuration of this task's trial runs: credentials the candidate declares (a named credential or a value typed for
 * the task), and text or number values that take precedence over what the agent provided (shown as placeholders). A
 * saved extension is configured on its own.
 */
export function TestConfigGroup({
  taskId,
  agentId,
  config,
}: {
  readonly taskId: string
  readonly agentId: string
  readonly config: TestConfig
}) {
  const credentials = useCredentials()
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({})
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [stored, setStored] = useState<Readonly<Record<string, string | number>>>(config.values)
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set(config.configured))
  const [bound, setBound] = useState<Readonly<Record<string, string>>>(config.boundCredentials ?? {})
  // Changed bindings only: a credential id, or `null` to unbind.
  const [bindings, setBindings] = useState<Readonly<Record<string, string | null>>>({})
  const [typing, setTyping] = useState<ReadonlySet<string>>(new Set())
  const [creating, setCreating] = useState<{ readonly key: string; readonly title: string }>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setConfigured(new Set(config.configured))
    setStored(config.values)
    setBound(config.boundCredentials ?? {})
  }, [config])
  const typedSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim() !== ''))
  const changedValues = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => value.trim() !== shown(stored[key])),
  )
  // A typed value replaces a binding by itself.
  const changedBindings = Object.fromEntries(
    Object.entries(bindings).filter(([key, id]) => (id ?? undefined) !== bound[key] && typedSecrets[key] === undefined),
  )
  const changed =
    Object.keys(typedSecrets).length + Object.keys(changedValues).length + Object.keys(changedBindings).length > 0
  const boundNow = (key: string): string | undefined => (key in bindings ? (bindings[key] ?? undefined) : bound[key])
  const sourceOf = (key: string): SecretSource => {
    const id = boundNow(key)
    if (id !== undefined) return { kind: 'credential', id }
    return typing.has(key) || (configured.has(key) && !(key in bindings)) ? { kind: 'private' } : { kind: 'unset' }
  }
  const choose = (key: string, source: SecretSource) => {
    setBindings((current) => ({ ...current, [key]: source.kind === 'credential' ? source.id : null }))
    setTyping((current) => {
      const next = new Set(current)
      if (source.kind === 'private') next.add(key)
      else next.delete(key)
      return next
    })
    if (source.kind !== 'private') setSecrets((current) => ({ ...current, [key]: '' }))
  }
  const save = async () => {
    setBusy(true)
    try {
      const result = await callHostApi(
        HostApiContracts.setAuthoringTestConfig,
        { taskId },
        {
          secrets: typedSecrets,
          values: changedValues,
          ...(Object.keys(changedBindings).length === 0 ? {} : { credentialBindings: changedBindings }),
        },
      )
      setConfigured(new Set(result.configured))
      setStored(result.values)
      setBound(result.boundCredentials ?? {})
      setSecrets({})
      setValues({})
      setBindings({})
      setTyping(new Set())
      toast('测试配置已保存，下次试运行时生效')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <PropertyGroup title="测试配置" tip="只用于试运行。保存成扩展后要在扩展配置里重新填写。">
      <div className={styles.testSecrets}>
        {config.fields.map((field) => {
          if (field.kind !== 'secret') {
            return (
              <Field key={field.key} label={field.title}>
                <Input
                  inputMode={field.kind === 'number' ? 'decimal' : undefined}
                  value={values[field.key] ?? shown(stored[field.key])}
                  placeholder={shown(config.agentValues[field.key])}
                  disabled={busy}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              </Field>
            )
          }
          const source = sourceOf(field.key)
          return (
            <div key={field.key} className={styles.testSecret}>
              <Field label={field.title}>
                <CredentialPicker
                  label={field.title}
                  value={source}
                  credentials={credentials.view?.credentials ?? []}
                  usable={(credential) => credentialOpenTo(credential, agentId)}
                  allowPrivate
                  disabled={busy}
                  onChange={(next) => choose(field.key, next)}
                  onCreate={() => setCreating({ key: field.key, title: field.title })}
                />
              </Field>
              {source.kind === 'private' ? (
                <SecretInput
                  aria-label={`${field.title}的值`}
                  configured={configured.has(field.key) && bound[field.key] === undefined}
                  value={secrets[field.key] ?? ''}
                  disabled={busy}
                  onChange={(event) => setSecrets((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              ) : null}
            </div>
          )
        })}
        <div className={styles.testSecretsActions}>
          <Button variant="primary" busy={busy} disabled={!changed} onClick={() => void save()}>
            保存测试配置
          </Button>
        </div>
      </div>
      <AddCredentialDialog
        open={creating !== undefined}
        onOpenChange={(open) => !open && setCreating(undefined)}
        view={credentials.view}
        initial={{ name: creating?.title ?? '' }}
        onCreated={({ view, credentialId }) => {
          credentials.replace(view)
          if (creating !== undefined) choose(creating.key, { kind: 'credential', id: credentialId })
          setCreating(undefined)
        }}
      />
    </PropertyGroup>
  )
}

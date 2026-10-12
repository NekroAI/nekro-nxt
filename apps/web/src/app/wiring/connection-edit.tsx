import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { configFields } from '@nekro-nxt/contracts'
import { ConfigForm, configIssues, secretIssues, type ConfigValue } from '../../extension-ui/index.js'
import { connectionDisplayName, useProductStore, type ConnectionSummary } from '../../product-runtime.js'
import { Banner, Button, Field, PropertyGroup, ReaderPage, SecretInput, Select, toast } from '../../ui-kit/index.js'
import { useProductApi } from '../model/store.js'
import { useGo } from '../model/nav.js'
import styles from './wiring.module.css'

type SecretChoice = 'keep' | 'replace' | 'clear'

export function ConnectionEdit({ connection }: { readonly connection: ConnectionSummary }) {
  const api = useProductApi()
  const go = useGo()
  const descriptor = useProductStore((state) =>
    state.connectionAdapters.find((item) => item.key === connection.adapterKey),
  )
  const [saved] = useState(connection.configuration ?? {})
  const [values, setValues] = useState<ConfigValue>(saved)
  const [choices, setChoices] = useState<Readonly<Record<string, SecretChoice>>>({})
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const back = () => go(`/wiring/connections/${connection.id}`)
  if (!descriptor || !connection.userManaged) return null
  const fields = configFields(descriptor.configSchema).filter((field) => field.kind === 'secret')
  const configured = new Set(connection.configuredSecrets ?? [])
  const retained = new Set([...configured].filter((key) => (choices[key] ?? 'keep') === 'keep'))
  const replacements = Object.fromEntries(Object.entries(secrets).filter(([key]) => choices[key] === 'replace'))
  const issues = { ...secretIssues(descriptor.configSchema, replacements, retained) }
  for (const field of fields) {
    if (choices[field.key] === 'replace' && !secrets[field.key]?.trim()) issues[field.key] = `请填写${field.title}。`
  }
  const dirty =
    Object.entries(values).some(([key, value]) => value !== saved[key]) ||
    Object.values(choices).some((choice) => choice !== 'keep')
  const save = async () => {
    setSubmitted(true)
    if (Object.keys(configIssues(descriptor.configSchema, values)).length || Object.keys(issues).length) return
    const credentials: Record<string, string | null> = {}
    for (const [key, choice] of Object.entries(choices)) {
      if (choice === 'clear') credentials[key] = null
      if (choice === 'replace') credentials[key] = secrets[key] ?? ''
    }
    // Only changed public fields are patched so a concurrent switch does not get overwritten by this form.
    const configuration: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(values)) {
      if (
        value !== saved[key] &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      )
        configuration[key] = value
    }
    setBusy(true)
    setError('')
    try {
      await api.getState().updateConnectionConfiguration(connection.id, configuration, credentials)
      setSecrets({})
      toast('连接设置已保存')
      back()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ReaderPage
      title="编辑连接设置"
      actions={
        <Button variant="ghost" size="small" icon={<ArrowLeft size={14} />} disabled={busy} onClick={back}>
          返回账号
        </Button>
      }
    >
      <form
        className={styles.configForm}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <PropertyGroup title={connectionDisplayName(connection)}>
          <ConfigForm
            schema={descriptor.configSchema}
            value={values}
            onChange={setValues}
            showIssues={submitted}
            disabled={busy}
          />
          {fields.map((field) => (
            <div key={field.key} className={styles.credentialField}>
              <Field
                label={field.title}
                hint={configured.has(field.key) ? '已配置' : '尚未配置'}
                error={submitted ? issues[field.key] : undefined}
              >
                <Select
                  aria-label={`${field.title}操作`}
                  value={choices[field.key] ?? 'keep'}
                  disabled={busy}
                  options={[
                    { value: 'keep', label: configured.has(field.key) ? '保留原值' : '保持未配置' },
                    { value: 'replace', label: '重新填写' },
                    ...(!field.required && configured.has(field.key) ? [{ value: 'clear', label: '清除' }] : []),
                  ]}
                  onValueChange={(value) => {
                    if (value !== 'keep' && value !== 'replace' && value !== 'clear') return
                    setChoices((current) => ({ ...current, [field.key]: value }))
                    setSecrets((current) => ({ ...current, [field.key]: '' }))
                  }}
                />
              </Field>
              {choices[field.key] === 'replace' ? (
                <Field label={`新的${field.title}`} error={submitted ? issues[field.key] : undefined}>
                  <SecretInput
                    configured={false}
                    aria-label={`新的${field.title}`}
                    autoComplete="off"
                    value={secrets[field.key] ?? ''}
                    disabled={busy}
                    onChange={(event) => setSecrets((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                </Field>
              ) : null}
            </div>
          ))}
          {error ? <Banner tone="bad">{error}</Banner> : null}
          <div className={styles.formActions}>
            <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
              保存设置
            </Button>
          </div>
        </PropertyGroup>
      </form>
    </ReaderPage>
  )
}

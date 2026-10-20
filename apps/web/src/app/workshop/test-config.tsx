import { HostApiContracts, type HostApiResponse, type JsonValue } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import { Button, Field, Input, PropertyGroup, SecretInput, toast } from '../../ui-kit/index.js'
import styles from './workshop.module.css'

type TestConfig = NonNullable<HostApiResponse<'getAuthoringTask'>['testConfig']>

const shown = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)

/**
 * Configuration of this task's trial runs: credentials the candidate declares, and text or number values that take
 * precedence over what the agent provided (shown as placeholders). A saved extension is configured on its own.
 */
export function TestConfigGroup({ taskId, config }: { readonly taskId: string; readonly config: TestConfig }) {
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({})
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [stored, setStored] = useState<Readonly<Record<string, string | number>>>(config.values)
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set(config.configured))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setConfigured(new Set(config.configured))
    setStored(config.values)
  }, [config])
  const typedSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim() !== ''))
  const changedValues = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => value.trim() !== shown(stored[key])),
  )
  const changed = Object.keys(typedSecrets).length + Object.keys(changedValues).length > 0
  const save = async () => {
    setBusy(true)
    try {
      const result = await callHostApi(
        HostApiContracts.setAuthoringTestConfig,
        { taskId },
        { secrets: typedSecrets, values: changedValues },
      )
      setConfigured(new Set(result.configured))
      setStored(result.values)
      setSecrets({})
      setValues({})
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
        {config.fields.map((field) =>
          field.kind === 'secret' ? (
            <Field key={field.key} label={field.title}>
              <SecretInput
                configured={configured.has(field.key)}
                value={secrets[field.key] ?? ''}
                disabled={busy}
                onChange={(event) => setSecrets((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            </Field>
          ) : (
            <Field key={field.key} label={field.title}>
              <Input
                inputMode={field.kind === 'number' ? 'decimal' : undefined}
                value={values[field.key] ?? shown(stored[field.key])}
                placeholder={shown(config.agentValues[field.key])}
                disabled={busy}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            </Field>
          ),
        )}
        <div className={styles.testSecretsActions}>
          <Button variant="primary" busy={busy} disabled={!changed} onClick={() => void save()}>
            保存测试配置
          </Button>
        </div>
      </div>
    </PropertyGroup>
  )
}

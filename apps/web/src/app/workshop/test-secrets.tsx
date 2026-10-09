import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import { Button, Field, PropertyGroup, SecretInput, toast } from '../../ui-kit/index.js'
import styles from './workshop.module.css'

type TestSecrets = NonNullable<HostApiResponse<'getAuthoringTask'>['testSecrets']>

/**
 * Credentials the candidate declares, filled only for this task's trial runs so it can call real services before it
 * is saved. A saved extension asks for its own credentials when it is enabled.
 */
export function TestSecretsGroup({ taskId, secrets }: { readonly taskId: string; readonly secrets: TestSecrets }) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set(secrets.configured))
  const [busy, setBusy] = useState(false)
  useEffect(() => setConfigured(new Set(secrets.configured)), [secrets])
  const typed = Object.fromEntries(Object.entries(drafts).filter(([, value]) => value.trim() !== ''))
  const save = async () => {
    setBusy(true)
    try {
      const result = await callHostApi(HostApiContracts.setAuthoringTestSecrets, { taskId }, { secrets: typed })
      setConfigured(new Set(result.configured))
      setDrafts({})
      toast('测试凭据已保存，下次试运行时生效')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <PropertyGroup title="测试凭据" tip="只用于试运行。保存成扩展后要在扩展配置里重新填写。">
      <div className={styles.testSecrets}>
        {secrets.fields.map((field) => (
          <Field key={field.key} label={field.title}>
            <SecretInput
              configured={configured.has(field.key)}
              value={drafts[field.key] ?? ''}
              disabled={busy}
              onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.target.value }))}
            />
          </Field>
        ))}
        <div className={styles.testSecretsActions}>
          <Button variant="primary" busy={busy} disabled={Object.keys(typed).length === 0} onClick={() => void save()}>
            保存测试凭据
          </Button>
        </div>
      </div>
    </PropertyGroup>
  )
}

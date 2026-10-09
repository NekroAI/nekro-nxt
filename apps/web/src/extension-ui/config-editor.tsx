import { parseJsonValue, type ConfigSchemaDocument, type JsonValue } from '@nekro-nxt/contracts'
import { useEffect, useMemo, useState } from 'react'
import { useProductRuntime, type LocalExtensionSummary } from '../product-runtime.js'
import { Button } from '../ui-kit/index.js'
import { ConfigForm, configDefaults, configIssues, secretIssues, type ConfigValue } from './config-form.js'
import styles from './config-editor.module.css'

const asConfigValue = (value: JsonValue | undefined): ConfigValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

/**
 * The configuration form of the installed record: one agent's (`agentId`) or the host's. `undefined` when that layer
 * declares no configuration.
 */
export const activeConfigSchema = (
  extension: LocalExtensionSummary,
  agentId?: string,
): ConfigSchemaDocument | undefined => {
  const revision = extension.revisions.find((candidate) => candidate.id === extension.installation?.revisionId)
  const schema = agentId === undefined ? revision?.hostConfigSchema : revision?.agentConfigSchema
  return schema && Object.keys(schema.dict).length > 0 ? schema : undefined
}

/**
 * Edits one agent's configuration (`agentId`) or the host configuration of an installed extension. Agent
 * configuration applies at the next safe point between tool calls; nothing renders when the layer declares none.
 */
export function ExtensionConfigEditor({
  extension,
  agentId,
}: {
  readonly extension: LocalExtensionSummary
  readonly agentId?: string
}) {
  const product = useProductRuntime()
  const schema = activeConfigSchema(extension, agentId)
  const saved = useMemo(() => {
    const stored =
      agentId === undefined
        ? extension.installation?.config
        : extension.activations.find((activation) => activation.agentId === agentId)?.config
    return asConfigValue(stored === undefined ? undefined : parseJsonValue(stored))
  }, [agentId, extension])
  // Stored secret values never reach the client; only which ones are set.
  const configuredSecrets = useMemo(
    () =>
      new Set(
        agentId === undefined
          ? (extension.installation?.configuredSecrets ?? [])
          : (extension.activations.find((activation) => activation.agentId === agentId)?.configuredSecrets ?? []),
      ),
    [agentId, extension],
  )
  const [draft, setDraft] = useState<ConfigValue>(saved)
  const [secretDrafts, setSecretDrafts] = useState<Readonly<Record<string, string>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setDraft(saved)
    setSecretDrafts({})
    setSubmitted(false)
    setError('')
  }, [saved])
  if (!schema) return null
  const typedSecrets = Object.fromEntries(Object.entries(secretDrafts).filter(([, value]) => value.trim() !== ''))
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(typedSecrets).length > 0
  const save = async () => {
    setSubmitted(true)
    if (Object.keys(configIssues(schema, draft)).length > 0) return
    if (Object.keys(secretIssues(schema, secretDrafts, configuredSecrets)).length > 0) return
    setBusy(true)
    setError('')
    try {
      await product.store.getState().updateExtensionConfig({
        extensionId: extension.id,
        ...(agentId === undefined ? {} : { agentId }),
        config: draft,
        ...(Object.keys(typedSecrets).length === 0 ? {} : { secrets: typedSecrets }),
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.editor} data-extension-config={extension.id}>
      <ConfigForm
        schema={schema}
        value={draft}
        onChange={setDraft}
        secrets={{ value: secretDrafts, onChange: setSecretDrafts, configured: configuredSecrets }}
        showIssues={submitted}
        disabled={busy}
      />
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(saved)
            setSecretDrafts({})
          }}
        >
          还原
        </Button>
        <Button
          variant="ghost"
          disabled={busy || JSON.stringify(draft) === JSON.stringify(configDefaults(schema))}
          onClick={() => setDraft(configDefaults(schema))}
        >
          恢复默认
        </Button>
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
          保存配置
        </Button>
      </div>
    </div>
  )
}

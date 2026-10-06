import { parseJsonValue, type ConfigSchemaDocument, type JsonValue } from '@nekro-nxt/contracts'
import { useEffect, useMemo, useState } from 'react'
import { useProductRuntime, type LocalExtensionSummary } from '../product-runtime.js'
import { Button } from '../ui-kit/next/index.js'
import { ConfigForm, configDefaults, configIssues, type ConfigValue } from './config-form.js'
import styles from './config-editor.module.css'

const asConfigValue = (value: JsonValue | undefined): ConfigValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

/** The schema of the Revision currently in use, when it declares any configuration. */
export const activeConfigSchema = (
  extension: LocalExtensionSummary,
  agentId?: string,
): ConfigSchemaDocument | undefined => {
  const revisionId =
    agentId === undefined
      ? extension.installation?.revisionId
      : extension.activations.find((activation) => activation.agentId === agentId)?.revisionId
  const schema = extension.revisions.find((revision) => revision.id === revisionId)?.configSchema
  return schema && Object.keys(schema.dict).length > 0 ? schema : undefined
}

/**
 * Edits the configuration of an enabled agent extension (`agentId`) or an installed Host extension. Agent
 * configuration applies at the next safe point between tool calls; nothing renders when the Revision declares none.
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
  const [draft, setDraft] = useState<ConfigValue>(saved)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setDraft(saved)
    setSubmitted(false)
    setError('')
  }, [saved])
  if (!schema) return null
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const save = async () => {
    setSubmitted(true)
    if (Object.keys(configIssues(schema, draft)).length > 0) return
    setBusy(true)
    setError('')
    try {
      await product.store
        .getState()
        .updateExtensionConfig({
          extensionId: extension.id,
          ...(agentId === undefined ? {} : { agentId }),
          config: draft,
        })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.editor} data-extension-config={extension.id}>
      <ConfigForm schema={schema} value={draft} onChange={setDraft} showIssues={submitted} disabled={busy} />
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button variant="ghost" disabled={busy || !dirty} onClick={() => setDraft(saved)}>
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

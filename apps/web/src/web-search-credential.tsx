import { useEffect, useState, type ReactNode } from 'react'
import {
  HostApiContracts,
  HostApiErrorSchema,
  buildHostApiContractPath,
  type HostApiContract,
} from '@nekro-nxt/contracts'
import { notify } from './components/notifications.js'
import { InlineFeedback } from './components/product-feedback.js'
import { useProductStore } from './product-store.js'
import { Button, Field, Input } from './ui-kit/index.js'
import styles from './llm-settings.module.css'

const requestHostApi = async <Output,>(
  contract: HostApiContract,
  responseSchema: { parse(input: unknown): Output },
  params: unknown,
  request: unknown,
): Promise<Output> => {
  const url = buildHostApiContractPath(contract, params)
  const requestBody = contract.parseRequest(request)
  const response = await fetch(url, {
    method: contract.method,
    headers: { 'content-type': 'application/json' },
    ...(contract.method === 'GET' || contract.method === 'DELETE' ? {} : { body: JSON.stringify(requestBody) }),
  })
  const responseBody: unknown = await response.json()
  if (!response.ok) {
    const parsedError = HostApiErrorSchema.safeParse(responseBody)
    throw new Error(parsedError.success ? parsedError.data.error.message : `请求失败（HTTP ${response.status}）`)
  }
  return responseSchema.parse(responseBody)
}

export function WebSearchCredentialForm({ onSaved }: { readonly onSaved?: () => void }): ReactNode {
  const availability = useProductStore((state) => state.capabilityAvailability.webSearch)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [configured, setConfigured] = useState(availability.credentialConfigured)

  useEffect(() => {
    setConfigured(availability.credentialConfigured)
  }, [availability.credentialConfigured])

  const save = async (): Promise<void> => {
    const secret = value.trim()
    if (!secret || pending) return
    setPending(true)
    setError('')
    try {
      const next = await requestHostApi(
        HostApiContracts.dshCredentialSet,
        HostApiContracts.dshCredentialSet.response,
        { ref: availability.credentialReference },
        { value: secret },
      )
      setValue('')
      setConfigured(next.configured)
      try {
        await useProductStore.getState().refreshHost()
        notify('网页搜索凭据已保存。', 'success', 'web-search-credential-save')
        onSaved?.()
      } catch (refreshError) {
        notify(
          `凭据已保存，但页面数据刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
          'warning',
          'web-search-credential-save',
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={styles.compactForm}>
      {configured ? (
        <InlineFeedback tone="info">凭据已保存。若搜索仍不可用，可重新保存后再试。</InlineFeedback>
      ) : (
        <InlineFeedback tone="warning">网页搜索需要 DeepSeek API 密钥；每次搜索会产生额外模型费用。</InlineFeedback>
      )}
      <Field label="DeepSeek API 密钥" hint="只写保存，已保存值不会回显。" error={error || undefined}>
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </Field>
      <div className={styles.compactActions}>
        <Button
          variant="primary"
          loading={pending}
          loadingLabel="保存中…"
          disabled={pending || value.trim().length === 0}
          onClick={() => void save()}
        >
          保存凭据
        </Button>
      </div>
    </div>
  )
}

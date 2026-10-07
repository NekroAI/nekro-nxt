import { useState, type ReactNode } from 'react'
import { useProductRuntime, type LocalExtensionSummary } from '../product-runtime.js'
import { ConfirmDialog, SwitchRow } from '../ui-kit/index.js'
import { highRiskCapabilities, permissionLines } from './permissions.js'
import styles from './activation.module.css'

interface PendingApproval {
  readonly extension: LocalExtensionSummary
  readonly agentId: string
  readonly agentName: string
  readonly revision: LocalExtensionSummary['revisions'][number]
  readonly digest: string
  readonly resolve: (approved: boolean) => void
}

/**
 * Enabling an agent extension with the permission approval its Revision requires. Disabling and Revisions without
 * declared permissions go straight through; otherwise the returned dialog asks first and the approval is bound to
 * that Revision's exact permission digest. Render `dialog` once in the consuming page.
 */
export function useExtensionActivation(): {
  readonly setActive: (input: {
    readonly extensionId: string
    readonly agentId: string
    readonly enabled: boolean
    readonly revisionId?: string
  }) => Promise<boolean>
  readonly dialog: ReactNode
} {
  const product = useProductRuntime()
  const [pending, setPending] = useState<PendingApproval>()
  const [acceptedRisks, setAcceptedRisks] = useState<ReadonlySet<string>>(new Set())

  const setActive = async (input: {
    readonly extensionId: string
    readonly agentId: string
    readonly enabled: boolean
    readonly revisionId?: string
  }): Promise<boolean> => {
    const state = product.store.getState()
    const extension = state.extensions.find((candidate) => candidate.id === input.extensionId)
    const revisionId = input.revisionId ?? extension?.revisions.at(-1)?.id
    const revision = extension?.revisions.find((candidate) => candidate.id === revisionId)
    const verification = revision?.verification
    if (!input.enabled || !extension || !revision || !verification?.permissionApprovalRequired) {
      await state.setExtensionActive(input.extensionId, input.agentId, input.enabled, revisionId)
      return true
    }
    const digest = verification.permissionDigest
    if (!digest) throw new Error('这个扩展版本缺少权限摘要，无法批准。')
    setAcceptedRisks(new Set())
    const approved = await new Promise<boolean>((resolve) =>
      setPending({
        extension,
        agentId: input.agentId,
        agentName: state.agents.find((agent) => agent.id === input.agentId)?.name ?? '智能体',
        revision,
        digest,
        resolve,
      }),
    )
    return approved
  }

  const risks = pending === undefined ? [] : highRiskCapabilities(pending.revision.verification?.permissions)
  const dialog = pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (open) return
        pending.resolve(false)
        setPending(undefined)
      }}
      title={`允许「${pending.extension.name}」为${pending.agentName}工作？`}
      confirmLabel="允许并启用"
      confirmDisabled={risks.some((risk) => !acceptedRisks.has(risk.key))}
      onConfirm={async () => {
        await product.store
          .getState()
          .setExtensionActive(pending.extension.id, pending.agentId, true, pending.revision.id, pending.digest)
        pending.resolve(true)
        setPending(undefined)
      }}
    >
      <ul className={styles.permissions}>
        {permissionLines(pending.revision.verification?.permissions).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {risks.map((risk) => (
        <SwitchRow
          key={risk.key}
          title={risk.label}
          description={`${risk.detail === undefined ? '' : `${risk.key.startsWith('mcp.') ? '将运行' : '用途'}：${risk.detail}。`}这项能力不受范围限制，打开开关表示你了解并接受风险。`}
          checked={acceptedRisks.has(risk.key)}
          onCheckedChange={(checked) =>
            setAcceptedRisks((current) => {
              const next = new Set(current)
              if (checked) next.add(risk.key)
              else next.delete(risk.key)
              return next
            })
          }
        />
      ))}
    </ConfirmDialog>
  ) : null

  return { setActive, dialog }
}

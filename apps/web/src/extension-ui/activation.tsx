import { useState, type ReactNode } from 'react'
import { useProductRuntime, type LocalExtensionSummary } from '../product-runtime.js'
import { ConfirmDialog } from '../ui-kit/next/index.js'
import { permissionLines } from './permissions.js'
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
    </ConfirmDialog>
  ) : null

  return { setActive, dialog }
}

import type { ExtensionPermissionRequirement } from '@nekro-nxt/contracts'
import { useState, type ReactNode } from 'react'
import type { ExtensionApprovals } from '../product-model.js'
import { useProductRuntime, type LocalExtensionSummary, type ProductState } from '../product-runtime.js'
import { ConfirmDialog, SwitchRow } from '../ui-kit/index.js'
import { highRiskCapabilities, permissionLines } from './permissions.js'
import styles from './activation.module.css'

interface PendingApproval {
  readonly extension: LocalExtensionSummary
  readonly agentId: string
  readonly agentName: string
  readonly revision: LocalExtensionSummary['revisions'][number]
  /** Installing or switching the extension on this machine, when enabling does that and it needs approval. */
  readonly host?: ExtensionPermissionRequirement
  /** The agent-layer capabilities, when they need approval. */
  readonly agent?: ExtensionPermissionRequirement
  readonly resolve: (approved: boolean) => void
}

interface ActivationRequest {
  readonly extensionId: string
  readonly agentId: string
  readonly enabled: boolean
  readonly revisionId?: string
}

type ActivationTransition = NonNullable<LocalExtensionSummary['activationTransitions']>[number]

const transitionOf = (state: ProductState, input: ActivationRequest): ActivationTransition | undefined =>
  state.extensions
    .find((extension) => extension.id === input.extensionId)
    ?.activationTransitions?.find((transition) => transition.agentId === input.agentId)

/**
 * Whether the store already shows the outcome of a request: the Activation in its new state, or a fresh waiting or
 * failed transition for it. A request returns before the snapshot refresh it triggers, so the switch would otherwise
 * jump back for a moment.
 */
const reflects = (state: ProductState, input: ActivationRequest, before: ActivationTransition | undefined): boolean => {
  const extension = state.extensions.find((candidate) => candidate.id === input.extensionId)
  if (extension === undefined) return true
  const transition = transitionOf(state, input)
  if (transition !== undefined && transition !== before) return true
  const record = extension.activations.find((activation) => activation.agentId === input.agentId)
  return input.enabled
    ? record !== undefined && (input.revisionId === undefined || record.revisionId === input.revisionId)
    : record === undefined
}

const REFLECT_TIMEOUT_MS = 5_000

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

  /** Sends the request and resolves once the store shows its outcome (or after a bounded wait). */
  const apply = async (input: ActivationRequest, approvals?: ExtensionApprovals): Promise<void> => {
    const store = product.store
    const before = transitionOf(store.getState(), input)
    await store
      .getState()
      .setExtensionActive(input.extensionId, input.agentId, input.enabled, input.revisionId, approvals)
    if (reflects(store.getState(), input, before)) return
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, REFLECT_TIMEOUT_MS)
      const unsubscribe = store.subscribe((state) => {
        if (reflects(state, input, before)) finish()
      })
    })
  }

  const setActive = async (input: {
    readonly extensionId: string
    readonly agentId: string
    readonly enabled: boolean
    readonly revisionId?: string
  }): Promise<boolean> => {
    const state = product.store.getState()
    const extension = state.extensions.find((candidate) => candidate.id === input.extensionId)
    // One current version per machine: an installed extension is enabled on its installed record.
    const revisionId = input.revisionId ?? extension?.installation?.revisionId ?? extension?.revisions.at(-1)?.id
    const revision = extension?.revisions.find((candidate) => candidate.id === revisionId)
    const verification = revision?.verification
    const installs = extension?.installation?.revisionId !== revisionId
    const host = installs && verification?.hostPermission?.approvalRequired ? verification.hostPermission : undefined
    const agent = verification?.agentPermission?.approvalRequired ? verification.agentPermission : undefined
    if (!input.enabled || !extension || !revision || (host === undefined && agent === undefined)) {
      await apply({ ...input, ...(revisionId === undefined ? {} : { revisionId }) })
      return true
    }
    setAcceptedRisks(new Set())
    const approved = await new Promise<boolean>((resolve) =>
      setPending({
        extension,
        agentId: input.agentId,
        agentName: state.agents.find((agent) => agent.id === input.agentId)?.name ?? '智能体',
        revision,
        ...(host === undefined ? {} : { host }),
        ...(agent === undefined ? {} : { agent }),
        resolve,
      }),
    )
    return approved
  }

  const risks =
    pending === undefined
      ? []
      : [...highRiskCapabilities(pending.host?.declaration), ...highRiskCapabilities(pending.agent?.declaration)]
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
        await apply(
          {
            extensionId: pending.extension.id,
            agentId: pending.agentId,
            enabled: true,
            revisionId: pending.revision.id,
          },
          {
            ...(pending.host === undefined ? {} : { host: pending.host.permissionDigest }),
            ...(pending.agent === undefined ? {} : { agent: pending.agent.permissionDigest }),
          },
        )
        pending.resolve(true)
        setPending(undefined)
      }}
    >
      {pending.host === undefined ? null : (
        <>
          <p className={styles.layer}>安装到本机，对整台机器生效：</p>
          <ul className={styles.permissions}>
            {permissionLines(pending.host.declaration).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {pending.agent === undefined ? null : (
        <>
          {pending.host === undefined ? null : <p className={styles.layer}>只对{pending.agentName}生效：</p>}
          <ul className={styles.permissions}>
            {permissionLines(pending.agent.declaration).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
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

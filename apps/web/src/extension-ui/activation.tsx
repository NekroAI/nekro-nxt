import { configFields, type ConfigSchemaDocument, type ExtensionPermissionRequirement } from '@nekro-nxt/contracts'
import { useState, type ReactNode } from 'react'
import type { ExtensionApprovals } from '../product-model.js'
import { useProductRuntime, type LocalExtensionSummary, type ProductState } from '../product-runtime.js'
import { ConfirmDialog, SwitchRow } from '../ui-kit/index.js'
import { highRiskCapabilities, permissionLines, type PermissionLayer } from './permissions.js'
import styles from './activation.module.css'

/** Keys of the high-risk capabilities in a host and an agent approval; each must be accepted before confirming. */
export const approvalRiskKeys = (
  host: ExtensionPermissionRequirement | undefined,
  agent: ExtensionPermissionRequirement | undefined,
): readonly string[] =>
  [...highRiskCapabilities(host?.declaration, 'host'), ...highRiskCapabilities(agent?.declaration, 'agent')].map(
    (risk) => risk.key,
  )

const sentence = (text: string): string => text.replace(/[。.！!？?]+$/u, '')

/** Config field titles of one record, for naming the fields a `network.mode: 'config'` permission reaches. */
export const configFieldTitles = (revision: {
  readonly hostConfigSchema?: ConfigSchemaDocument | undefined
  readonly agentConfigSchema?: ConfigSchemaDocument | undefined
}): ((key: string) => string) => {
  const titles = new Map(
    [revision.hostConfigSchema, revision.agentConfigSchema].flatMap((schema) =>
      schema === undefined ? [] : configFields(schema).map((field) => [field.key, field.title] as const),
    ),
  )
  return (key) => titles.get(key) ?? key
}

/** One layer of an approval: its title, the ordinary permissions and one switch per high-risk capability. */
function ApprovalLayer({
  layer,
  title,
  requirement,
  accepted,
  onAcceptedChange,
  fieldTitle,
}: {
  readonly layer: PermissionLayer
  readonly title: string
  readonly requirement: ExtensionPermissionRequirement
  readonly accepted: ReadonlySet<string>
  readonly onAcceptedChange: (accepted: ReadonlySet<string>) => void
  readonly fieldTitle?: ((key: string) => string) | undefined
}) {
  const lines = permissionLines(requirement.declaration, layer, fieldTitle)
  const risks = highRiskCapabilities(requirement.declaration, layer)
  return (
    <div>
      <p className={styles.layer}>{title}</p>
      {lines.length === 0 ? null : (
        <ul className={styles.permissions}>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {risks.map((risk) => (
        <SwitchRow
          key={risk.key}
          title={risk.label}
          description={`${risk.detail === undefined ? '' : `${risk.key.startsWith(`${layer}:mcp.`) ? '将运行' : '用途'}：${sentence(risk.detail)}。`}这项能力没有范围限制，打开即表示接受风险。`}
          checked={accepted.has(risk.key)}
          onCheckedChange={(checked) => {
            const next = new Set(accepted)
            if (checked) next.add(risk.key)
            else next.delete(risk.key)
            onAcceptedChange(next)
          }}
        />
      ))}
    </div>
  )
}

/**
 * The body of a permission approval: the host layer (installing on this machine), then the agent layer, followed by
 * one switch per high-risk capability.
 */
export function PermissionApprovalList({
  host,
  agent,
  hostTitle,
  agentTitle,
  accepted,
  onAcceptedChange,
  fieldTitle,
}: {
  readonly fieldTitle?: (key: string) => string
  readonly host?: ExtensionPermissionRequirement | undefined
  readonly agent?: ExtensionPermissionRequirement | undefined
  readonly hostTitle: string
  readonly agentTitle: string
  readonly accepted: ReadonlySet<string>
  readonly onAcceptedChange: (accepted: ReadonlySet<string>) => void
}) {
  const shared = { accepted, onAcceptedChange, fieldTitle }
  return (
    <>
      {host === undefined ? null : <ApprovalLayer layer="host" title={hostTitle} requirement={host} {...shared} />}
      {agent === undefined ? null : <ApprovalLayer layer="agent" title={agentTitle} requirement={agent} {...shared} />}
    </>
  )
}

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

  const risks = pending === undefined ? [] : approvalRiskKeys(pending.host, pending.agent)
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
      confirmDisabled={risks.some((key) => !acceptedRisks.has(key))}
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
      <PermissionApprovalList
        host={pending.host}
        agent={pending.agent}
        hostTitle="安装到本机，对整台机器生效："
        agentTitle={`只对${pending.agentName}生效：`}
        accepted={acceptedRisks}
        onAcceptedChange={setAcceptedRisks}
        fieldTitle={configFieldTitles(pending.revision)}
      />
    </ConfirmDialog>
  ) : null

  return { setActive, dialog }
}

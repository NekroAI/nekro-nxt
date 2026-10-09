import type { ConnectionPanelRole, ExtensionPanelAnchor, PanelDensity, ToolViewDensity } from '@nekro-nxt/contracts'
import type { AdapterRichMessagePart, ExtensionToolCall } from '@nekro-nxt/extension-sdk'
import { createElement, useMemo, type ReactNode } from 'react'
import { useProductStore } from '../product-runtime.js'
import { ContributionBoundary, ContributionFrame } from './contribution-frame.js'
import type { ContributionRegistry, PanelEntry } from './registry.js'
import { useExtensionUiRuntime } from './runtime.js'

export interface PanelAnchor {
  readonly kind: ExtensionPanelAnchor
  /** Agent, channel, extension or connection id. For `connection` while adding an account, pass the Adapter key. */
  readonly id: string
}

interface PlacementContext {
  /** Whether an installed extension is enabled for an agent; read live from the product state. */
  readonly attached: (extensionId: string, agentId: string) => boolean
  /** Agent answering the anchored channel. */
  readonly channelAgentId?: string
  readonly channelKind?: 'internal' | 'direct' | 'group'
  /** Adapter of the anchored connection or channel. */
  readonly adapterKey?: string
}

/** Placement rules of Decision §5.1: which panels belong on one anchor. */
export const panelsForAnchor = (
  panels: readonly PanelEntry[],
  anchor: PanelAnchor,
  density: PanelDensity,
  context: PlacementContext,
  filter: { readonly role?: ConnectionPanelRole; readonly agentId?: string } = {},
): readonly PanelEntry[] => {
  const seen = new Set<string>()
  return panels.filter((entry) => {
    const { declaration, owner } = entry
    if (declaration.anchor !== anchor.kind || !declaration.densities.includes(density)) return false
    if (filter.role !== undefined && declaration.role !== filter.role) return false
    const forAgent = (agentId: string | undefined) =>
      agentId !== undefined &&
      (owner.kind === 'extension' ? context.attached(owner.extensionId, agentId) : owner.agentId === agentId)
    const ownAdapter =
      owner.kind === 'extension' && owner.adapterKey !== undefined && owner.adapterKey === context.adapterKey
    let placed = false
    switch (anchor.kind) {
      case 'agent':
        placed = forAgent(anchor.id)
        break
      case 'extension':
        placed =
          owner.kind === 'extension' &&
          owner.extensionId === anchor.id &&
          (filter.agentId === undefined || forAgent(filter.agentId))
        break
      case 'channel':
        placed = forAgent(context.channelAgentId) || ownAdapter
        if (placed && declaration.when?.channelKinds && context.channelKind) {
          placed = declaration.when.channelKinds.includes(context.channelKind)
        }
        break
      case 'connection':
        placed = ownAdapter
        break
    }
    if (!placed || seen.has(entry.key)) return false
    seen.add(entry.key)
    return true
  })
}

function usePlacement(anchor: PanelAnchor): PlacementContext {
  const channel = useProductStore((state) =>
    anchor.kind === 'channel' ? state.channels.find((candidate) => candidate.id === anchor.id) : undefined,
  )
  const connectionId = anchor.kind === 'connection' ? anchor.id : channel?.connectionId
  const connectionAdapter = useProductStore(
    (state) => state.connections.find((candidate) => candidate.id === connectionId)?.adapterKey,
  )
  const attached = useAttachedAgents()
  return useMemo(() => {
    // An unknown connection id while adding an account is the Adapter key itself.
    const adapterKey = connectionAdapter ?? (anchor.kind === 'connection' ? anchor.id : undefined)
    return {
      attached,
      ...(channel?.agentId ? { channelAgentId: channel.agentId } : {}),
      ...(channel ? { channelKind: channel.kind } : {}),
      ...(adapterKey === undefined ? {} : { adapterKey }),
    }
  }, [anchor.id, anchor.kind, attached, channel, connectionAdapter])
}

/** Live lookup of which agents each installed extension is enabled for. */
function useAttachedAgents(): (extensionId: string, agentId: string) => boolean {
  const extensions = useProductStore((state) => state.extensions)
  return useMemo(() => {
    const attached = new Map(
      extensions.map((extension) => [extension.id, new Set(extension.activations.map(({ agentId }) => agentId))]),
    )
    return (extensionId, agentId) => attached.get(extensionId)?.has(agentId) === true
  }, [extensions])
}

/**
 * Every installed panel that belongs on one object, each in its own frame and error boundary. Renders nothing when
 * no extension contributes here, so pages can place it unconditionally.
 */
export function PanelSlot({
  anchor,
  density,
  role,
  agentId,
  registry,
  className,
}: {
  readonly anchor: PanelAnchor
  readonly density: PanelDensity
  /** Connection panels only: `setup` while adding an account, `status` or `diagnostics` on the account. */
  readonly role?: ConnectionPanelRole
  /** Extension anchor only: show the panel as enabled for this agent. */
  readonly agentId?: string
  /** Defaults to the installed runtime; previews pass their own registry. */
  readonly registry?: ContributionRegistry
  readonly className?: string
}) {
  const runtime = useExtensionUiRuntime()
  const placement = usePlacement(anchor)
  const source = registry ?? runtime?.registry
  if (!source) return null
  const entries = panelsForAnchor(source.panels(), anchor, density, placement, {
    ...(role === undefined ? {} : { role }),
    ...(agentId === undefined ? {} : { agentId }),
  })
  if (entries.length === 0) return null
  return (
    <div className={className} data-panel-slot={anchor.kind}>
      {entries.map((entry) => (
        <ContributionFrame
          key={entry.key}
          title={entry.declaration.title}
          icon={entry.declaration.icon}
          source={entry.owner.label}
          density={density}
          styleScope={entry.owner.styleScope}
          resetKey={`${entry.owner.key}:${anchor.id}`}
          onError={(error) => runtime?.reportRenderFailure(entry.owner, error)}
        >
          {createElement(entry.component, {
            anchor: { kind: anchor.kind, id: anchor.id },
            density,
            ...(entry.declaration.role === undefined ? {} : { role: entry.declaration.role }),
          })}
        </ContributionFrame>
      ))}
    </div>
  )
}

/**
 * The extension's own view of one tool call, or `null` when no enabled extension of that agent provides one (the
 * host then shows its default rendering). `chip` is the one-line summary; `card` is the expanded view.
 */
export function ToolView({
  call,
  density,
  agentId,
  registry,
}: {
  readonly call: ExtensionToolCall
  readonly density: ToolViewDensity
  /** Agent that ran the tool; only its enabled extensions may render the call. */
  readonly agentId?: string
  readonly registry?: ContributionRegistry
}): ReactNode {
  const runtime = useExtensionUiRuntime()
  const attached = useAttachedAgents()
  const source = registry ?? runtime?.registry
  const entry = source
    ?.toolViews()
    .find(
      (candidate) =>
        candidate.tool === call.toolName &&
        (agentId === undefined ||
          (candidate.owner.kind === 'extension'
            ? attached(candidate.owner.extensionId, agentId)
            : candidate.owner.agentId === agentId)),
    )
  if (!entry) return null
  return (
    <span data-host-ui-owner={entry.owner.styleScope} data-tool-view={density}>
      <ContributionBoundary
        resetKey={`${entry.key}:${call.callId}:${call.state}`}
        onError={(error) => runtime?.reportRenderFailure(entry.owner, error)}
        fallback={() => null}
      >
        {createElement(entry.component, { call, density })}
      </ContributionBoundary>
    </span>
  )
}

/** Renders an Adapter `rich` message part with the installed renderer of that Adapter, or `fallback`. */
export function MessageRendererSlot({
  part,
  messageId,
  channelId,
  fallback,
  registry,
}: {
  readonly part: AdapterRichMessagePart
  readonly messageId: string
  readonly channelId: string
  readonly fallback: ReactNode
  readonly registry?: ContributionRegistry
}): ReactNode {
  const runtime = useExtensionUiRuntime()
  const source = registry ?? runtime?.registry
  const entry = source
    ?.messageRenderers()
    .find(
      (candidate) =>
        candidate.richKind === part.kind &&
        (candidate.owner.kind !== 'extension' || candidate.owner.adapterKey === part.adapterKey),
    )
  if (!entry) return fallback
  return (
    <div data-host-ui-owner={entry.owner.styleScope} data-message-renderer={part.kind}>
      <ContributionBoundary
        resetKey={`${entry.key}:${messageId}`}
        onError={(error) => runtime?.reportRenderFailure(entry.owner, error)}
        fallback={() => fallback}
      >
        {createElement(entry.component, { part, messageId, channelId })}
      </ContributionBoundary>
    </div>
  )
}

import { EXTENSION_DATA_HOOK_PERMISSIONS, type HostUiPermission } from '@nekro-nxt/contracts'
import type {
  ExtensionAgentView,
  ExtensionChannelRuntimeView,
  ExtensionChannelView,
  ExtensionClientData,
  ExtensionConnectionView,
} from '@nekro-nxt/extension-sdk'
import { useMemo } from 'react'
import { useStore } from 'zustand'
import type { ProductRuntime } from '../product-runtime.js'

type ProductStore = ProductRuntime['store']

const CONNECTION_STATES: readonly ExtensionConnectionView['state'][] = [
  'stopped',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
]

const connectionState = (value: string): ExtensionConnectionView['state'] =>
  CONNECTION_STATES.find((state) => state === value) ?? 'stopped'

const assertPermission = (permissions: ReadonlySet<HostUiPermission>, hook: keyof ExtensionClientData): void => {
  const permission = EXTENSION_DATA_HOOK_PERMISSIONS[hook]
  if (!permissions.has(permission)) {
    throw new Error(`${hook} 需要在扩展声明中申请 ${permission} 权限。`)
  }
}

/**
 * Read-only product data for one Client. Every Hook checks the permission the Revision declared (and the user
 * approved) before reading, and re-renders with product state; it selects the stored object and maps it in a memo
 * so unrelated updates do not re-render the contribution.
 */
export const createExtensionData = (
  store: ProductStore,
  permissions: ReadonlySet<HostUiPermission>,
): ExtensionClientData => ({
  useAgent(agentId: string): ExtensionAgentView | undefined {
    assertPermission(permissions, 'useAgent')
    const agent = useStore(store, (state) => state.agents.find((candidate) => candidate.id === agentId))
    return useMemo(() => (agent ? { id: agent.id, name: agent.name, phase: agent.state } : undefined), [agent])
  },
  useChannel(channelId: string): ExtensionChannelView | undefined {
    assertPermission(permissions, 'useChannel')
    const channel = useStore(store, (state) => state.channels.find((candidate) => candidate.id === channelId))
    return useMemo(
      () =>
        channel
          ? {
              id: channel.id,
              name: channel.name,
              kind: channel.kind,
              connectionId: channel.connectionId,
              ...(channel.agentId ? { agentId: channel.agentId } : {}),
            }
          : undefined,
      [channel],
    )
  },
  useConnection(connectionId: string): ExtensionConnectionView | undefined {
    assertPermission(permissions, 'useConnection')
    const connection = useStore(store, (state) => state.connections.find((candidate) => candidate.id === connectionId))
    return useMemo(
      () =>
        connection
          ? {
              id: connection.id,
              adapterKey: connection.adapterKey,
              name: connection.alias ?? connection.name,
              state: connectionState(connection.runtimeState),
            }
          : undefined,
      [connection],
    )
  },
  useChannelRuntime(channelId: string): ExtensionChannelRuntimeView | undefined {
    assertPermission(permissions, 'useChannelRuntime')
    const runtime = useStore(store, (state) => state.channelRuntimes[channelId])
    return useMemo(
      () =>
        runtime
          ? {
              channelId: runtime.channelId,
              phase: runtime.phase,
              ...(runtime.occupancy
                ? { contextTokens: runtime.occupancy.projectedTokens, contextWindow: runtime.occupancy.contextWindow }
                : {}),
            }
          : undefined,
      [runtime],
    )
  },
})

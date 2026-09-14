import type { HostApiContractName, HostApiParams, HostApiRequest, HostApiResponse } from '@nekro-nxt/contracts'
import type { ChannelRuntimeView, ConversationMessage, DshSettingsCatalog } from './product-model.js'

type Request<Name extends HostApiContractName> = (HostApiParams<Name> extends Record<string, never>
  ? object
  : HostApiParams<Name>) &
  (HostApiRequest<Name> extends undefined ? object : HostApiRequest<Name>)
type Action<Name extends HostApiContractName> = (input: Request<Name>) => Promise<HostApiResponse<Name>>

type RenameDisplayName<T> = T extends unknown ? Omit<T, 'displayName'> : never

export interface ProductActions {
  'settings.providers': (signal?: AbortSignal) => Promise<HostApiResponse<'llmProviders'>>
  'settings.catalog': (signal?: AbortSignal) => Promise<DshSettingsCatalog>

  'extensions.commitImport': Action<'commitExtensionImport'>
  'extensions.rebuild': Action<'rebuildExtensionRevision'>
  'extensions.delete': Action<'deleteLocalExtension'>
  'hostUi.updatePreferences': Action<'updateHostUiPagePreferences'>
  'host.refresh': () => Promise<null>
  'host.reconnect': () => Promise<null>
  'notifications.update': Action<'updateNotificationSettings'>
  'notifications.testBark': Action<'testBarkNotification'>
  'notifications.testSystem': () => Promise<HostApiResponse<'testSystemNotification'>>
  'platformUsers.list': (
    input?: Partial<HostApiParams<'listPlatformUsers'>>,
    signal?: AbortSignal,
  ) => Promise<HostApiResponse<'listPlatformUsers'>>
  'connections.listEvents': (
    input: Omit<HostApiParams<'listConnectionEvents'>, 'limit'> & { limit?: number },
  ) => Promise<HostApiResponse<'listConnectionEvents'>>
  'agents.create': Action<'createAgent'>
  'agents.revise': Action<'reviseAgent'>
  'agents.delete': Action<'deleteAgent'>
  'channels.resetContext': Action<'resetChannelContext'>
  'channels.delete': Action<'deleteChannel'>
  'channels.rename': Action<'renameChannel'>
  'agents.updateCapabilities': Action<'updateAgentCapabilities'>
  'connections.create': Action<'createConnection'>
  'connections.login.start': Action<'startConnectionLogin'>
  'connections.login.get': Action<'getConnectionLogin'>
  'connections.login.cancel': Action<'cancelConnectionLogin'>
  'connections.updateConfiguration': Action<'updateConnectionConfiguration'>
  'connections.updateAlias': Action<'updateConnectionAlias'>
  'connections.updateActivityTriggerDefaults': Action<'updateConnectionActivityTriggerDefaults'>
  'connections.delete': Action<'deleteConnection'>
  'connections.restore': Action<'restoreConnection'>
  'channels.createInternal': Action<'createInternalChannel'>
  'bindings.create': Action<'createBinding'>
  'bindings.clear': Action<'clearBinding'>
  'workTreeOrder.put': Action<'putWorkTreeOrder'>
  'connections.test': Action<'testConnection'>
  'dynamic.approve': Action<'dynamicApprove'>
  'dynamic.decline': Action<'dynamicDecline'>
  'authoring.decide': Action<'decideAuthoringAttempt'>
  'authoring.stop': Action<'stopAuthoringTask'>
  'authoring.delete': Action<'deleteAuthoringTask'>
  'extensions.activate': Action<'activateExtension'>
  'extensions.uninstall': Action<'uninstallHostExtension'>
  'extensions.hostClientDiagnostic': Action<'hostExtensionClientDiagnostic'>
  'extensions.deactivate': Action<'deactivateExtension'>
  'extensions.clientDiagnostic': Action<'extensionClientDiagnostic'>
  'channels.sendMessage': (
    input: HostApiParams<'sendChannelMessage'> & { body: string },
  ) => Promise<HostApiResponse<'sendChannelMessage'>>
  'channels.listMessages': (
    input: Omit<HostApiParams<'listChannelMessages'>, 'limit'> & {
      limit?: number
      mode?: 'initial' | 'older' | 'latest'
    },
  ) => Promise<{ messages: readonly ConversationMessage[]; hasMore: boolean }>
  'channels.getRuntime': (input: HostApiParams<'getChannelRuntime'>) => Promise<ChannelRuntimeView>
  'extensions.install': (
    input: HostApiParams<'installHostExtension'> &
      Omit<HostApiRequest<'installHostExtension'>, 'permissionApproval'> & { permissionDigest?: string },
  ) => Promise<HostApiResponse<'installHostExtension'>>
  'extensions.saveFromDynamic': (
    input: RenameDisplayName<HostApiRequest<'saveExtensionFromDynamic'>> & { name: string },
  ) => Promise<HostApiResponse<'saveExtensionFromDynamic'>>
  'extensions.clientCall': (
    input: HostApiParams<'extensionClientCall'> &
      Omit<HostApiRequest<'extensionClientCall'>, 'input'> & { value?: HostApiRequest<'extensionClientCall'>['input'] },
  ) => Promise<HostApiResponse<'extensionClientCall'>>
}

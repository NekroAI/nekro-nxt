import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from './host-api-client.js'
export type CommandCatalog = HostApiResponse<'listCommands'>
export const commandApi = {
  list: (channelId?: string, signal?: AbortSignal) =>
    callHostApi(HostApiContracts.listCommands, channelId ? { channelId } : {}, undefined, signal ? { signal } : {}),
  execute: (channelId: string, text: string, requestId: string) =>
    callHostApi(HostApiContracts.executeCommand, {}, { channelId, text, requestId }),
  members: (channelId: string) => callHostApi(HostApiContracts.listCommandMembers, { channelId }, undefined),
  policy: (scope: string, name: string, policy: HostApiResponse<'listCommands'>['commands'][number]['globalPolicy']) =>
    callHostApi(HostApiContracts.setCommandPolicy, {}, { scope, name, policy: policy ?? {} }),
  setBareCommands: (channelId: string, bareCommands: boolean) =>
    callHostApi(HostApiContracts.setCommandChannelSettings, {}, { channelId, bareCommands }),
  grant: (channelId: string, identityId: string, enabled: boolean) =>
    callHostApi(HostApiContracts.setCommandGrant, {}, { channelId, identityId, enabled }),
}

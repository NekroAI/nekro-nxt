import type { DeviceCredential } from './credential-vault.js'
import { InstanceOperationError } from './instance-operation-error.js'
import type { InstanceProfile, InstanceProfileStore } from './instance-profiles.js'
import {
  enrollRemoteDevice,
  inspectRemoteInstance,
  revokeRemoteDevice,
  type EnrollRemoteInput,
  type PairRemoteResult,
  type RemoteInspection,
} from './remote-pairing.js'

interface CredentialStore {
  put(credential: DeviceCredential): Promise<string | undefined>
  remove(reference: string): Promise<void>
}

interface RemotePairingGateway {
  inspect(address: string): Promise<RemoteInspection>
  enroll(input: EnrollRemoteInput): Promise<PairRemoteResult>
  revoke(paired: PairRemoteResult): Promise<void>
}

const defaultGateway: RemotePairingGateway = {
  inspect: inspectRemoteInstance,
  enroll: enrollRemoteDevice,
  revoke: revokeRemoteDevice,
}

interface RemoteProfileOperationInput {
  readonly profiles: Pick<
    InstanceProfileStore,
    'assertRemoteConnectionAvailable' | 'addRemote' | 'get' | 'updateRemoteConnection' | 'updateRemoteSecurity'
  >
  readonly credentials: CredentialStore
  readonly managementKey?: string
  readonly deviceLabel: string
  readonly clientReleaseId: string
  readonly gateway?: RemotePairingGateway
  readonly assertActive?: () => void
}

export interface AddRemoteProfileInput extends RemoteProfileOperationInput {
  readonly displayName: string
  readonly address: string
}

export interface ReauthenticateRemoteProfileInput extends RemoteProfileOperationInput {
  readonly profileId: string
}

export interface RemoteProfileEnrollmentResult {
  readonly profile: InstanceProfile
  readonly credential?: DeviceCredential
}

const enrollmentInput = (input: RemoteProfileOperationInput, inspection: RemoteInspection): EnrollRemoteInput => ({
  inspection,
  ...(input.managementKey === undefined ? {} : { managementKey: input.managementKey }),
  deviceLabel: input.deviceLabel,
  clientReleaseId: input.clientReleaseId,
})

const compensateEnrollment = async (
  gateway: RemotePairingGateway,
  credentials: CredentialStore,
  paired: PairRemoteResult,
  credentialRef: string | undefined,
): Promise<void> => {
  if (credentialRef !== undefined) {
    try {
      await credentials.remove(credentialRef)
    } catch {
      // Keep compensating remotely even when local encrypted-file cleanup fails.
    }
  }
  try {
    await gateway.revoke(paired)
  } catch {
    // Enrollment compensation is best-effort because the remote endpoint may disappear after enrollment.
  }
}

export const addRemoteProfile = async (input: AddRemoteProfileInput): Promise<RemoteProfileEnrollmentResult> => {
  const gateway = input.gateway ?? defaultGateway
  const origin = input.profiles.assertRemoteConnectionAvailable({ origin: input.address })
  const inspection = await gateway.inspect(origin)
  input.profiles.assertRemoteConnectionAvailable({
    origin: inspection.origin,
    observedInstanceId: inspection.descriptor.instanceId,
  })
  input.assertActive?.()
  const paired = await gateway.enroll(enrollmentInput(input, inspection))
  let credentialRef: string | undefined
  try {
    input.assertActive?.()
    input.profiles.assertRemoteConnectionAvailable({
      origin: paired.origin,
      observedInstanceId: paired.descriptor.instanceId,
    })
    const credential =
      paired.deviceId === undefined || paired.deviceSecret === undefined
        ? undefined
        : { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
    if (credential !== undefined) {
      input.assertActive?.()
      credentialRef = await input.credentials.put(credential)
    }
    input.assertActive?.()
    const profile = await input.profiles.addRemote({
      displayName: input.displayName,
      origin: paired.origin,
      observedInstanceId: paired.descriptor.instanceId,
      transport: paired.descriptor.transport,
      ...(paired.spkiSha256 === undefined ? {} : { pinnedSpkiSha256: paired.spkiSha256 }),
      ...(credentialRef === undefined ? {} : { credentialRef }),
    })
    return { profile, ...(credential === undefined ? {} : { credential }) }
  } catch (error) {
    await compensateEnrollment(gateway, input.credentials, paired, credentialRef)
    throw error
  }
}

export const reauthenticateRemoteProfile = async (
  input: ReauthenticateRemoteProfileInput,
): Promise<RemoteProfileEnrollmentResult> => {
  const current = input.profiles.get(input.profileId)
  if (current === undefined || current.kind !== 'remote' || current.observedInstanceId === undefined) {
    throw new Error('远程服务实例不存在。')
  }
  const gateway = input.gateway ?? defaultGateway
  if (current.transport === 'loopback-http') {
    throw new Error('本机 HTTP 服务实例不需要重新认证。')
  }
  const inspection = await gateway.inspect(current.origin)
  if (inspection.origin !== current.origin || inspection.descriptor.instanceId !== current.observedInstanceId) {
    throw new InstanceOperationError(
      'instance-identity-changed',
      '服务器地址或实例身份已经变化，请将其添加为新的服务实例。',
    )
  }
  input.assertActive?.()
  const paired = await gateway.enroll(enrollmentInput(input, inspection))
  if (
    paired.deviceId === undefined ||
    paired.deviceSecret === undefined ||
    (current.transport === 'auto-tls-pinned-v1' && paired.spkiSha256 === undefined)
  ) {
    throw new Error('服务器没有返回设备凭据。')
  }
  let credentialRef: string | undefined
  try {
    input.assertActive?.()
    const credential = { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
    input.assertActive?.()
    credentialRef = await input.credentials.put(credential)
    input.assertActive?.()
    const profile = await input.profiles.updateRemoteSecurity(current.id, {
      ...(paired.spkiSha256 === undefined ? {} : { pinnedSpkiSha256: paired.spkiSha256 }),
      ...(credentialRef === undefined ? {} : { credentialRef }),
    })
    if (current.credentialRef !== undefined && current.credentialRef !== credentialRef) {
      try {
        await input.credentials.remove(current.credentialRef)
      } catch {
        // The new Profile is already durable; stale encrypted data does not invalidate reauthentication.
      }
    }
    return { profile, credential }
  } catch (error) {
    await compensateEnrollment(gateway, input.credentials, paired, credentialRef)
    throw error
  }
}

export interface EditRemoteProfileConnectionInput extends RemoteProfileOperationInput {
  readonly profileId: string
  readonly displayName: string
  readonly address: string
}

export interface ReplacedRemoteProfileConnection {
  readonly partition?: string
  readonly credentialRef?: string
}

export interface RemoteProfileConnectionEditResult {
  readonly profile: InstanceProfile
  readonly credential?: DeviceCredential
  readonly replaced?: ReplacedRemoteProfileConnection
}

export const editRemoteProfileConnection = async (
  input: EditRemoteProfileConnectionInput,
): Promise<RemoteProfileConnectionEditResult> => {
  const current = input.profiles.get(input.profileId)
  if (current === undefined || current.kind !== 'remote' || current.observedInstanceId === undefined) {
    throw new Error('远程服务实例不存在。')
  }
  const gateway = input.gateway ?? defaultGateway
  const candidateOrigin = input.profiles.assertRemoteConnectionAvailable({ origin: input.address }, current.id)
  const originChanged = candidateOrigin !== current.origin
  const managementKeyProvided = input.managementKey !== undefined && input.managementKey.trim().length > 0
  if (!originChanged && !managementKeyProvided) {
    input.assertActive?.()
    const profile = await input.profiles.updateRemoteConnection(current.id, {
      displayName: input.displayName,
      origin: current.origin,
      observedInstanceId: current.observedInstanceId,
      ...(current.transport === undefined ? {} : { transport: current.transport }),
      ...(current.pinnedSpkiSha256 === undefined ? {} : { pinnedSpkiSha256: current.pinnedSpkiSha256 }),
      ...(current.credentialRef === undefined ? {} : { credentialRef: current.credentialRef }),
    })
    return { profile }
  }
  if (!originChanged && current.transport === 'loopback-http') {
    throw new Error('本机 HTTP 服务实例不需要重新认证。')
  }
  const inspection = await gateway.inspect(originChanged ? candidateOrigin : current.origin)
  if (originChanged) {
    if (inspection.descriptor.instanceId !== current.observedInstanceId) {
      throw new InstanceOperationError(
        'instance-identity-changed',
        '该地址对应另一个服务实例，不能迁移此服务实例，请将其添加为新的服务实例。',
      )
    }
  } else if (inspection.origin !== current.origin || inspection.descriptor.instanceId !== current.observedInstanceId) {
    throw new InstanceOperationError(
      'instance-identity-changed',
      '服务器地址或实例身份已经变化，请将其添加为新的服务实例。',
    )
  }
  input.profiles.assertRemoteConnectionAvailable(
    { origin: inspection.origin, observedInstanceId: inspection.descriptor.instanceId },
    current.id,
  )
  input.assertActive?.()
  const paired = await gateway.enroll(enrollmentInput(input, inspection))
  input.assertActive?.()
  input.profiles.assertRemoteConnectionAvailable(
    { origin: paired.origin, observedInstanceId: paired.descriptor.instanceId },
    current.id,
  )
  if (
    paired.descriptor.transport !== 'loopback-http' &&
    (paired.deviceId === undefined ||
      paired.deviceSecret === undefined ||
      (paired.descriptor.transport === 'auto-tls-pinned-v1' && paired.spkiSha256 === undefined))
  ) {
    throw new Error('服务器没有返回设备凭据。')
  }
  let credentialRef: string | undefined
  try {
    input.assertActive?.()
    const credential =
      paired.deviceId === undefined || paired.deviceSecret === undefined
        ? undefined
        : { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
    if (credential !== undefined) {
      input.assertActive?.()
      credentialRef = await input.credentials.put(credential)
    }
    input.assertActive?.()
    const profile = await input.profiles.updateRemoteConnection(current.id, {
      displayName: input.displayName,
      origin: paired.origin,
      observedInstanceId: paired.descriptor.instanceId,
      transport: paired.descriptor.transport,
      ...(paired.spkiSha256 === undefined ? {} : { pinnedSpkiSha256: paired.spkiSha256 }),
      ...(credentialRef === undefined ? {} : { credentialRef }),
    })
    const replaced: ReplacedRemoteProfileConnection = {
      ...(profile.partition === current.partition ? {} : { partition: current.partition }),
      ...(current.credentialRef === undefined || current.credentialRef === credentialRef
        ? {}
        : { credentialRef: current.credentialRef }),
    }
    return {
      profile,
      ...(credential === undefined ? {} : { credential }),
      ...(replaced.partition === undefined && replaced.credentialRef === undefined ? {} : { replaced }),
    }
  } catch (error) {
    await compensateEnrollment(gateway, input.credentials, paired, credentialRef)
    throw error
  }
}

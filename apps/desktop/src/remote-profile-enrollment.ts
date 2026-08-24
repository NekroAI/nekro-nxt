import type { DeviceCredential } from './credential-vault.js'
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
    'assertRemoteConnectionAvailable' | 'addRemote' | 'get' | 'updateRemoteSecurity'
  >
  readonly credentials: CredentialStore
  readonly managementKey: string
  readonly deviceLabel: string
  readonly clientReleaseId: string
  readonly gateway?: RemotePairingGateway
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
  readonly credential: DeviceCredential
}

const enrollmentInput = (input: RemoteProfileOperationInput, inspection: RemoteInspection): EnrollRemoteInput => ({
  inspection,
  managementKey: input.managementKey,
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
  const paired = await gateway.enroll(enrollmentInput(input, inspection))
  let credentialRef: string | undefined
  try {
    input.profiles.assertRemoteConnectionAvailable({
      origin: paired.origin,
      observedInstanceId: paired.descriptor.instanceId,
    })
    const credential = { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
    credentialRef = await input.credentials.put(credential)
    const profile = await input.profiles.addRemote({
      displayName: input.displayName,
      origin: paired.origin,
      observedInstanceId: paired.descriptor.instanceId,
      pinnedSpkiSha256: paired.spkiSha256,
      ...(credentialRef === undefined ? {} : { credentialRef }),
    })
    return { profile, credential }
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
  const inspection = await gateway.inspect(current.origin)
  if (inspection.origin !== current.origin || inspection.descriptor.instanceId !== current.observedInstanceId) {
    throw new Error('服务器地址或实例身份已经变化，请将其添加为新的服务实例。')
  }
  const paired = await gateway.enroll(enrollmentInput(input, inspection))
  let credentialRef: string | undefined
  try {
    const credential = { deviceId: paired.deviceId, deviceSecret: paired.deviceSecret }
    credentialRef = await input.credentials.put(credential)
    const profile = await input.profiles.updateRemoteSecurity(current.id, {
      pinnedSpkiSha256: paired.spkiSha256,
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

import { InstanceDescriptorSchema, ManagementDeviceIdSchema } from '@nekro-nxt/contracts'
import { describe, expect, it, vi } from 'vitest'
import { trustedInstanceFailure, trustedInstanceSuccess } from '../src/instance-operation-error.ts'
import { ManagerMutationLifecycle, runManagerMutation } from '../src/manager-mutation-lifecycle.ts'
import { addRemoteProfile } from '../src/remote-profile-enrollment.ts'
import type { PairRemoteResult, RemoteInspection } from '../src/remote-pairing.ts'
import { RuntimeCredentialStore } from '../src/runtime-credential-store.ts'
import { SerialTaskQueue } from '../src/serial-task-queue.ts'

const descriptor = InstanceDescriptorSchema.parse({
  format: 'nxt.instance-descriptor',
  descriptorVersion: 1,
  instanceId: 'nxt_instance_01H00000000000000000000020',
  releaseId: 'nxt.test-release',
  productVersion: '0.0.0-test',
  managementProtocol: 1,
  desktopChromeProtocol: 1,
  transport: 'auto-tls-pinned-v1',
})

const inspection: RemoteInspection = {
  origin: 'https://pending-mutation.example',
  descriptor,
  spkiSha256: 'test-spki',
}

const enrollment: PairRemoteResult = {
  ...inspection,
  deviceId: ManagementDeviceIdSchema.parse('nxt_device_01H00000000000000000000020'),
  deviceSecret: 'test-device-secret',
}

describe('Desktop manager mutation lifecycle', () => {
  it('cancels queued work on dispose and lets running enrollment compensate without partial local commits', async () => {
    const queue = new SerialTaskQueue()
    const lifecycle = new ManagerMutationLifecycle()
    const runtimeCredentials = new RuntimeCredentialStore()
    let releaseEnrollment!: () => void
    let markEnrollmentStarted!: () => void
    const enrollmentStarted = new Promise<void>((resolve) => {
      markEnrollmentStarted = resolve
    })
    const enrollmentGate = new Promise<void>((resolve) => {
      releaseEnrollment = resolve
    })
    const credentialPut = vi.fn(() => Promise.resolve('credential-ref'))
    const credentialRemove = vi.fn(() => Promise.resolve())
    const profileAdd = vi.fn(() => Promise.reject(new Error('profile add must not run')))
    const revoke = vi.fn(() => Promise.resolve())
    let queuedMutationExecuted = false

    const running = runManagerMutation(queue, lifecycle, async (token) => {
      const result = await addRemoteProfile({
        profiles: {
          assertRemoteConnectionAvailable: ({ origin }) => origin,
          addRemote: profileAdd,
          get: () => undefined,
          updateRemoteConnection: () => Promise.reject(new Error('connection update must not run')),
          updateRemoteSecurity: () => Promise.reject(new Error('security update must not run')),
        },
        credentials: { put: credentialPut, remove: credentialRemove },
        displayName: '待取消实例',
        address: inspection.origin,
        managementKey: 'm'.repeat(32),
        deviceLabel: 'NekroNXT test device',
        clientReleaseId: 'nxt.test-release',
        gateway: {
          inspect: () => Promise.resolve(inspection),
          enroll: async () => {
            markEnrollmentStarted()
            await enrollmentGate
            return enrollment
          },
          revoke,
        },
        assertActive: () => lifecycle.assertActive(token),
      })
      if (lifecycle.isActive(token) && result.credential !== undefined) {
        runtimeCredentials.set(result.profile.id, result.credential)
      }
    })
    const queued = runManagerMutation(queue, lifecycle, () => {
      queuedMutationExecuted = true
      return Promise.resolve()
    })
    const runningResult = running.then(trustedInstanceSuccess, trustedInstanceFailure)
    const queuedResult = queued.then(trustedInstanceSuccess, trustedInstanceFailure)

    await enrollmentStarted
    lifecycle.dispose()
    queue.close()
    runtimeCredentials.dispose()
    lifecycle.dispose()
    queue.close()
    runtimeCredentials.dispose()

    await expect(queuedResult).resolves.toEqual({
      ok: false,
      error: { code: 'operation-failed', message: '无法完成实例操作，请稍后重试。' },
    })
    expect(queuedMutationExecuted).toBe(false)

    releaseEnrollment()
    await expect(runningResult).resolves.toEqual({
      ok: false,
      error: { code: 'operation-failed', message: 'Desktop 已关闭，实例操作已取消。' },
    })
    expect(credentialPut).not.toHaveBeenCalled()
    expect(profileAdd).not.toHaveBeenCalled()
    expect(credentialRemove).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledOnce()
    expect(runtimeCredentials.size).toBe(0)
  })
})

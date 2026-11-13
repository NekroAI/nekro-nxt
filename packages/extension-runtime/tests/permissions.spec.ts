import { describe, expect, it } from 'vitest'
import type { ExtensionCapabilities } from '@nekro-nxt/contracts'
import { hostUiPermissionDigest, permissionRequirement } from '../src/permissions.js'

const declaration = (capabilities: ExtensionCapabilities) => ({ permissions: [], networkOrigins: [], capabilities })

describe('approval digest of media, commands and speech', () => {
  it('ignores the order of command profiles and covers each new one', () => {
    expect(hostUiPermissionDigest(declaration({ commands: { profiles: ['ffmpeg', 'ffprobe'] } }))).toBe(
      hostUiPermissionDigest(declaration({ commands: { profiles: ['ffprobe', 'ffmpeg'] } })),
    )
    const granted = {
      ownerKey: 'ext_FIXTURE',
      artifactDigest: 'a'.repeat(64),
      permissionDigest: 'b'.repeat(64),
      declaration: declaration({ media: true, commands: { profiles: ['ffprobe' as const] } }),
      approvedAt: 1,
    }
    expect(
      permissionRequirement(declaration({ commands: { profiles: ['ffprobe'] }, media: true }), granted),
    ).toMatchObject({
      approvalRequired: false,
    })
    expect(
      permissionRequirement(declaration({ media: true, commands: { profiles: ['ffprobe', 'ffmpeg'] } }), granted),
    ).toMatchObject({ approvalRequired: true })
    expect(
      hostUiPermissionDigest(declaration({ speech: { maxCallsPerMinute: 5 } })) ===
        hostUiPermissionDigest(declaration({ speech: { maxCallsPerMinute: 6 } })),
    ).toBe(false)
  })
})

describe('outbound permission approval', () => {
  it.each(['read', 'transform', 'cancel'] as const)('requires an explicit grant for outbound %s', (capability) => {
    const requested = declaration({ outbound: { [capability]: true, timeoutMs: 1000 } })
    const missing = permissionRequirement(requested, undefined)
    expect(missing.approvalRequired).toBe(true)
    expect(missing.declaration.capabilities?.outbound).toEqual(requested.capabilities.outbound)
    expect(missing.permissionDigest).not.toBe(hostUiPermissionDigest(declaration({})))

    // Older grants that omitted outbound do not authorize it during activation or restoration.
    const prior = {
      ownerKey: 'activation:agt_FIXTURE:ext_FIXTURE',
      artifactDigest: 'a'.repeat(64),
      permissionDigest: hostUiPermissionDigest(declaration({})),
      declaration: declaration({}),
      approvedAt: 1,
    }
    expect(permissionRequirement(requested, prior).approvalRequired).toBe(true)
    expect(permissionRequirement(requested, { ...prior, declaration: missing.declaration }).approvalRequired).toBe(
      false,
    )
  })

  it('requires renewed approval for outbound expansion and failure cancellation, but permits narrowing', () => {
    const requested = declaration({ outbound: { read: true, timeoutMs: 1000, onTimeout: 'send' } })
    const prior = {
      ownerKey: 'activation:agt_FIXTURE:ext_FIXTURE',
      artifactDigest: 'a'.repeat(64),
      permissionDigest: hostUiPermissionDigest(requested),
      declaration: permissionRequirement(requested, undefined).declaration,
      approvedAt: 1,
    }
    for (const outbound of [
      { read: true as const, transform: true as const, timeoutMs: 1000 },
      { read: true as const, cancel: true as const, timeoutMs: 1000 },
      { read: true as const, timeoutMs: 1000, onTimeout: 'cancel' as const },
    ]) {
      expect(permissionRequirement(declaration({ outbound }), prior).approvalRequired).toBe(true)
    }
    expect(permissionRequirement(declaration({}), prior).approvalRequired).toBe(false)
  })
})

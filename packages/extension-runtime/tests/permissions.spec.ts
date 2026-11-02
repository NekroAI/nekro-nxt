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

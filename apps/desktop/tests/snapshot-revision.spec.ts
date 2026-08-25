import { describe, expect, it } from 'vitest'
import { SnapshotRevisionClock } from '../src/snapshot-revision.ts'

describe('Desktop snapshot revision clock', () => {
  it('is monotonic and does not emit a revision for an unchanged presentation', () => {
    const clock = new SnapshotRevisionClock()
    expect(clock.commit({ currentProfileId: 'local', status: 'ready' })).toBe(1)
    expect(clock.commit({ currentProfileId: 'local', status: 'ready' })).toBeUndefined()
    expect(clock.revision).toBe(1)
    expect(clock.commit({ currentProfileId: 'local', status: 'offline' })).toBe(2)
    expect(clock.revision).toBe(2)
  })
})

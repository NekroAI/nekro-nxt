import { memoryNxtJobs, memoryNxtStorage } from '../../src/extension-host-backends.js'
import type { NxtServiceBackends } from '../../src/extension-host-service.js'

/** Publishes nxt for lifecycle-only tests; unexpected product operations fail explicitly. */
export const unusedNxtBackends = (): NxtServiceBackends => {
  const unused = () => Promise.reject(new Error('Unexpected nxt operation in a lifecycle-only fixture.'))
  return {
    fetch: unused,
    storage: memoryNxtStorage(() => 1),
    secret: unused,
    createAsset: unused,
    callContext: unused,
    members: { describe: unused },
    platform: { catalog: unused, invoke: unused, raw: unused, selfPlatformUserId: unused },
    jobs: memoryNxtJobs(),
    complete: unused,
    history: { list: unused, search: unused },
  }
}

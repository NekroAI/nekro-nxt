import { memoryNxtJobs, memoryNxtStorage } from '../../src/extension-host-backends.js'
import type { NxtServiceBackends } from '../../src/extension-host-service.js'
import { memoryIndexEngine } from '../../src/extension-index.js'
import { ExtensionLibrary, memoryLibraryRegistry } from '../../src/extension-library.js'

/** A library that knows no Assets: every lookup reports a missing picture. */
export const emptyExtensionLibrary = (): ExtensionLibrary =>
  new ExtensionLibrary({
    registry: memoryLibraryRegistry(),
    assets: { getAssetById: () => undefined, canAccessAsset: () => false, grantAssetAccess: () => undefined },
    assetService: {
      prepare: () => Promise.reject(new Error('Unexpected Asset write in a fixture.')),
      blobPath: () => {
        throw new Error('Unexpected Asset read in a fixture.')
      },
    },
    now: () => 1,
  })

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
    library: emptyExtensionLibrary(),
    index: memoryIndexEngine(),
    models: { list: unused, complete: unused },
  }
}

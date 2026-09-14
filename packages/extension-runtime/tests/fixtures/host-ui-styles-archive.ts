import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { ExtensionIdSchema, ExtensionRevisionIdSchema } from '@nekro-nxt/contracts'
import { materializeDynamicPackage } from '../../src/materializer.js'
import { stylesSnapshot } from './host-ui-styles.js'

/** A real transferable revision made from the same body used by the runtime regression. */
export function createStylesArchive(suffix: string) {
  const extensionId = ExtensionIdSchema.parse(`ext_STYLES${suffix}`)
  const revisionId = ExtensionRevisionIdSchema.parse(`xrv_STYLES${suffix}`)
  const revision = materializeDynamicPackage({ extensionId, revisionId, snapshot: stylesSnapshot })
  const files: Record<string, Uint8Array> = {
    'revision/manifest.json': strToU8(JSON.stringify(revision.manifest)),
    'revision/source/client.ts': strToU8(revision.sources.client!),
    ...Object.fromEntries(
      Object.entries(revision.resources ?? {}).map(([name, content]) => [`revision/${name}`, strToU8(content)]),
    ),
  }
  files['manifest.json'] = strToU8(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'nekro-nxt-extension',
      extension: {
        id: extensionId,
        scope: 'host-ui',
        slug: `styles-probe-${suffix.toLowerCase()}`,
        displayName: stylesSnapshot.name,
        description: stylesSnapshot.purpose,
        createdAt: 1,
      },
      revision: {
        id: revisionId,
        revisionNumber: 1,
        contentDigest: revision.contentDigest,
        payloadDigest: revision.payloadDigest,
        createdAt: 1,
      },
      files: Object.entries(files).map(([path, content]) => ({
        path,
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      })),
      sourceVerification: null,
    }),
  )
  return { extensionId, revisionId, archive: zipSync(files) }
}

import { materializeImportedRevision, sha256Hex } from '@nekro-nxt/extension-format'
import { zipSync, strToU8 } from 'fflate'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = import.meta.dirname
const materialized = materializeImportedRevision({
  manifest: JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')),
  sources: { host: await readFile(path.join(root, 'source/host.ts'), 'utf8') },
})
const files: Record<string, Uint8Array> = {
  'revision/manifest.json': strToU8(JSON.stringify(materialized.manifest, null, 2) + '\n'),
  'revision/source/host.ts': strToU8(materialized.sources.host!),
}
const transfer = {
  schemaVersion: 2,
  kind: 'nekro-nxt-extension',
  extension: {
    id: materialized.manifest.extensionId,
    slug: 'command-echo',
    displayName: '命令回声示例',
    description: '无需模型会话的命令扩展示例。',
    createdAt: 1,
  },
  revision: {
    id: materialized.manifest.revisionId,
    revisionNumber: 1,
    contentDigest: materialized.contentDigest,
    payloadDigest: materialized.payloadDigest,
    createdAt: 1,
  },
  files: Object.entries(files).map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: sha256Hex(bytes) })),
  sourceVerification: null,
}
files['manifest.json'] = strToU8(JSON.stringify(transfer, null, 2) + '\n')
const output = path.resolve(root, '../../../../.local/command-echo.nxt-extension')
await mkdir(path.dirname(output), { recursive: true })
await writeFile(output, zipSync(files))
console.log(output)

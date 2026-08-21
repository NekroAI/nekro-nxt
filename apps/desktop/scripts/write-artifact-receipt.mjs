import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../distributions.json' with { type: 'json' }

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const channel = option('--channel')
const platform = option('--platform')
if ((channel !== 'preview' && channel !== 'stable') || !['mac', 'win', 'linux'].includes(platform)) {
  throw new Error('产物 receipt 需要有效的 --channel 与 --platform。')
}

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(await readFile(path.join(appRoot, 'dist', 'product-release.json'), 'utf8'))
const distribution = desktopDistributions[channel]
const artifactName =
  platform === 'mac'
    ? `${distribution.artifactSlug}-mac-universal-v${release.version}.dmg`
    : platform === 'win'
      ? `${distribution.artifactSlug}-win-x64-v${release.version}-setup.exe`
      : `${distribution.artifactSlug}-linux-x64-v${release.version}.AppImage`
const artifact = path.join(appRoot, 'release', channel, artifactName)
const hash = createHash('sha256')
for await (const chunk of createReadStream(artifact)) hash.update(chunk)
const artifactStat = await stat(artifact)
const receipt = {
  format: 'nxt.desktop-artifact-receipt',
  version: 1,
  channel,
  platform,
  arch: platform === 'mac' ? 'universal' : 'x64',
  baseVersion: release.baseVersion,
  releaseVersion: release.version,
  releaseId: release.releaseId,
  commit: release.commit,
  artifact: artifactName,
  bytes: artifactStat.size,
  sha256: hash.digest('hex'),
  signed: false,
}
await writeFile(`${artifact}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

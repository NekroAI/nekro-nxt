import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../distributions.json' with { type: 'json' }
import { artifactTarget, desktopArchitecture, readArtifactIntegrity } from '../../../scripts/product-release.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const channel = option('--channel')
const platform = option('--platform')
const arch = option('--arch')
if ((channel !== 'preview' && channel !== 'stable') || !['mac', 'win', 'linux'].includes(platform)) {
  throw new Error('产物 receipt 需要有效的 --channel 与 --platform。')
}
const resolvedArch = desktopArchitecture(platform, arch)

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(await readFile(path.join(appRoot, 'dist', 'product-release.json'), 'utf8'))
const distribution = desktopDistributions[channel]
const target = artifactTarget(distribution, release.version, platform, resolvedArch)
const artifactName = target.artifactName
const artifact = path.join(appRoot, 'release', channel, artifactName)
const integrity = await readArtifactIntegrity(artifact)
const receipt = {
  format: 'nxt.desktop-artifact-receipt',
  version: 1,
  channel,
  platform,
  arch: target.arch,
  baseVersion: release.baseVersion,
  releaseVersion: release.version,
  releaseId: release.releaseId,
  commit: release.commit,
  artifact: artifactName,
  bytes: integrity.bytes,
  sha256: integrity.sha256,
  signed: false,
}
await writeFile(`${artifact}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

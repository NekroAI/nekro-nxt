import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import desktopDistributions from '../distributions.json' with { type: 'json' }
import { artifactTarget, desktopArchitectures } from '../../../scripts/product-release.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const channel = option('--channel')
if (channel !== 'preview' && channel !== 'stable') {
  throw new Error(`macOS 产物验证需要有效的 --channel：${channel ?? 'undefined'}`)
}
if (process.platform !== 'darwin') throw new Error('macOS 产物签名只能在 macOS 上验证。')

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const release = JSON.parse(await readFile(path.join(appRoot, 'dist', 'product-release.json'), 'utf8'))
const distribution = desktopDistributions[channel]

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${path.basename(command)} 验证失败${details === '' ? '' : `：\n${details}`}`)
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

for (const arch of desktopArchitectures('mac')) {
  const target = artifactTarget(distribution, release.version, 'mac', arch)
  const artifact = path.join(appRoot, 'release', channel, target.artifactName)
  const mountPoint = await mkdtemp(path.join(os.tmpdir(), `nekro-nxt-${channel}-${arch}-`))
  let mounted = false
  try {
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, artifact])
    mounted = true
    const app = path.join(mountPoint, `${distribution.productName}.app`)
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', app])
    const signature = run('/usr/bin/codesign', ['-dv', '--verbose=4', app])
    if (signature.includes('linker-signed') || !signature.includes(`Identifier=${distribution.appId}`)) {
      throw new Error(`macOS ${arch} 应用没有完整签署，或签名身份与 ${distribution.appId} 不一致。`)
    }
  } finally {
    if (mounted) spawnSync('/usr/bin/hdiutil', ['detach', mountPoint], { encoding: 'utf8' })
    await rm(mountPoint, { recursive: true, force: true })
  }
}

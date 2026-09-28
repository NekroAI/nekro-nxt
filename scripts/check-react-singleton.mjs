import { realpath, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const expectedVersion = '18.3.1'
const isNodeError = (error, code) => error instanceof Error && 'code' in error && error.code === code

async function workspaceManifests(directory) {
  const manifests = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(directory, entry.name, 'package.json')
    try {
      manifests.push([manifestPath, JSON.parse(await readFile(manifestPath, 'utf8'))])
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
  return manifests
}

export async function checkReactSingleton({ root = process.cwd() } = {}) {
  const errors = []
  for (const workspaceRoot of ['apps', 'packages']) {
    for (const [manifestPath, manifest] of await workspaceManifests(path.join(root, workspaceRoot))) {
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const packageName of ['react', 'react-dom']) {
          const declared = manifest[section]?.[packageName]
          if (declared !== undefined && declared !== expectedVersion) {
            errors.push(`${path.relative(root, manifestPath)}: ${section}.${packageName} 必须固定为 ${expectedVersion}`)
          }
        }
      }
    }
  }

  const webRequire = createRequire(path.join(root, 'apps/web/package.json'))
  const compatRequire = createRequire(path.join(root, 'packages/dsh-compat/package.json'))
  const rendererManifest = compatRequire.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json')
  const rendererRequire = createRequire(rendererManifest)

  for (const packageName of ['react', 'react-dom']) {
    const resolutions = [webRequire, compatRequire, rendererRequire]
    const installed = await Promise.all(
      resolutions.map(async (resolver) => {
        const manifestPath = resolver.resolve(`${packageName}/package.json`)
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        return { manifestPath: await realpath(manifestPath), version: manifest.version }
      }),
    )
    const paths = new Set(installed.map(({ manifestPath }) => manifestPath))
    const versions = new Set(installed.map(({ version }) => version))
    if (paths.size !== 1 || versions.size !== 1 || !versions.has(expectedVersion)) {
      errors.push(`${packageName} 未解析为同一个 ${expectedVersion} 实例：${JSON.stringify(installed)}`)
    }
  }

  return errors
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const errors = await checkReactSingleton()
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`React singleton check passed (${expectedVersion}).`)
  }
}

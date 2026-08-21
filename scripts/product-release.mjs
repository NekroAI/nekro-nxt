import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const readPackage = async (repositoryRoot, relativePath) =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath, 'package.json'), 'utf8'))

export async function readProductRelease(repositoryRoot) {
  const [rootPackage, desktopPackage, serverPackage] = await Promise.all([
    readPackage(repositoryRoot, '.'),
    readPackage(repositoryRoot, 'apps/desktop'),
    readPackage(repositoryRoot, 'apps/server'),
  ])
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  const dshVersion = serverPackage.dependencies?.['@deepseek-ai/dsh-session-persistence-sqlite']
  if (
    typeof rootPackage.version !== 'string' ||
    rootPackage.version !== desktopPackage.version ||
    typeof dshVersion !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(commit)
  ) {
    throw new Error('无法生成 NekroNxt 产品 Release 清单。')
  }
  return {
    format: 'nxt.product-release',
    version: rootPackage.version,
    commit,
    releaseId: `${rootPackage.version}+${commit.slice(0, 12)}`,
    dshVersion,
  }
}

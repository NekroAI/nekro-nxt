import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

describe('Desktop runtime dependencies', () => {
  it('pins the approved aged Electron release with the WebContentsView hit-test fix', async () => {
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const repositoryRoot = path.resolve(desktopRoot, '../..')
    const packageJson: unknown = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'))
    const dependencies = isRecord(packageJson) ? packageJson['devDependencies'] : undefined
    const electron = isRecord(dependencies) ? dependencies['electron'] : undefined
    if (typeof electron !== 'string') throw new Error('Desktop package must declare Electron.')
    expect(electron).toBe('42.9.0')

    const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
    expect(lockfile).toContain(`specifier: ${electron}`)
    expect(lockfile).toContain(`electron@${electron}:`)

    const workspace = await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
    const exclusions = workspace.split('minimumReleaseAgeExclude:')[1]?.split('# Desktop Release')[0] ?? ''
    expect(exclusions).not.toContain('electron@')
  })
})

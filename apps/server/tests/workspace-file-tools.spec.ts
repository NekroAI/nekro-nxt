import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { strToU8, zipSync } from 'fflate'
import type * as FileOperations from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanTrash,
  copyFileEntry,
  deleteEntry,
  diffFiles,
  fileInfo,
  makeDirectory,
  mountWorkspaceFileTools,
  moveFileEntry,
  TRASH_DIRECTORY,
  unzipEntry,
  zipEntry,
  type FileToolScope,
} from '../src/workspace-file-tools.ts'
import { mountDevelopmentCapabilities } from '../src/index.ts'

const archiveOpenRace = vi.hoisted(() => ({
  beforeOpen: undefined as ((target: string) => void) | undefined,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileOperations>()
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      archiveOpenRace.beforeOpen?.(String(args[0]))
      return actual.createWriteStream(...args)
    },
  }
})

const directories: string[] = []
afterEach(() => {
  archiveOpenRace.beforeOpen = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A workspace with a sibling folder outside it, both real paths. */
const fixture = (unrestricted = false) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'nekro-nxt-files-')))
  directories.push(base)
  const workspace = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), 'outside')
  const scope: FileToolScope = { workspace, unrestricted }
  const file = (name: string, content = name) => {
    mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true })
    writeFileSync(path.join(workspace, name), content)
  }
  return { workspace, outside, scope, file }
}

describe('moving, copying and making folders', () => {
  it('moves and renames inside the workspace without replacing anything', async () => {
    const { workspace, scope, file } = fixture()
    file('a.txt')
    file('b.txt')
    expect(await moveFileEntry(scope, 'a.txt', 'docs/renamed.txt')).toEqual({ from: 'a.txt', to: 'docs/renamed.txt' })
    expect(readFileSync(path.join(workspace, 'docs/renamed.txt'), 'utf8')).toBe('a.txt')
    await expect(moveFileEntry(scope, 'b.txt', 'docs/renamed.txt')).rejects.toThrow('已经存在')
    await expect(moveFileEntry(scope, 'docs', 'docs/inner')).rejects.toThrow('自己里面')
  })

  it('keeps everything inside the workspace, also through a symlinked folder', async () => {
    const { workspace, outside, scope, file } = fixture()
    file('a.txt')
    symlinkSync(outside, path.join(workspace, 'link'))
    await expect(moveFileEntry(scope, 'a.txt', '../outside/a.txt')).rejects.toThrow('只能操作你工作区里的位置')
    await expect(moveFileEntry(scope, 'a.txt', 'link/a.txt')).rejects.toThrow('只能操作你工作区里的位置')
    await expect(copyFileEntry(scope, 'link/secret.txt', 'copied.txt')).rejects.toThrow('只能操作你工作区里的位置')
    await expect(makeDirectory(scope, 'link/new')).rejects.toThrow('只能操作你工作区里的位置')
    await expect(deleteEntry(scope, '.', true)).rejects.toThrow('整个工作区')
    expect(existsSync(path.join(outside, 'a.txt'))).toBe(false)
  })

  it('reaches outside the workspace with full access', async () => {
    const { outside, scope, file } = fixture(true)
    file('a.txt')
    const moved = await moveFileEntry(scope, 'a.txt', path.join(outside, 'a.txt'))
    expect(moved.to).toBe(path.join(outside, 'a.txt'))
    expect(existsSync(path.join(outside, 'a.txt'))).toBe(true)
  })

  it('copies folders and makes nested folders', async () => {
    const { workspace, scope, file } = fixture()
    file('src/one.txt')
    file('src/deep/two.txt')
    expect(await copyFileEntry(scope, 'src', 'backup')).toMatchObject({ to: 'backup', entries: 4 })
    expect(readFileSync(path.join(workspace, 'backup/deep/two.txt'), 'utf8')).toBe('src/deep/two.txt')
    expect(await makeDirectory(scope, 'a/b/c')).toEqual({ path: 'a/b/c' })
    await expect(makeDirectory(scope, 'a/b')).rejects.toThrow('已经存在')
  })
})

describe('deleting into the workspace trash', () => {
  it('moves what is deleted into the trash with its path, and empties the trash only for good', async () => {
    const { workspace, scope, file } = fixture()
    file('notes/a.txt')
    await expect(deleteEntry(scope, 'notes', false)).rejects.toThrow('recursive')
    const deleted = await deleteEntry(scope, 'notes', true, new Date(Date.UTC(2026, 10, 4, 8, 0, 0)))
    expect(deleted.permanent).toBe(false)
    expect(deleted.trashed).toMatch(/^\.trash\/20261104-080000-[0-9a-f]{4}\/notes$/u)
    expect(existsSync(path.join(workspace, 'notes'))).toBe(false)
    expect(readFileSync(path.join(workspace, deleted.trashed!, 'a.txt'), 'utf8')).toBe('notes/a.txt')
    expect(await deleteEntry(scope, deleted.trashed!, true)).toMatchObject({ permanent: true })
    await expect(deleteEntry(scope, TRASH_DIRECTORY, true)).rejects.toThrow('自动清理')
  })

  it('cleans deletions older than seven days and leaves other entries alone', async () => {
    const { workspace } = fixture()
    const trash = path.join(workspace, TRASH_DIRECTORY)
    for (const name of ['20261020-000000-aaaa', '20261101-000000-bbbb', 'kept-by-hand']) {
      mkdirSync(path.join(trash, name), { recursive: true })
    }
    await cleanTrash(workspace, new Date(Date.UTC(2026, 10, 4)))
    expect(existsSync(path.join(trash, '20261020-000000-aaaa'))).toBe(false)
    expect(existsSync(path.join(trash, '20261101-000000-bbbb'))).toBe(true)
    expect(existsSync(path.join(trash, 'kept-by-hand'))).toBe(true)
  })
})

describe('inspecting and comparing', () => {
  it('reports a file with its hash and refuses a link that points outside', async () => {
    const { workspace, outside, scope, file } = fixture()
    file('a.txt', 'hello')
    expect(await fileInfo(scope, 'a.txt')).toMatchObject({
      type: 'file',
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
    symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'secret-link'))
    expect(await fileInfo(scope, 'secret-link')).toMatchObject({ type: 'symlink' })
    await expect(diffFiles(scope, 'a.txt', 'secret-link')).rejects.toThrow('只能操作你工作区里的位置')
  })

  it('shows a unified diff of two text files', async () => {
    const { scope, file } = fixture()
    file('old.txt', 'one\ntwo\n')
    file('new.txt', 'one\nthree\n')
    file('same.txt', 'one\ntwo\n')
    const result = await diffFiles(scope, 'old.txt', 'new.txt')
    expect(result.diff).toContain('-two')
    expect(result.diff).toContain('+three')
    expect(await diffFiles(scope, 'old.txt', 'same.txt')).toEqual({ same: true, diff: '' })
  })
})

describe('zip and unzip', () => {
  it('preserves a competing archive created after preflight when exclusive open fails', async () => {
    const { workspace, scope, file } = fixture()
    file('source.txt', 'original source')
    const target = path.join(workspace, 'pack.zip')
    const competingArchive = 'synthetic competing archive'
    archiveOpenRace.beforeOpen = (openedTarget) => {
      expect(openedTarget).toBe(target)
      writeFileSync(target, competingArchive, { flag: 'wx' })
    }

    await expect(zipEntry(scope, 'source.txt', 'pack.zip')).rejects.toMatchObject({ code: 'EEXIST' })

    expect(readFileSync(target, 'utf8')).toBe(competingArchive)
    expect(readFileSync(path.join(workspace, 'source.txt'), 'utf8')).toBe('original source')
  })

  it('round-trips a folder and leaves links out', async () => {
    const { workspace, outside, scope, file } = fixture()
    file('pack/a.txt', 'alpha')
    file('pack/sub/b.txt', 'beta')
    symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'pack/link'))
    expect(await zipEntry(scope, 'pack', 'pack.zip')).toMatchObject({ files: 2, skipped: 1 })
    expect(await unzipEntry(scope, 'pack.zip', 'out')).toMatchObject({ to: 'out', files: 2 })
    expect(readFileSync(path.join(workspace, 'out/pack/sub/b.txt'), 'utf8')).toBe('beta')
    expect(existsSync(path.join(workspace, 'out/pack/link'))).toBe(false)
    await expect(unzipEntry(scope, 'pack.zip', 'out')).rejects.toThrow('已经存在')
    // Completion owns no archive or output handles, including on Windows.
    rmSync(path.join(workspace, 'pack.zip'))
    rmSync(path.join(workspace, 'out'), { recursive: true })
  })

  it('refuses an archive whose entry would land outside, and leaves nothing behind', async () => {
    const { workspace, outside, scope } = fixture()
    writeFileSync(
      path.join(workspace, 'evil.zip'),
      zipSync({ 'fine.txt': strToU8('ok'), '../outside/evil.txt': strToU8('evil') }),
    )
    await expect(unzipEntry(scope, 'evil.zip', undefined)).rejects.toThrow('目标目录以外')
    expect(existsSync(path.join(outside, 'evil.txt'))).toBe(false)
    expect(existsSync(path.join(workspace, 'evil'))).toBe(false)
    expect(existsSync(path.join(workspace, 'outside'))).toBe(false)
    expect(readdirSync(workspace).filter((name) => name.startsWith('.unzip-'))).toEqual([])
  })

  it('reads GBK names from archives made on Chinese Windows', async () => {
    const { workspace, scope } = fixture()
    // "报告.txt" in GBK, stored without the UTF-8 flag.
    const gbk = String.fromCharCode(0xb1, 0xa8, 0xb8, 0xe6) + '.txt'
    writeFileSync(path.join(workspace, 'cn.zip'), zipSync({ [gbk]: strToU8('内容') }))
    await unzipEntry(scope, 'cn.zip', 'cn')
    expect(readFileSync(path.join(workspace, 'cn/报告.txt'), 'utf8')).toBe('内容')
  })

  it('says plainly when the file is not a zip', async () => {
    const { scope, file } = fixture()
    file('fake.zip', 'not a zip')
    await expect(unzipEntry(scope, 'fake.zip', 'fake')).rejects.toThrow('不是有效的 zip 文件')
  })
})

describe('finding and searching files', () => {
  const mount = async (scope: FileToolScope) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(LocalSubprocessRuntime)
    mountWorkspaceFileTools(ctx, scope)
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({
        callId: ToolCallId(`${name}-call`),
        name,
        arguments: args,
        signal: new AbortController().signal,
      })
      return {
        isError: result.isError,
        text: [
          ...result.content.map((block) => (block.type === 'text' ? block.text : '')),
          ...(result.isError ? [result.error.message] : []),
        ].join('\n'),
      }
    }
    return { ctx, run }
  }

  it('finds files by name without listing the trash', async () => {
    const { workspace, scope, file } = fixture()
    file('notes/plan.md', 'deadline friday')
    file(`${TRASH_DIRECTORY}/20261104-080000-aaaa/old.md`, 'deadline monday')
    const { run } = await mount(scope)
    const found = await run('glob', { pattern: '**/*.md', path: workspace })
    expect(found.text).toContain('plan.md')
    expect(found.text).not.toContain('old.md')
    const grep = await run('grep', { pattern: 'deadline', path: workspace })
    expect(grep.text).toContain('plan.md')
    expect(grep.text).not.toContain('old.md')
  })

  it('refuses to search outside the workspace unless the agent has full access', async () => {
    const { outside, scope } = fixture()
    const { run } = await mount(scope)
    expect(await run('grep', { pattern: 'outside', path: outside })).toMatchObject({ isError: true })
    expect((await run('glob', { pattern: '*', path: '..' })).isError).toBe(true)
    const full = await mount({ ...scope, unrestricted: true })
    expect((await full.run('grep', { pattern: 'outside', path: outside })).text).toContain('secret.txt')
  })
})

describe('who gets the file tools', () => {
  it.each([
    [false, true],
    [true, false],
  ])('with commands %s, lists them %s', async (developmentShell, listed) => {
    const { workspace } = fixture()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjections)
    await mountDevelopmentCapabilities(
      ctx,
      { fileTools: true, developmentShell, unrestrictedFileAccess: false },
      workspace,
      { hidden: [], readable: [], network: true },
      () => ({}),
      () => false,
    )
    for (const name of ['move', 'copy', 'delete', 'make_dir', 'file_info', 'diff', 'zip', 'unzip', 'glob', 'grep']) {
      expect(ctx.tools.get(name) !== undefined, name).toBe(listed)
    }
    expect(ctx.tools.get('read')).toBeDefined()
  })
})

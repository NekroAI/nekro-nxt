import type { Context } from '@deepseek-ai/cordis'
import {
  applyGrepTool,
  buildGlobCommand,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  parseGlobArgs,
  presentGlobCall,
  RAW_OUTPUT_MAX_BYTES,
  runRipgrep,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  toWorkdirRelative,
} from '@deepseek-ai/dsh-tool-fs-search'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createTwoFilesPatch } from 'diff'
import { Unzip, UnzipInflate, Zip, ZipDeflate, type UnzipFile } from 'fflate'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

/**
 * File management tools for agents that read and write their workspace but cannot run commands (工作区读写): move,
 * copy, delete, make a folder, search, zip, inspect and compare. Agents with commands do all of this in their shell,
 * so they do not get these tools. Every path is judged by where it really is after symlinks, like the read and write
 * tools; with full access the tools reach the same places as those.
 */
export interface FileToolScope {
  readonly workspace: string
  readonly unrestricted: boolean
  /** Directories outside the workspace that `glob` and `grep` may also search, such as the session's spill files. */
  readonly readOnlyRoots?: () => readonly string[]
}

/** Deleted entries wait here, one folder per deletion, until {@link TRASH_DAYS} have passed. */
export const TRASH_DIRECTORY = '.trash'
export const TRASH_DAYS = 7
/** Copying, zipping and unzipping stop at these, so one call cannot fill the disk. */
export const FILE_TOOL_MAX_BYTES = 1024 * 1024 * 1024
export const FILE_TOOL_MAX_ENTRIES = 10_000
const DIFF_MAX_FILE_BYTES = 1024 * 1024
const DIFF_MAX_OUTPUT_CHARS = 32_000
const GLOB_MAX_RESULTS = 100
const HASH_MAX_BYTES = FILE_TOOL_MAX_BYTES

const OUTSIDE = '只能操作你工作区里的位置。'

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined)

const exists = (target: string) =>
  lstat(target).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    },
  )

const workspaceRoot = (scope: FileToolScope) => realpath(scope.workspace)

/** The path an agent sees: workspace-relative with `/`, or absolute outside the workspace. */
const shown = (root: string, target: string): string => {
  const relative = path.relative(root, target)
  if (relative === '') return '.'
  return isWithin(root, target) ? relative.split(path.sep).join('/') : target
}

const checkReach = (scope: FileToolScope, root: string, target: string) => {
  if (!scope.unrestricted && !isWithin(root, target)) throw new Error(OUTSIDE)
}

/**
 * An entry that exists, located by its folder's real path so a symlink is the link itself (move, delete and copy act
 * on the link, never on what it points to). The workspace itself is never a target.
 */
const existingEntry = async (scope: FileToolScope, input: string) => {
  const root = await workspaceRoot(scope)
  const absolute = path.resolve(root, input)
  let folder: string
  try {
    folder = await realpath(path.dirname(absolute))
  } catch {
    throw new Error(`找不到 ${input}。`)
  }
  const entry = path.join(folder, path.basename(absolute))
  checkReach(scope, root, entry)
  if (entry === root || path.dirname(entry) === entry) throw new Error('不能对整个工作区或根目录这样做。')
  if (!(await exists(entry))) throw new Error(`找不到 ${input}。`)
  return { root, entry }
}

/** What an existing entry's content really is: its real path must be in reach too, so a link cannot read past it. */
const readableFile = async (scope: FileToolScope, input: string) => {
  const root = await workspaceRoot(scope)
  let real: string
  try {
    real = await realpath(path.resolve(root, input))
  } catch {
    throw new Error(`找不到 ${input}。`)
  }
  checkReach(scope, root, real)
  return { root, real }
}

/** A place that does not exist yet: its nearest existing folder decides where it really is. */
const newEntry = async (scope: FileToolScope, input: string) => {
  const root = await workspaceRoot(scope)
  const absolute = path.resolve(root, input)
  let ancestor = absolute
  const rest: string[] = []
  while (!(await exists(ancestor))) {
    rest.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  if (rest.length === 0) throw new Error(`${input} 已经存在。`)
  const target = path.join(await realpath(ancestor), ...rest)
  checkReach(scope, root, target)
  return { root, target }
}

/** Counts files and bytes under an entry without following links, stopping as soon as a limit is passed. */
const measure = async (entry: string) => {
  let bytes = 0
  let entries = 0
  const visit = async (target: string): Promise<void> => {
    const info = await lstat(target)
    entries += 1
    if (entries > FILE_TOOL_MAX_ENTRIES) throw new Error(`超过 ${FILE_TOOL_MAX_ENTRIES} 个文件，请分批处理。`)
    if (info.isDirectory()) {
      for (const name of await readdir(target)) await visit(path.join(target, name))
      return
    }
    bytes += info.size
    if (bytes > FILE_TOOL_MAX_BYTES) throw new Error(`超过 ${FILE_TOOL_MAX_BYTES / 1024 / 1024} MB，请分批处理。`)
  }
  await visit(entry)
  return { bytes, entries }
}

/** Moves across disks by copying, since `rename` cannot (full access only reaches another disk). */
const moveEntry = async (from: string, to: string) => {
  try {
    await rename(from, to)
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

const trashStamp = (now: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${date}-${time}-${randomBytes(2).toString('hex')}`
}

const stampTime = (name: string): number | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/u.exec(name)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match.map(Number)
  return Date.UTC(year!, month! - 1, day, hour, minute, second)
}

/** Removes deletions older than {@link TRASH_DAYS}; anything else in the folder is left alone. */
export const cleanTrash = async (workspace: string, now: Date = new Date()): Promise<void> => {
  const trash = path.join(workspace, TRASH_DIRECTORY)
  let names: string[]
  try {
    names = await readdir(trash)
  } catch {
    return
  }
  const cutoff = now.getTime() - TRASH_DAYS * 24 * 60 * 60 * 1000
  for (const name of names) {
    const time = stampTime(name)
    if (time !== undefined && time < cutoff) await rm(path.join(trash, name), { recursive: true, force: true })
  }
}

/** Moves an entry into the workspace trash, keeping its path; something already in the trash is removed for good. */
export const deleteEntry = async (scope: FileToolScope, input: string, recursive: boolean, now = new Date()) => {
  const { root, entry } = await existingEntry(scope, input)
  const info = await lstat(entry)
  if (info.isDirectory() && !recursive)
    throw new Error(`${input} 是目录，要连同里面的内容一起删除时，把 recursive 设为 true。`)
  const trash = path.join(root, TRASH_DIRECTORY)
  if (entry === trash) throw new Error(`不能删除 ${TRASH_DIRECTORY} 本身；里面超过 ${TRASH_DAYS} 天的内容会自动清理。`)
  if (isWithin(trash, entry)) {
    await rm(entry, { recursive: true, force: true })
    return { path: shown(root, entry), permanent: true }
  }
  // Outside the workspace (full access) the absolute path is kept below `outside/`.
  const kept = isWithin(root, entry)
    ? path.relative(root, entry)
    : path.join('outside', entry.replace(/^[A-Za-z]:/u, (drive) => drive[0]!).replace(/^[\\/]+/u, ''))
  const destination = path.join(trash, trashStamp(now), kept)
  await mkdir(path.dirname(destination), { recursive: true })
  await moveEntry(entry, destination)
  await cleanTrash(root, now)
  return { path: shown(root, entry), permanent: false, trashed: shown(root, destination) }
}

export const moveFileEntry = async (scope: FileToolScope, from: string, to: string) => {
  const source = await existingEntry(scope, from)
  const { target } = await newEntry(scope, to)
  if (isWithin(source.entry, target)) throw new Error('不能把目录移动到它自己里面。')
  await mkdir(path.dirname(target), { recursive: true })
  await moveEntry(source.entry, target)
  return { from: shown(source.root, source.entry), to: shown(source.root, target) }
}

export const copyFileEntry = async (scope: FileToolScope, from: string, to: string) => {
  const source = await existingEntry(scope, from)
  const { target } = await newEntry(scope, to)
  if (isWithin(source.entry, target)) throw new Error('不能把目录复制到它自己里面。')
  const size = await measure(source.entry)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source.entry, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  return { from: shown(source.root, source.entry), to: shown(source.root, target), ...size }
}

export const makeDirectory = async (scope: FileToolScope, input: string) => {
  const { root, target } = await newEntry(scope, input)
  await mkdir(target, { recursive: true })
  return { path: shown(root, target) }
}

export const fileInfo = async (scope: FileToolScope, input: string) => {
  const { root, entry } = await existingEntry(scope, input)
  const info = await lstat(entry)
  const base = { path: shown(root, entry), modifiedAt: info.mtime.toISOString() }
  if (info.isSymbolicLink()) return { ...base, type: 'symlink' as const, target: await readlink(entry) }
  if (info.isDirectory()) return { ...base, type: 'directory' as const, entries: (await readdir(entry)).length }
  const file = { ...base, type: 'file' as const, bytes: info.size }
  if (info.size > HASH_MAX_BYTES) return file
  const hash = createHash('sha256')
  await pipeline(createReadStream(entry), hash)
  return { ...file, sha256: hash.digest('hex') }
}

export const diffFiles = async (scope: FileToolScope, left: string, right: string) => {
  const files = await Promise.all([readableFile(scope, left), readableFile(scope, right)])
  const texts = await Promise.all(
    files.map(async ({ real }, index) => {
      const info = await stat(real)
      if (!info.isFile()) throw new Error(`${index === 0 ? left : right} 不是文件。`)
      if (info.size > DIFF_MAX_FILE_BYTES) throw new Error(`${index === 0 ? left : right} 超过 1 MB，不能比较。`)
      const bytes = await readFile(real)
      if (bytes.includes(0)) throw new Error(`${index === 0 ? left : right} 不是文本文件。`)
      return bytes.toString('utf8')
    }),
  )
  if (texts[0] === texts[1]) return { same: true, diff: '' }
  const patch = createTwoFilesPatch(left, right, texts[0]!, texts[1]!, undefined, undefined, { context: 3 })
  const body = patch.split('\n').slice(2).join('\n')
  return body.length > DIFF_MAX_OUTPUT_CHARS
    ? { same: false, diff: `${body.slice(0, DIFF_MAX_OUTPUT_CHARS)}\n…（差异太长，只显示开头）` }
    : { same: false, diff: body }
}

/** A file's bytes in chunks; a stream without an encoding only yields buffers. */
async function* bytesOf(file: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(file)) {
    const value: unknown = chunk
    if (value instanceof Uint8Array) yield value
  }
}

/** Zips a file or folder; links are left out so nothing outside it is packed through one. */
export const zipEntry = async (scope: FileToolScope, from: string, to: string) => {
  const source = await existingEntry(scope, from)
  const { target } = await newEntry(scope, to)
  if (isWithin(source.entry, target)) throw new Error('压缩包不能放在被压缩的目录里。')
  await measure(source.entry)
  const files: { readonly name: string; readonly real: string }[] = []
  let skipped = 0
  const collect = async (entry: string, name: string): Promise<void> => {
    const info = await lstat(entry)
    if (info.isSymbolicLink()) {
      skipped += 1
      return
    }
    if (info.isDirectory()) {
      for (const child of (await readdir(entry)).sort()) await collect(path.join(entry, child), `${name}/${child}`)
      return
    }
    files.push({ name, real: entry })
  }
  await collect(source.entry, path.basename(source.entry))
  await mkdir(path.dirname(target), { recursive: true })
  const output = createWriteStream(target, { flags: 'wx' })
  const zip = new Zip()
  let outputError: Error | undefined
  output.once('error', (error) => {
    outputError = error
  })
  const closed = new Promise<void>((resolve) => output.once('close', resolve))
  zip.ondata = (error, chunk, final) => {
    if (error) {
      output.destroy(error)
      return
    }
    if (output.destroyed) return
    output.write(chunk)
    if (final) output.end()
  }
  try {
    for (const file of files) {
      const stream = new ZipDeflate(file.name, { level: 6 })
      zip.add(stream)
      for await (const chunk of bytesOf(file.real)) stream.push(chunk)
      stream.push(new Uint8Array(0), true)
    }
    zip.end()
    await closed
    if (outputError !== undefined) throw outputError
  } catch (error) {
    output.destroy()
    await closed
    await rm(target, { force: true })
    throw error
  }
  return { from: shown(source.root, source.entry), to: shown(source.root, target), files: files.length, skipped }
}

/** Zip names written without the UTF-8 flag are often GBK (archives made on Chinese Windows). */
const entryName = (name: string): string => {
  if (![...name].every((char) => char.charCodeAt(0) < 256) || /^[\x20-\x7e]*$/u.test(name)) return name
  const bytes = Uint8Array.from(name, (char) => char.charCodeAt(0))
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      // Try the next encoding.
    }
  }
  return name
}

/** A zip starts with a local file header, or with the end record when it is empty. */
const ZIP_SIGNATURES = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])]

/** A safe relative path inside the output folder, or undefined for a name that would leave it. */
const safeEntryPath = (name: string): string | undefined => {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return undefined
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..')) return undefined
  return parts.join(path.sep)
}

/**
 * Unzips into a new folder: entries are written to a hidden folder next to it and moved in place when everything
 * fits, so a refused or broken archive leaves nothing behind. Names that would leave the folder are refused.
 */
export const unzipEntry = async (scope: FileToolScope, from: string, to: string | undefined) => {
  const { root, real } = await readableFile(scope, from)
  const archive = await stat(real)
  if (!archive.isFile()) throw new Error(`${from} 不是文件。`)
  // The streaming reader skips anything it does not recognise, so a file that is not a zip would unzip to nothing.
  const head = Buffer.alloc(4)
  const handle = await open(real, 'r')
  try {
    await handle.read(head, 0, 4, 0)
  } finally {
    await handle.close()
  }
  if (!ZIP_SIGNATURES.some((signature) => head.equals(signature))) throw new Error(`${from} 不是有效的 zip 文件。`)
  const destination = to ?? path.join(path.dirname(from), path.basename(from, path.extname(from)))
  const { target } = await newEntry(scope, destination)
  const staging = path.join(path.dirname(target), `.unzip-${randomBytes(4).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  let entries = 0
  let bytes = 0
  const writes: Promise<void>[] = []
  const active = new Map<ReturnType<typeof createWriteStream>, UnzipFile>()
  let failure: Error | undefined
  const fail = (error: Error) => {
    failure ??= error
    for (const [stream, file] of active) {
      file.terminate()
      stream.destroy()
    }
  }
  const unzip = new Unzip((file: UnzipFile) => {
    if (failure) return
    const relative = safeEntryPath(entryName(file.name))
    if (relative === undefined) return fail(new Error(`压缩包里的 ${file.name} 会写到目标目录以外，已停止解压。`))
    entries += 1
    if (entries > FILE_TOOL_MAX_ENTRIES) return fail(new Error(`压缩包里超过 ${FILE_TOOL_MAX_ENTRIES} 个文件。`))
    const output = path.join(staging, relative)
    try {
      if (file.name.endsWith('/')) {
        mkdirSync(output, { recursive: true })
        return
      }
      // fflate hands over the data while the archive is pushed, so the file starts here, synchronously.
      mkdirSync(path.dirname(output), { recursive: true })
    } catch (error) {
      return fail(error instanceof Error ? error : new Error(String(error)))
    }
    const stream = createWriteStream(output, { flags: 'wx' })
    active.set(stream, file)
    writes.push(
      new Promise<void>((resolve) => {
        stream.once('close', () => {
          active.delete(stream)
          resolve()
        })
        stream.once('error', fail)
        file.ondata = (error, chunk, final) => {
          if (error) {
            fail(error)
            return
          }
          bytes += chunk.length
          if (bytes > FILE_TOOL_MAX_BYTES) {
            fail(new Error(`解压后超过 ${FILE_TOOL_MAX_BYTES / 1024 / 1024} MB。`))
            return
          }
          stream.write(chunk)
          if (final) stream.end()
        }
        file.start()
      }),
    )
  })
  unzip.register(UnzipInflate)
  try {
    for await (const chunk of bytesOf(real)) {
      if (failure) break
      unzip.push(chunk)
    }
    if (!failure) unzip.push(new Uint8Array(0), true)
    await Promise.all(writes)
    if (failure) throw failure
    await rename(staging, target)
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
    await Promise.all(writes)
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { from: shown(root, real), to: shown(root, target), files: entries, bytes }
}

/** `glob` and `grep` take a `path`; outside full access it must really be inside the workspace or a read-only root. */
const searchPathDenial = (scope: FileToolScope, exec: { readonly name: string; readonly arguments: unknown }) => {
  if (scope.unrestricted || (exec.name !== 'glob' && exec.name !== 'grep')) return undefined
  const args = exec.arguments
  const requested = typeof args === 'object' && args !== null && 'path' in args ? args.path : undefined
  if (typeof requested !== 'string' || requested.trim() === '') return undefined
  const root = realpathSync(scope.workspace)
  const absolute = path.resolve(root, requested)
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute
  if (isWithin(root, real)) return undefined
  const readOnly = scope.readOnlyRoots?.() ?? []
  return readOnly.some((entry) => existsSync(entry) && isWithin(realpathSync(entry), real))
    ? undefined
    : `${requested}：${OUTSIDE}`
}

/** Every tool here answers in one sentence or block of text. */
const textOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: { text: { type: 'string' as const, required: true as const } },
  },
  render: (_arguments: unknown, value: { readonly text: string }) => [{ type: 'text' as const, text: value.text }],
}

const text = (value: string) => ({ text: value })

const pathParameter = (description: string) => ({ type: 'string' as const, required: true as const, description })

/** Registers the tools in a context that has `workingDirectory`, `subprocess`, `systemPrompt` and `tools`. */
export const mountWorkspaceFileTools = (ctx: Context, scope: FileToolScope): void => {
  const relativeNote = '路径相对你的工作区。'
  ctx.tools.register(
    defineTool({
      name: 'move',
      description: `移动文件或目录，也用来改名。目标已经存在时不会覆盖。${relativeNote}`,
      parameters: { from: pathParameter('要移动的文件或目录。'), to: pathParameter('移动后的完整路径，含新名字。') },
      output: textOutput,
      execute: async (args) => {
        const moved = await moveFileEntry(scope, args.from, args.to)
        return text(`已把 ${moved.from} 移到 ${moved.to}。`)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'copy',
      description: `复制文件或目录。目标已经存在时不会覆盖；最多 ${FILE_TOOL_MAX_ENTRIES} 个文件、${FILE_TOOL_MAX_BYTES / 1024 / 1024} MB。${relativeNote}`,
      parameters: { from: pathParameter('要复制的文件或目录。'), to: pathParameter('副本的完整路径。') },
      output: textOutput,
      execute: async (args) => {
        const copied = await copyFileEntry(scope, args.from, args.to)
        return text(`已把 ${copied.from} 复制到 ${copied.to}（${copied.entries} 项）。`)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'delete',
      description: `删除文件或目录。删掉的内容先放进工作区的 ${TRASH_DIRECTORY}/，${TRASH_DAYS} 天后自动清理，误删时可以用 move 移回原处；删除 ${TRASH_DIRECTORY}/ 里的内容则是彻底删除。${relativeNote}`,
      parameters: {
        path: pathParameter('要删除的文件或目录。'),
        recursive: { type: 'boolean', description: '删除目录及其中全部内容时设为 true。' },
      },
      output: textOutput,
      execute: async (args) => {
        const deleted = await deleteEntry(scope, args.path, args.recursive === true)
        return text(
          deleted.permanent ? `已彻底删除 ${deleted.path}。` : `已删除 ${deleted.path}，暂存在 ${deleted.trashed}。`,
        )
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'make_dir',
      description: `新建目录，缺少的上级目录一并建好。${relativeNote}`,
      parameters: { path: pathParameter('要新建的目录。') },
      output: textOutput,
      execute: async (args) => text(`已新建目录 ${(await makeDirectory(scope, args.path)).path}。`),
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'file_info',
      description: `查看文件或目录的类型、大小、修改时间；文件还给出 SHA-256，可用来核对两个文件是否相同。${relativeNote}`,
      parameters: { path: pathParameter('要查看的文件或目录。') },
      output: textOutput,
      execute: async (args) => text(JSON.stringify(await fileInfo(scope, args.path))),
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'diff',
      description: `逐行比较两个文本文件（每个最多 1 MB），返回统一差异格式。${relativeNote}`,
      parameters: { left: pathParameter('原文件。'), right: pathParameter('对比的文件。') },
      output: textOutput,
      execute: async (args) => {
        const result = await diffFiles(scope, args.left, args.right)
        return text(result.same ? '两个文件内容相同。' : result.diff)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'zip',
      description: `把文件或目录压缩成 zip，符号链接不打包。最多 ${FILE_TOOL_MAX_ENTRIES} 个文件、${FILE_TOOL_MAX_BYTES / 1024 / 1024} MB。${relativeNote}`,
      parameters: { from: pathParameter('要压缩的文件或目录。'), to: pathParameter('压缩包路径，以 .zip 结尾。') },
      output: textOutput,
      execute: async (args) => {
        const zipped = await zipEntry(scope, args.from, args.to)
        return text(
          `已压缩 ${zipped.files} 个文件到 ${zipped.to}${zipped.skipped > 0 ? `，跳过 ${zipped.skipped} 个符号链接` : ''}。`,
        )
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'unzip',
      description: `解压 zip 到一个新目录（目录不能已经存在）。解压后最多 ${FILE_TOOL_MAX_ENTRIES} 个文件、${FILE_TOOL_MAX_BYTES / 1024 / 1024} MB；会写到目录以外的条目会让解压停止。${relativeNote}`,
      parameters: {
        from: pathParameter('zip 文件。'),
        to: { type: 'string', description: '解压到的新目录；不写时用压缩包同名目录。' },
      },
      output: textOutput,
      execute: async (args) => {
        const unzipped = await unzipEntry(scope, args.from, args.to)
        return text(`已解压 ${unzipped.files} 项到 ${unzipped.to}。`)
      },
    }),
  )
  const glob = defineTool({
    name: 'glob',
    description: `按文件名模式查找文件（不含目录），按修改时间排序，最多返回 ${GLOB_MAX_RESULTS} 个；不列出 ${TRASH_DIRECTORY}/ 和版本库目录。`,
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: '匹配模式，例如 "**/*.md"、"docs/*.txt"；不含 / 的模式在任意层级匹配文件名。',
      },
      path: { type: 'string', description: '在哪个目录里找；不写时是整个工作区。' },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: textOutput,
    execute: async (args, exec) => {
      const input = parseGlobArgs(args)
      const argv = [
        ...buildGlobCommand({ pattern: input.pattern }),
        `--glob=!**/${TRASH_DIRECTORY}`,
        `--glob=!**/${TRASH_DIRECTORY}/**`,
        ...(input.path === undefined ? [] : ['--', input.path]),
      ]
      const run = await runRipgrep(
        ctx,
        exec,
        'glob',
        argv,
        RAW_OUTPUT_MAX_BYTES,
        SEARCH_GRACE_MS,
        SEARCH_STDERR_MAX_BYTES,
      )
      if (run.noMatches) return text('没有找到匹配的文件。')
      const paths = run.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => toWorkdirRelative(line, run.workdir).split(path.sep).join('/'))
      const listed = paths.slice(0, GLOB_MAX_RESULTS).join('\n')
      return text(
        paths.length > GLOB_MAX_RESULTS
          ? `${listed}\n…共 ${paths.length} 个，只列出最近修改的 ${GLOB_MAX_RESULTS} 个；可以缩小范围再找。`
          : listed,
      )
    },
    presentCall: presentGlobCall,
  })
  ctx.tools.register(glob)
  applyGrepTool(ctx, {
    maxMatches: GREP_MAX_MATCHES,
    maxLineBytes: GREP_MAX_LINE_BYTES,
    maxMetaBytes: SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
    graceMs: SEARCH_GRACE_MS,
    stderrMaxBytes: SEARCH_STDERR_MAX_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
  })
  ctx.tools.guard((exec) => searchPathDenial(scope, exec))
  void cleanTrash(scope.workspace).catch(() => undefined)
}

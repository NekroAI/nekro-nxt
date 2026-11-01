import { lstat, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ActiveAddonProgram } from './addons.js'
import type { ConfinedProgramRunner } from './confined-program.js'

/**
 * One argument of a profile run: plain text, an input file named by its key in `inputs`, or an output file named
 * inside the call's work folder. The shape is what extensions later pass to `nxt.commands.run`.
 */
export type CommandArgument = string | { readonly input: string } | { readonly output: string }

/** What follows an allowed option: nothing, a text value, or an input file. */
export interface CommandOptionRule {
  readonly takes: 'flag' | 'value' | 'input'
  /** Extra check of a text value; returns why it is refused. */
  readonly check?: (value: string) => string | undefined
}

/**
 * What a program may be run with (附加功能 F7). Options not listed are refused. Inputs and outputs never appear as
 * text: the run maps them to host paths, and every input and output gets the profile's forced arguments in front of
 * it, because ffmpeg applies options such as `-protocol_whitelist` to the next file only.
 */
export interface CommandProfile {
  readonly id: string
  readonly program: string
  readonly options: Readonly<Record<string, CommandOptionRule>>
  /** Arguments every run starts with. */
  readonly prefix: readonly string[]
  readonly inputPrefix: readonly string[]
  readonly outputPrefix: readonly string[]
  /** What an argument outside any option is. */
  readonly positional: 'input' | 'output'
  /** A bare `-` writes to standard output. */
  readonly stdoutPositional: boolean
  readonly timeoutMs: { readonly default: number; readonly max: number }
  /** Kept bytes of each of stdout and stderr. */
  readonly maxStdioBytes: number
  readonly maxOutputs: number
}

export class CommandProfileError extends Error {
  constructor(
    readonly code:
      'profile-unavailable' | 'argument-rejected' | 'input-missing' | 'output-name' | 'timeout' | 'too-many-outputs',
    message: string,
  ) {
    super(message)
  }
}

const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
/** One `%d` or `%03d` numbers an image sequence. */
const SEQUENCE = /%0?\d?d/u

const outputNameProblem = (name: string): string | undefined => {
  const plain = name.replace(SEQUENCE, '1')
  if (!OUTPUT_NAME.test(plain) || plain.includes('..') || name.split('%').length > 2) {
    return `输出名「${name}」不合法，只能用字母、数字、点、横线和下划线。`
  }
  return undefined
}

/** Rules every text value follows: no addresses, no host paths, no way out of the work folder. */
const valueProblem = (value: string): string | undefined => {
  if (value.includes('\0')) return '参数里有不可见字符。'
  if (value.includes('://')) return '参数里不能出现网址。'
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/u.test(value)) return '参数里不能出现绝对路径。'
  if (value.includes('..')) return '参数里不能出现“..”。'
  return undefined
}

/** Filters that open files, devices, plugins or sockets by themselves. */
const DENIED_FILTERS = [
  'movie',
  'amovie',
  'subtitles',
  'ass',
  'sendcmd',
  'asendcmd',
  'zmq',
  'azmq',
  'lv2',
  'ladspa',
  'frei0r',
  'frei0r_src',
  'dnn_processing',
  'dnn_classify',
  'dnn_detect',
  'sr',
  'derain',
  'dejudder_file',
  'vidstabdetect',
  'vidstabtransform',
  'signature',
  'ocr',
  'arnndn',
  'afir',
  'sofalizer',
  'libplacebo',
  'openclsrc',
]
/** Filter options that name a file to read or write. */
const DENIED_FILTER_KEYS = [
  'filename',
  'file',
  'stats_file',
  'textfile',
  'fontfile',
  'fontsdir',
  'result',
  'model',
  'f',
]

const filterProblem = (graph: string): string | undefined => {
  for (const name of DENIED_FILTERS) {
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'iu').test(graph)) {
      return `滤镜 ${name} 会读取或写入其他文件，不能使用。`
    }
  }
  for (const key of DENIED_FILTER_KEYS) {
    if (new RegExp(`(?<![A-Za-z0-9_])${key}\\s*=`, 'iu').test(graph)) return `滤镜参数 ${key} 会读写文件，不能使用。`
  }
  return undefined
}

/** Containers ffmpeg may read: the demuxers of common audio, video and image files, nothing that lists other files. */
export const MEDIA_DEMUXERS = [
  'mov',
  'matroska',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'aac',
  'amr',
  'amrnb',
  'amrwb',
  'avi',
  'flv',
  'mpegts',
  'mpeg',
  'asf',
  'caf',
  'aiff',
  'au',
  'w64',
  'wv',
  'ivf',
  'h264',
  'hevc',
  'm4v',
  'mjpeg',
  'gif',
  'apng',
  'image2',
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
  'bmp_pipe',
  'tiff_pipe',
  'gif_pipe',
  's16le',
  'f32le',
  'u8',
]
const MEDIA_MUXERS = [
  'mp4',
  'mov',
  'ipod',
  'matroska',
  'webm',
  'mp3',
  'wav',
  'ogg',
  'opus',
  'flac',
  'adts',
  'amr',
  'avi',
  'flv',
  'mpegts',
  'gif',
  'apng',
  'webp',
  'image2',
  'mjpeg',
  'rawvideo',
  'h264',
  'hevc',
  's16le',
  'f32le',
  'u8',
  'null',
  'md5',
  'framemd5',
  'crc',
]
const FORMATS = new Set([...MEDIA_DEMUXERS, ...MEDIA_MUXERS])

const formatProblem = (value: string): string | undefined =>
  FORMATS.has(value) ? undefined : `格式 ${value} 不在允许的范围内。`
const namePattern = /^[A-Za-z0-9_.+-]+$/u
const nameProblem = (value: string): string | undefined =>
  namePattern.test(value) ? undefined : `「${value}」不是有效的名称。`

const flag: CommandOptionRule = { takes: 'flag' }
const value: CommandOptionRule = { takes: 'value' }
const named: CommandOptionRule = { takes: 'value', check: nameProblem }
const filter: CommandOptionRule = { takes: 'value', check: filterProblem }

/** Forced in front of every input: local files only, common containers only. */
export const MEDIA_INPUT_PREFIX = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', MEDIA_DEMUXERS.join(',')]

/** Largest file one ffmpeg output may grow to. */
const MAX_OUTPUT_FILE_BYTES = 512 * 1024 * 1024

export const FFMPEG_PROFILE: CommandProfile = {
  id: 'ffmpeg',
  program: 'ffmpeg',
  prefix: ['-nostdin', '-hide_banner', '-y'],
  inputPrefix: MEDIA_INPUT_PREFIX,
  outputPrefix: ['-fs', String(MAX_OUTPUT_FILE_BYTES)],
  positional: 'output',
  stdoutPositional: true,
  timeoutMs: { default: 60_000, max: 600_000 },
  maxStdioBytes: 256 * 1024,
  maxOutputs: 1000,
  options: {
    i: { takes: 'input' },
    y: flag,
    n: flag,
    vn: flag,
    an: flag,
    sn: flag,
    dn: flag,
    shortest: flag,
    copyts: flag,
    accurate_seek: flag,
    noaccurate_seek: flag,
    ss: value,
    sseof: value,
    t: value,
    to: value,
    itsoffset: value,
    stream_loop: value,
    f: { takes: 'value', check: formatProblem },
    c: named,
    codec: named,
    vcodec: named,
    acodec: named,
    b: value,
    q: value,
    qscale: value,
    crf: value,
    preset: named,
    tune: named,
    profile: named,
    level: value,
    pix_fmt: named,
    sample_fmt: named,
    r: value,
    framerate: value,
    s: value,
    aspect: value,
    vf: filter,
    af: filter,
    filter: filter,
    filter_complex: filter,
    lavfi: filter,
    map: value,
    map_metadata: value,
    map_chapters: value,
    metadata: value,
    disposition: value,
    tag: value,
    ar: value,
    ac: value,
    frames: value,
    vframes: value,
    aframes: value,
    g: value,
    bf: value,
    maxrate: value,
    minrate: value,
    bufsize: value,
    threads: value,
    loop: value,
    movflags: value,
    fps_mode: named,
    vsync: value,
    strict: value,
    v: named,
    loglevel: named,
    update: value,
    start_number: value,
    compression_level: value,
    lossless: value,
    quality: value,
    deadline: named,
    'cpu-used': value,
    'row-mt': value,
  },
}

export const FFPROBE_PROFILE: CommandProfile = {
  id: 'ffprobe',
  program: 'ffprobe',
  prefix: ['-hide_banner'],
  inputPrefix: MEDIA_INPUT_PREFIX,
  outputPrefix: [],
  positional: 'input',
  stdoutPositional: false,
  timeoutMs: { default: 30_000, max: 120_000 },
  maxStdioBytes: 1024 * 1024,
  maxOutputs: 0,
  options: {
    i: { takes: 'input' },
    v: named,
    loglevel: named,
    of: value,
    print_format: value,
    show_format: flag,
    show_streams: flag,
    show_frames: flag,
    show_packets: flag,
    show_chapters: flag,
    show_programs: flag,
    show_entries: value,
    select_streams: value,
    count_frames: flag,
    count_packets: flag,
    read_intervals: value,
    pretty: flag,
    sexagesimal: flag,
    f: { takes: 'value', check: formatProblem },
  },
}

/** The argv of one run and the host paths it touches. */
export interface PreparedCommand {
  readonly args: string[]
  readonly readable: string[]
  readonly outputs: string[]
}

const isObject = (argument: CommandArgument): argument is Exclude<CommandArgument, string> =>
  typeof argument === 'object' && argument !== null

/**
 * Checks `args` against `profile` and maps inputs to `file:` host paths and outputs into `workDir`. Throws
 * {@link CommandProfileError} with the first refused argument.
 */
export const prepareCommand = (
  profile: CommandProfile,
  args: readonly CommandArgument[],
  context: { readonly inputs: Readonly<Record<string, string>>; readonly workDir: string },
): PreparedCommand => {
  const refuse = (message: string): never => {
    throw new CommandProfileError('argument-rejected', message)
  }
  const prepared: PreparedCommand = { args: [...profile.prefix], readable: [], outputs: [] }
  const input = (argument: CommandArgument, option?: string): void => {
    if (!isObject(argument) || !('input' in argument)) return refuse('输入文件要用 { input } 指定。')
    const host = context.inputs[argument.input]
    if (host === undefined) {
      throw new CommandProfileError('input-missing', `没有名为「${argument.input}」的输入文件。`)
    }
    if (!path.isAbsolute(host)) throw new Error(`Command inputs must be absolute host paths: ${argument.input}`)
    prepared.args.push(...profile.inputPrefix, ...(option === undefined ? [] : [option]), `file:${host}`)
    prepared.readable.push(host)
  }
  const output = (argument: CommandArgument): void => {
    if (typeof argument === 'string') {
      if (argument === '-' && profile.stdoutPositional) {
        prepared.args.push(...profile.outputPrefix, 'pipe:1')
        return
      }
      return refuse(`参数「${argument}」不在 ${profile.program} 允许的范围内；输出文件要用 { output } 指定。`)
    }
    if (!('output' in argument)) return refuse('输入文件要放在 -i 后面。')
    const problem = outputNameProblem(argument.output)
    if (problem !== undefined) throw new CommandProfileError('output-name', problem)
    if (profile.maxOutputs === 0) return refuse(`${profile.program} 不能写文件。`)
    prepared.args.push(...profile.outputPrefix, `file:${path.join(context.workDir, argument.output)}`)
    prepared.outputs.push(argument.output)
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (typeof argument === 'string' && argument.length > 1 && argument.startsWith('-')) {
      const base = argument.slice(1).split(':')[0]!
      const rule = Object.hasOwn(profile.options, base) ? profile.options[base] : undefined
      if (rule === undefined) return refuse(`参数 ${argument} 不在 ${profile.program} 允许的范围内。`)
      if (rule.takes === 'flag') {
        prepared.args.push(argument)
        continue
      }
      const next = args[index + 1]
      index += 1
      if (next === undefined) return refuse(`参数 ${argument} 后面缺少值。`)
      if (rule.takes === 'input') {
        input(next, argument)
        continue
      }
      if (typeof next !== 'string') return refuse(`参数 ${argument} 的值要写成文字。`)
      const problem = valueProblem(next) ?? rule.check?.(next)
      if (problem !== undefined) return refuse(problem)
      prepared.args.push(argument, next)
      continue
    }
    if (profile.positional === 'input') input(argument)
    else output(argument)
  }
  return prepared
}

export interface CommandRunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly outputs: readonly { readonly name: string; readonly path: string; readonly byteSize: number }[]
}

const filesIn = async (directory: string): Promise<Set<string>> => {
  const names = new Set<string>()
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile()) names.add(entry.name)
  return names
}

/**
 * Runs programs of the current add-on providers by their command profiles (附加功能 F7), on host paths: inputs are
 * files the caller already holds, outputs land in the call's own `workDir`. Exposure to extensions maps `fileId`s onto
 * this.
 */
export class CommandProfiles {
  readonly #programs: () => readonly ActiveAddonProgram[]
  readonly #runner: ConfinedProgramRunner
  readonly #addonTitle: (profileId: string) => string | undefined

  constructor(options: {
    readonly programs: () => readonly ActiveAddonProgram[]
    readonly runner: ConfinedProgramRunner
    /** Name of the add-on that provides a profile's program, for the message while it is unavailable. */
    readonly addonTitle?: (profileId: string) => string | undefined
  }) {
    this.#programs = options.programs
    this.#runner = options.runner
    this.#addonTitle = options.addonTitle ?? (() => undefined)
  }

  /** Profiles whose program a current provider offers. */
  available(): CommandProfile[] {
    return this.#programs().flatMap((program) => (program.profile === undefined ? [] : [program.profile]))
  }

  async run(
    profileId: string,
    args: readonly CommandArgument[],
    options: {
      readonly inputs: Readonly<Record<string, string>>
      readonly workDir: string
      readonly timeoutMs?: number
      readonly signal?: AbortSignal
    },
  ): Promise<CommandRunResult> {
    const program = this.#programs().find((candidate) => candidate.profile?.id === profileId)
    const profile = program?.profile
    if (program === undefined || profile === undefined) {
      const addon = this.#addonTitle(profileId)
      throw new CommandProfileError(
        'profile-unavailable',
        `${profileId} 不可用，请管理员到「设置 → 附加功能」安装${addon ?? '提供它的附加功能'}。`,
      )
    }
    if (!path.isAbsolute(options.workDir)) throw new Error('Command work folders must be absolute host paths.')
    const prepared = prepareCommand(profile, args, options)
    for (const host of prepared.readable) {
      const info = await lstat(host).catch(() => undefined)
      if (info?.isFile() !== true) throw new Error(`Command input is not a regular file: ${host}`)
    }
    const before = await filesIn(options.workDir)
    const timeoutMs = Math.min(options.timeoutMs ?? profile.timeoutMs.default, profile.timeoutMs.max)
    const result = await this.#runner.run({
      executable: program.path,
      args: prepared.args,
      cwd: options.workDir,
      readable: prepared.readable,
      timeoutMs,
      maxOutputBytes: profile.maxStdioBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const written = [...(await filesIn(options.workDir))].filter(
      (name) => !before.has(name) || prepared.outputs.includes(name),
    )
    if (result.timedOut || written.length > profile.maxOutputs) {
      await Promise.all(written.map((name) => rm(path.join(options.workDir, name), { force: true })))
      if (result.timedOut) {
        throw new CommandProfileError(
          'timeout',
          `${profile.program} 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已停止。`,
        )
      }
      throw new CommandProfileError('too-many-outputs', `${profile.program} 最多输出 ${profile.maxOutputs} 个文件。`)
    }
    const outputs = await Promise.all(
      written.sort().map(async (name) => {
        const file = path.join(options.workDir, name)
        return { name, path: file, byteSize: (await stat(file)).size }
      }),
    )
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr,
      truncated: result.truncated,
      outputs,
    }
  }
}

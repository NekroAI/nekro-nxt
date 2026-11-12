import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { decode as decodeSilk, encode as encodeSilk, isSilk } from 'silk-wasm'
import { z } from 'zod'
import { MEDIA_INPUT_PREFIX } from './command-profiles.js'
import type { ConfinedProgramRunner } from './confined-program.js'

/** Where the current `media` provider's programs are. */
export interface MediaPrograms {
  readonly ffmpeg: string
  readonly ffprobe: string
}

export class MediaError extends Error {
  constructor(
    readonly code:
      | 'media-unavailable'
      | 'media-input'
      | 'media-options'
      | 'media-unsupported'
      | 'media-encoder-missing'
      | 'media-failed'
      | 'media-timeout',
    message: string,
  ) {
    super(message)
  }
}

export interface MediaStreamInfo {
  readonly index: number
  readonly type: 'video' | 'audio' | 'subtitle' | 'other'
  readonly codec: string
  readonly width?: number
  readonly height?: number
  readonly fps?: number
  readonly sampleRate?: number
  readonly channels?: number
}

export interface MediaProbe {
  readonly durationSeconds?: number
  /** The container as ffprobe names it (`mov` for mp4, `png_pipe` for a png), or `silk`. */
  readonly format: string
  readonly streams: readonly MediaStreamInfo[]
}

interface RunOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type FrameFormat = 'jpeg' | 'png' | 'rgb24' | 'gray8'

export interface FrameOptions extends RunOptions {
  /** Seconds to take frames at, or an even spread by interval or count between `from` and `to`. */
  readonly at?:
    | readonly number[]
    | { readonly intervalSeconds?: number; readonly count?: number; readonly from?: number; readonly to?: number }
  /** Bounds of each frame; with both, the frame fits inside them keeping its proportions. */
  readonly width?: number
  readonly height?: number
  readonly format: FrameFormat
  /** jpeg quality, 1–100. */
  readonly quality?: number
}

/** One taken frame; rgb24 and gray8 frames are bare pixels, `width × height × 3` or `× 1` bytes. */
export interface MediaFrame {
  readonly time: number
  readonly path: string
  readonly width: number
  readonly height: number
}

export type AudioFormat = 'wav' | 'pcm_s16le' | 'mp3' | 'ogg' | 'amr' | 'silk'

export interface AudioOptions extends RunOptions {
  readonly from?: number
  readonly to?: number
  readonly sampleRate?: number
  readonly channels?: number
  readonly format: AudioFormat
}

export interface AudioResult {
  readonly path: string
  readonly byteSize: number
  readonly format: AudioFormat
  readonly sampleRate: number
  readonly channels: number
}

export type ConvertFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'mp3' | 'ogg' | 'wav' | 'amr' | 'silk' | 'mp4' | 'webm'

export interface ConvertOptions extends RunOptions {
  readonly format: ConvertFormat
  readonly maxWidth?: number
  readonly maxHeight?: number
}

export interface ConvertResult {
  readonly path: string
  readonly byteSize: number
  readonly format: ConvertFormat
}

const MAX_FRAMES = 1000
const MAX_POINTS = 200
const MAX_SIDE = 8192
const MAX_TIMEOUT_MS = 900_000
const MAX_SILK_BYTES = 64 * 1024 * 1024
/** QQ and similar platforms record SILK at 24 kHz. */
const SILK_SAMPLE_RATE = 24_000
const SILK_SAMPLE_RATES = [8000, 12_000, 16_000, 24_000, 32_000, 44_100, 48_000]
const FRAME_EXTENSION: Record<FrameFormat, string> = { jpeg: 'jpg', png: 'png', rgb24: 'raw', gray8: 'raw' }
const AUDIO_TARGETS: ReadonlySet<string> = new Set<AudioFormat>(['mp3', 'ogg', 'wav', 'amr', 'silk'])
const isAudioTarget = (format: ConvertFormat): format is ConvertFormat & AudioFormat => AUDIO_TARGETS.has(format)
const SHARP_TARGETS: Partial<Record<ConvertFormat, 'png' | 'jpeg' | 'webp' | 'gif'>> = {
  png: 'png',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
}
const isPoints = (at: NonNullable<FrameOptions['at']>): at is readonly number[] => Array.isArray(at)
const ProbeOutputSchema = z.object({
  format: z.record(z.string(), z.unknown()).optional(),
  streams: z.array(z.record(z.string(), z.unknown())).optional(),
})
/** Image formats sharp converts in this process; anything else goes through ffmpeg. */
const SHARP_INPUTS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heif'])

const optionsProblem = (message: string): never => {
  throw new MediaError('media-options', message)
}

const checkSide = (value: number | undefined, label: string) => {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > MAX_SIDE)) {
    optionsProblem(`${label}要是 1 到 ${MAX_SIDE} 之间的整数。`)
  }
}

const checkSeconds = (value: number | undefined, label: string) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) optionsProblem(`${label}要是不小于 0 的秒数。`)
}

const seconds = (value: number) => String(Math.round(value * 1000) / 1000)

/** A rate such as `30000/1001` or `25/1`. */
const rate = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined
  const [top, bottom] = value.split('/').map(Number)
  if (top === undefined || !Number.isFinite(top) || top <= 0) return undefined
  const result = bottom === undefined ? top : bottom > 0 ? top / bottom : undefined
  return result === undefined ? undefined : Math.round(result * 1000) / 1000
}

const positive = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** `scale` keeping proportions inside the given bounds; `shrinkOnly` never enlarges, `even` suits yuv420p video. */
const scaleFilter = (
  width: number | undefined,
  height: number | undefined,
  options: { readonly shrinkOnly: boolean; readonly even: boolean },
): string | undefined => {
  if (width === undefined && height === undefined) return options.even ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : undefined
  const bound = (value: number | undefined, side: 'iw' | 'ih') =>
    value === undefined ? (options.even ? '-2' : '-1') : options.shrinkOnly ? `'min(${side},${value})'` : String(value)
  const fit = width !== undefined && height !== undefined ? ':force_original_aspect_ratio=decrease' : ''
  const divisible = options.even && fit !== '' ? ':force_divisible_by=2' : ''
  return `scale=w=${bound(width, 'iw')}:h=${bound(height, 'ih')}${fit}${divisible}`
}

/** `[Parsed_showinfo_N @ …] n:   0 pts: 0 pts_time:0.5 … s:64x48 …` → one entry per frame. */
const shownFrames = (stderr: string): { n: number; time: number; width: number; height: number }[] =>
  [...stderr.matchAll(/Parsed_showinfo_\d+ @ [^\]]+\] n:\s*(\d+) .*?pts_time:\s*(-?[\d.]+).*? s:(\d+)x(\d+)/gu)].map(
    (match) => ({ n: Number(match[1]), time: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }),
  )

/** One ffmpeg input: a local file, read with the forced protocol and container lists. */
const inputArgs = (file: string): string[] => [...MEDIA_INPUT_PREFIX, '-i', `file:${file}`]

/** ffmpeg's closing lines that only say something failed. */
const GENERIC_FAILURE = /^(?:Error opening (?:input|output) files?|Conversion failed!|Error opening output file)/u

const fileSize = async (file: string): Promise<number> => (await stat(file)).size

/**
 * Media processing on host paths (附加功能 F8), with the `media` add-on's ffmpeg and ffprobe run through the confined
 * program runner and SILK handled by silk-wasm in this process. Inputs must be local files; outputs go to the folder
 * or path the caller gives. Exposure to extensions maps `assetId`s and `fileId`s onto this.
 */
export class MediaToolkit {
  readonly #programs: () => MediaPrograms | undefined
  readonly #runner: ConfinedProgramRunner
  readonly #encoders = new Map<string, Promise<ReadonlySet<string>>>()

  constructor(options: { readonly programs: () => MediaPrograms | undefined; readonly runner: ConfinedProgramRunner }) {
    this.#programs = options.programs
    this.#runner = options.runner
  }

  /** Whether the `media` add-on has programs to run now. */
  available(): boolean {
    return this.#programs() !== undefined
  }

  async probe(input: string, options: RunOptions = {}): Promise<MediaProbe> {
    await this.#checkInput(input)
    const silk = await this.#silk(input)
    if (silk !== undefined) {
      return {
        durationSeconds: silk.duration / 1000,
        format: 'silk',
        streams: [{ index: 0, type: 'audio', codec: 'silk', sampleRate: SILK_SAMPLE_RATE, channels: 1 }],
      }
    }
    return this.#probe(input, options)
  }

  async frames(input: string, options: FrameOptions, outDir: string): Promise<MediaFrame[]> {
    checkSide(options.width, '宽度')
    checkSide(options.height, '高度')
    if (
      options.quality !== undefined &&
      (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100)
    ) {
      optionsProblem('画质要是 1 到 100 之间的整数。')
    }
    await this.#checkInput(input)
    const info = await this.#probe(input, options)
    if (!info.streams.some((stream) => stream.type === 'video')) {
      throw new MediaError('media-unsupported', '这个文件没有画面。')
    }
    const filters = [
      scaleFilter(options.width, options.height, { shrinkOnly: false, even: false }),
      options.format === 'jpeg' ? 'format=yuvj420p' : options.format === 'rgb24' ? 'format=rgb24' : undefined,
      options.format === 'gray8' ? 'format=gray' : undefined,
    ].filter((entry) => entry !== undefined)
    const encode =
      options.format === 'jpeg'
        ? ['-c:v', 'mjpeg', '-q:v', String(Math.round(31 - ((options.quality ?? 85) / 100) * 29))]
        : options.format === 'png'
          ? ['-c:v', 'png']
          : ['-c:v', 'rawvideo']
    const extension = FRAME_EXTENSION[options.format]
    const at = options.at ?? { count: 1 }
    if (isPoints(at)) {
      const points = at
      if (points.length === 0 || points.length > MAX_POINTS) optionsProblem(`时间点要有 1 到 ${MAX_POINTS} 个。`)
      for (const point of points) checkSeconds(point, '时间点')
      const frames: MediaFrame[] = []
      for (const [index, point] of points.entries()) {
        const target = path.join(outDir, `frame-${String(index + 1).padStart(5, '0')}.${extension}`)
        const result = await this.#ffmpeg(
          [
            '-ss',
            seconds(point),
            ...inputArgs(input),
            '-an',
            '-sn',
            '-dn',
            '-vf',
            [...filters, 'showinfo'].join(','),
            '-frames:v',
            '1',
            ...encode,
            '-f',
            'image2',
            '-update',
            '1',
            `file:${target}`,
          ],
          { cwd: outDir, readable: [input], timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal },
        )
        const shown = shownFrames(result.stderr)[0]
        // A point past the end yields no frame.
        if (shown === undefined || (await fileSize(target).catch(() => 0)) === 0) continue
        frames.push({ time: point + Math.max(0, shown.time), path: target, width: shown.width, height: shown.height })
      }
      return frames
    }
    const spread = at
    checkSeconds(spread.from, '起点')
    checkSeconds(spread.to, '终点')
    const from = spread.from ?? 0
    const to = spread.to ?? info.durationSeconds
    if (to === undefined) throw new MediaError('media-unsupported', '这个文件的时长未知，请按时间点取帧。')
    if (to <= from) optionsProblem('终点要晚于起点。')
    if (
      spread.count !== undefined &&
      (!Number.isInteger(spread.count) || spread.count < 1 || spread.count > MAX_FRAMES)
    ) {
      optionsProblem(`帧数要是 1 到 ${MAX_FRAMES} 之间的整数。`)
    }
    if (spread.intervalSeconds !== undefined && !(spread.intervalSeconds > 0)) optionsProblem('间隔要大于 0 秒。')
    const interval = spread.intervalSeconds ?? (to - from) / (spread.count ?? 1)
    const limit = Math.min(spread.count ?? Math.ceil((to - from) / interval), MAX_FRAMES)
    const pattern = path.join(outDir, `frame-%05d.${extension}`)
    const result = await this.#ffmpeg(
      [
        '-ss',
        seconds(from),
        '-t',
        seconds(to - from),
        ...inputArgs(input),
        '-an',
        '-sn',
        '-dn',
        '-vf',
        [`fps=1000/${Math.max(1, Math.round(interval * 1000))}`, ...filters, 'showinfo'].join(','),
        '-frames:v',
        String(limit),
        ...encode,
        '-f',
        'image2',
        '-start_number',
        '1',
        `file:${pattern}`,
      ],
      { cwd: outDir, readable: [input], timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal },
    )
    const frames: MediaFrame[] = []
    for (const shown of shownFrames(result.stderr)) {
      const target = path.join(outDir, `frame-${String(shown.n + 1).padStart(5, '0')}.${extension}`)
      if ((await fileSize(target).catch(() => 0)) === 0) continue
      frames.push({ time: from + Math.max(0, shown.time), path: target, width: shown.width, height: shown.height })
    }
    return frames
  }

  async audio(input: string, options: AudioOptions, outPath: string): Promise<AudioResult> {
    checkSeconds(options.from, '起点')
    checkSeconds(options.to, '终点')
    if (options.from !== undefined && options.to !== undefined && options.to <= options.from) {
      optionsProblem('终点要晚于起点。')
    }
    if (
      options.channels !== undefined &&
      (!Number.isInteger(options.channels) || options.channels < 1 || options.channels > 8)
    ) {
      optionsProblem('声道数要是 1 到 8 之间的整数。')
    }
    if (
      options.sampleRate !== undefined &&
      (!Number.isInteger(options.sampleRate) || options.sampleRate < 8000 || options.sampleRate > 192_000)
    ) {
      optionsProblem('采样率要是 8000 到 192000 之间的整数。')
    }
    if (
      options.format === 'silk' &&
      options.sampleRate !== undefined &&
      !SILK_SAMPLE_RATES.includes(options.sampleRate)
    ) {
      optionsProblem(`SILK 的采样率只能是 ${SILK_SAMPLE_RATES.join('、')}。`)
    }
    await this.#checkInput(input)
    const directory = path.dirname(outPath)
    const source = await this.#audioSource(input, directory, options)
    try {
      const sourceStream = source.info?.streams.find((stream) => stream.type === 'audio')
      if (source.info !== undefined && sourceStream === undefined) {
        throw new MediaError('media-unsupported', '这个文件没有声音。')
      }
      const forced = options.format === 'amr' ? { sampleRate: 8000, channels: 1 } : undefined
      const sampleRate =
        forced?.sampleRate ??
        options.sampleRate ??
        (options.format === 'silk' ? SILK_SAMPLE_RATE : options.format === 'ogg' ? 48_000 : undefined) ??
        sourceStream?.sampleRate ??
        SILK_SAMPLE_RATE
      const channels =
        forced?.channels ?? (options.format === 'silk' ? 1 : (options.channels ?? sourceStream?.channels ?? 1))
      const trim = [
        ...(options.from === undefined ? [] : ['-ss', seconds(options.from)]),
        ...(options.to === undefined ? [] : ['-t', seconds(options.to - (options.from ?? 0))]),
      ]
      const pcmTarget = options.format === 'silk' ? path.join(directory, `.silk-${randomUUID()}.pcm`) : outPath
      try {
        const encode =
          options.format === 'silk' ? ['-c:a', 'pcm_s16le', '-f', 's16le'] : await this.#audioEncode(options.format)
        await this.#ffmpeg(
          [
            ...trim,
            ...source.args,
            '-vn',
            '-sn',
            '-dn',
            '-ac',
            String(channels),
            '-ar',
            String(sampleRate),
            ...encode,
            `file:${pcmTarget}`,
          ],
          {
            cwd: directory,
            readable: source.readable,
            timeoutMs: options.timeoutMs ?? 300_000,
            signal: options.signal,
          },
        )
        if (options.format === 'silk') {
          const encoded = await encodeSilk(await readFile(pcmTarget), sampleRate)
          await writeFile(outPath, encoded.data)
        }
      } finally {
        if (options.format === 'silk') await rm(pcmTarget, { force: true })
      }
      return { path: outPath, byteSize: await fileSize(outPath), format: options.format, sampleRate, channels }
    } finally {
      await source.dispose()
    }
  }

  async convert(input: string, options: ConvertOptions, outPath: string): Promise<ConvertResult> {
    checkSide(options.maxWidth, '最大宽度')
    checkSide(options.maxHeight, '最大高度')
    await this.#checkInput(input)
    if (isAudioTarget(options.format)) {
      const audioFormat = options.format
      const result = await this.audio(
        input,
        {
          format: audioFormat,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        outPath,
      )
      return { path: result.path, byteSize: result.byteSize, format: options.format }
    }
    if (await this.#silk(input)) throw new MediaError('media-unsupported', 'SILK 语音只能转换成音频格式。')
    if (await this.#sharpConvert(input, options, outPath)) {
      return { path: outPath, byteSize: await fileSize(outPath), format: options.format }
    }
    const directory = path.dirname(outPath)
    const video = options.format === 'mp4' || options.format === 'webm'
    const scale = scaleFilter(options.maxWidth, options.maxHeight, { shrinkOnly: true, even: video })
    let encode: string[]
    let filters = scale === undefined ? [] : [scale]
    if (options.format === 'gif') {
      filters = ['fps=10', ...filters, 'split[a][b]', '[a]palettegen[p]', '[b][p]paletteuse']
      encode = ['-an', '-loop', '0', '-f', 'gif']
    } else if (options.format === 'png' || options.format === 'jpeg') {
      encode = [
        '-an',
        '-frames:v',
        '1',
        ...(options.format === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '3']),
        '-f',
        'image2',
        '-update',
        '1',
      ]
    } else if (options.format === 'webp') {
      const encoder = await this.#encoder(['libwebp_anim', 'libwebp'], 'webp')
      encode = ['-an', '-c:v', encoder, '-loop', '0', '-f', 'webp']
    } else if (options.format === 'mp4') {
      const encoder = await this.#encoder(['libx264', 'h264_videotoolbox', 'mpeg4'], 'mp4')
      encode = [
        '-c:v',
        encoder,
        ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '23'] : ['-b:v', '2M']),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
      ]
    } else {
      const encoder = await this.#encoder(['libvpx-vp9', 'libvpx'], 'webm')
      const audio = await this.#encoder(['libopus', 'libvorbis'], 'webm')
      encode = [
        '-c:v',
        encoder,
        ...(encoder === 'libvpx-vp9' ? ['-b:v', '0', '-crf', '32', '-row-mt', '1'] : ['-b:v', '1M']),
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        audio,
        '-f',
        'webm',
      ]
    }
    await this.#ffmpeg(
      [
        ...inputArgs(input),
        '-sn',
        '-dn',
        ...(filters.length === 0 ? [] : ['-vf', filters.join(',')]),
        ...encode,
        `file:${outPath}`,
      ],
      { cwd: directory, readable: [input], timeoutMs: options.timeoutMs ?? 300_000, signal: options.signal },
    )
    return { path: outPath, byteSize: await fileSize(outPath), format: options.format }
  }

  async #checkInput(input: string): Promise<void> {
    if (!path.isAbsolute(input)) throw new MediaError('media-input', '只能处理本机文件。')
    const info = await stat(input).catch(() => undefined)
    if (info?.isFile() !== true) throw new MediaError('media-input', '要处理的文件不存在。')
  }

  #require(): MediaPrograms {
    const programs = this.#programs()
    if (programs === undefined) {
      throw new MediaError('media-unavailable', '媒体处理不可用，请管理员到「设置 → 附加功能」安装。')
    }
    return programs
  }

  async #probe(input: string, options: RunOptions): Promise<MediaProbe> {
    const { ffprobe } = this.#require()
    const result = await this.#inScratch((cwd) =>
      this.#run(
        ffprobe,
        [
          '-hide_banner',
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          ...MEDIA_INPUT_PREFIX,
          `file:${input}`,
        ],
        { cwd, readable: [input], timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal },
      ),
    )
    let parsed: z.output<typeof ProbeOutputSchema>
    try {
      parsed = ProbeOutputSchema.parse(JSON.parse(result.stdout.toString('utf8')))
    } catch {
      throw new MediaError('media-failed', '读不出这个文件的媒体信息。')
    }
    const duration = positive(parsed.format?.['duration'])
    const formatName = parsed.format?.['format_name']
    return {
      ...(duration === undefined ? {} : { durationSeconds: duration }),
      format: typeof formatName === 'string' ? formatName.split(',')[0]! : 'unknown',
      streams: (parsed.streams ?? []).map((stream, position) => {
        const kind = stream['codec_type']
        const type = kind === 'video' || kind === 'audio' || kind === 'subtitle' ? kind : 'other'
        const width = positive(stream['width'])
        const height = positive(stream['height'])
        const fps = type === 'video' ? (rate(stream['avg_frame_rate']) ?? rate(stream['r_frame_rate'])) : undefined
        const sampleRate = positive(stream['sample_rate'])
        const channels = positive(stream['channels'])
        return {
          index: typeof stream['index'] === 'number' ? stream['index'] : position,
          type,
          codec: typeof stream['codec_name'] === 'string' ? stream['codec_name'] : 'unknown',
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(fps === undefined ? {} : { fps }),
          ...(sampleRate === undefined ? {} : { sampleRate }),
          ...(channels === undefined ? {} : { channels }),
        }
      }),
    }
  }

  /** The decoded voice when `input` is SILK; QQ's files carry one extra byte in front of the header. */
  async #silk(input: string): Promise<{ readonly pcm: Uint8Array; readonly duration: number } | undefined> {
    const handle = await open(input, 'r')
    let head: Buffer
    try {
      head = Buffer.alloc(16)
      const { bytesRead } = await handle.read(head, 0, 16, 0)
      head = head.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    if (!isSilk(head)) return undefined
    if ((await fileSize(input)) > MAX_SILK_BYTES) throw new MediaError('media-unsupported', 'SILK 语音文件太大。')
    try {
      const decoded = await decodeSilk(await readFile(input), SILK_SAMPLE_RATE)
      return { pcm: decoded.data, duration: decoded.duration }
    } catch {
      throw new MediaError('media-failed', '这段 SILK 语音解不开。')
    }
  }

  /** ffmpeg input arguments for `input`; SILK is decoded to a PCM file first and removed afterwards. */
  async #audioSource(
    input: string,
    directory: string,
    options: RunOptions,
  ): Promise<{
    readonly args: string[]
    readonly readable: string[]
    readonly info: MediaProbe | undefined
    dispose(): Promise<void>
  }> {
    const silk = await this.#silk(input)
    if (silk === undefined) {
      return {
        args: inputArgs(input),
        readable: [input],
        info: await this.#probe(input, options),
        dispose: async () => {},
      }
    }
    const pcm = path.join(directory, `.silk-${randomUUID()}.pcm`)
    await writeFile(pcm, silk.pcm)
    return {
      args: ['-f', 's16le', '-ar', String(SILK_SAMPLE_RATE), '-ac', '1', ...inputArgs(pcm)],
      readable: [pcm],
      info: undefined,
      dispose: () => rm(pcm, { force: true }),
    }
  }

  async #audioEncode(format: Exclude<AudioFormat, 'silk'>): Promise<string[]> {
    switch (format) {
      case 'wav':
        return ['-c:a', 'pcm_s16le', '-f', 'wav']
      case 'pcm_s16le':
        return ['-c:a', 'pcm_s16le', '-f', 's16le']
      case 'mp3':
        return ['-c:a', await this.#encoder(['libmp3lame'], 'mp3'), '-q:a', '4', '-f', 'mp3']
      case 'ogg': {
        const encoder = await this.#encoder(['libopus', 'libvorbis'], 'ogg')
        return ['-c:a', encoder, ...(encoder === 'libopus' ? ['-b:a', '64k'] : ['-q:a', '4']), '-f', 'ogg']
      }
      case 'amr':
        return ['-c:a', await this.#encoder(['libopencore_amrnb'], 'amr'), '-b:a', '12.2k', '-f', 'amr']
    }
  }

  /** The first of `candidates` this ffmpeg can encode with. */
  async #encoder(candidates: readonly string[], format: string): Promise<string> {
    const { ffmpeg } = this.#require()
    let known = this.#encoders.get(ffmpeg)
    if (known === undefined) {
      known = this.#inScratch((cwd) =>
        this.#run(ffmpeg, ['-hide_banner', '-encoders'], { cwd, readable: [], timeoutMs: 30_000 }),
      ).then(
        (result) =>
          new Set([...result.stdout.toString('utf8').matchAll(/^ [VAS][A-Z.]{5} (\S+)/gmu)].map((match) => match[1]!)),
      )
      this.#encoders.set(ffmpeg, known)
      known.catch(() => this.#encoders.delete(ffmpeg))
    }
    const available = await known
    const found = candidates.find((candidate) => available.has(candidate))
    if (found === undefined) {
      throw new MediaError('media-encoder-missing', `当前使用的 ffmpeg 不能生成 ${format} 文件。`)
    }
    return found
  }

  /** Converts still and animated images in this process; false when `input` is not one or the target is no image. */
  async #sharpConvert(input: string, options: ConvertOptions, outPath: string): Promise<boolean> {
    const target = SHARP_TARGETS[options.format]
    if (target === undefined) return false
    let format: string | undefined
    try {
      format = (await sharp(input).metadata()).format
    } catch {
      return false
    }
    if (format === undefined || !SHARP_INPUTS.has(format)) return false
    const animated = options.format === 'gif' || options.format === 'webp'
    try {
      await sharp(input, { animated })
        .resize({
          ...(options.maxWidth === undefined ? {} : { width: options.maxWidth }),
          ...(options.maxHeight === undefined ? {} : { height: options.maxHeight }),
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(target)
        .toFile(outPath)
    } catch {
      throw new MediaError('media-failed', '图片转换失败。')
    }
    return true
  }

  async #ffmpeg(
    args: readonly string[],
    options: { cwd: string; readable: readonly string[]; timeoutMs: number; signal: AbortSignal | undefined },
  ) {
    const { ffmpeg } = this.#require()
    return this.#run(ffmpeg, ['-nostdin', '-hide_banner', '-nostats', '-y', ...args], options)
  }

  /** Runs that write nothing still need a workspace; the Windows sandbox refuses the temp root itself as one. */
  async #inScratch<T>(run: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-media-'))
    try {
      return await run(cwd)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  async #run(
    executable: string,
    args: readonly string[],
    options: { cwd: string; readable: readonly string[]; timeoutMs: number; signal?: AbortSignal | undefined },
  ) {
    const timeoutMs = Math.min(options.timeoutMs, MAX_TIMEOUT_MS)
    const result = await this.#runner.run({
      executable,
      args,
      cwd: options.cwd,
      readable: options.readable,
      timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (result.timedOut) {
      throw new MediaError('media-timeout', `媒体处理超过 ${Math.round(timeoutMs / 1000)} 秒没有完成，已停止。`)
    }
    if (result.exitCode !== 0) {
      // ffmpeg names files by their host paths; the message keeps only file names.
      const line =
        result.stderr
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '' && !GENERIC_FAILURE.test(entry))
          .at(-1) ?? ''
      const named = [...options.readable, options.cwd].reduce(
        (text, file) => text.replaceAll(`file:${file}`, path.basename(file)).replaceAll(file, path.basename(file)),
        line.replaceAll(/file:(\S+)/gu, (_, file: string) => path.basename(file)),
      )
      throw new MediaError('media-failed', named === '' ? '媒体处理失败。' : `媒体处理失败：${named}`)
    }
    return result
  }
}

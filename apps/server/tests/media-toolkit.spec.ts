import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { isSilk } from 'silk-wasm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ConfinedProgramRunner,
  createProgramSandbox,
  type ConfinedProgramRequest,
  type ConfinedProgramResult,
} from '../src/confined-program.ts'
import { commonMediaDirectories, findSystemMediaPrograms } from '../src/media-ffmpeg.ts'
import { MediaError, MediaToolkit } from '../src/media-toolkit.ts'

const programs = await findSystemMediaPrograms({
  platform: process.platform,
  pathEnv: process.env['PATH'],
  searchDirectories: commonMediaDirectories(),
  isFile: async (file) => (await stat(file).catch(() => undefined))?.isFile() === true,
  versionOf: (file) => {
    try {
      return Promise.resolve(
        /version (\S+)/u.exec(execFileSync(file, ['-hide_banner', '-version'], { encoding: 'utf8' }))?.[1],
      )
    } catch {
      return Promise.resolve(undefined)
    }
  },
})

describe('media processing without ffmpeg', () => {
  it('asks for the add-on', async () => {
    const toolkit = new MediaToolkit({
      programs: () => undefined,
      runner: new ConfinedProgramRunner({
        sandbox: { confine: () => Promise.reject(new Error('unused')) },
        confinement: { hidden: [], readable: [] },
      }),
    })
    const file = path.join(realpathSync(tmpdir()), `nekro-nxt-media-missing-${process.pid}.bin`)
    await writeFile(file, 'x')
    try {
      expect(toolkit.available()).toBe(false)
      await expect(toolkit.probe(file)).rejects.toMatchObject({ code: 'media-unavailable' })
      await expect(toolkit.probe('relative.mp4')).rejects.toMatchObject({ code: 'media-input' })
    } finally {
      await rm(file, { force: true })
    }
  })
})

describe('media processing workspace', () => {
  it('gives probes their own directory, never the temp root the Windows sandbox reserves', async () => {
    const seen: string[] = []
    const toolkit = new MediaToolkit({
      programs: () => ({ ffmpeg: '/media/ffmpeg', ffprobe: '/media/ffprobe' }),
      runner: new (class extends ConfinedProgramRunner {
        override async run(request: ConfinedProgramRequest): Promise<ConfinedProgramResult> {
          seen.push(request.cwd)
          expect((await stat(request.cwd)).isDirectory()).toBe(true)
          return {
            exitCode: 0,
            timedOut: false,
            stdout: Buffer.from('{"format":{"format_name":"mov"},"streams":[]}'),
            stderr: '',
            truncated: false,
            confinement: 'full',
          }
        }
      })({
        sandbox: { confine: () => Promise.reject(new Error('unused')) },
        confinement: { hidden: [], readable: [] },
      }),
    })
    const file = path.join(realpathSync(tmpdir()), `nekro-nxt-media-cwd-${process.pid}.mp4`)
    await writeFile(file, 'not silk')
    try {
      await expect(toolkit.probe(file)).resolves.toMatchObject({ format: 'mov' })
    } finally {
      await rm(file, { force: true })
    }
    expect(seen).toHaveLength(1)
    expect(path.resolve(seen[0]!)).not.toBe(path.resolve(tmpdir()))
    expect(path.dirname(seen[0]!)).toBe(tmpdir())
    await expect(stat(seen[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('isolates concurrent probe work folders and removes them only after their runs finish', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nekro-nxt-media-probe-'))
  const input = path.join(directory, 'input.bin')
  await writeFile(input, 'fixture input')
  const runner = new ConfinedProgramRunner({
    sandbox: { confine: () => Promise.reject(new Error('unused')) },
    confinement: { hidden: [], readable: [] },
  })
  const requests: ConfinedProgramRequest[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const run = vi.spyOn(runner, 'run').mockImplementation(async (request) => {
    requests.push(request)
    await held
    return {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ format: { format_name: 'fixture' }, streams: [] })),
      stderr: '',
      truncated: false,
      timedOut: false,
      confinement: 'full',
    }
  })
  const toolkit = new MediaToolkit({ programs: () => ({ ffmpeg: 'fixture', ffprobe: 'fixture' }), runner })
  const probes = [toolkit.probe(input), toolkit.probe(input)]
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(new Set(requests.map(({ cwd }) => cwd)).size).toBe(2)
    for (const request of requests) {
      expect(path.resolve(request.cwd)).not.toBe(path.resolve(tmpdir()))
      expect(request.readable).toEqual([input])
      expect((await stat(request.cwd)).isDirectory()).toBe(true)
    }
    release()
    expect(await Promise.all(probes)).toEqual([
      { format: 'fixture', streams: [] },
      { format: 'fixture', streams: [] },
    ])
    for (const { cwd } of requests) await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    run.mockImplementationOnce((request) => {
      requests.push(request)
      return Promise.reject(new Error('fixture probe failed'))
    })
    await expect(toolkit.probe(input)).rejects.toThrow('fixture probe failed')
    await expect(stat(requests.at(-1)!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    release()
    await Promise.allSettled(probes)
    run.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(programs === undefined)('media processing with this device’s ffmpeg', () => {
  let root: string
  let inputs: string
  let sandbox: Awaited<ReturnType<typeof createProgramSandbox>>
  let toolkit: MediaToolkit
  const cachedFiles = sharp.cache().files.max
  const ffmpeg = (...args: string[]) =>
    execFileSync(programs!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })
  const out = async (name: string) => {
    const directory = path.join(root, 'out', name)
    await mkdir(directory, { recursive: true })
    return directory
  }

  beforeAll(async () => {
    // These fixture files are removed after the suite; libvips must not retain open handles on Windows.
    sharp.cache({ files: 0 })
    root = realpathSync(await mkdtemp(path.join(tmpdir(), 'nekro-nxt-media-')))
    // Inputs sit in a folder the confinement hides, as files under the data root do.
    inputs = path.join(root, 'hidden')
    await mkdir(inputs)
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=4:size=320x240:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4:sample_rate=44100',
      '-shortest',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      path.join(inputs, 'clip.mp4'),
    )
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=2:sample_rate=48000',
      '-ac',
      '2',
      path.join(inputs, 'tone.wav'),
    )
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5', path.join(inputs, 'moving.gif'))
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#3a7bd5' } })
      .png()
      .toFile(path.join(inputs, 'card.png'))
    sandbox = await createProgramSandbox()
    toolkit = new MediaToolkit({
      programs: () => programs,
      runner: new ConfinedProgramRunner({ sandbox, confinement: { hidden: [inputs], readable: [] } }),
    })
  })

  afterAll(async () => {
    try {
      await sandbox.dispose()
      await rm(root, { recursive: true, force: true })
    } finally {
      sharp.cache({ files: cachedFiles })
    }
  })

  it('probes duration, container and streams', async () => {
    const info = await toolkit.probe(path.join(inputs, 'clip.mp4'))
    expect(info.format).toBe('mov')
    expect(info.durationSeconds).toBeGreaterThan(3.5)
    expect(info.streams).toEqual([
      expect.objectContaining({ type: 'video', codec: 'mpeg4', width: 320, height: 240, fps: 10 }),
      expect.objectContaining({ type: 'audio', codec: 'aac', sampleRate: 44100, channels: 1 }),
    ])
  })

  it('takes jpeg frames at given times, scaled into the bounds', async () => {
    const directory = await out('points')
    const frames = await toolkit.frames(
      path.join(inputs, 'clip.mp4'),
      { at: [0.5, 2, 30], width: 160, height: 160, format: 'jpeg', quality: 70 },
      directory,
    )
    // 30 s is past the end and yields nothing.
    expect(frames.map(({ time, width, height }) => [Math.round(time * 10) / 10, width, height])).toEqual([
      [0.5, 160, 120],
      [2, 160, 120],
    ])
    const meta = await sharp(frames[0]!.path).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 160, 120])
  })

  it('takes small gray frames at an interval as bare pixels', async () => {
    const directory = await out('interval')
    const frames = await toolkit.frames(
      path.join(inputs, 'clip.mp4'),
      { at: { intervalSeconds: 1, from: 1, to: 3 }, width: 32, format: 'gray8' },
      directory,
    )
    expect(frames.map(({ time }) => time)).toEqual([1, 2])
    for (const frame of frames) {
      expect([frame.width, frame.height]).toEqual([32, 24])
      expect((await stat(frame.path)).size).toBe(32 * 24)
    }
  })

  it('spreads a count of rgb frames over the whole clip', async () => {
    const directory = await out('count')
    const frames = await toolkit.frames(
      path.join(inputs, 'clip.mp4'),
      { at: { count: 4 }, width: 16, format: 'rgb24' },
      directory,
    )
    expect(frames).toHaveLength(4)
    expect((await stat(frames[0]!.path)).size).toBe(16 * 12 * 3)
  })

  it('cuts audio to 16 kHz mono PCM', async () => {
    const target = path.join(await out('pcm'), 'speech.pcm')
    const result = await toolkit.audio(
      path.join(inputs, 'tone.wav'),
      { from: 0.5, to: 1.5, sampleRate: 16000, channels: 1, format: 'pcm_s16le' },
      target,
    )
    expect(result).toMatchObject({ format: 'pcm_s16le', sampleRate: 16000, channels: 1 })
    expect(result.byteSize).toBe(16000 * 2)
  })

  it('turns audio into SILK and back', async () => {
    const directory = await out('silk')
    const silk = await toolkit.audio(
      path.join(inputs, 'tone.wav'),
      { format: 'silk' },
      path.join(directory, 'voice.silk'),
    )
    expect(silk).toMatchObject({ sampleRate: 24000, channels: 1 })
    expect(isSilk(await readFile(silk.path))).toBe(true)
    const info = await toolkit.probe(silk.path)
    expect(info.format).toBe('silk')
    expect(info.durationSeconds).toBeGreaterThan(1.5)
    const wav = await toolkit.convert(silk.path, { format: 'wav' }, path.join(directory, 'voice.wav'))
    const back = await toolkit.probe(wav.path)
    expect(back.streams[0]).toMatchObject({ type: 'audio', codec: 'pcm_s16le', sampleRate: 24000, channels: 1 })
    expect(back.durationSeconds).toBeGreaterThan(1.5)
    // The decoded PCM is temporary.
    expect((await readdir(directory)).sort()).toEqual(['voice.silk', 'voice.wav'])
  })

  it('converts between image, animation, audio and video formats', async () => {
    const directory = await out('convert')
    const webp = await toolkit.convert(
      path.join(inputs, 'card.png'),
      { format: 'webp', maxWidth: 100 },
      path.join(directory, 'card.webp'),
    )
    expect(await sharp(webp.path).metadata()).toMatchObject({ format: 'webp', width: 100, height: 50 })
    const gif = await toolkit.convert(
      path.join(inputs, 'clip.mp4'),
      { format: 'gif', maxWidth: 80 },
      path.join(directory, 'clip.gif'),
    )
    expect(await sharp(gif.path, { animated: true }).metadata()).toMatchObject({ format: 'gif', width: 80 })
    const still = await toolkit.convert(
      path.join(inputs, 'moving.gif'),
      { format: 'png' },
      path.join(directory, 'moving.png'),
    )
    expect((await sharp(still.path).metadata()).format).toBe('png')
    const mp3 = await toolkit.convert(
      path.join(inputs, 'tone.wav'),
      { format: 'mp3' },
      path.join(directory, 'tone.mp3'),
    )
    expect((await toolkit.probe(mp3.path)).streams[0]).toMatchObject({ codec: 'mp3' })
    const mp4 = await toolkit.convert(
      path.join(inputs, 'moving.gif'),
      { format: 'mp4' },
      path.join(directory, 'moving.mp4'),
    )
    expect((await toolkit.probe(mp4.path)).streams[0]).toMatchObject({ type: 'video', width: 64, height: 48 })
  })

  it('says when this ffmpeg cannot write a format, and leaves the input alone on bad options', async () => {
    const directory = await out('limits')
    try {
      const amr = await toolkit.convert(
        path.join(inputs, 'tone.wav'),
        { format: 'amr' },
        path.join(directory, 'tone.amr'),
      )
      expect((await toolkit.probe(amr.path)).streams[0]).toMatchObject({ sampleRate: 8000, channels: 1 })
    } catch (error) {
      expect(error).toBeInstanceOf(MediaError)
      expect(error).toMatchObject({ code: 'media-encoder-missing' })
    }
    await expect(toolkit.frames(path.join(inputs, 'tone.wav'), { format: 'png' }, directory)).rejects.toMatchObject({
      code: 'media-unsupported',
    })
    await expect(
      toolkit.frames(path.join(inputs, 'clip.mp4'), { at: { intervalSeconds: 0 }, format: 'png' }, directory),
    ).rejects.toMatchObject({ code: 'media-options' })
    await expect(
      toolkit.audio(
        path.join(inputs, 'tone.wav'),
        { format: 'silk', sampleRate: 22050 },
        path.join(directory, 'x.silk'),
      ),
    ).rejects.toMatchObject({ code: 'media-options' })
  })

  it('stops on abort', async () => {
    const controller = new AbortController()
    controller.abort(new Error('fixture: stopped'))
    await expect(
      toolkit.convert(
        path.join(inputs, 'clip.mp4'),
        { format: 'webm', signal: controller.signal },
        path.join(await out('abort'), 'clip.webm'),
      ),
    ).rejects.toThrow('stopped')
  })
})

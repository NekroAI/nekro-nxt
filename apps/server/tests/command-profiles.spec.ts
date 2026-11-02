import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ActiveAddonProgram } from '../src/addons.ts'
import {
  CommandProfileError,
  CommandProfiles,
  FFMPEG_PROFILE,
  FFPROBE_PROFILE,
  prepareCommand,
  type CommandArgument,
  type CommandProfile,
} from '../src/command-profiles.ts'
import { ConfinedProgramRunner, createProgramSandbox, type ProgramSandbox } from '../src/confined-program.ts'
import { commonMediaDirectories, findSystemMediaPrograms } from '../src/media-ffmpeg.ts'
import { stat } from 'node:fs/promises'

const temporaryDirectories: string[] = []
const temporary = async () => {
  const directory = realpathSync(await mkdtemp(path.join(tmpdir(), 'nekro-nxt-profile-')))
  temporaryDirectories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const context = { inputs: { clip: '/fixture/inputs/clip.mp4' }, workDir: '/fixture/work' }
const rejection = (profile: CommandProfile, args: readonly CommandArgument[]) => {
  try {
    prepareCommand(profile, args, context)
  } catch (error) {
    if (error instanceof CommandProfileError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('The arguments were accepted.')
}

describe('checking profile arguments', () => {
  it('maps inputs and outputs to host paths with the forced arguments in front of each', () => {
    const prepared = prepareCommand(
      FFMPEG_PROFILE,
      [
        '-ss',
        '1.5',
        '-i',
        { input: 'clip' },
        '-vf',
        'scale=320:-2,fps=2',
        '-c:v',
        'mjpeg',
        { output: 'frame-%03d.jpg' },
      ],
      context,
    )
    expect(prepared.args.slice(0, 3)).toEqual(['-nostdin', '-hide_banner', '-y'])
    const input = prepared.args.indexOf('file:/fixture/inputs/clip.mp4')
    expect(prepared.args.slice(input - 5, input)).toEqual([
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      expect.stringContaining('mov,matroska'),
      '-i',
    ])
    expect(prepared.args.slice(-3)).toEqual(['-fs', String(512 * 1024 * 1024), 'file:/fixture/work/frame-%03d.jpg'])
    expect(prepared.readable).toEqual(['/fixture/inputs/clip.mp4'])
    expect(prepared.outputs).toEqual(['frame-%03d.jpg'])
  })

  it('lets ffmpeg write to standard output and ffprobe read its input as a bare argument', () => {
    expect(
      prepareCommand(
        FFMPEG_PROFILE,
        ['-i', { input: 'clip' }, '-af', 'volumedetect', '-f', 'null', '-'],
        context,
      ).args.at(-1),
    ).toBe('pipe:1')
    const probe = prepareCommand(FFPROBE_PROFILE, ['-show_streams', '-of', 'json', { input: 'clip' }], context)
    expect(probe.args.at(-1)).toBe('file:/fixture/inputs/clip.mp4')
    expect(probe.args).toContain('-protocol_whitelist')
  })

  it.each<[string, readonly CommandArgument[], string]>([
    ['options outside the allowlist', ['-report', '-i', { input: 'clip' }, { output: 'a.mp4' }], '-report'],
    ['options that read their value from a file', ['-/vf', 'filter.txt', '-i', { input: 'clip' }], '-/vf'],
    ['an input given as text', ['-i', 'https://example.test/clip.mp4', { output: 'a.mp4' }], '{ input }'],
    ['an input given as a host path', ['-i', '/etc/hosts', { output: 'a.mp4' }], '{ input }'],
    [
      'an address inside a value',
      ['-i', { input: 'clip' }, '-metadata', 'comment=http://example.test', { output: 'a.mp4' }],
      '网址',
    ],
    [
      'an absolute path inside a value',
      ['-i', { input: 'clip' }, '-map_metadata', '/etc/hosts', { output: 'a.mp4' }],
      '绝对路径',
    ],
    ['a parent folder inside a value', ['-i', { input: 'clip' }, '-metadata', 'title=../x', { output: 'a.mp4' }], '..'],
    [
      'a filter that opens another file',
      ['-i', { input: 'clip' }, '-vf', 'scale=320:-1,movie=other.mp4', { output: 'a.mp4' }],
      'movie',
    ],
    [
      'an audio source filter that opens another file',
      ['-i', { input: 'clip' }, '-filter_complex', '[0:a]amovie=x.wav[b]', { output: 'a.mp4' }],
      'amovie',
    ],
    [
      'a filter option naming a file',
      ['-i', { input: 'clip' }, '-vf', 'drawtext=textfile=notes.txt', { output: 'a.mp4' }],
      'textfile',
    ],
    ['a device or filtergraph input format', ['-f', 'lavfi', '-i', { input: 'clip' }, { output: 'a.mp4' }], 'lavfi'],
    ['a playlist input format', ['-f', 'concat', '-i', { input: 'clip' }, { output: 'a.mp4' }], 'concat'],
    ['an output given as text', ['-i', { input: 'clip' }, 'out.mp4'], '{ output }'],
    [
      'a codec name with odd characters',
      ['-i', { input: 'clip' }, '-c:v', 'lib x264', { output: 'a.mp4' }],
      'lib x264',
    ],
    ['an option missing its value', ['-i', { input: 'clip' }, '-ss'], '缺少值'],
    ['ffprobe writing a file', [{ input: 'clip' }, '-o', 'x.json'], '-o'],
  ])('refuses %s', (_, args, mention) => {
    const profile = args.includes('-o') ? FFPROBE_PROFILE : FFMPEG_PROFILE
    const refused = rejection(profile, args)
    expect(refused.code).toBe('argument-rejected')
    expect(refused.message).toContain(mention)
  })

  it.each(['../escape.mp4', 'sub/out.mp4', '.hidden', 'a%d%d.png', 'with space.mp4', ''])(
    'refuses the output name %j',
    (name) => {
      expect(rejection(FFMPEG_PROFILE, ['-i', { input: 'clip' }, { output: name }]).code).toBe('output-name')
    },
  )

  it('refuses an input key the call did not provide', () => {
    expect(rejection(FFMPEG_PROFILE, ['-i', { input: 'other' }, { output: 'a.mp4' }]).code).toBe('input-missing')
  })
})

/** A sandbox that leaves the argv as it is, for runs that only test limits. */
const plainSandbox: ProgramSandbox = {
  confine: (argv) =>
    Promise.resolve({ argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }),
}

const scriptProfile: CommandProfile = {
  ...FFPROBE_PROFILE,
  id: 'fixture',
  program: 'fixture',
  prefix: [],
  inputPrefix: [],
  options: { v: { takes: 'value' } },
  timeoutMs: { default: 5000, max: 5000 },
  maxStdioBytes: 64,
  maxOutputs: 5,
}

describe.skipIf(process.platform === 'win32')('running a profile', () => {
  const fixtureProgram = async (body: string): Promise<ActiveAddonProgram> => {
    const folder = await temporary()
    const file = path.join(folder, 'fixture')
    await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return { name: 'fixture', addon: 'media', provider: 'system', source: 'system', path: file, profile: scriptProfile }
  }
  const profiles = (program: ActiveAddonProgram, concurrency = 2) =>
    new CommandProfiles({
      programs: () => [program],
      runner: new ConfinedProgramRunner({
        sandbox: plainSandbox,
        confinement: { hidden: [], readable: [] },
        concurrency,
      }),
    })

  it('stops a program past its time limit and keeps nothing it wrote', async () => {
    const program = await fixtureProgram('echo partial > left.txt; sleep 5')
    const workDir = await temporary()
    const input = path.join(await temporary(), 'in.bin')
    await writeFile(input, 'x')
    const started = Date.now()
    await expect(
      profiles({ ...program, profile: { ...scriptProfile, timeoutMs: { default: 300, max: 300 } } }).run(
        'fixture',
        [{ input: 'in' }],
        { inputs: { in: input }, workDir },
      ),
    ).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(await readdir(workDir)).toEqual([])
  })

  it('stops on abort, also while waiting for its turn', async () => {
    const program = await fixtureProgram('sleep 5')
    const workDir = await temporary()
    const input = path.join(await temporary(), 'in.bin')
    await writeFile(input, 'x')
    const runner = profiles(
      { ...program, profile: { ...scriptProfile, timeoutMs: { default: 10_000, max: 10_000 } } },
      1,
    )
    const first = new AbortController()
    const second = new AbortController()
    const running = runner.run('fixture', [{ input: 'in' }], { inputs: { in: input }, workDir, signal: first.signal })
    const waiting = runner.run('fixture', [{ input: 'in' }], { inputs: { in: input }, workDir, signal: second.signal })
    second.abort(new Error('fixture: left the queue'))
    await expect(waiting).rejects.toThrow('left the queue')
    first.abort(new Error('fixture: stopped'))
    await expect(running).rejects.toThrow('stopped')
  })

  it('truncates long output and reports the files written', async () => {
    const program = await fixtureProgram('printf "%0200d" 0; echo done > result.txt')
    const workDir = await temporary()
    const input = path.join(await temporary(), 'in.bin')
    await writeFile(input, 'x')
    const result = await profiles(program).run('fixture', [{ input: 'in' }], { inputs: { in: input }, workDir })
    expect(result).toMatchObject({ exitCode: 0, truncated: true })
    expect(result.stdout).toHaveLength(64)
    expect(result.outputs).toEqual([{ name: 'result.txt', path: path.join(workDir, 'result.txt'), byteSize: 5 }])
  })

  it('says which add-on to install when no provider offers the program', async () => {
    const empty = new CommandProfiles({
      programs: () => [],
      runner: new ConfinedProgramRunner({ sandbox: plainSandbox, confinement: { hidden: [], readable: [] } }),
    })
    await expect(empty.run('ffmpeg', [], { inputs: {}, workDir: '/fixture' })).rejects.toMatchObject({
      code: 'profile-unavailable',
    })
  })
})

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('the confined runner', () => {
  it('reads a hidden file only when the run lists it', async () => {
    const sandbox = await createProgramSandbox()
    try {
      // Outside the system temp folder: the Linux sandbox lets every command read and write /tmp.
      await mkdir(path.join(process.cwd(), '.local'), { recursive: true })
      const hidden = realpathSync(await mkdtemp(path.join(process.cwd(), '.local', 'nekro-nxt-hidden-')))
      temporaryDirectories.push(hidden)
      const secret = path.join(hidden, 'note.txt')
      await writeFile(secret, 'fixture note')
      const runner = new ConfinedProgramRunner({ sandbox, confinement: { hidden: [hidden], readable: [] } })
      const cwd = await temporary()
      const denied = await runner.run({ executable: '/bin/cat', args: [secret], cwd, timeoutMs: 10_000 })
      if (denied.confinement === 'none') return
      expect(denied.exitCode).not.toBe(0)
      const allowed = await runner.run({
        executable: '/bin/cat',
        args: [secret],
        cwd,
        readable: [secret],
        timeoutMs: 10_000,
      })
      expect(allowed.stdout.toString('utf8')).toBe('fixture note')
    } finally {
      await sandbox.dispose()
    }
  })
})

const systemPrograms = await findSystemMediaPrograms({
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

describe.skipIf(systemPrograms === undefined)('ffmpeg through its profile, confined', () => {
  let sandbox: Awaited<ReturnType<typeof createProgramSandbox>>
  beforeAll(async () => {
    sandbox = await createProgramSandbox()
  })
  afterAll(async () => {
    await sandbox.dispose()
  })

  it('reads an input from a hidden folder, writes only into the work folder, and probes the result', async () => {
    const hidden = await temporary()
    await mkdir(path.join(hidden, 'files'))
    const input = path.join(hidden, 'files', 'tone.wav')
    execFileSync(systemPrograms!.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      input,
    ])
    const workDir = await temporary()
    const programs: ActiveAddonProgram[] = [
      { name: 'ffmpeg', addon: 'media', provider: 'system', path: systemPrograms!.ffmpeg, profile: FFMPEG_PROFILE },
      { name: 'ffprobe', addon: 'media', provider: 'system', path: systemPrograms!.ffprobe, profile: FFPROBE_PROFILE },
    ]
    const profiles = new CommandProfiles({
      programs: () => programs,
      runner: new ConfinedProgramRunner({ sandbox, confinement: { hidden: [hidden], readable: [] } }),
    })
    const converted = await profiles.run(
      'ffmpeg',
      ['-i', { input: 'tone' }, '-ac', '1', '-ar', '16000', { output: 'tone-16k.wav' }],
      { inputs: { tone: input }, workDir },
    )
    expect(converted.exitCode).toBe(0)
    expect(converted.outputs.map(({ name }) => name)).toEqual(['tone-16k.wav'])
    const probed = await profiles.run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'json', { input: 'out' }],
      { inputs: { out: converted.outputs[0]!.path }, workDir },
    )
    expect(JSON.parse(probed.stdout)).toMatchObject({ streams: [{ sample_rate: '16000', channels: 1 }] })
  })
})

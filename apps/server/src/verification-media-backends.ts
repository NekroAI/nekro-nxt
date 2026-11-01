import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { FFMPEG_PROFILE, FFPROBE_PROFILE, prepareCommand } from './command-profiles.js'
import type { NxtServiceBackends } from './extension-host-service.js'
import { encodeSpeechWav } from './speech-audio.js'

/** A tenth of a second of silence at 16 kHz. */
const PLACEHOLDER_WAV = encodeSpeechWav(new Int16Array(1600))
const PICTURES = ['png', 'jpeg', 'webp', 'gif'] as const
const VERIFICATION_PROFILES = [FFMPEG_PROFILE, FFPROBE_PROFILE]

/** A 1×1 grey picture in the asked format, a pixel for raw frames, or silence for every sound. */
const placeholder = async (format: string): Promise<Buffer> => {
  if (format === 'rgb24') return Buffer.alloc(3, 128)
  if (format === 'gray8') return Buffer.alloc(1, 128)
  const picture = PICTURES.find((candidate) => candidate === format)
  if (picture === undefined) return Buffer.from(PLACEHOLDER_WAV)
  return sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .toFormat(picture)
    .toBuffer()
}

/**
 * `nxt.media`, `nxt.commands` and `nxt.speech` for save and import verification: fixed placeholder results that keep
 * the call path and file handling real without running ffmpeg or a speech model. Each picture is a 1×1 grey frame,
 * each sound a short silence, each command checks its arguments like a real run, exits 0 and writes an empty file for every output it names, and every
 * transcript reads the same fixed text.
 */
export const verificationMediaBackends = (): Pick<NxtServiceBackends, 'media' | 'commands' | 'speech'> => ({
  media: {
    probe: () =>
      Promise.resolve({
        durationSeconds: 1,
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        streams: [
          { index: 0, type: 'video', codec: 'h264', width: 1, height: 1, fps: 1 },
          { index: 1, type: 'audio', codec: 'aac', sampleRate: 16_000, channels: 1 },
        ],
      }),
    async frames(_input, options, outDir) {
      const file = path.join(
        outDir,
        `frame-00001.${options.format === 'jpeg' ? 'jpg' : options.format === 'png' ? 'png' : 'raw'}`,
      )
      await writeFile(file, await placeholder(options.format))
      return [{ time: 0, path: file, width: 1, height: 1 }]
    },
    async audio(_input, options, outPath) {
      const bytes = await placeholder(options.format)
      await writeFile(outPath, bytes)
      return {
        path: outPath,
        byteSize: bytes.byteLength,
        format: options.format,
        sampleRate: options.sampleRate ?? 16_000,
        channels: options.channels ?? 1,
      }
    },
    async convert(_input, options, outPath) {
      const bytes = await placeholder(options.format)
      await writeFile(outPath, bytes)
      return { path: outPath, byteSize: bytes.byteLength, format: options.format }
    },
  },
  commands: {
    available: () => [...VERIFICATION_PROFILES],
    async run(profileId, args, options) {
      const profile = VERIFICATION_PROFILES.find(({ id }) => id === profileId)
      // The arguments are checked as a real run would check them; only the program is left out.
      const prepared = profile === undefined ? undefined : prepareCommand(profile, args, options)
      const outputs = []
      for (const name of prepared?.outputs ?? []) {
        if (name.includes('%')) continue
        const file = path.join(options.workDir, name)
        await writeFile(file, '')
        outputs.push({ name, path: file, byteSize: 0 })
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, outputs }
    },
  },
  speech: {
    transcribe: () => Promise.resolve(VERIFICATION_TRANSCRIPT),
    transcribeOnce: () => Promise.resolve(VERIFICATION_TRANSCRIPT),
  },
})

const VERIFICATION_TRANSCRIPT = {
  text: '验证用的固定文字',
  segments: [{ start: 0, end: 1, text: '验证用的固定文字' }],
  durationSeconds: 1,
  provider: { id: 'verification', title: '验证' },
  model: 'verification',
} as const

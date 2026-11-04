import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SpeechLanguage } from '@nekro-nxt/contracts'
import { z } from 'zod'
import type { ActiveAddonProvider } from './addons.js'
import {
  encodeSpeechWav,
  isSpeechWav,
  parseWav,
  speechSamplesOf,
  toSpeechSamples,
  SPEECH_SAMPLE_RATE,
} from './speech-audio.js'
import type { SpeechCloud } from './speech-cloud.js'
import type { SpeechSegment } from './speech-engine.js'
import type { LocalSpeech } from './speech-local.js'
import { LOCAL_SPEECH_MODELS, type LocalSpeechModelId } from './speech-model-files.js'

/** What a transcription returns (附加功能 F9, F16): the provider and model that actually ran are named. */
export interface SpeechTranscript {
  readonly text: string
  /** The language the provider heard, when it says. */
  readonly language?: string
  readonly segments: readonly SpeechSegment[]
  readonly durationSeconds: number
  readonly provider: { readonly id: string; readonly title: string }
  readonly model: string
}

export interface SpeechTranscribeInput {
  /** An audio file on this host: a WAV, or anything `decode` understands. */
  readonly path: string
  /** `auto` or absent lets the provider tell; cloud transcription then uses its configured language. */
  readonly language?: SpeechLanguage
  readonly signal?: AbortSignal
}

/**
 * Converts an audio file to 16 kHz mono 16-bit WAV at `output` (the media add-on's `audio`). Without one, only WAV
 * input is accepted.
 */
export type SpeechAudioDecoder = (
  input: string,
  output: string,
  options: { readonly sampleRate: 16000; readonly channels: 1; readonly format: 'wav'; readonly signal?: AbortSignal },
) => Promise<void>

/** Thrown while no provider can be used; the message is meant for people. */
export class SpeechUnavailableError extends Error {
  constructor() {
    super('语音识别还不能使用，请管理员到「设置 → 附加功能」安装或配置语音识别。')
  }
}

export interface SpeechServiceOptions {
  /** The provider the `speech` add-on uses now. */
  readonly active: () => ActiveAddonProvider | undefined
  readonly titles: Readonly<Record<string, string>>
  readonly local: Pick<LocalSpeech, 'transcribe'>
  readonly cloud: Pick<SpeechCloud, 'transcribe' | 'settings'>
  readonly decode?: SpeechAudioDecoder
  /** Where transcripts are kept by audio content; `<data root>/runtimes/speech/transcripts`. */
  readonly cacheDirectory: string
  /** Most transcripts kept; the least recently written go first. */
  readonly cacheEntries?: number
}

const isLocalModel = (id: string): id is LocalSpeechModelId => id in LOCAL_SPEECH_MODELS

const TranscriptSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  durationSeconds: z.number(),
  provider: z.object({ id: z.string(), title: z.string() }),
  model: z.string(),
})

/**
 * Speech to text with whichever provider the `speech` add-on uses (附加功能 F9, F16). Callers name a capability, never
 * a provider; the result says which one ran. Extensions (`nxt.speech`) and voice messages (F10) both go through here.
 */
export class SpeechService {
  readonly #options: SpeechServiceOptions
  #writes = 0

  constructor(options: SpeechServiceOptions) {
    this.#options = options
  }

  /** The provider and model a transcription would use now, or `undefined` while none can be used. */
  current():
    { readonly provider: { readonly id: string; readonly title: string }; readonly model: string } | undefined {
    const active = this.#options.active()
    if (active === undefined) return undefined
    const provider = { id: active.id, title: this.#options.titles[active.id] ?? active.id }
    if (isLocalModel(active.id)) return { provider, model: LOCAL_SPEECH_MODELS[active.id].name }
    const model = this.#options.cloud.settings()?.model
    return model === undefined ? undefined : { provider, model }
  }

  async transcribe(input: SpeechTranscribeInput): Promise<SpeechTranscript> {
    const current = this.current()
    if (current === undefined) throw new SpeechUnavailableError()
    input.signal?.throwIfAborted()
    const work = path.join(tmpdir(), `nxt-speech-${randomUUID()}`)
    try {
      const audio = await this.#speechAudio(input, work)
      const durationSeconds = Math.round((audio.samples.length / SPEECH_SAMPLE_RATE) * 100) / 100
      const language = input.language ?? 'auto'
      const options = input.signal === undefined ? {} : { signal: input.signal }
      if (isLocalModel(current.provider.id)) {
        let wav = audio.path
        if (wav === undefined) {
          await mkdir(work, { recursive: true })
          wav = path.join(work, 'speech.wav')
          await writeFile(wav, encodeSpeechWav(audio.samples))
        }
        const result = await this.#options.local.transcribe(current.provider.id, wav, {
          language,
          durationSeconds,
          ...options,
        })
        return { ...result, durationSeconds, ...current }
      }
      const { model, ...result } = await this.#options.cloud.transcribe(audio.samples, {
        ...(input.language === undefined ? {} : { language: input.language }),
        ...options,
      })
      return { ...result, durationSeconds, provider: current.provider, model }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  /**
   * Transcribes audio once per content (附加功能 F10): `digest` names the audio's bytes; the same audio with the same
   * provider, model and language is answered from the cache.
   */
  async transcribeOnce(input: SpeechTranscribeInput & { readonly digest: string }): Promise<SpeechTranscript> {
    const current = this.current()
    if (current === undefined) throw new SpeechUnavailableError()
    const key = createHash('sha256')
      .update(JSON.stringify([input.digest, current.provider.id, current.model, input.language ?? 'auto']))
      .digest('hex')
    const file = path.join(this.#options.cacheDirectory, `${key}.json`)
    try {
      const cached = TranscriptSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
      if (cached.success) {
        const { language, ...transcript } = cached.data
        return language === undefined ? transcript : { ...transcript, language }
      }
    } catch {
      // Not cached yet.
    }
    const transcript = await this.transcribe(input)
    await mkdir(this.#options.cacheDirectory, { recursive: true })
    await writeFile(file, JSON.stringify(transcript))
    if (++this.#writes % 50 === 0) await this.#prune()
    return transcript
  }

  async #prune(): Promise<void> {
    const limit = this.#options.cacheEntries ?? 2000
    const names = (await readdir(this.#options.cacheDirectory)).filter((name) => name.endsWith('.json'))
    if (names.length <= limit) return
    const entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.#options.cacheDirectory, name)
        return { file, time: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0 }
      }),
    )
    entries.sort((left, right) => left.time - right.time)
    await Promise.all(entries.slice(0, entries.length - limit).map(({ file }) => rm(file, { force: true })))
  }

  /** The input as 16 kHz mono samples, and the file itself when the engine can read it directly. */
  async #speechAudio(
    input: SpeechTranscribeInput,
    work: string,
  ): Promise<{ readonly samples: Int16Array; readonly path?: string }> {
    const info = parseWav(await readFile(input.path))
    if (info !== undefined) {
      return isSpeechWav(info)
        ? { samples: speechSamplesOf(info), path: input.path }
        : { samples: toSpeechSamples(info) }
    }
    if (this.#options.decode === undefined) {
      throw new Error('Speech input is not a 16-bit PCM or float WAV, and no audio decoder is available.')
    }
    await mkdir(work, { recursive: true })
    const decoded = path.join(work, 'decoded.wav')
    await this.#options.decode(input.path, decoded, {
      sampleRate: 16000,
      channels: 1,
      format: 'wav',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const converted = parseWav(await readFile(decoded))
    if (converted === undefined) throw new Error('The audio decoder did not produce a WAV.')
    return isSpeechWav(converted)
      ? { samples: speechSamplesOf(converted), path: decoded }
      : { samples: toSpeechSamples(converted) }
  }
}

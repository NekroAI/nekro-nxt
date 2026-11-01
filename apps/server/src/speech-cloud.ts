import type { JsonValue, SpeechCloudSettings, SpeechLanguage, SpeechSettings } from '@nekro-nxt/contracts'
import { SpeechCloudSettingsSchema } from '@nekro-nxt/contracts'
import { z } from 'zod'
import { encodeSpeechWav, splitAtQuiet, SPEECH_SAMPLE_RATE } from './speech-audio.js'
import type { SpeechEngineResult, SpeechSegment } from './speech-engine.js'

const SETTING_KEY = 'speech'
/** Long audio goes out in pieces of at most this long. */
const REQUEST_SECONDS = 30

/** A model provider from 设置 → 模型 as cloud transcription sees it. */
export interface SpeechCloudProvider {
  readonly provider: string
  readonly displayName: string
  readonly configured: boolean
  readonly baseURL?: string
  readonly api?: string
}

export interface SpeechCloudOptions {
  readonly settings: {
    get(key: string): { readonly value: JsonValue; readonly revision: number } | undefined
    put(key: string, value: JsonValue, expectedRevision: number | undefined): void
  }
  /** The providers configured in 设置 → 模型. */
  readonly providers: () => Promise<readonly SpeechCloudProvider[]>
  /** Address and key a provider's saved configuration uses. */
  readonly connection: (
    provider: string,
  ) => Promise<{ readonly baseURL?: string; readonly apiKey?: string } | undefined>
  readonly fetch?: typeof fetch
}

/** Providers spoken to with the OpenAI protocols at their own address can serve `/audio/transcriptions`. */
const transcribable = (provider: SpeechCloudProvider): boolean =>
  provider.configured &&
  provider.baseURL !== undefined &&
  (provider.api === undefined || provider.api.startsWith('openai'))

const VerboseJsonSchema = z
  .object({
    text: z.string(),
    language: z.string().optional(),
    segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough()).optional(),
  })
  .passthrough()

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  chinese: 'zh',
  mandarin: 'zh',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  cantonese: 'yue',
}

/** OpenAI names languages in full (`chinese`); others use codes. */
const languageCode = (language: string | undefined): string | undefined => {
  const value = language?.trim().toLowerCase()
  if (value === undefined || value === '') return undefined
  return LANGUAGE_NAMES[value] ?? (/^[a-z]{2,3}$/u.test(value) ? value : undefined)
}

const errorDetail = async (response: Response): Promise<string> => {
  const body = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(body)
    const error: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'error') : undefined
    const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : error
    if (typeof message === 'string') return message.slice(0, 300)
  } catch {
    // Not JSON; the text itself is the detail.
  }
  return body.trim().slice(0, 300)
}

/**
 * One request to an OpenAI-compatible `POST {baseURL}/audio/transcriptions`. Providers that ignore `verbose_json`
 * and return only text get one segment covering the whole piece.
 */
export const requestTranscription = async (input: {
  readonly baseURL: string
  readonly apiKey?: string
  readonly model: string
  readonly wav: Uint8Array<ArrayBuffer>
  readonly durationSeconds: number
  readonly language?: SpeechLanguage
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
}): Promise<SpeechEngineResult> => {
  const form = new FormData()
  form.append('file', new Blob([input.wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', input.model)
  form.append('response_format', 'verbose_json')
  if (input.language !== undefined && input.language !== 'auto') form.append('language', input.language)
  const response = await (input.fetch ?? fetch)(`${input.baseURL.replace(/\/+$/u, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: input.apiKey === undefined ? {} : { authorization: `Bearer ${input.apiKey}` },
    body: form,
    signal: input.signal ?? null,
  })
  if (!response.ok) {
    const detail = await errorDetail(response)
    const suffix = detail === '' ? '' : `：${detail}`
    if (response.status === 401 || response.status === 403) {
      throw new Error(`语音识别供应商拒绝了请求，请到「设置 → 模型」检查 API 密钥${suffix}`)
    }
    if (response.status === 404) throw new Error(`语音识别供应商没有这个模型或转写接口${suffix}`)
    if (response.status === 429) throw new Error(`语音识别供应商限流或额度不足，请稍后再试${suffix}`)
    throw new Error(`语音识别请求失败（HTTP ${response.status}）${suffix}`)
  }
  const body = await response.text()
  let parsed: z.output<typeof VerboseJsonSchema> | undefined
  try {
    const result = VerboseJsonSchema.safeParse(JSON.parse(body))
    parsed = result.success ? result.data : undefined
  } catch {
    parsed = undefined
  }
  if (parsed === undefined && body.trimStart().startsWith('{')) throw new Error('语音识别供应商返回的内容无法识别。')
  const text = (parsed?.text ?? body).trim()
  const segments: SpeechSegment[] = (parsed?.segments ?? [])
    .map((segment) => ({ start: segment.start, end: segment.end, text: segment.text.trim() }))
    .filter((segment) => segment.text !== '')
  const language = languageCode(parsed?.language)
  return {
    text,
    ...(language === undefined ? {} : { language }),
    segments: segments.length > 0 || text === '' ? segments : [{ start: 0, end: input.durationSeconds, text }],
  }
}

/** Cloud transcription through a provider from 设置 → 模型 (附加功能 F9); its choice is the system setting `speech.cloud`. */
export class SpeechCloud {
  readonly #options: SpeechCloudOptions
  readonly #listeners = new Set<() => void>()

  constructor(options: SpeechCloudOptions) {
    this.#options = options
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  settings(): SpeechCloudSettings | undefined {
    const value = this.#options.settings.get(SETTING_KEY)?.value
    const cloud = typeof value === 'object' && value !== null && !Array.isArray(value) ? value['cloud'] : undefined
    const parsed = SpeechCloudSettingsSchema.safeParse(cloud)
    return parsed.success ? parsed.data : undefined
  }

  async view(): Promise<SpeechSettings> {
    const providers = (await this.#options.providers()).filter(transcribable)
    return {
      cloud: this.settings() ?? null,
      providers: providers.map(({ provider, displayName }) => ({ provider, displayName })),
    }
  }

  async update(cloud: SpeechCloudSettings | null): Promise<SpeechSettings> {
    if (cloud !== null) {
      const providers = (await this.#options.providers()).filter(transcribable)
      if (!providers.some((provider) => provider.provider === cloud.provider)) {
        throw new Error('这个供应商不能用于语音识别，请选择有 OpenAI 兼容地址的供应商。')
      }
    }
    const current = this.#options.settings.get(SETTING_KEY)
    this.#options.settings.put(
      SETTING_KEY,
      cloud === null
        ? {}
        : {
            cloud: {
              provider: cloud.provider,
              model: cloud.model,
              ...(cloud.language === undefined ? {} : { language: cloud.language }),
            },
          },
      current?.revision,
    )
    for (const listener of this.#listeners) listener()
    return this.view()
  }

  /** Transcribes 16 kHz mono samples in pieces of at most 30 s; segment times count from the start of the audio. */
  async transcribe(
    samples: Int16Array,
    options: { readonly language?: SpeechLanguage; readonly signal?: AbortSignal },
  ): Promise<SpeechEngineResult & { readonly model: string }> {
    const settings = this.settings()
    if (settings === undefined) throw new Error('云端语音识别还没有配置。')
    const connection = await this.#options.connection(settings.provider)
    if (connection?.baseURL === undefined) {
      throw new Error('云端语音识别使用的供应商已不可用，请到「设置 → 附加功能」重新选择。')
    }
    const language = options.language ?? settings.language
    const segments: SpeechSegment[] = []
    const texts: string[] = []
    let detected: string | undefined
    for (const piece of splitAtQuiet(samples, REQUEST_SECONDS)) {
      options.signal?.throwIfAborted()
      const offset = piece.start / SPEECH_SAMPLE_RATE
      const result = await requestTranscription({
        baseURL: connection.baseURL,
        ...(connection.apiKey === undefined ? {} : { apiKey: connection.apiKey }),
        model: settings.model,
        wav: encodeSpeechWav(piece.samples),
        durationSeconds: piece.samples.length / SPEECH_SAMPLE_RATE,
        ...(language === undefined ? {} : { language }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      })
      detected ??= result.language
      if (result.text !== '') texts.push(result.text)
      const round = (seconds: number) => Math.round((offset + seconds) * 100) / 100
      for (const segment of result.segments) {
        segments.push({ start: round(segment.start), end: round(segment.end), text: segment.text })
      }
    }
    return {
      text: texts.reduce(
        (text, next) =>
          text !== '' && /[A-Za-z0-9.,!?]$/u.test(text) && /^[A-Za-z0-9]/u.test(next) ? `${text} ${next}` : text + next,
        '',
      ),
      ...(detected === undefined ? {} : { language: detected }),
      segments,
      model: settings.model,
    }
  }
}

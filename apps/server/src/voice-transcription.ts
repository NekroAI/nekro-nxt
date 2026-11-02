import type { InboundAnnotation } from '@nekro-nxt/channel-runtime'
import type { AgentId, AssetId } from '@nekro-nxt/contracts'
import type { InboundHostAnnotator } from './extension-inbound-hooks.js'
import { MediaError } from './media-toolkit.js'
import { SpeechUnavailableError, type SpeechService } from './speech-service.js'

/** The label the agent sees in front of a transcript. */
export const VOICE_TRANSCRIPTION_LABEL = '语音转写'
/** The longest a message waits for its transcripts before the agent is woken anyway (附加功能 F10). */
export const VOICE_TRANSCRIPTION_WAIT_MS = 30_000
/** Longer transcripts are cut, so one voice message stays a short note next to it. */
export const VOICE_TRANSCRIPT_MAX_CHARS = 1000

export interface VoiceTranscriptionOptions {
  /** Whether the agent turned on 语音消息转文字. */
  readonly enabled: (agentId: AgentId) => boolean
  /** Where an audio Asset's bytes are on this host and the digest of their content; `undefined` when gone. */
  readonly audio: (assetId: AssetId) => { readonly path: string; readonly digest: string } | undefined
  readonly speech: Pick<SpeechService, 'transcribeOnce'>
  readonly waitMs?: number
  /** Failures that are not the user's to fix: an engine crash, an unreadable file. */
  readonly warn?: (message: string, error: unknown) => void
}

const failed = (reason: string): InboundAnnotation => ({
  label: VOICE_TRANSCRIPTION_LABEL,
  text: `没能转成文字：${reason}`,
})

const reasonOf = (error: unknown): string | undefined => {
  if (error instanceof SpeechUnavailableError || error instanceof MediaError) return error.message.replace(/。$/u, '')
  return undefined
}

/**
 * 语音消息转文字 (附加功能 F10): for agents that turned it on, each voice part of an inbound message is transcribed once
 * by its content and shown to the agent as `[语音转写] …`. All parts of a message share one wait; past it, or on any
 * failure, the agent sees why there is no text instead. The inbound gate stores the outcome with the message's
 * decision, so a restart does not transcribe again.
 */
export const voiceTranscriptionAnnotator = (options: VoiceTranscriptionOptions): InboundHostAnnotator => ({
  covers: (agentId) => options.enabled(agentId),
  async annotate({ event }) {
    const parts = event.parts.flatMap((part) => (part.type === 'audio' ? [part.assetId] : []))
    if (parts.length === 0) return []
    const waitMs = options.waitMs ?? VOICE_TRANSCRIPTION_WAIT_MS
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve('expired')
      }, waitMs)
    })
    const timeoutReason = `${Math.round(waitMs / 1000)} 秒内没有转写完`
    try {
      const notes: InboundAnnotation[] = []
      for (const assetId of parts) {
        if (controller.signal.aborted) {
          notes.push(failed(timeoutReason))
          continue
        }
        const audio = options.audio(assetId)
        if (audio === undefined) {
          notes.push(failed('找不到这段语音'))
          continue
        }
        const transcribing = options.speech
          .transcribeOnce({ path: audio.path, digest: audio.digest, signal: controller.signal })
          .then(
            (transcript) => ({ transcript }),
            (error: unknown) => ({ error }),
          )
        const outcome = await Promise.race([transcribing, expired])
        if (outcome === 'expired') {
          notes.push(failed(timeoutReason))
          continue
        }
        if ('error' in outcome) {
          const reason = controller.signal.aborted ? timeoutReason : reasonOf(outcome.error)
          if (reason === undefined) options.warn?.('语音消息没能转成文字。', outcome.error)
          notes.push(failed(reason ?? '转写出错'))
          continue
        }
        const text = outcome.transcript.text.trim()
        notes.push(
          text === ''
            ? failed('没有听到说话')
            : {
                label: VOICE_TRANSCRIPTION_LABEL,
                text:
                  text.length <= VOICE_TRANSCRIPT_MAX_CHARS
                    ? text
                    : `${text.slice(0, VOICE_TRANSCRIPT_MAX_CHARS - 1)}…`,
              },
        )
      }
      return notes
    } finally {
      clearTimeout(timer)
    }
  },
})

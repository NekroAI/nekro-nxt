import { describe, expect, it, vi } from 'vitest'
import type { InboundHookDecision } from '@nekro-nxt/channel-runtime'
import {
  AgentIdSchema,
  AssetIdSchema,
  ChannelEventIdSchema,
  ChannelIdSchema,
  LogicalMessageIdSchema,
  type AssetId,
  type MessagePart,
} from '@nekro-nxt/contracts'
import type { BindingRecord, ChannelEventRecord } from '@nekro-nxt/core'
import { ExtensionInboundHookGate, type InboundHookDecisionStore } from '../src/extension-inbound-hooks.js'
import { MediaError } from '../src/media-toolkit.js'
import { SpeechUnavailableError, type SpeechService } from '../src/speech-service.js'
import { voiceTranscriptionAnnotator } from '../src/voice-transcription.js'

const agentId = AgentIdSchema.parse('agt_VOICEFIXTURE000000000000000')
const channelId = ChannelIdSchema.parse('chn_VOICEFIXTURE000000000000000')
const voiceAsset = AssetIdSchema.parse('ast_VOICEFIXTURE000000000000000')

const binding: BindingRecord = {
  channelId,
  agentId,
  triggerPolicy: 'always',
  paused: false,
  processingFeedback: 'auto',
  localAgentMessages: 'observe',
  activityTriggerOverrides: {},
  responseTiming: {},
  boundAt: 1,
}

let sequence = 0
const message = (parts: readonly MessagePart[]): ChannelEventRecord => {
  sequence += 1
  return {
    id: ChannelEventIdSchema.parse(`evt_VOICE${String(sequence).padStart(21, '0')}`),
    logicalMessageId: LogicalMessageIdSchema.parse(`msg_VOICE${String(sequence).padStart(21, '0')}`),
    channelId,
    kind: 'message-created',
    parts,
    sourceTimestamp: 2,
    receivedAt: 2,
    dedupeKey: `voice-${sequence}`,
    searchText: '',
  }
}

/** Saved decisions with what they were saved with, like the durable store. */
const recordingStore = () => {
  const saved = new Map<string, InboundHookDecision>()
  const store: InboundHookDecisionStore = {
    get: (eventId, agent) => saved.get(`${eventId}\0${agent}`),
    save: ({ eventId, agentId: agent, decision }) => {
      const key = `${eventId}\0${agent}`
      const existing = saved.get(key)
      if (existing !== undefined) return existing
      saved.set(key, decision)
      return decision
    },
  }
  return { store, saved }
}

const transcript = (text: string) => ({
  text,
  segments: [],
  durationSeconds: 2,
  provider: { id: 'fixture-provider', title: '示例识别' },
  model: 'fixture-model',
})

const gate = (input: {
  readonly enabled?: boolean
  readonly speech: Pick<SpeechService, 'transcribeOnce'>
  readonly store?: InboundHookDecisionStore
  readonly waitMs?: number
  readonly audio?: (assetId: AssetId) => { readonly path: string; readonly digest: string } | undefined
}) =>
  new ExtensionInboundHookGate({
    handlers: () => [],
    hostAnnotators: [
      voiceTranscriptionAnnotator({
        enabled: () => input.enabled ?? true,
        audio: input.audio ?? ((assetId) => ({ path: `/fixture/${assetId}.silk`, digest: `digest-of-${assetId}` })),
        speech: input.speech,
        ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
      }),
    ],
    describe: () => ({ displayName: '示例', capabilities: undefined }),
    nxtFor: () => {
      throw new Error('No extension handler runs here.')
    },
    message: () => {
      throw new Error('No extension handler runs here.')
    },
    store: input.store ?? recordingStore().store,
    now: () => 3,
  })

describe('语音消息转文字', () => {
  it('adds the transcript of each voice part under its own label and keeps it with the decision', async () => {
    const speech = { transcribeOnce: vi.fn(() => Promise.resolve(transcript('明天下午三点开会'))) }
    const { store, saved } = recordingStore()
    const voice = message([{ type: 'audio', assetId: voiceAsset }])
    const decision = await gate({ speech, store }).decide({ binding, event: voice, defaultTriggered: true })
    expect(decision).toEqual({
      trigger: 'default',
      hidden: false,
      hostAnnotations: [{ label: '语音转写', text: '明天下午三点开会' }],
    })
    // It is not an extension annotation.
    expect(decision.annotation).toBeUndefined()
    expect(speech.transcribeOnce).toHaveBeenCalledWith(
      expect.objectContaining({ path: `/fixture/${voiceAsset}.silk`, digest: `digest-of-${voiceAsset}` }),
    )
    expect(saved.size).toBe(1)

    // After a restart the stored decision answers; the voice is not transcribed again.
    const restarted = gate({ speech, store })
    expect(restarted.stored(voice.id, agentId)).toEqual(decision)
    expect(await restarted.decide({ binding, event: voice, defaultTriggered: true })).toEqual(decision)
    expect(speech.transcribeOnce).toHaveBeenCalledTimes(1)
  })

  it('leaves agents without the switch and messages without voice alone, deciding a plain message once', async () => {
    const speech = { transcribeOnce: vi.fn(() => Promise.resolve(transcript('不会用到'))) }
    const { store, saved } = recordingStore()
    const off = gate({ enabled: false, speech, store })
    expect(off.covers(agentId)).toBe(false)
    const on = gate({ speech, store })
    expect(on.covers(agentId)).toBe(true)
    const text = message([{ type: 'text', text: '只是文字' }])
    expect(await on.decide({ binding, event: text, defaultTriggered: true })).toEqual({
      trigger: 'default',
      hidden: false,
    })
    // The unchanged decision is kept, so a restart does not decide the message again.
    expect(saved.size).toBe(1)
    expect(on.stored(text.id, agentId)).toEqual({ trigger: 'default', hidden: false })
    expect(speech.transcribeOnce).not.toHaveBeenCalled()
  })

  it('keeps no decision when the annotator itself failed, so the message is decided again later', async () => {
    const speech = { transcribeOnce: vi.fn(() => Promise.resolve(transcript('不会用到'))) }
    const { store, saved } = recordingStore()
    const broken = gate({
      speech,
      store,
      audio: () => {
        throw new Error('示例存储读取失败')
      },
    })
    const voice = message([{ type: 'audio', assetId: voiceAsset }])
    expect(await broken.decide({ binding, event: voice, defaultTriggered: true })).toEqual({
      trigger: 'default',
      hidden: false,
    })
    expect(saved.size).toBe(0)
    expect(broken.stored(voice.id, agentId)).toBeUndefined()
  })

  it('wakes the agent after the wait with the reason instead of the text', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const speech = {
        transcribeOnce: vi.fn(
          ({ signal }: { readonly signal?: AbortSignal }) =>
            new Promise<never>(() => {
              signal?.addEventListener('abort', () => (aborted = true))
            }),
        ),
      }
      const deciding = gate({ speech }).decide({
        binding,
        event: message([
          { type: 'audio', assetId: voiceAsset },
          { type: 'audio', assetId: AssetIdSchema.parse('ast_VOICEFIXTURE000000000000001') },
        ]),
        defaultTriggered: true,
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await deciding).hostAnnotations).toEqual([
        { label: '语音转写', text: '没能转成文字：30 秒内没有转写完' },
        { label: '语音转写', text: '没能转成文字：30 秒内没有转写完' },
      ])
      expect(aborted).toBe(true)
      // The second voice part shares the same wait and is not started after it ran out.
      expect(speech.transcribeOnce).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says why there is no text when speech recognition or the audio is unavailable', async () => {
    const unavailable = gate({ speech: { transcribeOnce: () => Promise.reject(new SpeechUnavailableError()) } })
    expect(
      (
        await unavailable.decide({
          binding,
          event: message([{ type: 'audio', assetId: voiceAsset }]),
          defaultTriggered: true,
        })
      ).hostAnnotations,
    ).toEqual([
      {
        label: '语音转写',
        text: '没能转成文字：语音识别还不能使用，请管理员到「设置 → 附加功能」安装或配置语音识别',
      },
    ])
    const undecodable = gate({
      speech: {
        transcribeOnce: () =>
          Promise.reject(new MediaError('media-unavailable', '媒体处理不可用，请管理员到「设置 → 附加功能」安装。')),
      },
    })
    expect(
      (
        await undecodable.decide({
          binding,
          event: message([{ type: 'audio', assetId: voiceAsset }]),
          defaultTriggered: true,
        })
      ).hostAnnotations?.[0]?.text,
    ).toBe('没能转成文字：媒体处理不可用，请管理员到「设置 → 附加功能」安装')
    const missing = gate({ speech: { transcribeOnce: vi.fn() }, audio: () => undefined })
    expect(
      (
        await missing.decide({
          binding,
          event: message([{ type: 'audio', assetId: voiceAsset }]),
          defaultTriggered: true,
        })
      ).hostAnnotations?.[0]?.text,
    ).toBe('没能转成文字：找不到这段语音')
    const silent = gate({ speech: { transcribeOnce: () => Promise.resolve(transcript('  ')) } })
    expect(
      (
        await silent.decide({
          binding,
          event: message([{ type: 'audio', assetId: voiceAsset }]),
          defaultTriggered: true,
        })
      ).hostAnnotations?.[0]?.text,
    ).toBe('没能转成文字：没有听到说话')
  })
})

import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssetIdSchema, type ChannelId } from '@nekro-nxt/contracts'
import type { AssetService } from '@nekro-nxt/core'
import type { AssetAccessRepository } from './session-image-context.js'
import type { SpeechService } from './speech-service.js'

/** Longer transcripts are cut so one recording does not flood the context. */
export const AUDIO_TRANSCRIBE_MAX_CHARS = 20_000

/**
 * Transcribes a channel Asset on request: voice messages that arrived before 语音消息转文字 was on, or that a platform
 * delivered as a plain file (a SILK `.amr`). The same content is transcribed only once.
 */
export const transcribeChannelAudio = async (input: {
  readonly channelId: ChannelId
  readonly assetId: string
  readonly assets: Pick<AssetAccessRepository, 'getAssetById' | 'canAccessAsset'>
  readonly assetService: Pick<AssetService, 'blobPath'>
  readonly speech: Pick<SpeechService, 'transcribeOnce'>
  readonly signal?: AbortSignal
}): Promise<{ readonly text: string; readonly durationSeconds: number; readonly truncated: boolean }> => {
  const parsed = AssetIdSchema.safeParse(input.assetId)
  const asset = parsed.success ? input.assets.getAssetById(parsed.data) : undefined
  if (asset === undefined || !input.assets.canAccessAsset(asset.id, input.channelId)) {
    throw new Error(`当前频道里找不到资源 ${input.assetId}。`)
  }
  const transcript = await input.speech.transcribeOnce({
    path: input.assetService.blobPath(asset),
    digest: asset.contentDigest,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  const text = transcript.text.trim()
  const truncated = text.length > AUDIO_TRANSCRIBE_MAX_CHARS
  return {
    text: truncated ? `${text.slice(0, AUDIO_TRANSCRIBE_MAX_CHARS - 1)}…` : text,
    durationSeconds: transcript.durationSeconds,
    truncated,
  }
}

/** Registered for agents with 语音消息转文字 on. */
export const audioTranscribeTool = (
  channelId: ChannelId,
  assets: Pick<AssetAccessRepository, 'getAssetById' | 'canAccessAsset'>,
  assetService: Pick<AssetService, 'blobPath'>,
  speech: Pick<SpeechService, 'transcribeOnce'>,
) =>
  defineTool({
    name: 'audio_transcribe',
    description: [
      '把当前频道里的一段语音或音频文件转成文字。',
      '用于没有附带转写的语音，例如开启语音转文字之前的语音，或者平台当作文件发来的语音（如 .amr、.silk）。',
      '视频不能直接转写。',
    ].join(''),
    parameters: {
      assetId: { type: 'string', required: true, description: '当前频道消息里出现过的资源编号。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          durationSeconds: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_arguments, value) => [
        {
          type: 'text',
          text:
            value.text === ''
              ? `这段音频（${value.durationSeconds} 秒）里没有听到说话。`
              : `转写结果（${value.durationSeconds} 秒${value.truncated ? '，内容过长已截断' : ''}）：\n${value.text}`,
        },
      ],
    },
    execute: (args, exec) =>
      transcribeChannelAudio({ channelId, assetId: args.assetId, assets, assetService, speech, signal: exec.signal }),
  })

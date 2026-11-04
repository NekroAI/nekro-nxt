import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetService, CoreService } from '@nekro-nxt/core'
import { openMigratedCoreDatabase, SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import { AUDIO_TRANSCRIBE_MAX_CHARS, transcribeChannelAudio } from '../src/audio-transcribe-tool.js'
import { SpeechUnavailableError } from '../src/speech-service.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const setup = async (text: string | Error = '示例转写') => {
  const root = await mkdtemp(path.join(tmpdir(), 'nxt-audio-transcribe-'))
  directories.push(root)
  const database = await openMigratedCoreDatabase(path.join(root, 'core.sqlite'))
  const repository = new SqliteCoreRepository(database)
  const core = new CoreService(repository)
  const connection = core.createConnection({ adapterKey: 'fixture-alpha', config: {} })
  const roomA = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-a', kind: 'group' })
  const roomB = core.createChannel({ connectionId: connection.id, platformChannelId: 'room-b', kind: 'group' })
  const assetService = new AssetService(repository, path.join(root, 'assets'))
  // A voice message a platform delivered as a plain file.
  const { asset } = await assetService.prepare({ bytes: new TextEncoder().encode('\u0002#!SILK_V3 示例语音') })
  repository.grantAssetAccess({ assetId: asset.id, channelId: roomA.id, source: 'agent-tool', grantedAt: 1 })
  const calls: { path: string; digest: string }[] = []
  const speech = {
    transcribeOnce: (input: { readonly path: string; readonly digest: string }) => {
      calls.push({ path: input.path, digest: input.digest })
      return text instanceof Error
        ? Promise.reject(text)
        : Promise.resolve({
            text,
            segments: [],
            durationSeconds: 6.5,
            provider: { id: 'sense-voice-small', title: '本地 SenseVoice' },
            model: 'sense-voice-small-int8',
          })
    },
  }
  const transcribe = (input: { readonly assetId?: string; readonly channelId?: typeof roomA.id } = {}) =>
    transcribeChannelAudio({
      channelId: input.channelId ?? roomA.id,
      assetId: input.assetId ?? asset.id,
      assets: repository,
      assetService,
      speech,
    })
  return { database, asset, assetService, roomB, calls, transcribe }
}

describe('audio_transcribe', () => {
  it('transcribes a channel file by its content', async () => {
    const { database, asset, assetService, calls, transcribe } = await setup('  今晚八点开会  ')
    try {
      expect(await transcribe()).toEqual({ text: '今晚八点开会', durationSeconds: 6.5, truncated: false })
      expect(calls).toEqual([{ path: assetService.blobPath(asset), digest: asset.contentDigest }])
    } finally {
      database.close()
    }
  })

  it('only reads files of the current channel', async () => {
    const { database, asset, roomB, calls, transcribe } = await setup()
    try {
      await expect(transcribe({ channelId: roomB.id })).rejects.toThrow(`当前频道里找不到资源 ${asset.id}。`)
      await expect(transcribe({ assetId: 'not-an-asset' })).rejects.toThrow('当前频道里找不到资源 not-an-asset。')
      expect(calls).toEqual([])
    } finally {
      database.close()
    }
  })

  it('cuts very long transcripts and passes speech errors through', async () => {
    const long = await setup('长'.repeat(AUDIO_TRANSCRIBE_MAX_CHARS + 5))
    try {
      const result = await long.transcribe()
      expect(result.truncated).toBe(true)
      expect(result.text).toHaveLength(AUDIO_TRANSCRIBE_MAX_CHARS)
      expect(result.text.endsWith('…')).toBe(true)
    } finally {
      long.database.close()
    }
    const unavailable = await setup(new SpeechUnavailableError())
    try {
      await expect(unavailable.transcribe()).rejects.toBeInstanceOf(SpeechUnavailableError)
    } finally {
      unavailable.database.close()
    }
  })
})

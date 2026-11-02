/** WAV reading and writing for speech recognition, which works on 16 kHz mono 16-bit PCM. */
export const SPEECH_SAMPLE_RATE = 16000

export interface WavInfo {
  readonly sampleRate: number
  readonly channels: number
  readonly encoding: 'pcm16' | 'float32'
  /** The `data` chunk. */
  readonly data: Uint8Array
}

/** Reads a 16-bit PCM or 32-bit float WAV; anything else returns `undefined` and needs a decoder. */
export const parseWav = (bytes: Uint8Array): WavInfo | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let format:
    { readonly code: number; readonly channels: number; readonly sampleRate: number; readonly bits: number } | undefined
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16) {
      let code = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of its sub-format.
      if (code === 0xfffe && size >= 26) code = view.getUint16(body + 24, true)
      format = {
        code,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data' && format !== undefined) {
      // Streamed WAVs (for example from a pipe) leave the size unknown; take the rest of the file.
      const end = Math.min(bytes.byteLength, body + size)
      const encoding =
        format.code === 1 && format.bits === 16
          ? 'pcm16'
          : format.code === 3 && format.bits === 32
            ? 'float32'
            : undefined
      if (encoding === undefined || format.channels < 1 || format.sampleRate < 1) return undefined
      const frame = (encoding === 'pcm16' ? 2 : 4) * format.channels
      return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        encoding,
        data: bytes.subarray(body, body + Math.floor((end - body) / frame) * frame),
      }
    }
    offset = body + size + (size % 2)
  }
  return undefined
}

/** Whether the engine can read the file as it is. */
export const isSpeechWav = (info: WavInfo): boolean =>
  info.sampleRate === SPEECH_SAMPLE_RATE && info.channels === 1 && info.encoding === 'pcm16'

/** Mixes down to one channel and converts to 16 kHz: averaging when lowering the rate, interpolating when raising it. */
export const toSpeechSamples = (info: WavInfo): Int16Array => {
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength)
  const width = info.encoding === 'pcm16' ? 2 : 4
  const frames = info.data.byteLength / (width * info.channels)
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < info.channels; channel++) {
      const at = (frame * info.channels + channel) * width
      sum += info.encoding === 'pcm16' ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true)
    }
    mono[frame] = sum / info.channels
  }
  const ratio = info.sampleRate / SPEECH_SAMPLE_RATE
  const length = Math.floor(frames / ratio)
  const output = new Int16Array(length)
  for (let index = 0; index < length; index++) {
    let value: number
    if (ratio > 1) {
      const from = Math.floor(index * ratio)
      const to = Math.max(from + 1, Math.min(frames, Math.floor((index + 1) * ratio)))
      let sum = 0
      for (let at = from; at < to; at++) sum += mono[at]!
      value = sum / (to - from)
    } else {
      const position = index * ratio
      const left = Math.floor(position)
      const right = Math.min(frames - 1, left + 1)
      value = mono[left]! + (mono[right]! - mono[left]!) * (position - left)
    }
    output[index] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)))
  }
  return output
}

/** The samples of a 16 kHz mono 16-bit WAV, without copying. */
export const speechSamplesOf = (info: WavInfo): Int16Array =>
  info.data.byteOffset % 2 === 0
    ? new Int16Array(info.data.buffer, info.data.byteOffset, info.data.byteLength / 2)
    : new Int16Array(info.data.slice().buffer)

export const encodeSpeechWav = (samples: Int16Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(44 + samples.byteLength)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index)
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.byteLength, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SPEECH_SAMPLE_RATE, true)
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.byteLength, true)
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44)
  return bytes
}

/**
 * Cuts audio into pieces of at most `maxSeconds`, each cut at the quietest 20 ms within the last 5 s before the limit
 * so that words are rarely split. `start` is in samples from the beginning.
 */
export const splitAtQuiet = (
  samples: Int16Array,
  maxSeconds: number,
): readonly { readonly start: number; readonly samples: Int16Array }[] => {
  const limit = maxSeconds * SPEECH_SAMPLE_RATE
  const frame = SPEECH_SAMPLE_RATE / 50
  const search = 5 * SPEECH_SAMPLE_RATE
  const pieces: { start: number; samples: Int16Array }[] = []
  let start = 0
  while (samples.length - start > limit) {
    let cut = start + limit
    let quietest = Number.POSITIVE_INFINITY
    for (let at = start + limit - search; at + frame <= start + limit; at += frame) {
      let energy = 0
      for (let index = at; index < at + frame; index++) energy += samples[index]! * samples[index]!
      if (energy < quietest) {
        quietest = energy
        cut = at + frame / 2
      }
    }
    pieces.push({ start, samples: samples.subarray(start, cut) })
    start = cut
  }
  if (start < samples.length || pieces.length === 0) pieces.push({ start, samples: samples.subarray(start) })
  return pieces
}

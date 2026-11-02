// Local speech recognition engine (附加功能 F9), run as a child of the server so that its memory, its own onnxruntime
// and any native crash stay out of the server process. It loads the downloaded sherpa-onnx from the folder given as
// the first argument, answers one request at a time over IPC and exits when the server goes away.
//
// Request: { id, model: { kind: 'paraformer' | 'sense-voice', model, tokens }, vad, wav, language, threads }
// Reply:   { id, result: { text, language?, segments: [{ start, end, text }], rssBytes } } or { id, error }
import { createRequire } from 'node:module'
import path from 'node:path'

const SAMPLE_RATE = 16000
const WINDOW = 512
const MAX_SEGMENT_SAMPLES = 30 * SAMPLE_RATE

const runtimeDirectory = process.argv[2]
if (runtimeDirectory === undefined || process.send === undefined) process.exit(2)
const send = process.send.bind(process)

let sherpa
let loaded

const recognizer = (model, language, threads) => {
  const key = JSON.stringify([model, model.kind === 'sense-voice' ? language : ''])
  if (loaded?.key === key) return loaded.recognizer
  sherpa ??= createRequire(path.join(runtimeDirectory, 'loader.js'))('sherpa-onnx-node')
  loaded = undefined
  const modelConfig =
    model.kind === 'sense-voice'
      ? { senseVoice: { model: model.model, language, useInverseTextNormalization: 1 } }
      : { paraformer: { model: model.model } }
  const instance = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { ...modelConfig, tokens: model.tokens, numThreads: threads, provider: 'cpu', debug: 0 },
  })
  loaded = { key, recognizer: instance }
  return instance
}

/** `<|zh|>` → `zh`; anything else is left out. */
const languageOf = (tag) => /^<\|([a-z]{2,3})\|>$/u.exec(tag ?? '')?.[1]

// Latin words need a space between segments; Chinese and Japanese do not.
const join = (texts) =>
  texts.reduce(
    (text, next) =>
      text !== '' && /[A-Za-z0-9]$/u.test(text) && /^[A-Za-z0-9]/u.test(next) ? `${text} ${next}` : text + next,
    '',
  )

const transcribe = (request) => {
  const engine = recognizer(request.model, request.language, request.threads)
  // Electron forbids buffers backed by native memory; ask for copies.
  const wave = sherpa.readWave(request.wav, false)
  if (wave.sampleRate !== SAMPLE_RATE) throw new Error(`Expected ${SAMPLE_RATE} Hz audio, got ${wave.sampleRate} Hz.`)
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: request.vad,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.4,
        maxSpeechDuration: 30,
        windowSize: WINDOW,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60,
  )
  const segments = []
  const languages = new Map()
  const decode = (start, samples) => {
    // The detector already caps speech at 30 s; longer runs are cut into windows anyway.
    for (let offset = 0; offset < samples.length; offset += MAX_SEGMENT_SAMPLES) {
      const window = samples.subarray(offset, offset + MAX_SEGMENT_SAMPLES)
      const stream = engine.createStream()
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: window })
      engine.decode(stream)
      const result = engine.getResult(stream)
      const text = result.text.trim()
      if (text === '') continue
      const language = languageOf(result.lang)
      if (language !== undefined) languages.set(language, (languages.get(language) ?? 0) + window.length)
      const begin = start + offset
      segments.push({
        start: Math.round((begin / SAMPLE_RATE) * 100) / 100,
        end: Math.round(((begin + window.length) / SAMPLE_RATE) * 100) / 100,
        text,
      })
    }
  }
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      decode(segment.start, segment.samples)
      vad.pop()
    }
  }
  for (let index = 0; index < wave.samples.length; index += WINDOW) {
    const window = wave.samples.subarray(index, index + WINDOW)
    if (window.length < WINDOW) {
      const padded = new Float32Array(WINDOW)
      padded.set(window)
      vad.acceptWaveform(padded)
    } else vad.acceptWaveform(window)
    drain()
  }
  vad.flush()
  drain()
  const language = [...languages.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
  return {
    text: join(segments.map((segment) => segment.text)),
    ...(language === undefined ? {} : { language }),
    segments,
    rssBytes: process.memoryUsage().rss,
  }
}

process.on('message', (request) => {
  try {
    send({ id: request.id, result: transcribe(request) })
  } catch (error) {
    send({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
})
// The server went away, crashed or stopped the engine.
process.on('disconnect', () => process.exit(0))
send({ ready: true })

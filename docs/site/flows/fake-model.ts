// A local stand-in for the built-in DeepSeek (Anthropic Messages protocol, reached through DEEPSEEK_BASE_URL), so
// flows can show an agent answering without a real key. Every turn sends the next scripted reply, then ends the turn.
import { createServer, type Server } from 'node:http'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? (value as unknown[]) : [])

type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: object }

export interface FakeModel {
  readonly baseURL: string
  close(): Promise<void>
}

export const startFakeModel = async (replies: readonly string[]): Promise<FakeModel> => {
  let calls = 0
  let turns = 0
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => {
      const parsed: unknown = JSON.parse(body || '{}')
      const input = isRecord(parsed) ? parsed : {}
      const id = `msg_docs_${++calls}`
      // The turn ends only after the send has returned: first the message, then finish_channel_turn.
      const last = listOf(input['messages']).at(-1)
      const sent = isRecord(last) && listOf(last['content']).some((part) => isRecord(part) && part['type'] === 'tool_result')
      const content: Block[] =
        listOf(input['tools']).length === 0
          ? [{ type: 'text', text: 'OK' }]
          : sent
            ? [{ type: 'tool_use', id: `toolu_${calls}`, name: 'finish_channel_turn', input: { outcome: 'response-complete', reason: '已回复' } }]
            : [
                {
                  type: 'tool_use',
                  id: `toolu_${calls}`,
                  name: 'send_channel_message',
                  input: {
                    target: { type: 'current' },
                    parts: [{ text: replies[Math.min(turns++, replies.length - 1)] ?? '' }],
                  },
                },
              ]
      const stopReason = content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn'
      const usage = { input_tokens: 1200, output_tokens: 40 }
      if (input['stream'] !== true) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ id, type: 'message', role: 'assistant', model: 'deepseek-flash', content, stop_reason: stopReason, usage }),
        )
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (event: string, data: object): void => {
        response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      }
      send('message_start', {
        message: { id, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage },
      })
      content.forEach((block, index) => {
        if (block.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
        } else {
          send('content_block_start', { index, content_block: { ...block, input: {} } })
          send('content_block_delta', {
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          })
        }
        send('content_block_stop', { index })
      })
      send('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 40 } })
      send('message_stop', {})
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('假模型没有拿到端口')
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

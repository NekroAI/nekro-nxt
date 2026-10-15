import { describe, expect, it } from 'vitest'
import {
  ChannelMemberIdSchema,
  CommandDefinitionSchema,
  parseCommandArguments,
  recognizeCommand,
  tokenizeCommand,
} from '../src/index.ts'
const definition = CommandDefinitionSchema.parse({
  name: '回声',
  aliases: ['echo'],
  description: '示例',
  parameters: [
    { name: '正文', kind: 'positional', type: 'string', required: true, min: 1 },
    { name: 'count', kind: 'option', type: 'integer', min: 1, max: 5, default: 1 },
    { name: 'loud', kind: 'option', type: 'boolean' },
  ],
})
describe('command parsing', () => {
  it('preserves quoted whitespace, unicode, empty quotes and escapes without evaluation', () => {
    expect(tokenizeCommand('  回声 "你好 世界" \'\' a\\ b "x\\"y"  ')).toEqual(['回声', '你好 世界', '', 'a b', 'x"y'])
    expect(parseCommandArguments(definition, tokenizeCommand('"你好 世界" --count 2 --loud'))).toEqual({
      正文: '你好 世界',
      count: 2,
      loud: true,
    })
    expect(parseCommandArguments(definition, ['--', '--literal'])).toEqual({ 正文: '--literal', count: 1 })
  })
  it.each(['"未闭合', 'a\\'])('rejects incomplete token syntax %s', (text) =>
    expect(() => tokenizeCommand(text)).toThrow(),
  )
  it('escapes inside single quotes and requires equals syntax for option values beginning with --', () => {
    expect(tokenizeCommand(String.raw`'a\ b' 'it\'s'`)).toEqual(['a b', "it's"])
    const option = CommandDefinitionSchema.parse({
      name: 'echo',
      description: '选项边界',
      parameters: [{ name: 'value', kind: 'option', type: 'string' }],
    })
    expect(() => parseCommandArguments(option, tokenizeCommand('--value "--literal"'))).toThrow('缺少值')
    expect(parseCommandArguments(option, tokenizeCommand('--value=--literal'))).toEqual({ value: '--literal' })
  })
  it.each(
    [
      [],
      [''],
      ['hi', 'extra'],
      ['hi', '--bad'],
      ['hi', '--count'],
      ['hi', '--count', '1.5'],
      ['hi', '--count', '6'],
      ['hi', '--count', '2', '--count', '3'],
      ['hi', '--loud=bad'],
    ].map((args) => ({ args })),
  )('rejects invalid arguments $args', ({ args }) => expect(() => parseCommandArguments(definition, args)).toThrow())
  it('recognizes text-only commands and only a leading mention to the connected bot', () => {
    const bot = ChannelMemberIdSchema.parse('mbr_BOT')
    expect(
      recognizeCommand(
        [
          { type: 'mention', memberId: bot },
          { type: 'text', text: ' /help' },
        ],
        bot,
      ),
    ).toEqual({ kind: 'command', text: '/help' })
    expect(
      recognizeCommand([
        { type: 'mention', memberId: bot },
        { type: 'text', text: '/help' },
      ]),
    ).toEqual({ kind: 'chat' })
    expect(
      recognizeCommand(
        [
          { type: 'mention', memberId: ChannelMemberIdSchema.parse('mbr_OTHER') },
          { type: 'text', text: ' /stop' },
        ],
        bot,
      ),
    ).toEqual({ kind: 'chat' })
    expect(
      recognizeCommand(
        [
          { type: 'mention', memberId: bot },
          { type: 'mention', memberId: ChannelMemberIdSchema.parse('mbr_OTHER') },
          { type: 'text', text: ' /stop' },
        ],
        bot,
      ),
    ).toEqual({ kind: 'chat' })
    expect(recognizeCommand([{ type: 'text', text: '@别人 /stop' }], bot)).toEqual({ kind: 'chat' })
    expect(recognizeCommand([{ type: 'text', text: '```\n/help\n```' }])).toEqual({ kind: 'chat' })
    expect(recognizeCommand([{ type: 'text', text: '//help' }])).toEqual({
      kind: 'escaped',
      parts: [{ type: 'text', text: '/help' }],
    })
  })
  it('recognizes group commands only when addressed to the account, unless bare commands are allowed', () => {
    const bot = ChannelMemberIdSchema.parse('mbr_BOT')
    const other = ChannelMemberIdSchema.parse('mbr_OTHER')
    const requireMention = { requireMention: true }
    expect(recognizeCommand([{ type: 'text', text: '/status' }], bot, requireMention)).toEqual({ kind: 'chat' })
    expect(recognizeCommand([{ type: 'text', text: '//status' }], bot, requireMention)).toEqual({ kind: 'chat' })
    expect(
      recognizeCommand(
        [
          { type: 'mention', memberId: other },
          { type: 'text', text: ' /status' },
        ],
        bot,
        requireMention,
      ),
    ).toEqual({ kind: 'chat' })
    expect(
      recognizeCommand(
        [
          { type: 'mention', memberId: bot },
          { type: 'text', text: ' /status' },
        ],
        bot,
        requireMention,
      ),
    ).toEqual({ kind: 'command', text: '/status' })
    expect(recognizeCommand([{ type: 'text', text: '/status' }], bot)).toEqual({ kind: 'command', text: '/status' })
  })
  it('keeps console-only results by default and accepts a definition without defaulted fields', () => {
    expect(CommandDefinitionSchema.parse({ name: 'ping', description: '示例' }).webReply).toBe('local')
    expect(CommandDefinitionSchema.parse({ name: 'ping', description: '示例', webReply: 'channel' }).webReply).toBe(
      'channel',
    )
  })
  it('rejects duplicate names and ambiguous required positional ordering', () => {
    expect(() => CommandDefinitionSchema.parse({ ...definition, aliases: ['回声'] })).toThrow()
    expect(() =>
      CommandDefinitionSchema.parse({
        ...definition,
        parameters: [
          { name: 'a', kind: 'positional', type: 'string' },
          { name: 'b', kind: 'positional', type: 'string', required: true },
        ],
      }),
    ).toThrow()
  })
})

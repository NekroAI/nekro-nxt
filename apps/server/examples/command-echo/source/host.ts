import type { ExtensionHostEnvironment } from '@nekro-nxt/extension-sdk'

export default ({ harness }: ExtensionHostEnvironment) => {
  harness.registerCommand(
    {
      name: 'echo',
      aliases: ['回声'],
      description: '回显文本，验证命令扩展无需模型会话即可运行。',
      minimumPermission: 'public',
      enabledByDefault: true,
      parameters: [
        { name: 'text', kind: 'positional', type: 'string', required: true, min: 1, max: 200 },
        { name: 'count', kind: 'option', type: 'integer', default: 1, min: 1, max: 3 },
      ],
      examples: ['/echo "你好 世界" --count 2'],
    },
    (context) => {
      context.signal.throwIfAborted()
      return {
        parts: [
          {
            type: 'text',
            text: Array.from({ length: Number(context.arguments['count']) }, () =>
              String(context.arguments['text']),
            ).join('\n'),
          },
        ],
      }
    },
  )
  return { apply() {} }
}

import { z } from 'zod'
import { WebSocketServer, type WebSocket } from 'ws'

/** Synthetic OneBot endpoint: no external account, token, or network service. */
export async function startCommandPlatform() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('平台夹具端口不可用。')
  let socket: WebSocket | undefined
  let messageId = 100
  let failDelivery = false
  const sent: unknown[] = []
  server.on('connection', (client) => {
    socket = client
    client.on('message', (raw) => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const request = z
        .object({ action: z.string(), echo: z.unknown(), params: z.unknown() })
        .parse(JSON.parse(bytes.toString('utf8')))
      let data: unknown = {}
      switch (request.action) {
        case 'get_login_info':
          data = { user_id: 90001, nickname: '命令测试机器人' }
          break
        case 'get_version_info':
          data = { app_name: 'command-fixture', app_version: '1', protocol_version: 'v11' }
          break
        case 'get_group_info':
          data = { group_id: 90002, group_name: '命令测试频道', member_count: 2, max_member_count: 10 }
          break
        case 'get_group_list':
          data = [{ group_id: 90002, group_name: '命令测试频道' }]
          break
        case 'get_group_member_list':
          data = [{ user_id: 90003, nickname: '示例成员', role: 'admin' }]
          break
        case 'get_group_member_info':
        case 'get_stranger_info':
          data = { user_id: 90003, nickname: '示例成员', card: '示例成员', role: 'admin' }
          break
        case 'get_friend_list':
          data = []
          break
        case 'can_send_image':
        case 'can_send_record':
          data = { yes: true }
          break
        case 'send_group_msg':
        case 'send_private_msg':
          sent.push(request.params)
          data = { message_id: ++messageId }
          break
      }
      const failed = failDelivery && request.action.startsWith('send_')
      client.send(
        JSON.stringify({
          status: failed ? 'failed' : 'ok',
          retcode: failed ? 100 : 0,
          data,
          echo: request.echo,
          ...(failed ? { wording: '测试投递失败' } : {}),
        }),
      )
    })
  })
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    sent,
    failDelivery: (value: boolean) => {
      failDelivery = value
    },
    connected: () => socket !== undefined,
    send: (text: string, mentionBot = false) => {
      if (!socket) throw new Error('平台夹具未连接。')
      socket.send(
        JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          self_id: 90001,
          post_type: 'message',
          message_type: 'group',
          sub_type: 'normal',
          group_id: 90002,
          user_id: 90003,
          message_id: ++messageId,
          sender: { user_id: 90003, nickname: '示例成员', card: '示例成员', role: 'admin' },
          message: [
            ...(mentionBot
              ? [
                  { type: 'text', data: { text: ' ' } },
                  { type: 'at', data: { qq: '90001' } },
                ]
              : []),
            { type: 'text', data: { text } },
          ],
          raw_message: text,
          font: 0,
        }),
      )
    },
    stop: async () => {
      for (const client of server.clients) client.terminate()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    },
  }
}

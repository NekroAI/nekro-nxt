import { WebSocketServer } from 'ws'
import { z } from 'zod'

/** A local synthetic protocol peer for production journeys; never connects to a real account. */
export async function createOneBotProtocolFixture(options: { readonly accountId?: string } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener has no port')
  const authorizations: Array<string | undefined> = []
  server.on('connection', (socket, request) => {
    authorizations.push(request.headers.authorization)
    socket.on('message', (raw) => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : raw.toString('utf8')
      const body = z.object({ action: z.string(), echo: z.unknown() }).parse(JSON.parse(text))
      socket.send(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          echo: body.echo,
          data:
            body.action === 'get_login_info'
              ? { user_id: options.accountId ?? '91999' }
              : body.action === 'get_version_info'
                ? { app_name: 'SyntheticFixture', protocol_version: 'v11' }
                : {},
        }),
      )
    })
  })
  let count = 0
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    authorizations,
    emit(group: string, name: string) {
      for (const socket of server.clients)
        socket.send(
          JSON.stringify({
            post_type: 'message',
            message_type: 'group',
            group_id: group,
            group_name: name,
            user_id: '81999',
            message_id: `fixture-message-${++count}`,
            sender: { nickname: '虚构成员' },
            time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text: '虚构的频道名称验收消息' } }],
          }),
        )
    },
    async stop() {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

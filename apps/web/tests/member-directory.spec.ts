import { describe, expect, it } from 'vitest'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { MEMBER_PAGE_SIZE, reloadMembers, type ListMembers } from '../src/app/wiring/member-directory.js'

const member = (index: number) => ({
  identityId: `pid_member${index}`,
  displayName: `成员${index}`,
  adapter: { key: 'fixture-beta', displayName: '示例群聊平台' },
  connection: { id: 'con_fixture', displayName: '示例群聊平台' },
  activeChannelCount: 1,
  channelPreview: [],
  historicalOnly: false,
})

/** A directory of `total` members served in cursor pages, recording each request. */
const directory = (total: number) => {
  const requests: Parameters<ListMembers>[0][] = []
  const list: ListMembers = (input) => {
    requests.push(input)
    const start = input.cursor === undefined ? 0 : Number(input.cursor.slice('pid_member'.length)) + 1
    const items = Array.from({ length: Math.max(0, Math.min(input.limit, total - start)) }, (_, offset) =>
      member(start + offset),
    )
    const last = items.at(-1)
    const more = start + items.length < total
    return Promise.resolve(
      HostApiContracts.listPlatformUsers.response.parse({
        total,
        items,
        facets: { adapters: [], connections: [] },
        ...(more && last ? { nextCursor: last.identityId } : {}),
      }),
    )
  }
  return { list, requests }
}

describe('reloadMembers', () => {
  it('reads the first page with the page size and keeps the cursor for loading more', async () => {
    const { list, requests } = directory(45)
    const page = await reloadMembers(list, { connectionId: 'con_fixture' }, MEMBER_PAGE_SIZE)
    expect(page.items).toHaveLength(30)
    expect(page.total).toBe(45)
    expect(page.nextCursor).toBe('pid_member29')
    expect(requests).toEqual([{ connectionId: 'con_fixture', limit: 30 }])
  })

  it('re-reads every loaded row after a directory change, in pages the Host accepts', async () => {
    const { list, requests } = directory(191)
    const page = await reloadMembers(list, { connectionId: 'con_fixture', query: '成员' }, 150)
    expect(page.items).toHaveLength(150)
    expect(page.items[149]?.identityId).toBe('pid_member149')
    expect(page.nextCursor).toBe('pid_member149')
    expect(requests.map((request) => request.limit)).toEqual([100, 50])
    expect(requests.every((request) => request.query === '成员')).toBe(true)
  })

  it('stops at the end of the directory without a cursor', async () => {
    const { list } = directory(12)
    const page = await reloadMembers(list, { connectionId: 'con_fixture' }, 60)
    expect(page.items).toHaveLength(12)
    expect(page.nextCursor).toBeUndefined()
  })
})

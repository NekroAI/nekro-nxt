import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { NekroNxtApp } from '../src/app.tsx'
import { ProductHostCoordinator, type ProductSnapshot } from '../src/product-port.ts'
import { useProductStore } from '../src/product-store.ts'

const renderRoute = (route: string): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <NekroNxtApp />
    </MemoryRouter>,
  )

describe('NekroNxt product shell', () => {
  it('renders the intelligent-agent collection and desktop navigation', () => {
    const markup = renderRoute('/agents')
    expect(markup).toContain('智能体集合')
    expect(markup).toContain('小奈')
    expect(markup).toContain('频道与连接')
    expect(markup).not.toContain('NekroNxt M0')
  })

  it('keeps Channel conversations isolated and names the actual send target', () => {
    const web = renderRoute('/channels/web-main')
    expect(web).toContain('发送给：小奈')
    expect(web).toContain('复核一下第一期计划')
    expect(web).not.toContain('不会。视频在一期')

    const qq = renderRoute('/channels/qq-product')
    expect(qq).toContain('发送到：QQ 产品讨论群（通过 QQ 机器人账号）')
    expect(qq).toContain('演示视频.mp4')
    expect(qq).not.toContain('复核一下第一期计划')
  })

  it('separates dynamic approval, saving and activation semantics', () => {
    const creator = renderRoute('/creator')
    expect(creator).toContain('等待 Client UI 批准')
    expect(creator).toContain('保存为本地扩展')
    expect(creator).toContain('不会创建另一个智能体')

    useProductStore.getState().resolveApproval('approval-1', true)
    expect(useProductStore.getState().approvals[0]?.state).toBe('已批准')
  })

  it('subscribes the Shell to authoritative Host projections through a narrow Port', () => {
    let snapshot: ProductSnapshot = {
      ...useProductStore.getState(),
      diagnosticNote: 'Host projection v1',
    }
    let listener: (() => void) | undefined
    const coordinator = new ProductHostCoordinator({
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      execute: () => Promise.resolve(null),
    })
    coordinator.start()
    expect(useProductStore.getState().diagnosticNote).toBe('Host projection v1')
    snapshot = { ...snapshot, diagnosticNote: 'Host projection v2' }
    listener?.()
    expect(useProductStore.getState().diagnosticNote).toBe('Host projection v2')
    coordinator.dispose()
    expect(listener).toBeUndefined()
  })

  it('creates one intelligent-agent definition and its default Web Channel as one product action', () => {
    const beforeAgents = useProductStore.getState().agents.length
    const beforeChannels = useProductStore.getState().channels.length
    useProductStore.getState().createAgent({ name: '资料员', model: 'DeepSeek V4 · 标准' })
    expect(useProductStore.getState().agents).toHaveLength(beforeAgents + 1)
    expect(useProductStore.getState().channels).toHaveLength(beforeChannels + 1)
    expect(useProductStore.getState().agents.at(-1)).toMatchObject({
      name: '资料员',
      capabilities: { dynamicCreation: false, developmentShell: false, fullFileAccess: false },
    })
  })
})

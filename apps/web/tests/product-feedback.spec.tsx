import { renderToStaticMarkup } from 'react-dom/server'
import { Cable } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { EmptyState, PageHeader } from '../src/components/product-feedback.js'

describe('product feedback', () => {
  it('supports a bounded branded illustration without changing the empty-state copy', () => {
    const markup = renderToStaticMarkup(
      <EmptyState
        title="还没有频道"
        description="创建智能体会自动建立内置频道。"
        illustration={{ src: '/brand/illustrations/welcome.png', alt: '水月荧邀请开始' }}
      />,
    )
    expect(markup).toContain('src="/brand/illustrations/welcome.png"')
    expect(markup).toContain('alt="水月荧邀请开始"')
    expect(markup).toContain('还没有频道')
  })

  it('renders the supplied Lucide page identity instead of a generic pseudo-icon', () => {
    const markup = renderToStaticMarkup(<PageHeader icon={Cable} title="接入聊天平台" />)
    expect(markup).toContain('data-has-icon=""')
    expect(markup).toContain('lucide-cable')
    expect(markup).toContain('接入聊天平台')
  })
})

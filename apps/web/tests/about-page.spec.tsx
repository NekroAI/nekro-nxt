import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AboutPage } from '../src/pages/about-page.js'

describe('about page', () => {
  it('shows product, release, repository, license and brand ownership facts', () => {
    const markup = renderToStaticMarkup(
      <AboutPage
        metadata={{
          displayName: 'NekroNXT Preview',
          organizationName: 'NekroAI',
          version: '1.2.3-preview',
          releaseId: 'nxt-release-test',
          repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
          licenseSpdx: 'MIT',
        }}
      />,
    )

    expect(markup).toContain('NekroNXT Preview')
    expect(markup).toContain('1.2.3-preview')
    expect(markup).toContain('nxt-release-test')
    expect(markup).toContain('NekroAI/nekro-nxt')
    expect(markup).toContain('MIT')
    expect(markup).toContain('Logo、水月荧、角色插画和宣传素材版权归 NekroAI')
  })

  it('keeps missing live metadata understandable', () => {
    const markup = renderToStaticMarkup(<AboutPage />)
    expect(markup).toContain('NekroNXT')
    expect(markup).toContain('Release ID')
    expect(markup).toContain('暂无')
    expect(markup).toContain('待项目所有者补充')
  })
})

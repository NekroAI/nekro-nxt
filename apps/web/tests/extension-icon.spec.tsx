import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { communityExtensionPage, listingChanges, parseListingTags } from '../src/app/workshop/publish-dialog.tsx'
import { extensionIconUrl } from '../src/http-host.ts'
import { ExtensionIcon, hueOf } from '../src/ui-kit/index.ts'

const icon = (revision: string, digest: string) =>
  `/api/extensions/ext_01ICONWEB/revisions/${revision}/icon/${digest.repeat(64)}.png`

const revision = (id: string, iconUrl?: string) => ({ id, ...(iconUrl === undefined ? {} : { iconUrl }) })

const extension = (
  overrides: Partial<Parameters<typeof extensionIconUrl>[0]>,
): Parameters<typeof extensionIconUrl>[0] => ({
  revisions: [
    revision('xrv_01A', icon('xrv_01A', 'a')),
    revision('xrv_01B', icon('xrv_01B', 'b')),
    revision('xrv_01C'),
  ],
  activations: [],
  ...overrides,
})

describe('extension icon selection', () => {
  it('follows the revision in use and otherwise the newest revision with an icon', () => {
    expect(extensionIconUrl(extension({}))).toBe(icon('xrv_01B', 'b'))
    expect(
      extensionIconUrl(
        extension({
          activations: [
            { extensionRevisionId: 'xrv_01B', activatedAt: 1 },
            { extensionRevisionId: 'xrv_01A', activatedAt: 5 },
          ],
        }),
      ),
    ).toBe(icon('xrv_01A', 'a'))
    expect(extensionIconUrl(extension({ revisions: [] }))).toBeUndefined()
  })
})

describe('ExtensionIcon', () => {
  it('shows the package icon or a stable initial placeholder', () => {
    const withImage = renderToStaticMarkup(<ExtensionIcon id="ext_01A" name="天气" iconUrl="/icon.png" />)
    expect(withImage).toContain('src="/icon.png"')
    expect(withImage).toContain('data-image')
    const placeholder = renderToStaticMarkup(<ExtensionIcon id="ext_01A" name="天气" iconUrl={null} />)
    expect(placeholder).not.toContain('<img')
    expect(placeholder).toContain('>天</span>')
    expect(placeholder).toContain(`--h:${hueOf('ext_01A')}`)
  })
})

describe('community listing input', () => {
  it('splits tags on common separators and removes duplicates', () => {
    expect(parseListingTags(' 天气，提醒、#天气 tools ')).toEqual(['天气', '提醒', 'tools'])
  })

  it('submits only fields that differ from the community listing', () => {
    const initial = { summary: '查询天气', description: '旧介绍', tags: '天气', sourceUrl: 'https://example.com/a' }
    expect(listingChanges(initial, initial)).toEqual({})
    expect(
      listingChanges({ ...initial, summary: ' 查询城市天气 ', tags: '天气、提醒', sourceUrl: '' }, initial),
    ).toEqual({ summary: '查询城市天气', tags: ['天气', '提醒'] })
    const empty = { summary: '', description: '', tags: '', sourceUrl: '' }
    expect(listingChanges({ ...empty, description: '## 用法' }, empty)).toEqual({ description: '## 用法' })
  })

  it('resets an empty source address to the extension page on the community', () => {
    const page = communityExtensionPage('https://community.example.com', 'ext_01DEMO')
    expect(page).toBe('https://community.example.com/extensions/ext_01DEMO')
    const initial = { summary: '查询天气', description: '', tags: '', sourceUrl: 'https://example.com/a' }
    expect(listingChanges({ ...initial, sourceUrl: '  ' }, initial, page)).toEqual({ sourceUrl: page })
    const first = { summary: '', description: '', tags: '', sourceUrl: '' }
    expect(listingChanges(first, first, page)).toEqual({ sourceUrl: page })
    expect(listingChanges({ ...initial, sourceUrl: page }, { ...initial, sourceUrl: page }, page)).toEqual({})
  })
})

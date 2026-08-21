import { DSH_RELEASE_VERSION } from './lib/dsh-release.mjs'

const githubReleasesUrl = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=20'
const npmMetadataUrl = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'

try {
  const [githubResponse, npmResponse] = await Promise.all([
    globalThis.fetch(githubReleasesUrl, { headers: { accept: 'application/vnd.github+json' } }),
    globalThis.fetch(npmMetadataUrl, { headers: { accept: 'application/json' } }),
  ])
  if (!githubResponse.ok) throw new Error(`GitHub Releases returned HTTP ${githubResponse.status}`)
  if (!npmResponse.ok) throw new Error(`npm registry returned HTTP ${npmResponse.status}`)
  const releases = await githubResponse.json()
  const metadata = await npmResponse.json()
  const release = Array.isArray(releases)
    ? releases.find((candidate) => typeof candidate?.tag_name === 'string' && candidate.tag_name.startsWith('dsh-v'))
    : undefined
  const npmNext = metadata?.['dist-tags']?.next
  const publishedAt = typeof release?.published_at === 'string' ? release.published_at : '未知'
  console.log(`当前 DSH：${DSH_RELEASE_VERSION}`)
  console.log(`GitHub Release：${release?.tag_name ?? '未找到'}（${publishedAt}）`)
  console.log(`npm next：${typeof npmNext === 'string' ? npmNext : '未找到'}`)
} catch (error) {
  console.warn(`无法检查 DSH 更新：${error instanceof Error ? error.message : String(error)}`)
}

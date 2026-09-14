/** Unknown paths deliberately count as product changes. */
export function hasPreviewProductChanges(paths) {
  return paths.some((file) => {
    if (file.startsWith('docs/') || file.startsWith('.github/ISSUE_TEMPLATE/')) return false
    if (/(?:^|\/)(?:README|AGENTS|CHANGELOG)\.md$/u.test(file)) return false
    if (/^(?:LICENSE|NOTICE|\.gitignore|\.prettierignore)$/u.test(file)) return false
    if (/^(?:apps|packages)\/[^/]+\/(?:tests|e2e|browser-tests)\//u.test(file) || file.startsWith('scripts/tests/'))
      return false
    return true
  })
}

export function publishedPreviewCommit(release) {
  if (!release || release.draft) return undefined
  return /<!-- nxt-preview-commit:([a-f0-9]{40}) -->/u.exec(release.body ?? '')?.[1]
}

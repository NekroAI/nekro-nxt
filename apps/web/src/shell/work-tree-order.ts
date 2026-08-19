export const orderByIds = <T extends { readonly id: string }>(
  items: readonly T[],
  preferred: readonly string[],
): T[] => {
  const remaining = new Map(items.map((item) => [item.id, item]))
  const ordered: T[] = []
  for (const id of preferred) {
    const item = remaining.get(id)
    if (!item) continue
    ordered.push(item)
    remaining.delete(id)
  }
  for (const item of items) {
    if (remaining.has(item.id)) ordered.push(item)
  }
  return ordered
}

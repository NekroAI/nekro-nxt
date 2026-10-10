import { createHash } from 'node:crypto'
import { ExtensionIdSchema, type ExtensionIndexCollection } from '@nekro-nxt/contracts'
import type {
  NxtIndexCondition,
  NxtIndexDocument,
  NxtIndexHit,
  NxtIndexQueryOptions,
  NxtIndexQueryResult,
} from '@nekro-nxt/extension-sdk'
import { EXTENSION_INDEX_KEYWORD_COLUMNS, type ExtensionIndexRepository } from '@nekro-nxt/storage-sqlite'
import { NxtCapabilityError } from './extension-host-service.js'

const DOCUMENT_ID_PATTERN = /^[\p{L}\p{N}._:/-]{1,128}$/u
const FIELD_MAX_CHARS = 4000
const FILTER_VALUE_MAX_CHARS = 128
const FILTER_VALUES_PER_FIELD = 64
const QUERY_MAX_TERMS = 32
/** Reciprocal-rank fusion constant; 60 is the usual choice and keeps either list from dominating. */
const RRF_K = 60

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
/** Single characters that carry no meaning on their own; longer words always count. */
const STOP_CHARACTERS = new Set('的了是在我你他她它和与就都也还很被把这那个一有吗呢吧啊呀哦嗯'.split(''))

/** Words of a text, lower-cased; the same segmentation builds documents and queries so they always meet. */
export const segmentWords = (text: string): readonly string[] =>
  [...segmenter.segment(text.toLowerCase())].filter((part) => part.isWordLike).map((part) => part.segment)

/** An FTS5 query matching any meaningful word of `text`, or `undefined` when there is none. */
export const keywordQuery = (text: string): string | undefined => {
  const terms = [...new Set(segmentWords(text).filter((word) => !(word.length === 1 && STOP_CHARACTERS.has(word))))]
  if (terms.length === 0) return undefined
  return terms
    .slice(0, QUERY_MAX_TERMS)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ')
}

/** Text a document is embedded from: its fields in declaration order. */
export const embeddingText = (fields: Readonly<Record<string, string>>): string =>
  Object.values(fields)
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .join('\n')

export const embeddingTextDigest = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface ValidatedIndexDocument {
  /** Declared text fields in declaration order; missing ones are empty. */
  readonly fields: Readonly<Record<string, string>>
  readonly keywords: readonly string[]
  readonly filters: readonly NxtIndexCondition[]
}

export const validateIndexDocument = (
  collection: ExtensionIndexCollection,
  id: string,
  document: NxtIndexDocument,
): ValidatedIndexDocument => {
  if (typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id)) {
    throw new NxtCapabilityError('索引文档 id 必须是 1–128 个字母、数字或 . _ : / - 字符。')
  }
  const declaredFields = collection.fields.map(({ name }) => name)
  const given = document?.fields ?? {}
  for (const name of Object.keys(given)) {
    if (!declaredFields.includes(name)) {
      throw new NxtCapabilityError(
        `索引 ${collection.name} 没有声明文本字段 ${name}。已声明：${declaredFields.join('、')}`,
      )
    }
  }
  const fields: Record<string, string> = {}
  for (const name of declaredFields) {
    const value = given[name] ?? ''
    if (typeof value !== 'string') throw new NxtCapabilityError(`索引字段 ${name} 必须是字符串。`)
    if (value.length > FIELD_MAX_CHARS) throw new NxtCapabilityError(`索引字段 ${name} 最多 ${FIELD_MAX_CHARS} 字。`)
    fields[name] = value
  }
  const filters: NxtIndexCondition[] = []
  for (const [field, raw] of Object.entries(document?.filters ?? {})) {
    if (!collection.filters.includes(field)) {
      throw new NxtCapabilityError(
        `索引 ${collection.name} 没有声明过滤项 ${field}。已声明：${collection.filters.join('、') || '无'}`,
      )
    }
    const values = typeof raw === 'string' ? [raw] : raw
    if (!Array.isArray(values) || values.length > FILTER_VALUES_PER_FIELD) {
      throw new NxtCapabilityError(`过滤项 ${field} 必须是字符串或最多 ${FILTER_VALUES_PER_FIELD} 个字符串的数组。`)
    }
    for (const value of values) {
      if (typeof value !== 'string' || value === '' || value.length > FILTER_VALUE_MAX_CHARS) {
        throw new NxtCapabilityError(`过滤项 ${field} 的每个值需要 1–${FILTER_VALUE_MAX_CHARS} 个字符。`)
      }
      filters.push({ field, value })
    }
  }
  const keywords = Array.from({ length: EXTENSION_INDEX_KEYWORD_COLUMNS }, (_, column) => {
    const name = declaredFields[column]
    return name === undefined ? '' : segmentWords(fields[name]!).join(' ')
  })
  return { fields, keywords, filters }
}

/** `Array.isArray` without its `any[]` narrowing, for values that are typed but come from extension code. */
const isList = (value: unknown): boolean => Array.isArray(value)

export const validateIndexFilter = (
  collection: ExtensionIndexCollection,
  filter: NxtIndexQueryOptions['filter'],
): readonly (readonly NxtIndexCondition[])[] => {
  if (filter === undefined) return []
  if (!isList(filter) || filter.length > 8) throw new NxtCapabilityError('filter 最多 8 组条件。')
  return filter.map((group) => {
    if (!isList(group) || group.length === 0 || group.length > 16) {
      throw new NxtCapabilityError('filter 的每组需要 1–16 个条件。')
    }
    return group.map(({ field, value }) => {
      if (!collection.filters.includes(field)) {
        throw new NxtCapabilityError(`索引 ${collection.name} 没有声明过滤项 ${String(field)}。`)
      }
      if (typeof value !== 'string') throw new NxtCapabilityError('过滤条件的值必须是字符串。')
      return { field, value }
    })
  })
}

export const queryLimit = (limit: number | undefined): number => Math.min(Math.max(Math.trunc(limit ?? 10), 1), 50)

/** int8 components with one scale per vector; cosine ranking is unaffected and storage is a quarter of float32. */
export const quantizeVector = (vector: Float32Array): { readonly vector: Buffer; readonly scale: number } => {
  let max = 0
  for (const value of vector) max = Math.max(max, Math.abs(value))
  const scale = max === 0 ? 1 : max / 127
  const bytes = Buffer.alloc(vector.length)
  for (let index = 0; index < vector.length; index++) bytes.writeInt8(Math.round(vector[index]! / scale), index)
  return { vector: bytes, scale }
}

const dotQuantized = (query: Float32Array, stored: Buffer, scale: number): number => {
  let sum = 0
  const length = Math.min(query.length, stored.length)
  for (let index = 0; index < length; index++) sum += query[index]! * stored.readInt8(index)
  return sum * scale
}

/** Supplies query vectors when the Host has vector search enabled. */
export interface IndexVectorProvider {
  /**
   * The query embedded in the active space; `{ degraded }` explains why vectors cannot take part right now;
   * `undefined` means vector search is off.
   */
  queryVector(
    text: string,
  ): Promise<{ readonly space: string; readonly vector: Float32Array } | { readonly degraded: string } | undefined>
  /** Documents were added or changed and may need vectors. */
  documentsChanged(): void
}

export interface ExtensionIndexEngine {
  upsert(extensionId: string, collection: ExtensionIndexCollection, id: string, document: ValidatedIndexDocument): void
  delete(extensionId: string, collection: string, id: string): boolean
  query(
    extensionId: string,
    collection: ExtensionIndexCollection,
    text: string,
    options: { readonly limit: number; readonly filter: readonly (readonly NxtIndexCondition[])[] },
  ): Promise<NxtIndexQueryResult>
  count(extensionId: string, collection: string): number
}

const fuse = (lists: readonly (readonly string[])[], limit: number): readonly NxtIndexHit[] => {
  const scores = new Map<string, number>()
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, score: Number(score.toFixed(6)) }))
}

/** Keyword search in SQLite FTS5, fused with vectors of the active space when the Host provides them. */
export const sqliteIndexEngine = (
  repository: ExtensionIndexRepository,
  vectors: IndexVectorProvider | undefined,
  now: () => number,
): ExtensionIndexEngine => ({
  upsert(extensionId, collection, id, document) {
    repository.upsertIndexDocument({
      extensionId: ExtensionIdSchema.parse(extensionId),
      collection: collection.name,
      documentId: id,
      fields: document.fields,
      keywords: document.keywords,
      filters: document.filters,
      updatedAt: now(),
    })
    vectors?.documentsChanged()
  },
  delete: (extensionId, collection, id) =>
    repository.deleteIndexDocument(ExtensionIdSchema.parse(extensionId), collection, id),
  count: (extensionId, collection) => repository.countIndexDocuments(ExtensionIdSchema.parse(extensionId), collection),
  async query(extensionId, collection, text, options) {
    const candidates = Math.min(options.limit * 5, 100)
    const match = keywordQuery(text)
    const keywordIds =
      match === undefined
        ? []
        : repository
            .searchIndexKeywords({
              extensionId: ExtensionIdSchema.parse(extensionId),
              collection: collection.name,
              match,
              weights: collection.fields.map(({ weight }) => weight),
              filter: options.filter,
              limit: candidates,
            })
            .map(({ documentId }) => documentId)
    const vector = vectors === undefined || text.trim() === '' ? undefined : await vectors.queryVector(text)
    if (vector === undefined || 'degraded' in vector) {
      return {
        hits: keywordIds
          .slice(0, options.limit)
          .map((id, rank) => ({ id, score: Number((1 / (rank + 1)).toFixed(6)) })),
        mode: 'keyword',
        ...(vector === undefined ? {} : { degraded: vector.degraded }),
      }
    }
    const vectorIds = repository
      .listIndexVectors({
        extensionId: ExtensionIdSchema.parse(extensionId),
        collection: collection.name,
        space: vector.space,
        filter: options.filter,
      })
      .map((row) => ({ id: row.documentId, score: dotQuantized(vector.vector, row.vector, row.scale) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, candidates)
      .map(({ id }) => id)
    return { hits: fuse([keywordIds, vectorIds], options.limit), mode: 'hybrid' }
  },
})

/** Dynamic runs and import verification keep their index in memory and use keywords only. */
export const memoryIndexEngine = (): ExtensionIndexEngine => {
  const documents = new Map<string, ValidatedIndexDocument>()
  const key = (extensionId: string, collection: string, id: string) => `${extensionId}\u0000${collection}\u0000${id}`
  return {
    upsert(extensionId, collection, id, document) {
      documents.set(key(extensionId, collection.name, id), document)
    },
    delete: (extensionId, collection, id) => documents.delete(key(extensionId, collection, id)),
    count: (extensionId, collection) =>
      [...documents.keys()].filter((entry) => entry.startsWith(`${extensionId}\u0000${collection}\u0000`)).length,
    query(extensionId, collection, text, options) {
      const terms = new Set(segmentWords(text).filter((word) => !(word.length === 1 && STOP_CHARACTERS.has(word))))
      const prefix = `${extensionId}\u0000${collection.name}\u0000`
      const scored = [...documents.entries()]
        .filter(([entry]) => entry.startsWith(prefix))
        .filter(([, document]) =>
          options.filter.every((group) =>
            group.some((condition) =>
              document.filters.some(({ field, value }) => field === condition.field && value === condition.value),
            ),
          ),
        )
        .map(([entry, document]) => {
          const score = document.keywords.reduce((sum, column, index) => {
            const words = column.split(' ')
            const weight = collection.fields[index]?.weight ?? 0
            return sum + weight * words.filter((word) => terms.has(word)).length
          }, 0)
          return { id: entry.slice(prefix.length), score }
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, options.limit)
      return Promise.resolve({ hits: scored, mode: 'keyword' })
    },
  }
}

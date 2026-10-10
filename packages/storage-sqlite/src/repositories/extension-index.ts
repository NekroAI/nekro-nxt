import { and, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm'
import type { ExtensionId } from '@nekro-nxt/contracts'
import type { DrizzleCoreDatabase } from '../database.js'
import { extensionIndexDocuments, extensionIndexFilterValues, extensionIndexVectors } from '../schema.js'

/** Keyword columns of `extension_index_fts`; a collection maps its text fields onto them in declaration order. */
export const EXTENSION_INDEX_KEYWORD_COLUMNS = 4

export interface ExtensionIndexDocumentInput {
  readonly extensionId: ExtensionId
  readonly collection: string
  readonly documentId: string
  readonly fields: Readonly<Record<string, string>>
  /** Space-separated keywords per FTS column, already segmented by the caller. */
  readonly keywords: readonly string[]
  readonly filters: readonly { readonly field: string; readonly value: string }[]
  readonly updatedAt: number
}

export interface ExtensionIndexCondition {
  readonly field: string
  readonly value: string
}

export interface ExtensionIndexKeywordHit {
  readonly rowId: number
  readonly documentId: string
  /** bm25: lower is better. */
  readonly rank: number
}

export interface ExtensionIndexStoredVector {
  readonly rowId: number
  readonly documentId: string
  readonly vector: Buffer
  readonly scale: number
}

export interface ExtensionIndexEmbeddingCandidate {
  readonly rowId: number
  readonly extensionId: ExtensionId
  readonly collection: string
  readonly fields: Readonly<Record<string, string>>
  readonly vectorDigest: string | null
}

const parseFields = (json: string): Readonly<Record<string, string>> => {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/** Every group must match; within a group one condition is enough. */
const filterClause = (rowId: SQL, groups: readonly (readonly ExtensionIndexCondition[])[]): SQL | undefined => {
  const clauses = groups
    .filter((group) => group.length > 0)
    .map(
      (group) =>
        sql`EXISTS (SELECT 1 FROM ${extensionIndexFilterValues} WHERE ${extensionIndexFilterValues.documentRowId} = ${rowId} AND (${sql.join(
          group.map(
            ({ field, value }) =>
              sql`(${extensionIndexFilterValues.field} = ${field} AND ${extensionIndexFilterValues.value} = ${value})`,
          ),
          sql` OR `,
        )}))`,
    )
  return clauses.length === 0 ? undefined : sql.join(clauses, sql` AND `)
}

export function createExtensionIndexRepository(database: DrizzleCoreDatabase) {
  return {
    upsertIndexDocument(input: ExtensionIndexDocumentInput): number {
      if (input.keywords.length !== EXTENSION_INDEX_KEYWORD_COLUMNS) {
        throw new TypeError(`Index keywords need exactly ${EXTENSION_INDEX_KEYWORD_COLUMNS} columns.`)
      }
      return database.transaction(
        (tx) => {
          const row = tx
            .insert(extensionIndexDocuments)
            .values({
              extensionId: input.extensionId,
              collection: input.collection,
              documentId: input.documentId,
              fields: input.fields,
              updatedAt: input.updatedAt,
            })
            .onConflictDoUpdate({
              target: [
                extensionIndexDocuments.extensionId,
                extensionIndexDocuments.collection,
                extensionIndexDocuments.documentId,
              ],
              set: { fields: input.fields, updatedAt: input.updatedAt },
            })
            .returning({ id: extensionIndexDocuments.id })
            .get()
          tx.run(sql`DELETE FROM extension_index_fts WHERE rowid = ${row.id}`)
          const [f1, f2, f3, f4] = input.keywords
          tx.run(
            sql`INSERT INTO extension_index_fts (rowid, f1, f2, f3, f4) VALUES (${row.id}, ${f1}, ${f2}, ${f3}, ${f4})`,
          )
          tx.delete(extensionIndexFilterValues).where(eq(extensionIndexFilterValues.documentRowId, row.id)).run()
          const filters = [
            ...new Map(input.filters.map((entry) => [`${entry.field}\u0000${entry.value}`, entry])).values(),
          ]
          if (filters.length > 0) {
            tx.insert(extensionIndexFilterValues)
              .values(filters.map(({ field, value }) => ({ documentRowId: row.id, field, value })))
              .run()
          }
          return row.id
        },
        { behavior: 'immediate' },
      )
    },
    deleteIndexDocument(extensionId: ExtensionId, collection: string, documentId: string): boolean {
      // The delete trigger removes the keyword row; filter values and vectors cascade.
      return (
        database
          .delete(extensionIndexDocuments)
          .where(
            and(
              eq(extensionIndexDocuments.extensionId, extensionId),
              eq(extensionIndexDocuments.collection, collection),
              eq(extensionIndexDocuments.documentId, documentId),
            ),
          )
          .run().changes > 0
      )
    },
    countIndexDocuments(extensionId: ExtensionId, collection: string): number {
      return (
        database
          .select({ count: sql<number>`count(*)` })
          .from(extensionIndexDocuments)
          .where(
            and(
              eq(extensionIndexDocuments.extensionId, extensionId),
              eq(extensionIndexDocuments.collection, collection),
            ),
          )
          .get()?.count ?? 0
      )
    },
    /** `match` is an FTS5 query built by the caller from quoted keywords; `weights` follow the keyword columns. */
    searchIndexKeywords(input: {
      readonly extensionId: ExtensionId
      readonly collection: string
      readonly match: string
      readonly weights: readonly number[]
      readonly filter: readonly (readonly ExtensionIndexCondition[])[]
      readonly limit: number
    }): readonly ExtensionIndexKeywordHit[] {
      const [w1 = 1, w2 = 1, w3 = 1, w4 = 1] = input.weights
      const filter = filterClause(sql`d.id`, input.filter)
      return database.all<ExtensionIndexKeywordHit>(sql`
        SELECT d.id AS rowId, d.document_id AS documentId, bm25(extension_index_fts, ${w1}, ${w2}, ${w3}, ${w4}) AS rank
        FROM extension_index_fts
        JOIN extension_index_documents d ON d.id = extension_index_fts.rowid
        WHERE extension_index_fts MATCH ${input.match}
          AND d.extension_id = ${input.extensionId}
          AND d.collection = ${input.collection}
          ${filter === undefined ? sql`` : sql`AND ${filter}`}
        ORDER BY rank
        LIMIT ${input.limit}
      `)
    },
    /** Vectors of one collection in one space, restricted by `filter`. */
    listIndexVectors(input: {
      readonly extensionId: ExtensionId
      readonly collection: string
      readonly space: string
      readonly filter: readonly (readonly ExtensionIndexCondition[])[]
    }): readonly ExtensionIndexStoredVector[] {
      const filter = filterClause(sql`d.id`, input.filter)
      return database.all<ExtensionIndexStoredVector>(sql`
        SELECT d.id AS rowId, d.document_id AS documentId, v.vector AS vector, v.scale AS scale
        FROM extension_index_vectors v
        JOIN extension_index_documents d ON d.id = v.document_row_id
        WHERE v.space = ${input.space}
          AND d.extension_id = ${input.extensionId}
          AND d.collection = ${input.collection}
          ${filter === undefined ? sql`` : sql`AND ${filter}`}
      `)
    },
    /** Documents and the digest their vector in `space` was made from, if any; the caller decides what is stale. */
    listIndexEmbeddingCandidates(space: string, options: { readonly afterRowId: number; readonly limit: number }) {
      return database
        .all<Omit<ExtensionIndexEmbeddingCandidate, 'fields'> & { readonly fields: string }>(
          sql`
        SELECT d.id AS rowId, d.extension_id AS extensionId, d.collection AS collection, d.fields AS fields,
          v.text_digest AS vectorDigest
        FROM extension_index_documents d
        LEFT JOIN extension_index_vectors v ON v.document_row_id = d.id AND v.space = ${space}
        WHERE d.id > ${options.afterRowId}
        ORDER BY d.id
        LIMIT ${options.limit}
      `,
        )
        .map((row): ExtensionIndexEmbeddingCandidate => ({ ...row, fields: parseFields(row.fields) }))
    },
    putIndexVector(input: {
      readonly rowId: number
      readonly space: string
      readonly vector: Buffer
      readonly scale: number
      readonly textDigest: string
    }): void {
      database
        .insert(extensionIndexVectors)
        .values({
          documentRowId: input.rowId,
          space: input.space,
          vector: input.vector,
          scale: input.scale,
          textDigest: input.textDigest,
        })
        .onConflictDoUpdate({
          target: [extensionIndexVectors.documentRowId, extensionIndexVectors.space],
          set: { vector: input.vector, scale: input.scale, textDigest: input.textDigest },
        })
        .run()
    },
    /** Drops vectors of every space not listed, e.g. after switching models. */
    deleteIndexVectorsExcept(spaces: readonly string[]): number {
      const keep = [...spaces]
      return database
        .delete(extensionIndexVectors)
        .where(keep.length === 0 ? undefined : notInArray(extensionIndexVectors.space, keep))
        .run().changes
    },
    countIndexVectors(space: string): { readonly vectors: number; readonly documents: number } {
      const vectors =
        database
          .select({ count: sql<number>`count(*)` })
          .from(extensionIndexVectors)
          .where(eq(extensionIndexVectors.space, space))
          .get()?.count ?? 0
      const documents =
        database
          .select({ count: sql<number>`count(*)` })
          .from(extensionIndexDocuments)
          .get()?.count ?? 0
      return { vectors, documents }
    },
    getIndexDocumentRowIds(extensionId: ExtensionId, collection: string, documentIds: readonly string[]) {
      if (documentIds.length === 0) return new Map<string, number>()
      return new Map(
        database
          .select({ id: extensionIndexDocuments.id, documentId: extensionIndexDocuments.documentId })
          .from(extensionIndexDocuments)
          .where(
            and(
              eq(extensionIndexDocuments.extensionId, extensionId),
              eq(extensionIndexDocuments.collection, collection),
              inArray(extensionIndexDocuments.documentId, [...documentIds]),
            ),
          )
          .all()
          .map(({ id, documentId }) => [documentId, id]),
      )
    },
  }
}

export type ExtensionIndexRepository = ReturnType<typeof createExtensionIndexRepository>

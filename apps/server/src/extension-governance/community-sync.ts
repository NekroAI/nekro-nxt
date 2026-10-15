import {
  type CommunitySyncItem,
  type ExtensionId,
  type ExtensionRevisionId,
} from '@nekro-nxt/contracts'
import { lineageRelation, type Revision } from '@nekro-nxt/extension-runtime'
import type { SqliteCoreRepository } from '@nekro-nxt/storage-sqlite'
import type { CommunityService } from '../community.js'
import { extensionVersions, type LineageReader } from './versions.js'

/**
 * Keeps this machine and the community in step for every extension line it follows or publishes: which release each
 * local version is, whether this machine may publish the line, and what the newest public release means here.
 */
export class CommunitySyncService {
  readonly #repository: SqliteCoreRepository
  readonly #community: CommunityService
  readonly #lineage: LineageReader
  readonly #now: () => number
  #cache: { readonly url: string; readonly checkedAt: number; readonly items: readonly CommunitySyncItem[] } | undefined

  constructor(input: {
    readonly repository: SqliteCoreRepository
    readonly community: CommunityService
    readonly lineage: LineageReader
    readonly now?: () => number
  }) {
    this.#repository = input.repository
    this.#community = input.community
    this.#lineage = input.lineage
    this.#now = input.now ?? Date.now
  }

  cached(): { readonly checkedAt: number; readonly items: readonly CommunitySyncItem[] } | undefined {
    const cache = this.#cache
    return cache?.url === this.#community.communityUrl ? { checkedAt: cache.checkedAt, items: cache.items } : undefined
  }

  /** The cached entry of one extension, for actions that need its latest release without a network round trip. */
  cachedItem(extensionId: ExtensionId): CommunitySyncItem | undefined {
    return this.cached()?.items.find((item) => item.extensionId === extensionId)
  }

  /** Records that `revision` is a community release installed here; the line becomes followed. */
  recordInstall(
    revision: Revision,
    release: { readonly releaseId: string; readonly number?: number; readonly publisherHandle: string },
    communityUrl = this.#community.communityUrl,
  ): void {
    const now = this.#now()
    this.#repository.recordExtensionRevisionRelease({
      revisionId: revision.id,
      extensionId: revision.extensionId,
      communityUrl,
      releaseId: release.releaseId,
      releaseNumber: release.number ?? null,
      publisherHandle: release.publisherHandle,
      via: 'install',
      recordedAt: now,
    })
    this.#repository.upsertExtensionCommunityLink({
      extensionId: revision.extensionId,
      communityUrl,
      role: 'subscriber',
      now,
    })
  }

  /** Records a release published from here; this machine owns the line on that community from now on. */
  recordPublish(
    revision: Revision,
    release: { readonly releaseId: string; readonly number?: number; readonly publisherHandle: string },
  ): void {
    const now = this.#now()
    const communityUrl = this.#community.communityUrl
    this.#repository.recordExtensionRevisionRelease({
      revisionId: revision.id,
      extensionId: revision.extensionId,
      communityUrl,
      releaseId: release.releaseId,
      releaseNumber: release.number ?? null,
      publisherHandle: release.publisherHandle,
      via: 'publish',
      recordedAt: now,
    })
    this.#repository.upsertExtensionCommunityLink({
      extensionId: revision.extensionId,
      communityUrl,
      role: 'owner',
      now,
      force: true,
    })
    this.#cache = undefined
  }

  /** Keep the local changes over `releaseId` (or stop doing so with null); the release is not offered again. */
  dismiss(extensionId: ExtensionId, releaseId: string | null): void {
    this.#repository.dismissExtensionCommunityRelease({
      extensionId,
      communityUrl: this.#community.communityUrl,
      releaseId,
      now: this.#now(),
    })
    this.#cache = undefined
  }

  /**
   * Lines the signed-in account publishes become owned here, including ones installed from the community on another
   * machine. Ownership is never taken away by this check; the community still decides on every publish.
   */
  async correctOwnership(): Promise<void> {
    const status = await this.#community.status()
    if (!status.account) return
    let mine
    try {
      mine = await this.#community.mine()
    } catch {
      return
    }
    const now = this.#now()
    for (const item of mine) {
      if (!this.#repository.getExtension(item.id)) continue
      this.#repository.upsertExtensionCommunityLink({
        extensionId: item.id,
        communityUrl: this.#community.communityUrl,
        role: 'owner',
        now,
      })
    }
  }

  /** Asks the community about every followed or published line and works out what each one needs. */
  async check(): Promise<{ readonly checkedAt: number; readonly items: readonly CommunitySyncItem[] }> {
    const url = this.#community.communityUrl
    await this.correctOwnership()
    const links = this.#repository.listExtensionCommunityLinks().filter((link) => link.communityUrl === url)
    const subjects = links.flatMap((link) => {
      const extension = this.#repository.getExtension(link.extensionId)
      const current = this.#current(link.extensionId)
      return extension && current ? [{ link, extension, current }] : []
    })
    const releases = this.#repository.listExtensionRevisionReleases().filter((release) => release.communityUrl === url)
    const remote = await this.#community.checkUpdates(
      subjects.map(({ extension, current }) => {
        const known = this.#knownRelease(extension.id, current.id, releases)
        return {
          extensionId: extension.id,
          revisionId: current.id,
          ...(known === undefined ? {} : { releaseId: known.releaseId }),
        }
      }),
    )
    const items = subjects.map(({ link, extension, current }): CommunitySyncItem => {
      const versions = extensionVersions(this.#repository, this.#lineage, extension.id)
      const answer = remote.get(extension.id)
      const currentRelease = releases.find((release) => release.revisionId === current.id)
      const latest = answer?.latest ?? null
      return {
        extensionId: extension.id,
        displayName: extension.displayName,
        communityUrl: url,
        role: link.role,
        currentRevisionId: current.id,
        currentVersionLabel: versions.get(current.id)?.label ?? 'v1',
        currentRelease:
          currentRelease === undefined ? null : { id: currentRelease.releaseId, number: currentRelease.releaseNumber },
        status: this.#status(current, latest, currentRelease?.releaseId, answer?.found === true),
        found: answer?.found === true,
        delisted: answer?.delisted === true,
        delistedReason: answer?.delistedReason ?? null,
        releaseWithdrawn: answer?.releaseWithdrawn === true,
        latest,
        dismissed: latest !== null && link.dismissedReleaseId === latest.id,
        addedPermissions: answer?.addedPermissions ?? [],
      }
    })
    const checkedAt = this.#now()
    this.#cache = { url, checkedAt, items }
    this.#community.setAttention(
      items.filter(
        (item) =>
          !item.dismissed && (item.status === 'remote-ahead' || item.status === 'diverged' || item.releaseWithdrawn),
      ).length,
    )
    return { checkedAt, items }
  }

  /** The installed Revision, or the newest one when the extension is not installed. */
  #current(extensionId: ExtensionId): Revision | undefined {
    const installed = this.#repository.getHostInstallation(extensionId)?.extensionRevisionId
    const revisions = this.#repository.listExtensionRevisions(extensionId)
    return revisions.find((revision) => revision.id === installed) ?? revisions.at(-1)
  }

  /** The release of the current version, or the nearest ancestor that was a release, as the community's reference. */
  #knownRelease(
    extensionId: ExtensionId,
    revisionId: ExtensionRevisionId,
    releases: ReturnType<SqliteCoreRepository['listExtensionRevisionReleases']>,
  ) {
    const own = releases.filter((release) => release.extensionId === extensionId)
    const exact = own.find((release) => release.revisionId === revisionId)
    if (exact) return exact
    const revision = this.#repository.getExtensionRevision(revisionId)
    const ancestry = revision ? (this.#lineage.lineageNode(revision).lineage?.ancestry ?? []) : []
    for (const ancestor of ancestry) {
      const match = own.find((release) => release.revisionId === ancestor)
      if (match) return match
    }
    return own.sort((left, right) => right.recordedAt - left.recordedAt)[0]
  }

  #status(
    current: Revision,
    latest: CommunitySyncItem['latest'],
    currentReleaseId: string | undefined,
    found: boolean,
  ): CommunitySyncItem['status'] {
    if (!found || latest === null) return 'unknown'
    if (latest.revisionId === undefined) {
      // An older community does not report lineage: all we can tell is whether the newest release is ours.
      return latest.id === currentReleaseId ? 'same' : 'remote-ahead'
    }
    return lineageRelation(this.#lineage.lineageNode(current), {
      revisionId: latest.revisionId,
      lineage: { parent: latest.parentRevisionId ?? null, ancestry: latest.ancestry ?? [] },
    })
  }
}

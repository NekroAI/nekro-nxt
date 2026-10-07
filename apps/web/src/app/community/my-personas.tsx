import { communityPersonaReviewLabel, HostApiContracts, type CommunityMyPersona } from '@nekro-nxt/contracts'
import { ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import { Banner, Button, Chip, InfoTip, PropertyGroup, Skeleton } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import { errorMessage, openExternal } from './community-model.js'
import { PersonaAvatar } from './personas.js'
import styles from './personas.module.css'

/** 「我的发布」里的人设：最新修订的审查状态；分享与更新在智能体页进行。 */
export function MyPersonasSection({ refreshKey }: { readonly refreshKey: unknown }) {
  const [items, setItems] = useState<readonly CommunityMyPersona[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    callHostApi(HostApiContracts.listCommunityMyPersonas, {}, undefined)
      .then((result) => {
        if (cancelled) return
        setItems(result.items)
        setError(undefined)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return (
    <PropertyGroup
      title={
        <span className={styles.metaWithTip}>
          我的人设
          <InfoTip label="分享人设">在智能体页选择「更多 → 分享人设到社区」分享或更新人设。审查通过后公开。</InfoTip>
        </span>
      }
    >
      {error ? (
        <Banner tone="bad">{error}</Banner>
      ) : items === undefined ? (
        <Skeleton height={64} />
      ) : items.length === 0 ? (
        <p className={styles.faint}>还没有分享过人设。</p>
      ) : (
        <div className={styles.mineList}>
          {items.map((item) => {
            const label = communityPersonaReviewLabel(item.latestRevision.reviewStatus)
            return (
              <article key={item.id} className={styles.mineItem} aria-label={item.name}>
                <PersonaAvatar name={item.name} url={item.avatarUrl} size="sm" />
                <div className={styles.mineBody}>
                  <div className={styles.mineTitle}>
                    {item.status === 'listed' && item.latestRevision.reviewStatus === 'approved' ? (
                      <Link to={`/community/personas/${item.id}`} className={styles.mineLink}>
                        {item.name}
                      </Link>
                    ) : (
                      item.name
                    )}
                    <Chip tone={label.tone}>{label.label}</Chip>
                    {item.status === 'delisted' ? <Chip tone="bad">已下架</Chip> : null}
                    {item.latestRevision.reviewSummary ? (
                      <InfoTip label="审查结论">{item.latestRevision.reviewSummary}</InfoTip>
                    ) : null}
                  </div>
                  <span className={styles.faint}>
                    {item.installs} 次安装 · {relativeTime(item.latestRevision.createdAt)}更新
                  </span>
                </div>
                <Button
                  size="small"
                  variant="ghost"
                  icon={<ExternalLink size={14} />}
                  onClick={() => openExternal(item.pageUrl)}
                >
                  社区页面
                </Button>
              </article>
            )
          })}
        </div>
      )}
    </PropertyGroup>
  )
}

import {
  COMMUNITY_RATING_BADGE_LIMIT,
  COMMUNITY_RATING_BADGES,
  COMMUNITY_RATING_DIMENSION_LABELS,
  COMMUNITY_RATING_DIMENSIONS,
  COMMUNITY_REVIEW_DIMENSION_LABELS,
  COMMUNITY_REVIEWER_NAME,
  communityReviewLabel,
  type CommunityExtensionDetail,
  type CommunityRating,
} from '@nekro-nxt/contracts'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Button, Chip, Disclosure } from '../../ui-kit/index.js'
import { openExternal } from './community-model.js'
import styles from './community.module.css'

/** Six dimensions in hexagon order; a dimension missing from the rating counts as zero stars. */
const orderedDimensions = (rating: CommunityRating) =>
  COMMUNITY_RATING_DIMENSIONS.map((key) => {
    const found = rating.dimensions.find((dimension) => dimension.key === key)
    return {
      key,
      label: COMMUNITY_RATING_DIMENSION_LABELS[key],
      stars: found?.stars ?? 0,
      headline: found?.headline ?? '',
      cap: found?.cap,
    }
  })

const corner = (index: number, radius: number): [number, number] => {
  const angle = (Math.PI / 3) * index - Math.PI / 2
  return [Math.cos(angle) * radius, Math.sin(angle) * radius]
}
const polygon = (values: readonly number[], radius: number): string =>
  values
    .map((value, index) =>
      corner(index, (value / 5) * radius)
        .map((n) => n.toFixed(1))
        .join(','),
    )
    .join(' ')

/** The six-dimension hexagon, clockwise from the top; a full hexagon gets a brass outline. */
export function RatingHexagon({ rating, size }: { readonly rating: CommunityRating; readonly size: number }) {
  const dimensions = orderedDimensions(rating)
  const stars = dimensions.map((dimension) => dimension.stars)
  const full = stars.every((value) => value === 5)
  const radius = 68
  return (
    <svg
      viewBox="-110 -104 220 208"
      width={size}
      height={(size * 208) / 220}
      role="img"
      aria-label={dimensions.map(({ label, stars }) => `${label} ${stars} 星`).join('，')}
    >
      {[1, 2, 3, 4, 5].map((ring) => (
        <polygon
          key={ring}
          points={polygon([ring, ring, ring, ring, ring, ring], radius)}
          fill={ring === 5 ? 'var(--accent-soft)' : 'none'}
          stroke="var(--line-2)"
          strokeWidth={ring === 5 ? 1.4 : 0.8}
        />
      ))}
      {dimensions.map((dimension, index) => {
        const [x, y] = corner(index, radius)
        return <line key={dimension.key} x1={0} y1={0} x2={x} y2={y} stroke="var(--line-2)" strokeWidth={0.8} />
      })}
      <polygon
        points={polygon(stars, radius)}
        fill="var(--accent)"
        fillOpacity={0.28}
        stroke={full ? 'var(--brass)' : 'var(--accent)'}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {stars.map((value, index) => {
        const [x, y] = corner(index, (value / 5) * radius)
        return <circle key={index} cx={x} cy={y} r={3} fill={value === 5 ? 'var(--brass)' : 'var(--accent)'} />
      })}
      {dimensions.map(({ label }, index) => {
        const [x, y] = corner(index, radius + 20)
        return (
          <text key={label} x={x} y={y + 5} textAnchor="middle" fontSize={14} fill="var(--muted)">
            {label}
          </text>
        )
      })}
    </svg>
  )
}

export function Stars({ stars }: { readonly stars: number }) {
  return (
    <span className={styles.stars} aria-label={`${stars} 星`}>
      <span className={styles.starsOn} aria-hidden="true">
        {'★'.repeat(stars)}
      </span>
      <span className={styles.starsOff} aria-hidden="true">
        {'★'.repeat(Math.max(0, 5 - stars))}
      </span>
    </span>
  )
}

/** The reviewer's seal, used as her signature. */
export function ReviewerSeal() {
  return (
    <span className={styles.reviewerSeal} aria-hidden="true">
      澄
    </span>
  )
}

/** A compact rating for cards and lists: one star and the composite score. */
export function RatingMark({ rating }: { readonly rating: CommunityRating | null }) {
  if (!rating) return null
  return (
    <span className={styles.ratingMark} title={`综合评分 ${rating.score.toFixed(1)}`}>
      <span className={styles.starsOn} aria-hidden="true">
        ★
      </span>
      {rating.score.toFixed(1)}
    </span>
  )
}

/** Achieved standards; only what was achieved, problems are shown by stars and status. */
export function BadgeChips({
  badges,
  limit = COMMUNITY_RATING_BADGE_LIMIT,
}: {
  readonly badges: readonly string[]
  readonly limit?: number
}) {
  const known = badges.flatMap((key) => {
    const badge = COMMUNITY_RATING_BADGES[key]
    return badge ? [{ key, ...badge }] : []
  })
  if (known.length === 0) return null
  return (
    <ul className={styles.badgeChips}>
      {known.slice(0, limit).map((badge) => (
        <li key={badge.key} title={badge.description}>
          {badge.label}
        </li>
      ))}
    </ul>
  )
}

const severityLabel = (
  severity: string,
): { readonly tone: 'bad' | 'warn' | 'accent' | 'neutral'; readonly label: string } =>
  severity === 'critical' || severity === 'block'
    ? { tone: 'bad', label: '严重' }
    : severity === 'risk'
      ? { tone: 'bad', label: '风险' }
      : severity === 'warning'
        ? { tone: 'warn', label: '提醒' }
        : severity === 'suggestion'
          ? { tone: 'accent', label: '建议' }
          : { tone: 'neutral', label: '信息' }

/**
 * The rating card on a community extension: hexagon, composite score, six star rows and up to four achieved
 * standards. The review record (summary, notes, findings) opens below it. Ratings describe findings only.
 */
export function RatingCard({
  review,
  pageUrl,
}: {
  readonly review: NonNullable<CommunityExtensionDetail['review']>
  readonly pageUrl: string
}) {
  const [open, setOpen] = useState(false)
  const { rating } = review
  const status = communityReviewLabel(review.status)
  const caps = new Map((rating?.dimensions ?? []).flatMap(({ key, cap }) => (cap ? [[key, cap] as const] : [])))
  return (
    <section className={styles.ratingCard} aria-label="审查评级">
      {rating ? (
        <div className={styles.ratingTop}>
          <div className={styles.ratingScore}>
            <RatingHexagon rating={rating} size={168} />
            <div>
              <b>{rating.score.toFixed(1)}</b>
              <span>综合评分</span>
            </div>
          </div>
          <ul className={styles.ratingRows}>
            {orderedDimensions(rating).map((dimension) => (
              <li key={dimension.key}>
                <b>{dimension.label}</b>
                <Stars stars={dimension.stars} />
                <span title={dimension.headline}>{dimension.headline}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={styles.ratingPending}>
          <Chip tone={status.tone}>{status.label}</Chip>
          {COMMUNITY_REVIEWER_NAME}还没有给出这次发布的星级。
        </p>
      )}
      {rating ? <BadgeChips badges={rating.badges} /> : null}
      <div className={styles.ratingSign}>
        <ReviewerSeal />
        <span>
          {COMMUNITY_REVIEWER_NAME}
          {rating ? ` · 审查标准 ${rating.standard}` : ''} · 只描述审查发现，不做安全担保
        </span>
        <Button
          size="small"
          variant="ghost"
          aria-expanded={open}
          aria-controls="community-review-record"
          icon={<ChevronDown size={14} className={open ? styles.chevronOpen : undefined} />}
          onClick={() => setOpen((value) => !value)}
        >
          审查记录
        </Button>
      </div>
      <Disclosure open={open} id="community-review-record">
        <div className={styles.reviewRecord}>
          <p className={styles.reviewRecordMeta}>
            <Chip tone={status.tone}>{status.label}</Chip>
            {review.reviewedAt ? <span>{new Date(review.reviewedAt).toLocaleString('zh-CN')} 完成</span> : null}
          </p>
          {review.summary ? <p>{review.summary}</p> : null}
          {review.dimensions.map((dimension) => (
            <div key={dimension.key} className={styles.reviewRecordRow}>
              <b>{COMMUNITY_REVIEW_DIMENSION_LABELS[dimension.key] ?? dimension.key}</b>
              <span>{dimension.notes}</span>
              {caps.get(dimension.key) ? <span className={styles.reviewCap}>{caps.get(dimension.key)}</span> : null}
            </div>
          ))}
          {[
            ...review.checks.map((item) => ({ ...item, where: '自动检查' })),
            ...review.findings.map((item) => ({
              ...item,
              where: COMMUNITY_REVIEW_DIMENSION_LABELS[item.dimension] ?? item.dimension,
            })),
          ].map((item, index) => {
            const severity = severityLabel(item.severity)
            return (
              <p key={index} className={styles.communityHighlight}>
                <Chip tone={severity.tone}>{severity.label}</Chip>
                {item.title}
                <span className={styles.faint}>{item.where}</span>
              </p>
            )
          })}
          <div>
            <Button
              size="small"
              variant="ghost"
              icon={<ExternalLink size={14} />}
              onClick={() => openExternal(pageUrl)}
            >
              在社区查看
            </Button>
          </div>
        </div>
      </Disclosure>
    </section>
  )
}

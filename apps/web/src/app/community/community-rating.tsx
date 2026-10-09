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
import { useId, useState } from 'react'
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

/**
 * 审查员小澄：水月荧贝雷帽上那只半透明的小水母，戴圆眼镜、举着放大镜；与社区网站同一形象，颜色固定以适配深浅主题。
 */
export function ReviewerSeal({ size = 28 }: { readonly size?: number }) {
  const id = useId().replaceAll(':', '')
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={styles.reviewerMascot} aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-bell`} cx="0.38" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.55" stopColor="#dfe9fb" />
          <stop offset="1" stopColor="#a9c2ec" />
        </radialGradient>
        <linearGradient id={`${id}-tentacle`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9fbbe9" />
          <stop offset="1" stopColor="#9fbbe9" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${id}-tentacle)`} strokeWidth="2.6" strokeLinecap="round">
        <path d="M19 37 C16 43 21 47 18 53 C16.5 56 18 58.5 19 60" />
        <path d="M27 38 C25 44 29 48 27 55" />
        <path d="M37 38 C39 44 35 48 37 55" />
      </g>
      <path d="M45 37 C48 41 46 44 49 47" fill="none" stroke="#9fbbe9" strokeWidth="2.6" strokeLinecap="round" />
      <line x1="50.2" y1="48.2" x2="53" y2="51" stroke="#b4884a" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="56" cy="54" r="4.2" fill="#e4eeff" stroke="#b4884a" strokeWidth="1.8" />
      <path d="M54.3 52.6 a2.4 2.4 0 0 1 2.6 -0.6" fill="none" stroke="#ffffff" strokeWidth="1" strokeLinecap="round" />
      <path
        d="M9 33 C9 17.5 19.5 7 32 7 C44.5 7 55 17.5 55 33 C55 36.2 52.4 37.6 50 35.8 C47.6 38.6 44 38.6 41.5 35.8 C39 38.6 35 38.6 32 35.8 C29 38.6 25 38.6 22.5 35.8 C20 38.6 16.4 38.6 14 35.8 C11.6 37.6 9 36.2 9 33 Z"
        fill={`url(#${id}-bell)`}
        stroke="#3f5b8f"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <g fill="none" stroke="#b4884a" strokeWidth="1.1" strokeLinecap="round" opacity="0.9">
        <path d="M12.5 22.5 Q32 14 51.5 22.5" />
        <path d="M23.5 9.8 Q19.5 20 20.5 30" />
        <path d="M40.5 9.8 Q44.5 20 43.5 30" />
      </g>
      <g fill="#c99a52">
        <circle cx="21.4" cy="18.9" r="1.3" />
        <circle cx="42.6" cy="18.9" r="1.3" />
        <circle cx="32" cy="16.5" r="1.3" />
      </g>
      <path
        d="M15 21 C16.5 15 21 11.2 25.5 10.2"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.85"
      />
      <ellipse cx="19.5" cy="30.5" rx="2.6" ry="1.5" fill="#f2a7b6" opacity="0.55" />
      <ellipse cx="44.5" cy="30.5" rx="2.6" ry="1.5" fill="#f2a7b6" opacity="0.55" />
      <ellipse cx="25.5" cy="27" rx="2.3" ry="2.7" fill="#22355c" />
      <ellipse cx="38.5" cy="27" rx="2.3" ry="2.7" fill="#22355c" />
      <circle cx="26.3" cy="26" r="0.9" fill="#ffffff" />
      <circle cx="39.3" cy="26" r="0.9" fill="#ffffff" />
      <g fill="none" stroke="#2a3d66" strokeWidth="1.2">
        <circle cx="25.5" cy="27" r="4.6" />
        <circle cx="38.5" cy="27" r="4.6" />
        <path d="M30.1 26.6 Q32 25.4 33.9 26.6" />
      </g>
      <path d="M30.4 32.2 Q32 33.4 33.6 32.2" fill="none" stroke="#22355c" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
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

import type { ReactNode } from 'react'
import { InfoTip, PageHeader } from '../../ui-kit/index.js'
import { CompatibilityNotices } from '../system/compatibility.js'
import styles from './settings.module.css'

/** Header of every settings section (05 §6.1): a view page header plus the compatibility notices that apply. */
export function SectionHead({
  title,
  subtitle,
  actions,
  tip,
}: {
  readonly title: string
  readonly subtitle?: ReactNode
  readonly actions?: ReactNode
  readonly tip?: ReactNode
}) {
  return (
    <>
      <PageHeader
        title={
          tip ? (
            <span className={styles.titleWithTip}>
              {title}
              <InfoTip label={title}>{tip}</InfoTip>
            </span>
          ) : (
            title
          )
        }
        subtitle={subtitle}
        actions={actions}
      />
      <CompatibilityNotices showContextReset />
    </>
  )
}

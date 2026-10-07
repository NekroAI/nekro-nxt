import { Compass, PackageCheck, Send, UserRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import type { CommunityPermissionItem, CommunityReviewStatus, HostApiResponse } from '@nekro-nxt/contracts'
import { Chip, ListPane, SelectionList, WorkbenchPage } from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import { useCrumb } from '../shell/crumb.js'
import { CommunityImportNote, ImportDialog } from '../workshop/import-dialog.js'
import { AccountView } from './account.js'
import { ENVIRONMENT_LABEL, useCommunityStatus } from './community-model.js'
import { CommunityView } from './discover.js'
import { InstalledView } from './installed.js'
import { MineView, ReviewReportView } from './mine.js'
import styles from './community.module.css'

type Inspection = HostApiResponse<'inspectExtensionImport'>

export interface PendingCommunityImport {
  readonly inspection: Inspection
  readonly publisher: string
  readonly status: CommunityReviewStatus | undefined
  readonly addedPermissions?: readonly CommunityPermissionItem[]
}

type Section =
  | { readonly kind: 'discover'; readonly extensionId?: string }
  | { readonly kind: 'installed' }
  | { readonly kind: 'mine'; readonly releaseId?: string }
  | { readonly kind: 'account' }

const parse = (pathname: string): Section | undefined => {
  if (pathname === '/community' || pathname === '/community/') return { kind: 'discover' }
  const extension = /^\/community\/extensions\/([^/]+)\/?$/u.exec(pathname)
  if (extension) return { kind: 'discover', extensionId: decodeURIComponent(extension[1] ?? '') }
  if (/^\/community\/installed\/?$/u.test(pathname)) return { kind: 'installed' }
  if (/^\/community\/mine\/?$/u.test(pathname)) return { kind: 'mine' }
  const release = /^\/community\/mine\/releases\/([^/]+)\/?$/u.exec(pathname)
  if (release) return { kind: 'mine', releaseId: decodeURIComponent(release[1] ?? '') }
  if (/^\/community\/account\/?$/u.test(pathname)) return { kind: 'account' }
  return undefined
}

const CRUMB: Readonly<Record<Section['kind'], string>> = {
  discover: '发现',
  installed: '已安装',
  mine: '我的发布',
  account: '账号',
}

/**
 * 「社区」一级入口：发现与安装社区扩展、管理从社区安装的扩展、查看自己的发布与审查结果、管理社区账号。
 * 安装一律走与本地文件相同的导入确认，导入后不会自动启用。
 */
export default function CommunitySpace() {
  const { pathname } = useLocation()
  const navigate = useGo()
  const community = useCommunityStatus()
  const [pending, setPending] = useState<PendingCommunityImport>()
  const section = parse(pathname)
  useCrumb('社区', section ? CRUMB[section.kind] : undefined)
  if (!section) return <Navigate to="/community" replace />

  const status = community.status
  const account = status?.account ?? null
  const environment = status?.environment
  const selected = section.kind

  const row = (key: Section['kind'], to: string, icon: ReactNode, name: string, sub: ReactNode, state?: ReactNode) => (
    <Link
      key={key}
      to={to}
      className={styles.row}
      data-selected={selected === key}
      aria-current={selected === key ? 'page' : undefined}
    >
      <span className={styles.rowGlyph}>{icon}</span>
      <span className={styles.rowName}>{name}</span>
      {state ? <span className={styles.rowState}>{state}</span> : null}
      <span className={styles.rowSub}>{sub}</span>
    </Link>
  )

  const list = (
    <ListPane
      title="社区"
      label="社区"
      actions={
        environment && environment !== 'production' ? (
          <Chip tone="warn">{ENVIRONMENT_LABEL[environment]}</Chip>
        ) : undefined
      }
    >
      <SelectionList selectedKey={selected}>
        {row('discover', '/community', <Compass size={14} />, '发现', '浏览、搜索与安装社区扩展')}
        {row(
          'installed',
          '/community/installed',
          <PackageCheck size={14} />,
          '已安装',
          status && status.updatesAvailable > 0 ? `${status.updatesAvailable} 个扩展有新发布` : '来自社区的扩展与更新',
          status && status.updatesAvailable > 0 ? (
            <span className={styles.count}>{status.updatesAvailable}</span>
          ) : null,
        )}
        {row('mine', '/community/mine', <Send size={14} />, '我的发布', account ? '发布记录与审查结果' : '登录后查看')}
        <div className={styles.account}>
          {row(
            'account',
            '/community/account',
            account?.avatarUrl ? (
              <img src={account.avatarUrl} alt="" className={styles.avatar} />
            ) : (
              <UserRound size={14} />
            ),
            account ? account.displayName : '社区账号',
            account ? `@${account.handle}` : status ? '未登录' : '正在读取…',
          )}
        </div>
      </SelectionList>
    </ListPane>
  )

  return (
    <WorkbenchPage list={list}>
      <ImportDialog
        inspection={pending?.inspection}
        note={
          pending ? (
            <CommunityImportNote
              publisher={pending.publisher}
              status={pending.status}
              {...(pending.addedPermissions ? { addedPermissions: pending.addedPermissions } : {})}
            />
          ) : null
        }
        onClose={() => setPending(undefined)}
        onImported={(id) => {
          setPending(undefined)
          void community.refresh()
          navigate(`/workshop/extensions/${id}`)
        }}
      />
      {section.kind === 'discover' ? (
        <CommunityView
          extensionId={section.extensionId}
          onInspected={(inspection, detail) =>
            setPending({ inspection, publisher: detail.publisher.handle, status: detail.latest?.reviewStatus })
          }
        />
      ) : section.kind === 'installed' ? (
        <InstalledView onInspected={setPending} onChecked={() => void community.refresh()} />
      ) : section.kind === 'mine' ? (
        section.releaseId ? (
          <ReviewReportView key={section.releaseId} releaseId={section.releaseId} />
        ) : (
          <MineView community={community} />
        )
      ) : (
        <AccountView community={community} />
      )}
    </WorkbenchPage>
  )
}

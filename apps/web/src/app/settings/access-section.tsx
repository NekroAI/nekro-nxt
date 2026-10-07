import { useEffect, useState } from 'react'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { isUnencryptedRemoteConnection, managementCsrfToken } from '../../management-access.js'
import { Banner, Button, Chip, ConfirmDialog, DataTable, toast, type Column } from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import styles from './settings.module.css'

type Device = HostApiResponse<'listManagementDevices'>['devices'][number]

/**
 * Whether this page reaches the Server through its management edge, i.e. sign-in exists here. The edge sets the
 * readable CSRF cookie with every session; a direct local Host never does, so no request is needed to tell.
 */
export const useManagementAccessAvailable = (): boolean => managementCsrfToken() !== undefined

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const formatDate = (time: number): string => {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const goToSignIn = () => window.location.assign('/login')

/** Browsers and Desktop clients signed in to this Server; each can be revoked, this one by signing out. */
export function AccessSection() {
  const [devices, setDevices] = useState<readonly Device[]>()
  const [unavailable, setUnavailable] = useState(false)
  const [pending, setPending] = useState<Device>()
  const load = async () => {
    try {
      if (managementCsrfToken() === undefined) {
        setUnavailable(true)
        return
      }
      const listed = await callHostApi(HostApiContracts.listManagementDevices, {}, undefined)
      setDevices(listed.devices.filter((device) => device.revokedAt === undefined))
    } catch (error) {
      failure(error)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const revoke = async (device: Device) => {
    try {
      if (device.current === true) {
        await callHostApi(HostApiContracts.managementLogout, {}, undefined)
        goToSignIn()
        return
      }
      await callHostApi(HostApiContracts.revokeManagementDevice, { deviceId: device.id }, undefined)
      toast('已撤销')
      await load()
    } catch (error) {
      failure(error)
    }
  }

  if (unavailable) {
    return <p className={styles.notice}>这台服务直接在本机运行，不需要登录。</p>
  }

  const columns: readonly Column<Device>[] = [
    {
      key: 'label',
      header: '设备',
      width: 'minmax(180px, 2fr)',
      render: (device) => (
        <span className={styles.deviceName}>
          {device.label}
          {device.current === true ? <Chip tone="accent">此设备</Chip> : null}
        </span>
      ),
    },
    {
      key: 'active',
      header: '最后活跃',
      width: 'minmax(96px, 1fr)',
      render: (device) => (
        <span
          className={styles.faint}
          title={device.lastUsedAt === undefined ? undefined : formatDate(device.lastUsedAt)}
        >
          {device.lastUsedAt === undefined ? '—' : relativeTime(device.lastUsedAt)}
        </span>
      ),
    },
    {
      key: 'created',
      header: '登录时间',
      width: 'minmax(132px, 1fr)',
      priority: 2,
      render: (device) => <span className={styles.faint}>{formatDate(device.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className={styles.srOnly}>操作</span>,
      width: '96px',
      align: 'end',
      render: (device) => (
        <Button size="small" variant={device.current === true ? 'ghost' : 'danger'} onClick={() => setPending(device)}>
          {device.current === true ? '退出登录' : '撤销'}
        </Button>
      ),
    },
  ]

  return (
    <>
      {isUnencryptedRemoteConnection() ? (
        <Banner tone="warn">
          当前通过未加密的 HTTP 访问，管理密钥和登录状态可能在网络中被截获。公网访问请使用 HTTPS，或通过反向代理启用
          HTTPS。
        </Banner>
      ) : null}
      <DataTable
        label="已登录设备"
        rows={devices ?? []}
        rowKey={(device) => device.id}
        empty={devices === undefined ? '正在读取…' : '没有已登录的设备。'}
        columns={columns}
      />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => !open && setPending(undefined)}
        title={pending?.current === true ? '退出这台设备的登录？' : `撤销「${pending?.label ?? ''}」的登录？`}
        confirmLabel={pending?.current === true ? '退出登录' : '撤销'}
        danger
        onConfirm={async () => {
          const device = pending
          setPending(undefined)
          if (device !== undefined) await revoke(device)
        }}
      >
        {pending?.current === true ? <p>之后需要重新输入管理密钥。</p> : <p>该设备需要重新输入管理密钥才能访问。</p>}
      </ConfirmDialog>
    </>
  )
}

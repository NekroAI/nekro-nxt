import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HostLogSettings, HostLogStatus } from '@nekro-nxt/contracts'
import {
  Banner,
  Button,
  ConfirmDialog,
  PageHeader,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  SaveBar,
  Select,
  toast,
} from '../../ui-kit/index.js'
import { logsApi } from './logs-api.js'

export function LogSettings() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<HostLogSettings>()
  const [original, setOriginal] = useState<HostLogSettings>()
  const [status, setStatus] = useState<HostLogStatus>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const load = () =>
    Promise.all([logsApi.settings(), logsApi.status()])
      .then(([value, state]) => {
        setSettings(value)
        setOriginal(value)
        setStatus(state)
        setError('')
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '日志设置读取失败。'))
  useEffect(() => {
    void load()
  }, [])
  const save = async () => {
    if (!settings) return
    setBusy(true)
    try {
      const value = await logsApi.saveSettings(settings)
      setSettings(value)
      setOriginal(value)
      setStatus(await logsApi.status())
      setError('')
      toast('日志保存设置已更新。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。')
      throw cause
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <PageHeader
        title="日志保存"
        subtitle="当前服务的日志保留多久、最多占用多少空间。"
        actions={
          <Button size="small" onClick={() => void navigate('/logs')}>
            查看日志
          </Button>
        }
      />
      {error ? (
        <Banner tone="bad">
          {error}
          <Button size="small" onClick={() => void load()}>
            重新读取
          </Button>
        </Banner>
      ) : null}
      {settings ? (
        <PropertyGroup title="保留策略" description="时间或容量达到上限后，自动清理最旧的记录。">
          <PropertyList>
            <PropertyRow label="保留时间" width="sm">
              <Select
                aria-label="保留时间"
                value={String(settings.retentionDays)}
                options={Array.from({ length: 30 }, (_, index) => ({
                  value: String(index + 1),
                  label: `${index + 1} 天`,
                }))}
                onValueChange={(value) => setSettings({ ...settings, retentionDays: Number(value) })}
              />
            </PropertyRow>
            <PropertyRow label="容量上限" tip="包含日志数据库、索引及写入期间的伴生文件。" width="sm">
              <Select
                aria-label="容量上限"
                value={String(settings.maxSizeMiB)}
                options={[64, 128, 256, 512, 1024, 2048].map((value) => ({
                  value: String(value),
                  label: `${value} MiB`,
                }))}
                onValueChange={(value) => setSettings({ ...settings, maxSizeMiB: Number(value) })}
              />
            </PropertyRow>
          </PropertyList>
          <SaveBar
            changes={[
              ...(settings.retentionDays !== original?.retentionDays ? ['保留时间'] : []),
              ...(settings.maxSizeMiB !== original?.maxSizeMiB ? ['容量上限'] : []),
            ]}
            busy={busy}
            onDiscard={() => original && setSettings(original)}
            onSave={() => {
              if (
                original &&
                (settings.retentionDays < original.retentionDays || settings.maxSizeMiB < original.maxSizeMiB)
              )
                setConfirm(true)
              else void save().catch(() => undefined)
            }}
          />
        </PropertyGroup>
      ) : (
        <p>正在读取日志设置…</p>
      )}
      {status ? (
        <PropertyGroup title="保存状态">
          <PropertyList>
            <PropertyRow label="状态">{status.state === 'ready' ? '正常保存' : '保存异常'}</PropertyRow>
            <PropertyRow label="实际占用">{(status.bytes / 1024 / 1024).toFixed(1)} MiB</PropertyRow>
            <PropertyRow label="已保存">{status.count.toLocaleString()} 条</PropertyRow>
            <PropertyRow label="最早记录">
              {status.oldestTimestamp ? new Date(status.oldestTimestamp).toLocaleString('zh-CN') : '暂无记录'}
            </PropertyRow>
            <PropertyRow label="本次运行未能保存">{status.droppedCount} 条</PropertyRow>
          </PropertyList>
        </PropertyGroup>
      ) : null}
      <p>日志独立保留，不随业务备份回滚。临时调试到期或服务重启后自动关闭。</p>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="缩短日志保留范围？"
        confirmLabel="保存并清理旧日志"
        danger
        onConfirm={save}
      >
        超出新保留范围的旧日志会被清理，聊天和插件数据不受影响。
      </ConfirmDialog>
    </>
  )
}

import { useState } from 'react'
import { HostApiContracts, type CodeRunAvailability } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { useProductApi } from '../model/store.js'
import { Button, toast } from '../../ui-kit/index.js'
import styles from './agents.module.css'

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`

/** Which downloadable program a download or removal acts on. */
export type RuntimeKind = 'node' | 'github-cli'

const RUNTIME_CONTRACTS = {
  node: { download: HostApiContracts.downloadCodeRunNode, remove: HostApiContracts.removeCodeRunNode },
  'github-cli': { download: HostApiContracts.downloadGithubCli, remove: HostApiContracts.removeGithubCli },
} as const

const runtimeLabel = (kind: RuntimeKind, version: string) =>
  kind === 'node' ? `Node ${version}` : `GitHub CLI ${version}`

/** A program on a device without one: NXT downloads the pinned release itself and shows its progress. */
export function CodeRunNodeDownload({
  availability,
  kind = 'node',
}: {
  readonly availability: CodeRunAvailability
  readonly kind?: RuntimeKind
}) {
  const api = useProductApi()
  const [busy, setBusy] = useState(false)
  const download = availability.download
  if (download === undefined) return null
  const start = async () => {
    setBusy(true)
    try {
      await callHostApi(RUNTIME_CONTRACTS[kind].download, {}, undefined)
      await api.getState().refreshHost()
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  if (download.state === 'downloading') {
    const received = download.receivedBytes ?? 0
    return (
      <span className={styles.note} role="status">
        正在下载 {megabytes(received)}
        {download.totalBytes === undefined ? '' : ` / ${megabytes(download.totalBytes)}`}
      </span>
    )
  }
  const button = (
    <Button size="small" busy={busy} onClick={() => void start()}>
      {download.state === 'failed' ? '重试' : `下载 ${runtimeLabel(kind, download.version)}`}
    </Button>
  )
  if (download.state !== 'failed') return button
  return (
    <div className={styles.note}>
      <span className={styles.noteWarn} role="alert">
        {download.error ?? '下载失败。'}
      </span>
      {button}
    </div>
  )
}

/** A program NXT downloaded can be removed again; one that came with the system or the server stays. */
export function CodeRunNodeRemove({
  availability,
  kind = 'node',
}: {
  readonly availability: CodeRunAvailability
  readonly kind?: RuntimeKind
}) {
  const api = useProductApi()
  const [busy, setBusy] = useState(false)
  if (availability.source !== 'downloaded') return null
  const remove = async () => {
    setBusy(true)
    try {
      await callHostApi(RUNTIME_CONTRACTS[kind].remove, {}, undefined)
      await api.getState().refreshHost()
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="small" busy={busy} onClick={() => void remove()}>
      删除
    </Button>
  )
}

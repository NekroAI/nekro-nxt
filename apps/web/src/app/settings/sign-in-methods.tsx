import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { startRegistration } from '@simplewebauthn/browser'
import { HostApiContracts, type HostApiResponse } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { pushDeviceName } from '../../web-push.js'
import { decodeQr } from '../../qr-decode.js'
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Switch,
  toast,
} from '../../ui-kit/index.js'
import { relativeTime } from '../channels/timeline-model.js'
import styles from './settings.module.css'

type SignIn = HostApiResponse<'getManagementSignIn'>
type LoginCode = HostApiResponse<'createLoginInvite'>
type LoginRequest = HostApiResponse<'getLoginRequest'>

const failure = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { tone: 'bad' })

/** A scanned QR code or a typed code, as the sign-in code it carries. */
const codeFrom = (text: string): string | undefined => {
  const trimmed = text.trim()
  try {
    const url = new URL(trimmed)
    return url.searchParams.get('approve') ?? url.searchParams.get('code') ?? undefined
  } catch {
    return trimmed === '' ? undefined : trimmed
  }
}

const cameraAvailable = (): boolean =>
  typeof navigator !== 'undefined' && window.isSecureContext && navigator.mediaDevices?.getUserMedia !== undefined

/** Passkeys, sign-in codes for other devices and the management key switch. */
export function SignInMethods() {
  const [view, setView] = useState<SignIn>()
  const [params, setParams] = useSearchParams()
  const [invite, setInvite] = useState<LoginCode>()
  const [confirming, setConfirming] = useState<string>()
  const [scanning, setScanning] = useState(false)
  const [typed, setTyped] = useState('')
  const [removing, setRemoving] = useState<SignIn['passkeys'][number]>()
  const [turningOff, setTurningOff] = useState(false)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    setView(await callHostApi(HostApiContracts.getManagementSignIn, {}, undefined))
  }, [])
  useEffect(() => {
    load().catch(failure)
  }, [load])

  // A QR code scanned with the system camera opens this page with the code to confirm.
  const approveParam = params.get('approve')
  useEffect(() => {
    if (approveParam === null) return
    setConfirming(approveParam)
    setParams(
      (current) => {
        current.delete('approve')
        return current
      },
      { replace: true },
    )
  }, [approveParam, setParams])
  const recovered = params.get('recovered') === '1'

  const addPasskey = async () => {
    setBusy('passkey')
    try {
      const optionsJSON = await callHostApi(HostApiContracts.startPasskeyRegistration, {}, undefined)
      const response = await startRegistration({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the server's WebAuthn creation options JSON.
        optionsJSON: optionsJSON as Parameters<typeof startRegistration>[0]['optionsJSON'],
      })
      await callHostApi(
        HostApiContracts.finishPasskeyRegistration,
        {},
        { response: { ...response }, label: pushDeviceName() },
      )
      toast('通行密钥已添加')
      await load()
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') toast('通行密钥没有添加，可以重试。')
      else failure(error)
    } finally {
      setBusy('')
    }
  }

  const setKeySignIn = async (keySignIn: boolean) => {
    setView(await callHostApi(HostApiContracts.updateManagementSignIn, {}, { keySignIn }))
    toast(keySignIn ? '已允许用管理密钥登录' : '已关闭管理密钥登录')
  }

  const showInvite = async () => {
    setBusy('invite')
    try {
      setInvite(await callHostApi(HostApiContracts.createLoginInvite, {}, undefined))
    } catch (error) {
      failure(error)
    } finally {
      setBusy('')
    }
  }

  const confirmTyped = () => {
    const code = codeFrom(typed)
    if (code === undefined) return
    setTyped('')
    setConfirming(code)
  }

  const here = view?.passkeys.filter((passkey) => passkey.rpId === view.rpId) ?? []
  const elsewhere = view?.passkeys.filter((passkey) => passkey.rpId !== view.rpId) ?? []

  return (
    <>
      {recovered ? (
        <Banner tone="warn">已用管理密钥找回访问。建议现在添加通行密钥，或用这台设备确认其他设备登录。</Banner>
      ) : null}
      <PropertyGroup title="登录方式">
        <PropertyList>
          <PropertyRow
            label="通行密钥"
            tip="用面容、指纹或设备密码登录，不用输入管理密钥。通行密钥只在添加时的地址上有效。"
            description={
              view === undefined
                ? '正在读取…'
                : !view.passkeysAvailable
                  ? `通行密钥需要通过 HTTPS 的域名访问，或在本机用 localhost 打开。现在是 ${view.rpId}。`
                  : here.length === 0
                    ? `${view.rpId} 还没有通行密钥。`
                    : `${view.rpId} 有 ${here.length} 个通行密钥。`
            }
          >
            <Button
              size="small"
              busy={busy === 'passkey'}
              disabled={busy !== '' || view?.passkeysAvailable !== true}
              onClick={() => void addPasskey()}
            >
              添加通行密钥
            </Button>
          </PropertyRow>
          {[...here, ...elsewhere].map((passkey) => (
            <PropertyRow
              key={passkey.id}
              depth={1}
              label={passkey.label}
              description={`${passkey.rpId} · ${passkey.lastUsedAt === undefined ? '还没用过' : `最近使用 ${relativeTime(passkey.lastUsedAt)}`}`}
            >
              <Button size="small" variant="ghost" onClick={() => setRemoving(passkey)}>
                删除
              </Button>
            </PropertyRow>
          ))}
          <PropertyRow label="让新设备登录" tip="在新设备上扫描二维码，或在它的登录页输入登录码，再在这里确认。">
            <Button size="small" busy={busy === 'invite'} disabled={busy !== ''} onClick={() => void showInvite()}>
              显示二维码
            </Button>
          </PropertyRow>
          <PropertyRow
            label="确认其他设备登录"
            tip="新设备的登录页选「扫码登录」后会显示二维码和登录码。"
            layout="stacked"
          >
            <div className={styles.originField}>
              <Input
                aria-label="登录码"
                placeholder="ABCD-EFGH"
                value={typed}
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') confirmTyped()
                }}
              />
              <Button size="small" disabled={codeFrom(typed) === undefined} onClick={confirmTyped}>
                确认
              </Button>
              {cameraAvailable() ? (
                <Button size="small" variant="ghost" onClick={() => setScanning(true)}>
                  扫码
                </Button>
              ) : null}
            </div>
          </PropertyRow>
          <PropertyRow
            label="用管理密钥登录"
            tip="关闭后，登录页只提供通行密钥和扫码登录；管理密钥仍可从登录页的找回入口使用。"
          >
            <Switch
              label="用管理密钥登录"
              checked={view?.keySignIn ?? true}
              disabled={view === undefined}
              onCheckedChange={(checked) => {
                if (checked) void setKeySignIn(true).catch(failure)
                else setTurningOff(true)
              }}
            />
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>

      <InviteDialog invite={invite} onClose={() => setInvite(undefined)} />
      <ApproveDialog code={confirming} onClose={() => setConfirming(undefined)} />
      <ScanDialog
        open={scanning}
        onClose={() => setScanning(false)}
        onCode={(code) => {
          setScanning(false)
          setConfirming(code)
        }}
      />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={`删除通行密钥「${removing?.label ?? ''}」？`}
        confirmLabel="删除"
        danger
        onConfirm={async () => {
          const passkey = removing
          setRemoving(undefined)
          if (passkey === undefined) return
          await callHostApi(HostApiContracts.deletePasskey, { passkeyId: passkey.id }, undefined).catch(failure)
          await load().catch(failure)
        }}
      >
        <p>删除后不能再用它登录。设备上保存的通行密钥需要在系统的密码管理里另外删除。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={turningOff}
        onOpenChange={setTurningOff}
        title="关闭管理密钥登录？"
        confirmLabel="关闭"
        onConfirm={async () => {
          setTurningOff(false)
          await setKeySignIn(false).catch(failure)
        }}
      >
        <p>
          登录页不再直接提供管理密钥，新设备用通行密钥或扫码登录。管理密钥仍可从登录页的「用管理密钥找回」使用。
          {here.length === 0 ? ' 这个地址还没有通行密钥，新设备需要已登录的设备确认才能登录。' : ''}
        </p>
      </ConfirmDialog>
    </>
  )
}

/** Watches a sign-in code until the new device has scanned it or it is decided. */
const useLoginRequest = (code: string | undefined) => {
  const [request, setRequest] = useState<LoginRequest>()
  const [gone, setGone] = useState(false)
  useEffect(() => {
    setRequest(undefined)
    setGone(false)
    if (code === undefined) return
    let stopped = false
    const read = async () => {
      try {
        const next = await callHostApi(HostApiContracts.getLoginRequest, { code }, undefined)
        if (!stopped) setRequest(next)
      } catch {
        if (!stopped) setGone(true)
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), 2_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [code])
  return { request, gone, setRequest }
}

function DecisionButtons({
  code,
  onDecided,
}: {
  readonly code: string
  readonly onDecided: (request: LoginRequest) => void
}) {
  const [busy, setBusy] = useState(false)
  const decide = async (approve: boolean) => {
    setBusy(true)
    try {
      const decided = await callHostApi(HostApiContracts.decideLoginRequest, { code }, { approve })
      toast(approve ? '已允许登录' : '已拒绝')
      onDecided(decided)
    } catch (error) {
      failure(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="ghost" disabled={busy} onClick={() => void decide(false)}>
        拒绝
      </Button>
      <Button busy={busy} disabled={busy} onClick={() => void decide(true)}>
        允许登录
      </Button>
    </>
  )
}

/** The QR code a new device scans, then the approval once it has. */
function InviteDialog({ invite, onClose }: { readonly invite: LoginCode | undefined; readonly onClose: () => void }) {
  const { request, gone, setRequest } = useLoginRequest(invite?.code)
  const waiting = request?.state === 'waiting'
  const decided = request?.state === 'approved' || request?.state === 'rejected'
  return (
    <Dialog
      open={invite !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title="让新设备登录"
      closeLabel="关闭"
      actions={
        waiting && invite !== undefined ? (
          <DecisionButtons code={invite.code} onDecided={(next) => setRequest(next)} />
        ) : decided ? (
          <Button onClick={onClose}>完成</Button>
        ) : undefined
      }
    >
      {invite === undefined ? null : gone ? (
        <p>登录码已过期，请重新生成。</p>
      ) : waiting ? (
        <p>「{request.requesterLabel ?? '新设备'}」请求登录。确认是你的设备再允许。</p>
      ) : decided ? (
        <p>{request.state === 'approved' ? '已允许，新设备马上就会登录。' : '已拒绝这次登录。'}</p>
      ) : (
        <div className={styles.loginCode}>
          {/* The SVG comes from this instance's own server. */}
          <div className={styles.qr} dangerouslySetInnerHTML={{ __html: invite.qrSvg }} />
          <span className={styles.codeText}>{invite.code}</span>
          <p className={styles.faint}>用新设备的相机扫描，或在它的登录页选「输入登录码」。5 分钟内有效。</p>
        </div>
      )}
    </Dialog>
  )
}

/** Approving a code another device showed, typed in or scanned. */
function ApproveDialog({ code, onClose }: { readonly code: string | undefined; readonly onClose: () => void }) {
  const { request, gone, setRequest } = useLoginRequest(code)
  const waiting = request?.state === 'waiting' && request.kind === 'request'
  return (
    <Dialog
      open={code !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title="确认设备登录"
      closeLabel="关闭"
      actions={
        waiting && code !== undefined ? (
          <DecisionButtons code={code} onDecided={(next) => setRequest(next)} />
        ) : request !== undefined && request.state !== 'waiting' && request.state !== 'open' ? (
          <Button onClick={onClose}>完成</Button>
        ) : undefined
      }
    >
      {gone ? (
        <p>登录码无效或已过期，请在新设备上重新开始扫码登录。</p>
      ) : request === undefined ? (
        <p>正在读取…</p>
      ) : waiting ? (
        <p>
          「{request.requesterLabel ?? '新设备'}」请求登录，登录码 {request.code}。确认是你的设备再允许。
        </p>
      ) : request.state === 'approved' ? (
        <p>已允许，那台设备马上就会登录。</p>
      ) : request.state === 'rejected' ? (
        <p>已拒绝这次登录。</p>
      ) : (
        <p>这个登录码是用来让新设备扫描的，不需要在这里确认。</p>
      )}
    </Dialog>
  )
}

/** Reads a sign-in QR code with the camera; used where the system camera would open another browser. */
function ScanDialog({
  open,
  onClose,
  onCode,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCode: (code: string) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    if (!open) return
    setProblem('')
    let stream: MediaStream | undefined
    let frame = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const tick = () => {
      if (stopped) return
      const element = video.current
      if (element !== null && context !== null && element.readyState >= element.HAVE_CURRENT_DATA) {
        canvas.width = element.videoWidth
        canvas.height = element.videoHeight
        context.drawImage(element, 0, 0)
        const found = decodeQr(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
        )
        const code = found === undefined ? undefined : codeFrom(found)
        if (code !== undefined) {
          onCode(code)
          return
        }
      }
      frame = requestAnimationFrame(tick)
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (opened) => {
        stream = opened
        if (stopped || video.current === null) return
        video.current.srcObject = opened
        await video.current.play()
        frame = requestAnimationFrame(tick)
      })
      .catch(() => setProblem('没有拿到相机权限。可以在系统设置里允许，或直接输入登录码。'))
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }, [open, onCode])
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} title="扫描登录二维码" closeLabel="关闭">
      {problem ? <p>{problem}</p> : <video ref={video} className={styles.scanner} playsInline muted />}
    </Dialog>
  )
}

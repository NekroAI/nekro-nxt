import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
type PairingCode = HostApiResponse<'createPairingCode'>
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

/** Passkeys, sign-in and pairing codes for other devices, and the management key switch. */
export function SignInMethods() {
  const [view, setView] = useState<SignIn>()
  const [params, setParams] = useSearchParams()
  const [invite, setInvite] = useState<LoginCode>()
  const [pairing, setPairing] = useState<PairingCode>()
  const [confirming, setConfirming] = useState<string>()
  const [entering, setEntering] = useState(false)
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

  const showPairing = async () => {
    setBusy('pairing')
    try {
      setPairing(await callHostApi(HostApiContracts.createPairingCode, {}, undefined))
    } catch (error) {
      failure(error)
    } finally {
      setBusy('')
    }
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

  const here = view?.passkeys.filter((passkey) => passkey.rpId === view.rpId) ?? []
  const elsewhere = view?.passkeys.filter((passkey) => passkey.rpId !== view.rpId) ?? []

  return (
    <>
      {recovered ? (
        <Banner tone="warn">已用管理密钥找回访问。建议现在添加通行密钥，或用这台设备确认其他设备登录。</Banner>
      ) : null}
      <PropertyGroup
        title="通行密钥"
        description={
          view === undefined
            ? undefined
            : view.passkeysAvailable
              ? `用面容、指纹或设备密码登录。通行密钥只在添加时的地址上有效，现在是 ${view.rpId}。`
              : `通行密钥需要通过 HTTPS 的域名访问，或在本机用 localhost 打开。现在是 ${view.rpId}，不能添加。`
        }
        actions={
          <Button
            size="small"
            busy={busy === 'passkey'}
            disabled={busy !== '' || view?.passkeysAvailable !== true}
            onClick={() => void addPasskey()}
          >
            添加通行密钥
          </Button>
        }
      >
        <PropertyList>
          {view === undefined ? (
            <PropertyRow label="正在读取…" />
          ) : view.passkeys.length === 0 ? (
            <PropertyRow label="还没有通行密钥" />
          ) : (
            [...here, ...elsewhere].map((passkey) => (
              <PropertyRow
                key={passkey.id}
                label={passkey.label}
                description={`${passkey.rpId} · ${passkey.lastUsedAt === undefined ? '还没用过' : `最近使用 ${relativeTime(passkey.lastUsedAt)}`}`}
              >
                <Button size="small" variant="ghost" onClick={() => setRemoving(passkey)}>
                  删除
                </Button>
              </PropertyRow>
            ))
          )}
        </PropertyList>
      </PropertyGroup>

      <PropertyGroup title="其他设备登录" description="登录码和配对码 5 分钟内有效，只能用一次。">
        <PropertyList>
          <PropertyRow label="连接安卓应用" description="用 NekroNXT 安卓应用扫码，不用输入地址和管理密钥。">
            <Button size="small" busy={busy === 'pairing'} disabled={busy !== ''} onClick={() => void showPairing()}>
              显示配对码
            </Button>
          </PropertyRow>
          <PropertyRow label="让新设备登录" description="显示二维码，新设备扫码或输入登录码后在这里允许。">
            <Button size="small" busy={busy === 'invite'} disabled={busy !== ''} onClick={() => void showInvite()}>
              显示二维码
            </Button>
          </PropertyRow>
          <PropertyRow label="确认设备登录" description="新设备的登录页显示了二维码和登录码时，在这里输入或扫码。">
            <Button size="small" onClick={() => setEntering(true)}>
              输入或扫码
            </Button>
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>

      <PropertyGroup title="管理密钥">
        <PropertyList>
          <PropertyRow
            label="用管理密钥登录"
            description={
              view?.keySignIn === false
                ? '已关闭。需要时从登录页的「用管理密钥找回」进入。'
                : '关闭后，登录页只提供通行密钥和扫码登录。'
            }
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
      <PairingDialog pairing={pairing} onClose={() => setPairing(undefined)} />
      <ConfirmLoginDialog
        open={entering || confirming !== undefined}
        initialCode={confirming}
        onClose={() => {
          setEntering(false)
          setConfirming(undefined)
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

/** The QR code the Android app scans; it pairs without a further confirmation, so this only reports who used it. */
function PairingDialog({
  pairing,
  onClose,
}: {
  readonly pairing: PairingCode | undefined
  readonly onClose: () => void
}) {
  const { request, gone } = useLoginRequest(pairing?.code)
  const used = request?.state === 'approved'
  return (
    <Dialog
      open={pairing !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title="连接安卓应用"
      closeLabel="关闭"
      actions={used ? <Button onClick={onClose}>完成</Button> : undefined}
    >
      {pairing === undefined ? null : used ? (
        <p>「{request.requesterLabel ?? '安卓应用'}」已连接，可以在「已登录设备」里看到它。</p>
      ) : gone ? (
        <p>配对码已过期，请重新生成。</p>
      ) : (
        <div className={styles.loginCode}>
          {/* The SVG comes from this instance's own server. */}
          <div className={styles.qr} dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          <span className={styles.codeText}>{pairing.code}</span>
          <p className={styles.faint}>
            在应用里点「扫码连接」。不能扫码时选「输入地址」，填 {pairing.origin} 和这个配对码。5 分钟内有效。
          </p>
          <p className={styles.faint}>
            还没安装？到
            <a href="https://nxt.nekro.ai/download" target="_blank" rel="noreferrer">
              下载页
            </a>
            获取安卓应用。
          </p>
        </div>
      )}
    </Dialog>
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

/**
 * Approving another device: type its code or scan its QR code, then allow or refuse. The camera is here because the
 * iPhone home screen app does not share sign-in with Safari, where the system camera would open the code.
 */
function ConfirmLoginDialog({
  open,
  initialCode,
  onClose,
}: {
  readonly open: boolean
  /** A code that arrived with the page, from a QR code the system camera opened. */
  readonly initialCode: string | undefined
  readonly onClose: () => void
}) {
  const [code, setCode] = useState<string>()
  const [typed, setTyped] = useState('')
  const [camera, setCamera] = useState(false)
  useEffect(() => {
    if (!open) return
    setCode(initialCode)
    setTyped('')
    setCamera(false)
  }, [open, initialCode])
  const { request, gone, setRequest } = useLoginRequest(code)
  const waiting = request?.state === 'waiting' && request.kind === 'request'
  const finished = request !== undefined && (request.state === 'approved' || request.state === 'rejected')
  const submit = () => {
    const next = codeFrom(typed)
    if (next !== undefined) setCode(next)
  }
  const restart = () => {
    setCode(undefined)
    setTyped('')
  }

  let body: ReactNode
  let actions: ReactNode
  if (code === undefined) {
    body = camera ? (
      <CameraScan
        onCode={(found) => {
          setCamera(false)
          setCode(found)
        }}
      />
    ) : (
      <div className={styles.codeEntry}>
        <Input
          aria-label="登录码"
          placeholder="ABCD-EFGH"
          value={typed}
          autoFocus
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <p className={styles.faint}>新设备的登录页会显示二维码和登录码。</p>
      </div>
    )
    actions = camera ? (
      <Button variant="ghost" onClick={() => setCamera(false)}>
        输入登录码
      </Button>
    ) : (
      <>
        {cameraAvailable() ? (
          <Button variant="ghost" onClick={() => setCamera(true)}>
            用相机扫码
          </Button>
        ) : null}
        <Button disabled={codeFrom(typed) === undefined} onClick={submit}>
          继续
        </Button>
      </>
    )
  } else if (gone) {
    body = <p>登录码无效或已过期。请在新设备上重新开始扫码登录。</p>
    actions = (
      <Button variant="ghost" onClick={restart}>
        重新输入
      </Button>
    )
  } else if (request === undefined) {
    body = <p>正在读取…</p>
  } else if (waiting) {
    body = (
      <p>
        「{request.requesterLabel ?? '新设备'}」请求登录，登录码 {request.code}。确认是你的设备再允许。
      </p>
    )
    actions = <DecisionButtons code={code} onDecided={(next) => setRequest(next)} />
  } else if (finished) {
    body = <p>{request.state === 'approved' ? '已允许，那台设备马上就会登录。' : '已拒绝这次登录。'}</p>
    actions = <Button onClick={onClose}>完成</Button>
  } else {
    body = <p>这个登录码是用来让新设备扫描的，不需要在这里确认。</p>
    actions = (
      <Button variant="ghost" onClick={restart}>
        重新输入
      </Button>
    )
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="确认设备登录"
      closeLabel="关闭"
      actions={actions}
    >
      {body}
    </Dialog>
  )
}

/** Reads a sign-in QR code from the camera. */
function CameraScan({ onCode }: { readonly onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
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
      .catch(() => setProblem('没有拿到相机权限。可以在系统设置里允许，或改为输入登录码。'))
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }, [onCode])
  return problem ? <p>{problem}</p> : <video ref={video} className={styles.scanner} playsInline muted />
}

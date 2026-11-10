/**
 * The anonymous browser login page of the management edge. It loads no product or extension code, so the management
 * key is typed into a page that nothing else runs in; its only script besides its own is the QR decoder this edge
 * serves, loaded when the page scans with the camera.
 *
 * One view at a time: an unencrypted connection is confirmed first. A phone leads with scanning the code a signed-in
 * device shows; other devices lead with their own QR code for a signed-in device to scan. A passkey sits under either
 * as the second button. The management key, a typed code and the other direction of scanning are quiet links.
 */
export const managementLoginPage = (input: {
  readonly secure: boolean
  readonly next: string
  /** Off: the key view is reached only as recovery. */
  readonly keySignIn?: boolean
  /** This address has passkeys and the browser may use them. */
  readonly passkeys?: boolean
  /** A sign-in code from a QR code another device showed. */
  readonly code?: string
  /** Same-origin script that defines `window.jsQR`. */
  readonly qrDecoder: string
}): string => {
  const json = (value: unknown) => JSON.stringify(value).replace(/</gu, '\\u003c')
  const config = {
    next: input.next,
    secure: input.secure,
    keySignIn: input.keySignIn ?? true,
    passkeys: input.passkeys === true,
    code: input.code ?? null,
    qrDecoder: input.qrDecoder,
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#f4f1ea" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0d1626" media="(prefers-color-scheme: dark)" />
<meta name="robots" content="noindex" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>登录 · NekroNXT</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f1ea; --surface: #fffdf8; --line: #e2dccf; --fg: #14243d; --muted: #566275;
    --accent: #2f4b78; --accent-fg: #ffffff; --warn: #87570d; --bad: #b03a30;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1626; --surface: #142036; --line: #24334d; --fg: #eef2f8; --muted: #8e9bb0;
      --accent: #8fb0e8; --accent-fg: #0d1626; --warn: #e9bd68; --bad: #f08f83;
    }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
      max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    background: var(--bg); color: var(--fg);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  }
  main {
    width: min(360px, 100%); display: grid; gap: 20px; padding: 28px 24px 22px;
    border: 1px solid var(--line); border-radius: 18px; background: var(--surface);
  }
  header { display: flex; align-items: center; gap: 10px; }
  header img { width: 28px; height: 28px; }
  h1 { margin: 0; font-size: 17px; font-weight: 650; }
  .view { display: grid; gap: 14px; }
  .view h2 { margin: 0; font-size: 15px; font-weight: 650; display: flex; align-items: center; gap: 6px; }
  p { margin: 0; color: var(--muted); }
  .note { font-size: 12.5px; }
  input {
    width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px;
    background: transparent; color: var(--fg); font: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  input.code-input { font: 600 18px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.1em; text-align: center; text-transform: uppercase; }
  button {
    padding: 10px 12px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-fg);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--fg) 20%, transparent);
    background: transparent; color: var(--fg); font-weight: 500;
  }
  button.text { background: none; padding: 2px 0; color: var(--accent); font-weight: 500; }
  button.back { background: none; padding: 0 4px 0 0; color: var(--muted); font-weight: 500; font-size: 15px; }
  .actions { display: grid; gap: 10px; }
  .or { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12.5px; }
  .or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
  .scan { display: grid; justify-items: center; gap: 10px; text-align: center; }
  .qr { position: relative; width: 184px; height: 184px; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); }
  .qr svg { display: block; width: 100%; height: 100%; }
  .qr .cover {
    position: absolute; inset: 0; display: grid; place-items: center; padding: 12px;
    background: color-mix(in srgb, var(--surface) 88%, transparent); color: var(--fg); font-weight: 600;
  }
  .code { font: 600 22px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.1em; }
  .viewfinder { position: relative; aspect-ratio: 1; border-radius: 14px; overflow: hidden; background: #000; }
  .viewfinder video { display: block; width: 100%; height: 100%; object-fit: cover; }
  .viewfinder::after {
    content: ""; position: absolute; inset: 16%; border-radius: 12px;
    box-shadow: 0 0 0 2px rgb(255 255 255 / 0.85), 0 0 0 999px rgb(0 0 0 / 0.3);
  }
  .center { text-align: center; }
  .spinner {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent);
    animation: spin 0.9s linear infinite; display: inline-block; vertical-align: -3px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .warning { color: var(--warn); }
  .error { color: var(--bad); }
  nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 14px; padding-top: 14px; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>
  <header><img src="/brand/mark.svg" alt="" /><h1>登录 NekroNXT</h1></header>

  ${
    input.secure
      ? ''
      : `  <section class="view" id="view-insecure" hidden>
    <h2 class="warning">当前连接未加密</h2>
    <p>登录状态会以明文在网络中传输，可能被截获。只在可信的内网这样使用；公网访问请通过 HTTPS。</p>
    <button type="button" id="accept-insecure">我了解风险，继续</button>
  </section>`
  }

  <section class="view" id="view-phone" hidden>
    <p>在已登录的设备上打开「设置 → 登录与访问 → 让新设备登录」，用这台手机扫描显示的二维码。</p>
    <div class="actions">
      <button type="button" data-go="camera">扫码登录</button>
      <button type="button" class="secondary" data-passkey hidden>使用通行密钥</button>
    </div>
  </section>

  <section class="view" id="view-show" hidden>
    <h2 id="show-title"><button type="button" class="back" data-back aria-label="返回">←</button>本机登录码</h2>
    <p class="warning" id="camera-notice" hidden></p>
    <div class="scan">
      <div class="qr" id="qr"><div class="cover" id="qr-cover">正在生成…</div></div>
      <span class="code" id="shown-code"></span>
      <p id="show-hint"></p>
    </div>
    <div class="actions" id="show-passkey" hidden>
      <span class="or">或</span>
      <button type="button" class="secondary" data-passkey>使用通行密钥</button>
    </div>
  </section>

  <section class="view" id="view-camera" hidden>
    <h2><button type="button" class="back" data-back aria-label="返回">←</button>扫描二维码</h2>
    <div class="viewfinder"><video id="video" playsinline muted></video></div>
    <p class="center" id="camera-status"></p>
  </section>

  <form class="view" id="view-key" hidden autocomplete="off">
    <h2><button type="button" class="back" data-back aria-label="返回">←</button><span id="key-title"></span></h2>
    <p id="key-intro"></p>
    <input type="password" id="key" aria-label="管理密钥" placeholder="管理密钥" />
    <button type="submit" id="key-submit"></button>
    <p class="note">这台浏览器会保持登录，可在「设置 → 登录与访问」中随时撤销。</p>
  </form>

  <form class="view" id="view-code" hidden autocomplete="off">
    <h2><button type="button" class="back" data-back aria-label="返回">←</button>输入登录码</h2>
    <p>在已登录设备的「设置 → 登录与访问」选「让新设备登录」，会显示二维码和登录码。</p>
    <input class="code-input" id="code" aria-label="登录码" placeholder="ABCD-EFGH" autocapitalize="characters" />
    <button type="submit">继续</button>
  </form>

  <section class="view" id="view-waiting" hidden>
    <h2>等待确认</h2>
    <p id="waiting-text"></p>
    <p><span class="spinner" aria-hidden="true"></span> 正在等待…</p>
    <button type="button" class="text" data-back>取消</button>
  </section>

  <p class="error" id="error" role="alert" hidden></p>

  <nav id="alternatives" hidden>
    <button type="button" class="text" data-go="camera">扫码登录</button>
    <button type="button" class="text" data-go="show">显示本机登录码</button>
    <button type="button" class="text" data-go="code">输入登录码</button>
    <button type="button" class="text" data-go="key"></button>
  </nav>
</main>
<script>
  const config = ${json(config)}
  const $ = (id) => document.getElementById(id)
  const views = ['insecure', 'phone', 'show', 'camera', 'key', 'code', 'waiting'].filter((name) => $('view-' + name) !== null)
  let current = null
  let timer = null
  let scanExpiresAt = 0
  let scanSecret = null

  // A phone scans the code a signed-in device shows; tablets and computers show their own. iPads report a desktop
  // browser and have wide screens, so they count as computers.
  const phone =
    /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/.test(navigator.userAgent) ||
    (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600)
  // Pages reach the camera only over HTTPS or on this machine. A camera that fails to open is remembered here too.
  const cameraApi = window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
  let cameraProblem = cameraApi
    ? null
    : window.isSecureContext
      ? '这个浏览器不能在页面里使用相机。'
      : '页面里扫码需要 HTTPS 连接。'
  const home = () => (phone && cameraProblem === null ? 'phone' : 'show')

  // Sign-ins that end in a session over plain HTTP carry the risk confirmation from the first view.
  const acknowledging = ['/api/management/login', '/api/management/login-requests', '/api/management/login-requests/claim']
  const post = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(body ?? {}),
        ...(config.secure || !acknowledging.includes(path) ? {} : { acknowledgeInsecure: true }),
      }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message ?? '登录失败，请稍后重试。')
    return data
  }
  const say = (message) => {
    $('error').textContent = message ?? ''
    $('error').hidden = !message
  }
  const stopPolling = () => { if (timer !== null) clearInterval(timer); timer = null }

  // The home view carries the passkey; the quiet row under it lists the ways in it does not show itself.
  const show = (name) => {
    if (current === 'camera' && name !== 'camera') stopCamera()
    current = name
    for (const view of views) $('view-' + view).hidden = view !== name
    say()
    const atHome = name === home()
    const nav = $('alternatives')
    nav.hidden = !atHome
    nav.querySelector('[data-go=camera]').hidden = !cameraApi || name === 'phone'
    nav.querySelector('[data-go=show]').hidden = !phone || name === 'show'
    for (const button of document.querySelectorAll('[data-passkey]')) button.hidden = !config.passkeys
    $('show-passkey').hidden = !config.passkeys || !atHome
    $('show-title').hidden = atHome
    $('camera-notice').hidden = !(atHome && phone && cameraProblem !== null)
    $('camera-notice').textContent = cameraProblem ?? ''
    $('show-hint').textContent = !phone
      ? '用已登录的手机扫码，或在已登录设备的「设置 → 登录与访问 → 确认设备登录」输入登录码。'
      : cameraProblem === null
        ? '在已登录设备的「设置 → 登录与访问 → 确认设备登录」输入这个登录码。'
        : '在已登录设备的「设置 → 登录与访问 → 确认设备登录」输入这个登录码，或用系统相机扫描已登录设备上的二维码。'
  }

  const goHome = () => {
    stopPolling()
    if (home() === 'show') void startShow()
    else show('phone')
  }

  // This device shows a code; a signed-in device approves it, then the poll picks up the session.
  const startShow = async (fresh = false) => {
    stopPolling()
    show('show')
    // Coming back to the code still on screen keeps it instead of asking for another one.
    if (!fresh && scanSecret !== null && Date.now() < scanExpiresAt - 10000) {
      poll(scanSecret, (message) => showExpired(message))
      return
    }
    $('qr-cover').hidden = false
    $('qr-cover').textContent = '正在生成…'
    $('qr-cover').onclick = null
    try {
      const created = await post('/api/management/login-requests')
      scanSecret = created.secret
      scanExpiresAt = created.expiresAt
      $('qr').querySelector('svg')?.remove()
      $('qr').insertAdjacentHTML('afterbegin', created.qrSvg)
      $('shown-code').textContent = created.code
      $('qr-cover').hidden = true
      if (current === 'show') poll(created.secret, (message) => showExpired(message))
    } catch (cause) {
      $('qr-cover').textContent = '点击重试'
      $('qr-cover').onclick = () => void startShow(true)
      say(cause.message)
    }
  }
  const showExpired = (message) => {
    stopPolling()
    scanSecret = null
    $('qr-cover').hidden = false
    $('qr-cover').textContent = (message ?? '登录码已过期。') + '点击刷新'
    $('qr-cover').onclick = () => void startShow(true)
  }

  const poll = (secret, onExpired) => {
    stopPolling()
    timer = setInterval(async () => {
      if (secret === scanSecret && Date.now() > scanExpiresAt) { onExpired(); return }
      try {
        const result = await post('/api/management/login-requests/poll', { secret })
        if (result.state === 'approved') { stopPolling(); location.replace(config.next); return }
        if (result.state === 'rejected') { stopPolling(); onExpired('这次登录被拒绝了。') }
        if (result.state === 'expired') { stopPolling(); onExpired('登录码已过期。') }
      } catch {
        // A failed poll is retried on the next tick.
      }
    }, 2000)
  }

  // A code another device showed, typed or scanned: this device waits until that device allows it.
  const claim = async (code, from) => {
    const fail = (message) => {
      if (from === 'code') show('code')
      else goHome()
      say(message)
    }
    try {
      const claimed = await post('/api/management/login-requests/claim', { code })
      $('waiting-text').textContent =
        '请在显示二维码的设备上允许' + (claimed.requesterLabel ? '「' + claimed.requesterLabel + '」' : '这台设备') + '登录。'
      show('waiting')
      poll(claimed.secret, (message) => fail(message ?? '登录码已过期，请重新生成。'))
    } catch (cause) {
      fail(cause.message)
    }
  }

  // Scanning with the camera. jsQR reads the frames on every browser, iPhones without BarcodeDetector included.
  let stream = null
  let frameTimer = null
  let decoder = null
  const loadDecoder = () =>
    (decoder ??= new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = config.qrDecoder
      script.onload = () => (typeof window.jsQR === 'function' ? resolve(window.jsQR) : reject(new Error('jsQR')))
      script.onerror = () => reject(new Error('jsQR'))
      document.head.append(script)
    }).catch((cause) => {
      decoder = null
      throw cause
    }))
  const stopCamera = () => {
    if (frameTimer !== null) clearTimeout(frameTimer)
    frameTimer = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    $('video').srcObject = null
  }
  const cameraFailure = (cause) =>
    cause?.name === 'NotAllowedError' || cause?.name === 'SecurityError'
      ? '没有相机权限。可以在浏览器设置里允许后再扫码。'
      : cause?.name === 'NotFoundError' || cause?.name === 'OverconstrainedError'
        ? '没有找到可用的相机。'
        : '相机没有打开。'
  // The link a signed-in device shows carries ?code=; ?approve= is on the code another new device shows.
  const readScan = (text) => {
    const value = text.trim()
    try {
      const url = new URL(value)
      if (url.searchParams.has('approve')) return { problem: '这是另一台新设备的登录码，请扫描已登录设备上的二维码。' }
      const code = url.searchParams.get('code')
      return code ? { code } : { problem: '这不是登录二维码。' }
    } catch {
      return /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(value) ? { code: value } : { problem: '这不是登录二维码。' }
    }
  }
  const startCamera = async () => {
    stopPolling()
    show('camera')
    $('camera-status').textContent = '正在打开相机…'
    $('camera-status').classList.remove('warning')
    let decode
    try {
      decode = await loadDecoder()
    } catch {
      $('camera-status').textContent = ''
      say('二维码识别组件没有加载，请检查网络后重试。')
      return
    }
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      if (current !== 'camera') { for (const track of opened.getTracks()) track.stop(); return }
      stream = opened
      $('video').srcObject = opened
      await $('video').play()
    } catch (cause) {
      stopCamera()
      if (current !== 'camera') return
      cameraProblem = cameraFailure(cause)
      goHome()
      // A phone explains it above its own code; elsewhere the code was already home.
      if (!phone) say(cameraProblem)
      return
    }
    cameraProblem = null
    $('camera-status').textContent = '对准已登录设备上的二维码。'
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const video = $('video')
    const tick = () => {
      frameTimer = null
      if (stream === null) return
      if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const found = decode(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
        if (found !== null) {
          const read = readScan(found.data)
          if (read.code !== undefined) {
            stopCamera()
            $('camera-status').textContent = '已识别，正在登录…'
            void claim(read.code, 'camera')
            return
          }
          $('camera-status').textContent = read.problem
          $('camera-status').classList.add('warning')
        }
      }
      frameTimer = setTimeout(tick, 150)
    }
    tick()
  }
  addEventListener('pagehide', stopCamera)

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)), (char) => char.charCodeAt(0))
  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  const signInWithPasskey = async () => {
    say()
    try {
      const started = await post('/api/management/passkey-login/options')
      const options = started.options
      const credential = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: fromBase64Url(options.challenge),
          allowCredentials: (options.allowCredentials ?? []).map((item) => ({ ...item, id: fromBase64Url(item.id) })),
        },
      })
      if (credential === null) return
      const response = credential.response
      await post('/api/management/passkey-login', {
        challengeId: started.challengeId,
        response: {
          id: credential.id,
          rawId: toBase64Url(credential.rawId),
          type: credential.type,
          ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            ...(response.userHandle ? { userHandle: toBase64Url(response.userHandle) } : {}),
          },
        },
      })
      location.replace(config.next)
    } catch (cause) {
      say(cause?.name === 'NotAllowedError' ? '通行密钥没有完成，可以重试或换一种方式。' : cause.message)
    }
  }
  for (const button of document.querySelectorAll('[data-passkey]')) button.addEventListener('click', signInWithPasskey)

  // The key view: everyday sign-in, or recovery when key sign-in is off.
  $('key-title').textContent = config.keySignIn ? '使用管理密钥' : '用管理密钥找回'
  $('key-intro').textContent = config.keySignIn
    ? '输入部署时设置的管理密钥。'
    : '这个实例关闭了管理密钥登录。找回后请添加通行密钥，或用这台设备确认其他设备登录。'
  $('key-submit').textContent = config.keySignIn ? '登录' : '找回'
  $('alternatives').querySelector('[data-go=key]').textContent = config.keySignIn ? '使用管理密钥' : '用管理密钥找回'
  $('view-key').addEventListener('submit', async (event) => {
    event.preventDefault()
    const key = $('key')
    if (key.value === '') return
    $('key-submit').disabled = true
    say()
    try {
      const result = await post('/api/management/login', { managementKey: key.value, recovery: !config.keySignIn })
      location.replace(result.next ?? config.next)
      return
    } catch (cause) {
      say(cause.message)
    }
    key.value = ''
    $('key-submit').disabled = false
    key.focus()
  })
  $('view-code').addEventListener('submit', (event) => {
    event.preventDefault()
    say()
    if ($('code').value.trim() !== '') void claim($('code').value, 'code')
  })

  for (const button of document.querySelectorAll('[data-back]')) button.addEventListener('click', goHome)
  for (const button of document.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => {
      stopPolling()
      const target = button.dataset.go
      if (target === 'camera') { void startCamera(); return }
      if (target === 'show') { void startShow(); return }
      show(target)
      ;(target === 'key' ? $('key') : $('code')).focus()
    })
  }

  const begin = () => {
    if (config.code !== null) { $('code').value = config.code; void claim(config.code, 'code'); return }
    goHome()
  }
  if (config.secure) begin()
  else {
    show('insecure')
    $('accept-insecure').addEventListener('click', begin)
  }
</script>
</body>
</html>
`
}

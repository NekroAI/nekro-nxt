/**
 * The anonymous browser login page of the management edge. It is self-contained (inline style and script) and loads
 * no product or extension code, so the management key is typed into a page that nothing else runs in.
 *
 * One view at a time: an unencrypted connection is confirmed first; then the easiest way in leads (a passkey, or the
 * QR code a signed-in device scans); the management key and a typed code are separate views behind quiet links.
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
}): string => {
  const json = (value: unknown) => JSON.stringify(value).replace(/</gu, '\\u003c')
  const config = {
    next: input.next,
    secure: input.secure,
    keySignIn: input.keySignIn ?? true,
    passkeys: input.passkeys === true,
    code: input.code ?? null,
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
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
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
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
  button.text { background: none; padding: 2px 0; color: var(--accent); font-weight: 500; }
  button.back { background: none; padding: 0 4px 0 0; color: var(--muted); font-weight: 500; font-size: 15px; }
  .scan { display: grid; justify-items: center; gap: 10px; text-align: center; }
  .qr { position: relative; width: 184px; height: 184px; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); }
  .qr svg { display: block; width: 100%; height: 100%; }
  .qr .cover {
    position: absolute; inset: 0; display: grid; place-items: center; padding: 12px;
    background: color-mix(in srgb, var(--surface) 88%, transparent); color: var(--fg); font-weight: 600;
  }
  .code { font: 600 22px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.1em; }
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

  <section class="view" id="view-home" hidden>
    <button type="button" id="passkey" hidden>使用通行密钥登录</button>
    <div class="scan" id="scan" hidden>
      <div class="qr" id="qr"><div class="cover" id="qr-cover">正在生成…</div></div>
      <span class="code" id="shown-code"></span>
      <p>用已登录的手机扫码，或在已登录设备的「设置 → 登录与访问」输入登录码，然后允许。</p>
    </div>
    <p class="error" id="home-error" role="alert" hidden></p>
  </section>

  <form class="view" id="view-key" hidden autocomplete="off">
    <h2><button type="button" class="back" data-back aria-label="返回">←</button><span id="key-title"></span></h2>
    <p id="key-intro"></p>
    <input type="password" id="key" aria-label="管理密钥" placeholder="管理密钥" />
    <button type="submit" id="key-submit"></button>
    <p class="error" id="key-error" role="alert" hidden></p>
    <p class="note">这台浏览器会保持登录，可在「设置 → 登录与访问」中随时撤销。</p>
  </form>

  <form class="view" id="view-code" hidden autocomplete="off">
    <h2><button type="button" class="back" data-back aria-label="返回">←</button>输入登录码</h2>
    <p>在已登录设备的「设置 → 登录与访问」选「让新设备登录」，会显示二维码和登录码。</p>
    <input class="code-input" id="code" aria-label="登录码" placeholder="ABCD-EFGH" autocapitalize="characters" />
    <button type="submit">继续</button>
    <p class="error" id="code-error" role="alert" hidden></p>
  </form>

  <section class="view" id="view-waiting" hidden>
    <h2>等待确认</h2>
    <p id="waiting-text"></p>
    <p><span class="spinner" aria-hidden="true"></span> 正在等待…</p>
    <button type="button" class="text" data-back>取消</button>
  </section>

  <nav id="alternatives" hidden>
    <button type="button" class="text" data-go="passkey" hidden>使用通行密钥</button>
    <button type="button" class="text" data-go="scan" hidden>扫码登录</button>
    <button type="button" class="text" data-go="key" hidden></button>
    <button type="button" class="text" data-go="code">我有登录码</button>
  </nav>
</main>
<script>
  const config = ${json(config)}
  const $ = (id) => document.getElementById(id)
  const views = ['insecure', 'home', 'key', 'code', 'waiting'].filter((name) => $('view-' + name) !== null)
  let timer = null
  let scanExpiresAt = 0
  let scanSecret = null

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
  const say = (id, message) => {
    const element = $(id)
    element.textContent = message ?? ''
    element.hidden = !message
  }
  const stopPolling = () => { if (timer !== null) clearInterval(timer); timer = null }

  // The home view leads with a passkey when this address has one, otherwise with the QR code.
  let homeMode = config.passkeys ? 'passkey' : 'scan'

  // The quiet row lists every way in except the one on screen.
  const show = (name) => {
    for (const view of views) $('view-' + view).hidden = view !== name
    const nav = $('alternatives')
    nav.hidden = name === 'insecure' || name === 'waiting'
    const onHome = name === 'home'
    nav.querySelector('[data-go=passkey]').hidden = !config.passkeys || (onHome && homeMode === 'passkey')
    nav.querySelector('[data-go=scan]').hidden = onHome && homeMode === 'scan'
    nav.querySelector('[data-go=key]').hidden = name === 'key'
    nav.querySelector('[data-go=code]').hidden = name === 'code'
  }

  const showPasskey = () => {
    stopPolling()
    homeMode = 'passkey'
    $('passkey').hidden = false
    $('scan').hidden = true
    say('home-error')
    show('home')
  }

  const goHome = () => (config.passkeys ? showPasskey() : void startScan())

  // This device shows a code; a signed-in device approves it, then the poll picks up the session.
  const startScan = async (fresh = false) => {
    stopPolling()
    homeMode = 'scan'
    $('passkey').hidden = true
    $('scan').hidden = false
    show('home')
    // Coming back to the code still on screen keeps it instead of asking for another one.
    if (!fresh && scanSecret !== null && Date.now() < scanExpiresAt - 10000) {
      poll(scanSecret, (message) => scanExpired(message))
      return
    }
    $('qr-cover').hidden = false
    $('qr-cover').textContent = '正在生成…'
    $('qr-cover').onclick = null
    say('home-error')
    try {
      const created = await post('/api/management/login-requests')
      scanSecret = created.secret
      scanExpiresAt = created.expiresAt
      $('qr').querySelector('svg')?.remove()
      $('qr').insertAdjacentHTML('afterbegin', created.qrSvg)
      $('shown-code').textContent = created.code
      $('qr-cover').hidden = true
      poll(created.secret, (message) => scanExpired(message))
    } catch (cause) {
      $('qr-cover').textContent = '点击重试'
      $('qr-cover').onclick = () => void startScan(true)
      say('home-error', cause.message)
    }
  }
  const scanExpired = (message) => {
    stopPolling()
    scanSecret = null
    $('qr-cover').hidden = false
    $('qr-cover').textContent = (message ?? '登录码已过期。') + '点击刷新'
    $('qr-cover').onclick = () => void startScan(true)
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

  const claim = async (code) => {
    say('code-error')
    try {
      const claimed = await post('/api/management/login-requests/claim', { code })
      $('waiting-text').textContent =
        '请在显示二维码的设备上允许' + (claimed.requesterLabel ? '「' + claimed.requesterLabel + '」' : '这台设备') + '登录。'
      show('waiting')
      poll(claimed.secret, (message) => { show('code'); say('code-error', message ?? '登录码已过期，请重新生成。') })
    } catch (cause) {
      show('code')
      say('code-error', cause.message)
    }
  }

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)), (char) => char.charCodeAt(0))
  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  $('passkey').addEventListener('click', async () => {
    say('home-error')
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
      say('home-error', cause?.name === 'NotAllowedError' ? '通行密钥没有完成，可以重试或换一种方式。' : cause.message)
    }
  })

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
    say('key-error')
    try {
      const result = await post('/api/management/login', { managementKey: key.value, recovery: !config.keySignIn })
      location.replace(result.next ?? config.next)
      return
    } catch (cause) {
      say('key-error', cause.message)
    }
    key.value = ''
    $('key-submit').disabled = false
    key.focus()
  })
  $('view-code').addEventListener('submit', (event) => {
    event.preventDefault()
    if ($('code').value.trim() !== '') void claim($('code').value)
  })

  for (const button of document.querySelectorAll('[data-back]')) button.addEventListener('click', goHome)
  for (const button of document.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => {
      stopPolling()
      const target = button.dataset.go
      if (target === 'scan') { void startScan(); return }
      if (target === 'passkey') { showPasskey(); return }
      show(target)
      ;(target === 'key' ? $('key') : $('code')).focus()
    })
  }

  const begin = () => {
    if (config.code !== null) { $('code').value = config.code; void claim(config.code); return }
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

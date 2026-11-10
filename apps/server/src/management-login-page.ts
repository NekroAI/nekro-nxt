/**
 * The anonymous browser login page of the management edge. It is self-contained (inline style and script) and loads
 * no product or extension code, so the management key is typed into a page that nothing else runs in.
 */
export const managementLoginPage = (input: {
  readonly secure: boolean
  readonly next: string
  /** Off: the key form is reached only through the recovery entry. */
  readonly keySignIn?: boolean
  /** This address has passkeys and the browser may use them. */
  readonly passkeys?: boolean
  /** A sign-in code from a QR code another device showed. */
  readonly code?: string
}): string => {
  const keySignIn = input.keySignIn ?? true
  const json = (value: unknown) => JSON.stringify(value).replace(/</gu, '\\u003c')
  // The key form is open right away only when nothing easier exists yet.
  const keyOpen = keySignIn && input.passkeys !== true && input.code === undefined
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
    --accent: #2f4b78; --accent-fg: #ffffff; --warn-bg: #fbf1dc; --warn: #87570d; --bad: #b03a30;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1626; --surface: #142036; --line: #24334d; --fg: #eef2f8; --muted: #8e9bb0;
      --accent: #8fb0e8; --accent-fg: #0d1626; --warn-bg: #2d2615; --warn: #e9bd68; --bad: #f08f83;
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
    width: min(380px, 100%); display: grid; gap: 16px; padding: 28px;
    border: 1px solid var(--line); border-radius: 18px; background: var(--surface);
  }
  header { display: flex; align-items: center; gap: 10px; }
  header img { width: 32px; height: 32px; }
  h1 { margin: 0; font-size: 18px; font-weight: 650; }
  p { margin: 0; color: var(--muted); }
  label { display: grid; gap: 6px; font-weight: 600; }
  input[type=password], input[type=text] {
    width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px;
    background: transparent; color: var(--fg); font: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .stack { display: grid; gap: 12px; }
  .warning {
    display: grid; gap: 8px; padding: 12px; border-radius: 10px;
    background: var(--warn-bg); color: var(--warn);
  }
  .warning label { display: flex; align-items: center; gap: 8px; font-weight: 500; color: var(--fg); }
  button {
    padding: 9px 12px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-fg);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  button.link { background: none; padding: 0; color: var(--accent); font-weight: 500; justify-self: start; }
  button:disabled { opacity: 0.5; cursor: default; }
  .panel { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; }
  .qr { justify-self: center; width: 200px; height: 200px; padding: 8px; border-radius: 8px; background: #ffffff; }
  .qr svg { display: block; width: 100%; height: 100%; }
  .code { justify-self: center; font: 600 20px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.08em; }
  .error { color: var(--bad); min-height: 1.6em; }
</style>
</head>
<body>
<main>
  <header><img src="/brand/mark.svg" alt="" /><h1>登录 NekroNXT</h1></header>
  ${
    input.secure
      ? ''
      : `<div class="warning" role="note">
    <span>当前连接未加密，登录状态在网络中以明文传输，可能被截获。公网访问请使用 HTTPS。</span>
    <label><input type="checkbox" id="acknowledge" /> 我了解风险，继续使用</label>
  </div>`
  }
  <div class="stack" id="choices">
    ${input.passkeys === true ? '<button type="button" id="passkey">使用通行密钥登录</button>' : ''}
    <button type="button" class="${input.passkeys === true ? 'secondary' : ''}" id="scan">扫码登录</button>
    <button type="button" class="link" id="enter-code">输入登录码</button>
  </div>
  <form class="panel" id="code-form" hidden autocomplete="off">
    <label>登录码<input type="text" id="code" placeholder="ABCD-EFGH" autocapitalize="characters" /></label>
    <p>在已登录设备的「设置 → 登录与访问」里选「让新设备登录」可以看到登录码。</p>
    <button type="submit" id="code-submit">继续</button>
  </form>
  <div class="panel" id="waiting" hidden>
    <div class="qr" id="qr" hidden></div>
    <span class="code" id="shown-code" hidden></span>
    <p id="waiting-text"></p>
    <button type="button" class="secondary" id="cancel">换一种方式</button>
  </div>
  <form class="panel" id="key-form" ${keyOpen ? '' : 'hidden'} autocomplete="off">
    <p>${keySignIn ? '输入部署时设置的管理密钥。' : '用部署时设置的管理密钥找回访问。登录后请添加通行密钥，或用这台设备确认其他设备登录。'}</p>
    <label>管理密钥<input type="password" id="key" /></label>
    <button type="submit" id="key-submit">${keySignIn ? '登录' : '找回'}</button>
  </form>
  <button type="button" class="link" id="show-key" ${keyOpen ? 'hidden' : ''}>${keySignIn ? '使用管理密钥' : '用管理密钥找回'}</button>
  <span class="error" id="error" role="alert"></span>
  <p>登录后这台浏览器会保持登录，可在「设置 → 登录与访问」中随时撤销。</p>
</main>
<script>
  const next = ${json(input.next)}
  const recovery = ${json(!keySignIn)}
  const initialCode = ${json(input.code ?? null)}
  const $ = (id) => document.getElementById(id)
  const acknowledge = $('acknowledge')
  const error = $('error')
  const acknowledged = () => acknowledge === null || acknowledge.checked
  const fail = (message) => { error.textContent = message }
  const post = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message ?? '登录失败，请稍后重试。')
    return data
  }
  const needAcknowledge = () => {
    if (acknowledged()) return false
    fail('请先确认了解未加密连接的风险。')
    return true
  }
  const done = (target) => location.replace(target ?? next)

  // Waiting for a signed-in device to approve this one.
  let timer = null
  const stopWaiting = () => { if (timer !== null) clearInterval(timer); timer = null }
  const showChoices = () => {
    stopWaiting()
    $('waiting').hidden = true
    $('choices').hidden = false
  }
  const wait = (secret, text, qrSvg, code) => {
    stopWaiting()
    error.textContent = ''
    $('choices').hidden = true
    $('code-form').hidden = true
    $('waiting').hidden = false
    $('waiting-text').textContent = text
    $('qr').hidden = qrSvg === undefined
    if (qrSvg !== undefined) $('qr').innerHTML = qrSvg
    $('shown-code').hidden = code === undefined
    if (code !== undefined) $('shown-code').textContent = code
    timer = setInterval(async () => {
      try {
        const result = await post('/api/management/login-requests/poll', { secret })
        if (result.state === 'approved') { stopWaiting(); done(); return }
        if (result.state === 'rejected') { showChoices(); fail('登录被拒绝了。') }
        if (result.state === 'expired') { showChoices(); fail('登录码已过期，请重新开始。') }
      } catch (cause) {
        showChoices()
        fail(cause.message)
      }
    }, 2000)
  }
  $('cancel').addEventListener('click', () => { showChoices(); error.textContent = '' })

  $('scan').addEventListener('click', async () => {
    if (needAcknowledge()) return
    try {
      const created = await post('/api/management/login-requests', { acknowledgeInsecure: acknowledged() })
      wait(created.secret, '用已登录的手机扫描二维码，或在已登录设备的「设置 → 登录与访问」输入上面的登录码，然后确认。', created.qrSvg, created.code)
    } catch (cause) {
      fail(cause.message)
    }
  })

  const claim = async (code) => {
    if (needAcknowledge()) return
    try {
      const claimed = await post('/api/management/login-requests/claim', { code, acknowledgeInsecure: acknowledged() })
      wait(claimed.secret, '请在显示二维码的设备上确认这台设备登录。')
    } catch (cause) {
      fail(cause.message)
    }
  }
  $('enter-code').addEventListener('click', () => {
    $('code-form').hidden = false
    $('code').focus()
  })
  $('code-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void claim($('code').value)
  })
  if (initialCode !== null) {
    $('code').value = initialCode
    if (acknowledged()) void claim(initialCode)
    else { $('code-form').hidden = false; fail('确认了解风险后点「继续」。') }
  }

  const fromBase64Url = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)), (char) => char.charCodeAt(0))
  const toBase64Url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  $('passkey')?.addEventListener('click', async () => {
    error.textContent = ''
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
          clientExtensionResults: credential.getClientExtensionResults(),
          ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            ...(response.userHandle ? { userHandle: toBase64Url(response.userHandle) } : {}),
          },
        },
      })
      done()
    } catch (cause) {
      fail(cause?.name === 'NotAllowedError' ? '通行密钥没有完成，可以重试或换一种方式。' : cause.message)
    }
  })

  const key = $('key')
  $('show-key').addEventListener('click', () => {
    $('key-form').hidden = false
    $('show-key').hidden = true
    key.focus()
  })
  $('key-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (key.value === '' || needAcknowledge()) return
    $('key-submit').disabled = true
    error.textContent = ''
    try {
      const result = await post('/api/management/login', {
        managementKey: key.value,
        acknowledgeInsecure: acknowledged(),
        recovery,
      })
      done(result.next)
      return
    } catch (cause) {
      fail(cause.message)
    }
    key.value = ''
    $('key-submit').disabled = false
    key.focus()
  })
</script>
</body>
</html>
`
}

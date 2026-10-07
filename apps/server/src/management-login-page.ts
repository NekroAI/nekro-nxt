/**
 * The anonymous browser login page of the management edge. It is self-contained (inline style and script) and loads
 * no product or extension code, so the management key is typed into a page that nothing else runs in.
 */
export const managementLoginPage = (input: { readonly secure: boolean; readonly next: string }): string => {
  const next = JSON.stringify(input.next).replace(/</gu, '\\u003c')
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
  input[type=password] {
    width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px;
    background: transparent; color: var(--fg); font: inherit;
  }
  input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .warning {
    display: grid; gap: 8px; padding: 12px; border-radius: 10px;
    background: var(--warn-bg); color: var(--warn);
  }
  .warning label { display: flex; align-items: center; gap: 8px; font-weight: 500; color: var(--fg); }
  button {
    padding: 9px 12px; border: 0; border-radius: 10px; background: var(--accent); color: var(--accent-fg);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .error { color: var(--bad); min-height: 1.6em; }
</style>
</head>
<body>
<main>
  <header><img src="/brand/mark.svg" alt="" /><h1>登录 NekroNXT</h1></header>
  <p>输入部署时设置的管理密钥。这台浏览器会保持登录 30 天，可在「设置 → 登录设备」中随时撤销。</p>
  <form id="login" autocomplete="off">
    <div style="display:grid;gap:14px">
      ${
        input.secure
          ? ''
          : `<div class="warning" role="note">
        <span>当前连接未加密。管理密钥和登录状态在网络中以明文传输，可能被截获。公网访问请使用 HTTPS，或通过反向代理启用 HTTPS。</span>
        <label><input type="checkbox" id="acknowledge" /> 我了解风险，继续使用</label>
      </div>`
      }
      <label>管理密钥<input type="password" id="key" required autofocus /></label>
      <span class="error" id="error" role="alert"></span>
      <button type="submit" id="submit">登录</button>
    </div>
  </form>
</main>
<script>
  const next = ${next}
  const form = document.getElementById('login')
  const key = document.getElementById('key')
  const acknowledge = document.getElementById('acknowledge')
  const submit = document.getElementById('submit')
  const error = document.getElementById('error')
  const sync = () => { submit.disabled = key.value === '' || (acknowledge !== null && !acknowledge.checked) }
  key.addEventListener('input', sync)
  acknowledge?.addEventListener('change', sync)
  sync()
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submit.disabled = true
    error.textContent = ''
    try {
      const response = await fetch('/api/management/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ managementKey: key.value, acknowledgeInsecure: acknowledge?.checked === true }),
      })
      if (response.ok) { location.replace(next); return }
      const body = await response.json().catch(() => null)
      error.textContent = body?.error?.message ?? '登录失败，请稍后重试。'
    } catch {
      error.textContent = '无法连接服务，请检查网络后重试。'
    }
    key.value = ''
    sync()
    key.focus()
  })
</script>
</body>
</html>
`
}

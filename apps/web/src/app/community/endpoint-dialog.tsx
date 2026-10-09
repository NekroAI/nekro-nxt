import { HostApiContracts, type CommunityEndpoint } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { callHostApi } from '../../host-api-client.js'
import { Banner, Button, Dialog, Field, Input, Switch, toast } from '../../ui-kit/index.js'
import { ENVIRONMENT_LABEL, errorMessage } from './community-model.js'
import styles from './community.module.css'

/** 局域网 HTTP 需要确认风险；本机与 HTTPS 不需要。与 Host 的判断一致，只用于提前显示确认开关。 */
const looksInsecure = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/**
 * 更改社区地址。大多数用户一直使用正式社区，这里只给需要连接测试站或本机社区开发服务的成员使用，
 * 因此入口放在「社区 → 账号」底部，不单独占一个设置分区。每个地址分别保存登录。
 */
export function CommunityEndpointDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onChanged: () => void
}) {
  const [endpoint, setEndpoint] = useState<CommunityEndpoint>()
  const [draft, setDraft] = useState('')
  const [acknowledge, setAcknowledge] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'reset'>('')
  const [result, setResult] = useState<{ ok: boolean; message: string }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setResult(undefined)
    setAcknowledge(false)
    callHostApi(HostApiContracts.getCommunityEndpoint, {}, undefined)
      .then((value) => {
        setEndpoint(value)
        setDraft(value.url)
        setError(undefined)
      })
      .catch((caught: unknown) => setError(errorMessage(caught)))
  }, [open])

  const insecure = looksInsecure(draft)
  const run = async (kind: Exclude<typeof busy, ''>, action: () => Promise<void>) => {
    setBusy(kind)
    try {
      await action()
    } catch (caught) {
      setResult({ ok: false, message: errorMessage(caught) })
    } finally {
      setBusy('')
    }
  }
  const apply = (saved: CommunityEndpoint, message: string) => {
    setEndpoint(saved)
    setDraft(saved.url)
    onChanged()
    onOpenChange(false)
    toast(message)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="更改社区地址"
      actions={
        endpoint ? (
          <>
            {endpoint.source === 'setting' ? (
              <Button
                variant="ghost"
                busy={busy === 'reset'}
                onClick={() =>
                  void run('reset', async () =>
                    apply(
                      await callHostApi(
                        HostApiContracts.updateCommunityEndpoint,
                        {},
                        { url: null, acknowledgeInsecure: false },
                      ),
                      '已恢复默认社区地址',
                    ),
                  )
                }
              >
                恢复默认
              </Button>
            ) : null}
            <Button
              busy={busy === 'test'}
              disabled={!draft.trim() || (insecure && !acknowledge)}
              onClick={() =>
                void run('test', async () => {
                  const tested = await callHostApi(
                    HostApiContracts.testCommunityEndpoint,
                    {},
                    { url: draft.trim(), acknowledgeInsecure: acknowledge },
                  )
                  setResult({
                    ok: tested.ok,
                    message: tested.environment
                      ? `${tested.message}（${ENVIRONMENT_LABEL[tested.environment]}）`
                      : tested.message,
                  })
                })
              }
            >
              测试连接
            </Button>
            <Button
              variant="primary"
              busy={busy === 'save'}
              disabled={!draft.trim() || draft.trim() === endpoint.url || (insecure && !acknowledge)}
              onClick={() =>
                void run('save', async () =>
                  apply(
                    await callHostApi(
                      HostApiContracts.updateCommunityEndpoint,
                      {},
                      { url: draft.trim(), acknowledgeInsecure: acknowledge },
                    ),
                    '已切换社区地址',
                  ),
                )
              }
            >
              保存
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <Banner tone="bad">{error}</Banner>
      ) : !endpoint ? (
        <p className={styles.faint}>正在读取社区地址…</p>
      ) : (
        <>
          <p className={styles.faint}>
            连接测试站或本机开发的社区时才需要修改。每个地址分别登录。
            {endpoint.source === 'environment' ? '当前地址来自环境变量 NEKRO_COMMUNITY_URL。' : ''}
          </p>
          <Field label="社区地址" hint={`默认 ${endpoint.defaultUrl}，只填协议、主机与端口。`}>
            <Input
              value={draft}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value)
                setResult(undefined)
              }}
              placeholder={endpoint.defaultUrl}
            />
          </Field>
          {insecure ? (
            <Banner tone="warn">
              这是未加密的局域网地址，扩展包会明文传输，只在你信任的网络里使用。
              <span className={styles.inlineSwitch}>
                <Switch checked={acknowledge} onCheckedChange={setAcknowledge} label="我了解风险" />
                我了解风险
              </span>
            </Banner>
          ) : null}
          {result ? <Banner tone={result.ok ? 'ok' : 'bad'}>{result.message}</Banner> : null}
        </>
      )}
    </Dialog>
  )
}

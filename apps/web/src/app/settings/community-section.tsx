import { HostApiContracts, type CommunityEndpoint } from '@nekro-nxt/contracts'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { callHostApi } from '../../host-api-client.js'
import {
  Banner,
  Button,
  Field,
  Input,
  PropertyGroup,
  PropertyList,
  PropertyRow,
  Switch,
  toast,
} from '../../ui-kit/index.js'
import { ENVIRONMENT_LABEL, errorMessage } from '../community/community-model.js'
import styles from './settings.module.css'

const SOURCE_LABEL: Readonly<Record<CommunityEndpoint['source'], string>> = {
  setting: '在这里设置',
  environment: '来自环境变量 NEKRO_COMMUNITY_URL',
  default: '默认的正式社区',
}

/** 局域网 HTTP 需要确认风险；本机与 HTTPS 不需要。与 Host 的判断一致，只用于提前显示确认开关。 */
const looksInsecure = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/** 社区地址：组织成员可以连接测试站或本机社区开发服务调试。账号登录在「社区 → 账号」。 */
export function CommunitySection() {
  const [endpoint, setEndpoint] = useState<CommunityEndpoint>()
  const [draft, setDraft] = useState('')
  const [acknowledge, setAcknowledge] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'reset'>('')
  const [result, setResult] = useState<{ ok: boolean; message: string }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    callHostApi(HostApiContracts.getCommunityEndpoint, {}, undefined)
      .then((value) => {
        setEndpoint(value)
        setDraft(value.url)
      })
      .catch((caught: unknown) => setError(errorMessage(caught)))
  }, [])

  const insecure = looksInsecure(draft)
  const run = async (kind: Exclude<typeof busy, ''>, action: () => Promise<void>) => {
    setBusy(kind)
    try {
      await action()
    } catch (caught) {
      toast(errorMessage(caught), { tone: 'bad' })
    } finally {
      setBusy('')
    }
  }

  if (error) return <Banner tone="bad">{error}</Banner>
  if (!endpoint) return <p className={styles.notice}>正在读取社区设置…</p>

  return (
    <>
      <PropertyGroup
        title="社区地址"
        description="NekroNXT 从这里浏览、安装与发布扩展。组织成员调试时可以改为测试站或本机社区开发服务；每个地址分别保存登录。"
      >
        <PropertyList>
          <PropertyRow label="当前地址">
            <span className={styles.faint}>{endpoint.url}</span>
          </PropertyRow>
          <PropertyRow label="来源">
            <span className={styles.faint}>{SOURCE_LABEL[endpoint.source]}</span>
          </PropertyRow>
        </PropertyList>
      </PropertyGroup>
      <Field label="新地址" hint={`默认 ${endpoint.defaultUrl}。只填协议、主机与端口。`}>
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
          这是未加密的 HTTP 地址，只允许局域网地址。扩展包会以明文在网络中传输，只在你信任的网络中使用。
          <div className={styles.actions}>
            <Switch checked={acknowledge} onCheckedChange={setAcknowledge} label="我了解风险" />
            <span>我了解风险</span>
          </div>
        </Banner>
      ) : null}
      {result ? <Banner tone={result.ok ? 'ok' : 'bad'}>{result.message}</Banner> : null}
      <div className={styles.actions}>
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
            void run('save', async () => {
              const saved = await callHostApi(
                HostApiContracts.updateCommunityEndpoint,
                {},
                { url: draft.trim(), acknowledgeInsecure: acknowledge },
              )
              setEndpoint(saved)
              setDraft(saved.url)
              toast('已切换社区地址')
            })
          }
        >
          保存
        </Button>
        {endpoint.source === 'setting' ? (
          <Button
            variant="ghost"
            busy={busy === 'reset'}
            onClick={() =>
              void run('reset', async () => {
                const saved = await callHostApi(
                  HostApiContracts.updateCommunityEndpoint,
                  {},
                  { url: null, acknowledgeInsecure: false },
                )
                setEndpoint(saved)
                setDraft(saved.url)
                setResult(undefined)
                toast('已恢复默认地址')
              })
            }
          >
            恢复默认
          </Button>
        ) : null}
      </div>
      <p className={styles.notice}>
        社区账号的登录与退出在{' '}
        <Link to="/community/account" className={styles.link}>
          社区 → 账号
        </Link>
        。
      </p>
    </>
  )
}

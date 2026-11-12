import { EllipsisVertical, Share, SquarePlus } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { openInstallPrompt, useHomeScreen, type HomeScreenState } from '../../home-screen.js'
import { useProductStore } from '../../product-runtime.js'
import { Banner, Button, Dialog, Pressable, usePhone } from '../../ui-kit/index.js'
import systemStyles from '../system/system.module.css'
import styles from './shell.module.css'

const HINT_KEY = 'nekro-nxt.home-screen-hint'
const HTTPS_GUIDE = 'https://nxt.nekro.ai/docs/install/https#通过反向代理使用-https'

const readDismissed = (): boolean => {
  try {
    return window.localStorage.getItem(HINT_KEY) === 'dismissed'
  } catch {
    return false
  }
}

const saveDismissed = (): void => {
  try {
    window.localStorage.setItem(HINT_KEY, 'dismissed')
  } catch {
    // Without storage the hint comes back next time, which is all that is lost.
  }
}

/** The steps dialog, opened from the hint or the side menu; one per page. */
let guideOpen = false
const guideListeners = new Set<() => void>()
const setGuideOpen = (open: boolean) => {
  guideOpen = open
  guideListeners.forEach((listener) => listener())
}

/** Chrome opens its own install dialog; everywhere else the page shows how to add it. */
const startInstall = async (state: HomeScreenState): Promise<void> => {
  if (state === 'prompt' && (await openInstallPrompt())) return
  setGuideOpen(true)
}

/** 「添加到主屏幕」 in the phone's side menu, while this page is open in a browser. */
export function HomeScreenMenuItem({ onChosen }: { readonly onChosen: () => void }) {
  const state = useHomeScreen()
  if (state === undefined || state === 'installed') return null
  return (
    <Pressable
      className={styles.menuItem}
      onClick={() => {
        onChosen()
        void startInstall(state)
      }}
    >
      <SquarePlus aria-hidden="true" strokeWidth={1.7} />
      <span>添加到主屏幕</span>
    </Pressable>
  )
}

/** Offers adding to the home screen once on a phone browser that can, and holds the steps dialog. */
export function HomeScreenHint() {
  const phone = usePhone()
  const state = useHomeScreen()
  const ready = useProductStore((store) => store.host.status === 'ready')
  const [dismissed, setDismissed] = useState(readDismissed)
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches)
  const open = useSyncExternalStore(
    (listener) => {
      guideListeners.add(listener)
      return () => guideListeners.delete(listener)
    },
    () => guideOpen,
  )
  // Only on a phone in the hand; a narrow window on a computer keeps it in the side menu.
  const offered = phone && touch && ready && !dismissed && (state === 'prompt' || state === 'apple' || state === 'menu')
  const close = () => {
    saveDismissed()
    setDismissed(true)
  }
  return (
    <>
      {offered ? (
        <div className={systemStyles.shellNotice} data-home-screen-hint="">
          <Banner
            tone="info"
            action={
              <span className={styles.hintActions}>
                <Button size="small" variant="ghost" onClick={close}>
                  不用了
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => {
                    close()
                    void startInstall(state)
                  }}
                >
                  添加
                </Button>
              </span>
            }
          >
            添加到主屏幕，像应用一样全屏打开
          </Banner>
        </div>
      ) : null}
      <Dialog open={open} onOpenChange={setGuideOpen} title="添加到主屏幕" closeLabel="关闭">
        {state === undefined ? null : <HomeScreenSteps state={state} />}
      </Dialog>
    </>
  )
}

function HomeScreenSteps({ state }: { readonly state: HomeScreenState }) {
  if (state === 'insecure')
    return (
      <div className={styles.homeSteps}>
        <p>
          这个地址不能添加到主屏幕。浏览器只为受信任的 HTTPS 地址安装应用，局域网 HTTP 和自签名证书都不行。
          <a href={HTTPS_GUIDE} target="_blank" rel="noreferrer">
            怎么设置 HTTPS
          </a>
        </p>
        <p>
          安卓手机也可以
          <a href="https://nxt.nekro.ai/download" target="_blank" rel="noreferrer">
            下载安卓应用
          </a>
          ，局域网地址也能连接。
        </p>
      </div>
    )
  if (state === 'apple')
    return (
      <ol className={styles.homeSteps}>
        <li>
          点浏览器的分享按钮
          <Share className={styles.inlineIcon} aria-label="分享" />
          ，Safari 在底部，iPad 在右上角
        </li>
        <li>在菜单里选「添加到主屏幕」，没看到就往下滑</li>
        <li>从主屏幕的 NekroNXT 图标打开。它和浏览器不共享登录，第一次要再登录一次</li>
      </ol>
    )
  return (
    <ol className={styles.homeSteps}>
      <li>
        点浏览器右上角的菜单
        <EllipsisVertical className={styles.inlineIcon} aria-label="菜单" />
      </li>
      <li>选「安装应用」或「添加到主屏幕」</li>
      <li>从主屏幕的 NekroNXT 图标打开</li>
    </ol>
  )
}

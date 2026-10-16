import { Plus, Cable } from 'lucide-react'
import { Ambient, Button, RevealText } from '../../ui-kit/index.js'
import { useGo } from '../model/nav.js'
import styles from './welcome.module.css'

/** What the overview shows before the first agent exists (05 §2.2 low-frequency moment; journey §6.1). */
export function Welcome() {
  const go = useGo()
  return (
    <Ambient className={styles.welcome}>
      <div className={styles.body}>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>NekroNXT</span>
          <h2 className={styles.title}>
            <RevealText text="欢迎使用 NekroNXT" />
          </h2>
          <p className={styles.lead}>创建一个智能体，选好模型，就能在它的频道里直接聊天。之后再把它接入你的群聊。</p>
          <div className={styles.actions}>
            <Button variant="primary" icon={<Plus />} onClick={() => go('/agents/new')}>
              创建智能体
            </Button>
            <Button icon={<Cable />} onClick={() => go('/wiring/new')}>
              添加平台账号
            </Button>
          </div>
        </div>
        <img className={styles.art} src="/brand/illustrations/welcome.png" alt="" />
      </div>
    </Ambient>
  )
}

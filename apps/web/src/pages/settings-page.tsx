import { LlmProviderSettings } from '../llm-settings.js'
import { DshExtensionSettings } from '../dsh-extension-settings.js'
import { PageHeader } from '../components/product-feedback.js'
import { useProductStore, type ThemeChoice } from '../product-store.js'
import { Button, SelectField, StageCrossfade, StatusBadge, SwitchField } from '../ui-kit/index.js'
import { useUiPreferences, type ContrastChoice } from '../ui-preferences.js'
import { useSearchParams } from 'react-router-dom'
import { useNxtNavigate } from '../shell/nxt-link.js'
import { AboutPage } from './about-page.js'
import styles from './product-pages.module.css'

function SystemExtensionsPanel() {
  const adapters = useProductStore((state) => state.connectionAdapters)
  const navigate = useNxtNavigate()
  return (
    <section className={styles.settingsSection} data-settings-content="">
      <div className={styles.systemAdapterIntro}>
        <div className={styles.sectionHeading}>已安装适配器</div>
        <p className={styles.secondaryText}>接入聊天平台。前往「连接」添加账号。</p>
      </div>
      <div className={styles.systemAdapterGrid}>
        {adapters.map((adapter) => (
          <article className={styles.systemAdapterCard} key={adapter.key}>
            <header>
              <div className={styles.sectionHeading}>{adapter.displayName}</div>
              <StatusBadge tone="success">已安装</StatusBadge>
            </header>
            <p className={styles.secondaryText}>{adapter.description}</p>
            {adapter.userCreatable ? (
              <Button onClick={() => void navigate(`/connections?create=1&adapter=${encodeURIComponent(adapter.key)}`)}>
                添加账号
              </Button>
            ) : (
              <StatusBadge tone="info">当前设备托管</StatusBadge>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

const isThemeChoice = (value: string): value is ThemeChoice =>
  value === 'system' || value === 'light' || value === 'dark'
const isContrastChoice = (value: string): value is ContrastChoice =>
  value === 'system' || value === 'standard' || value === 'more'

export function SettingsPage() {
  const productMetadata = useProductStore((state) => state.productMetadata)
  const [searchParams] = useSearchParams()
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const reducedTransparency = useUiPreferences((state) => state.appearance.reducedTransparency)
  const contrast = useUiPreferences((state) => state.appearance.contrast)
  const inspectorCollapsed = useUiPreferences((state) => state.layout.inspectorCollapsed)
  const requestedTab = searchParams.get('tab')
  const activeTab =
    requestedTab === 'appearance' ||
    requestedTab === 'dsh-extensions' ||
    requestedTab === 'system-extensions' ||
    requestedTab === 'about'
      ? requestedTab
      : 'models'
  const title =
    activeTab === 'appearance'
      ? '外观'
      : activeTab === 'dsh-extensions'
        ? 'DSH 扩展'
        : activeTab === 'system-extensions'
          ? '系统扩展'
          : activeTab === 'about'
            ? '关于'
            : '模型供应商'

  return (
    <div className={[styles.page, styles.settingsPage].join(' ')} data-product-page="settings">
      <StageCrossfade swapKey={activeTab}>
        <PageHeader title={title} quiet />
        {activeTab === 'models' ? <LlmProviderSettings /> : null}
        {activeTab === 'dsh-extensions' ? <DshExtensionSettings /> : null}
        {activeTab === 'system-extensions' ? <SystemExtensionsPanel /> : null}
        {activeTab === 'about' ? <AboutPage metadata={productMetadata} /> : null}
        {activeTab === 'appearance' ? (
          <section className={styles.settingsSection} data-settings-content="">
            <div className={styles.appearanceSignature} aria-label="月潮观测所品牌主题">
              <img src="/brand/mark.svg" alt="" aria-hidden="true" />
              <div>
                <strong>月潮观测所</strong>
                <small>月潮靛构成稳定工作面，流明蓝标记焦点，黄铜节点标记校准。</small>
              </div>
              <span className={styles.appearanceSwatches} aria-hidden="true">
                <i data-tone="moon" />
                <i data-tone="lumen" />
                <i data-tone="brass" />
              </span>
            </div>
            <div className={styles.settingsGroup}>
              <div className={styles.sectionHeading}>主题与可读性</div>
              <SelectField
                label="主题"
                value={theme}
                onValueChange={(value) => {
                  if (isThemeChoice(value)) useProductStore.getState().setTheme(value)
                }}
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                ]}
              />
              <SwitchField
                label="减少动态效果"
                description="关闭页面衔接、选中块滑动和对话框过渡。"
                checked={reducedMotion}
                onCheckedChange={(enabled) => useProductStore.getState().setReducedMotion(enabled)}
              />
              <SwitchField
                label="减少透明效果"
                description="将浮层、侧栏和状态背景改为更明确的实色与边框。"
                checked={reducedTransparency}
                onCheckedChange={(enabled) => useUiPreferences.getState().setReducedTransparency(enabled)}
              />
              <SelectField
                label="对比度"
                value={contrast}
                onValueChange={(value) => {
                  if (isContrastChoice(value)) useUiPreferences.getState().setContrast(value)
                }}
                options={[
                  { value: 'system', label: '跟随系统' },
                  { value: 'standard', label: '标准' },
                  { value: 'more', label: '更高对比度' },
                ]}
              />
            </div>
            <div className={styles.settingsGroup}>
              <div className={styles.sectionHeading}>工作区布局</div>
              <SwitchField
                label="默认隐藏检查器"
                description="打开频道或智能体工作台时优先显示主画布；主画布右边缘的检查器按钮可随时重新展开。"
                checked={inspectorCollapsed}
                onCheckedChange={(enabled) => useUiPreferences.getState().setInspectorCollapsed(enabled)}
              />
              <Button onClick={() => useUiPreferences.getState().resetLayout()}>恢复默认分栏</Button>
            </div>
          </section>
        ) : null}
      </StageCrossfade>
    </div>
  )
}

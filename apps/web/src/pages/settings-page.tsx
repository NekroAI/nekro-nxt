import { LlmProviderSettings } from '../llm-settings.js'
import { DshExtensionSettings } from '../dsh-extension-settings.js'
import { PageHeader } from '../components/product-feedback.js'
import { useProductStore, type ThemeChoice } from '../product-store.js'
import { Button, SelectField, SwitchField } from '../ui-kit/index.js'
import { useUiPreferences, type ContrastChoice } from '../ui-preferences.js'
import { useSearchParams } from 'react-router-dom'
import styles from './product-pages.module.css'

const isThemeChoice = (value: string): value is ThemeChoice =>
  value === 'system' || value === 'light' || value === 'dark'
const isContrastChoice = (value: string): value is ContrastChoice =>
  value === 'system' || value === 'standard' || value === 'more'

export function SettingsPage() {
  const [searchParams] = useSearchParams()
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const reducedTransparency = useUiPreferences((state) => state.appearance.reducedTransparency)
  const contrast = useUiPreferences((state) => state.appearance.contrast)
  const inspectorCollapsed = useUiPreferences((state) => state.layout.inspectorCollapsed)
  const requestedTab = searchParams.get('tab')
  const activeTab = requestedTab === 'appearance' || requestedTab === 'dsh-extensions' ? requestedTab : 'models'
  const title = activeTab === 'appearance' ? '外观' : activeTab === 'dsh-extensions' ? 'DSH 扩展' : '模型供应商'

  return (
    <div className={styles.page}>
      <PageHeader title={title} />
      {activeTab === 'models' ? <LlmProviderSettings /> : null}
      {activeTab === 'dsh-extensions' ? <DshExtensionSettings /> : null}
      {activeTab === 'appearance' ? (
        <section className={styles.settingsSection}>
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
              description="减少页面和浮层过渡，保留必要的状态反馈。"
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
              description="打开频道或智能体工作台时优先显示主画布；页头右侧图标可随时重新展开。"
              checked={inspectorCollapsed}
              onCheckedChange={(enabled) => useUiPreferences.getState().setInspectorCollapsed(enabled)}
            />
            <Button onClick={() => useUiPreferences.getState().resetLayout()}>恢复默认分栏</Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

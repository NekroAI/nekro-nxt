import { LlmProviderSettings } from '../llm-settings.js'
import { DshExtensionSettings } from '../dsh-extension-settings.js'
import { PageHeader } from '../components/product-feedback.js'
import { useProductStore, type ThemeChoice } from '../product-store.js'
import { SelectField, SwitchField, Tabs } from '../ui-kit/index.js'
import { useSearchParams } from 'react-router-dom'
import styles from './product-pages.module.css'

const isThemeChoice = (value: string): value is ThemeChoice =>
  value === 'system' || value === 'light' || value === 'dark'

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)
  const requestedTab = searchParams.get('tab')
  const activeTab = requestedTab === 'appearance' || requestedTab === 'dsh-extensions' ? requestedTab : 'models'

  return (
    <div className={styles.page}>
      <PageHeader title="设置" />
      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          if (value === 'models') next.delete('tab')
          else next.set('tab', value)
          setSearchParams(next, { replace: true })
        }}
      >
        <Tabs.List aria-label="设置分类">
          <Tabs.Trigger value="models">模型供应商</Tabs.Trigger>
          <Tabs.Trigger value="dsh-extensions">DSH 扩展</Tabs.Trigger>
          <Tabs.Trigger value="appearance">外观</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="models">
          <LlmProviderSettings />
        </Tabs.Content>
        <Tabs.Content value="dsh-extensions">
          <DshExtensionSettings />
        </Tabs.Content>
        <Tabs.Content value="appearance">
          <section className={styles.settingsSection}>
            <div className={styles.sectionHeading}>外观</div>
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
          </section>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

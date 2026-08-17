import { LlmProviderSettings } from '../llm-settings.js'
import { PageHeader } from '../components/product-feedback.js'
import { useProductStore, type ThemeChoice } from '../product-store.js'
import { SelectField, SwitchField, Tabs } from '../ui-kit/index.js'
import styles from './product-pages.module.css'

export function SettingsPage() {
  const theme = useProductStore((state) => state.theme)
  const reducedMotion = useProductStore((state) => state.reducedMotion)

  return (
    <div className={styles.page}>
      <PageHeader title="设置" />
      <Tabs.Root defaultValue="models">
        <Tabs.List aria-label="设置分类">
          <Tabs.Trigger value="models">模型供应商</Tabs.Trigger>
          <Tabs.Trigger value="appearance">外观</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="models">
          <LlmProviderSettings />
        </Tabs.Content>
        <Tabs.Content value="appearance">
          <section className={styles.settingsSection}>
            <div className={styles.sectionHeading}>外观</div>
            <SelectField
              label="主题"
              value={theme}
              onValueChange={(value) => useProductStore.getState().setTheme(value as ThemeChoice)}
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

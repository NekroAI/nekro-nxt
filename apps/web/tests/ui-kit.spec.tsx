import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Button,
  DialogLayout,
  Field,
  IconButton,
  Input,
  NxtMotionProvider,
  SelectField,
  SwitchField,
  Tabs,
  Textarea,
  Tooltip,
} from '../src/ui-kit/index.tsx'
import { canCloseDialog } from '../src/ui-kit/dialog-policy.ts'
import { ModalLayerRegistry } from '../src/ui-kit/layers.ts'

describe('ui-kit control semantics', () => {
  it('keeps ordinary buttons out of surrounding form submission by default', () => {
    const markup = renderToStaticMarkup(
      <NxtMotionProvider reducedMotion>
        <Tooltip.Provider>
          <Button>普通操作</Button>
          <Button type="submit">提交</Button>
          <IconButton label="更多操作">
            <span>+</span>
          </IconButton>
          <Button loading loadingLabel="正在保存">
            保存
          </Button>
          <Button loadingLabel="不应显示">保留正文</Button>
        </Tooltip.Provider>
      </NxtMotionProvider>,
    )

    expect(markup).toContain('<button type="button"')
    expect(markup).toContain('<button type="submit"')
    expect(markup).toContain('aria-label="更多操作"')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('正在保存')
    expect(markup).toContain('保留正文')
    expect(markup).not.toContain('不应显示')
  })

  it('associates labels, hints, and errors with inputs and textareas', () => {
    const input = renderToStaticMarkup(
      <Field id="display-name" label="显示名称" hint="频道中可见" error="名称已存在">
        <Input />
      </Field>,
    )
    expect(input).toContain('for="display-name"')
    expect(input).toContain('id="display-name"')
    expect(input).toContain('aria-labelledby="display-name-label"')
    expect(input).toContain('aria-describedby="display-name-hint display-name-error"')
    expect(input).toContain('aria-errormessage="display-name-error"')
    expect(input).toContain('aria-invalid="true"')

    const textarea = renderToStaticMarkup(
      <Field id="persona" label="人设" hint="进入下一配置版本">
        <Textarea aria-describedby="external-note" />
      </Field>,
    )
    expect(textarea).toContain('aria-describedby="external-note persona-hint"')
  })

  it('gives switches a stable accessible name and description, including when disabled', () => {
    const markup = renderToStaticMarkup(
      <SwitchField
        id="dynamic-creation"
        label="动态创造"
        description="允许创建临时能力。"
        checked={false}
        disabled
        onCheckedChange={() => undefined}
      />,
    )

    expect(markup).toContain('role="switch"')
    expect(markup).toContain('id="dynamic-creation"')
    expect(markup).toContain('aria-labelledby="dynamic-creation-label"')
    expect(markup).toContain('aria-describedby="dynamic-creation-description"')
    expect(markup).toContain('disabled=""')
  })

  it('exposes select placeholder, disabled, helper, and error semantics', () => {
    const markup = renderToStaticMarkup(
      <SelectField
        id="model"
        label="模型"
        value=""
        placeholder="请选择模型"
        helper="只影响下一配置版本"
        error="请选择一个模型"
        disabled
        options={[{ value: 'model-a', label: '模型 A' }]}
        onValueChange={() => undefined}
      />,
    )

    expect(markup).toContain('请选择模型')
    expect(markup).toContain('aria-labelledby="model-label"')
    expect(markup).toContain('aria-describedby="model-hint model-error"')
    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('disabled=""')
  })

  it('provides tabs without leaking the Radix import into consumers', () => {
    const markup = renderToStaticMarkup(
      <Tabs.Root defaultValue="profile">
        <Tabs.List aria-label="智能体设置">
          <Tabs.Trigger value="profile">配置</Tabs.Trigger>
          <Tabs.Trigger value="channels">频道</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="profile">配置内容</Tabs.Content>
        <Tabs.Content value="channels">频道内容</Tabs.Content>
      </Tabs.Root>,
    )

    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('role="tab"')
    expect(markup).toContain('role="tabpanel"')
    expect(markup).toContain('data-nxt-tabs-indicator=""')
    expect(markup.match(/data-nxt-tabs-indicator/g)).toHaveLength(1)
    expect(markup).toContain('配置内容')
  })

  it('keeps dialog header, scroll body, and footer as independent regions', () => {
    const markup = renderToStaticMarkup(
      <DialogLayout title={<h2>确认操作</h2>} closeButton={<button type="button">关闭</button>} footer="底部操作">
        很长的内容
      </DialogLayout>,
    )

    expect(markup).toContain('data-nxt-dialog-region="header"')
    expect(markup).toContain('data-nxt-dialog-region="body"')
    expect(markup).not.toContain('tabindex="0"')
    expect(markup).toContain('data-nxt-dialog-region="footer"')

    const compact = renderToStaticMarkup(
      <DialogLayout title={<h2>危险确认</h2>} closeButton={<button type="button">关闭</button>} footer="底部操作" />,
    )
    expect(compact).not.toContain('data-nxt-dialog-region="body"')
  })
})

describe('modal layer registry', () => {
  it('places a newer overlay above every floating surface in the preceding modal', () => {
    const registry = new ModalLayerRegistry({ modalBase: 80, modalStep: 4, floatingBase: 60 })
    const unregisterFirst = registry.register('first')
    const first = registry.layerFor('first')
    registry.register('second')
    const second = registry.layerFor('second')

    expect(first).toEqual({ order: 0, overlay: 80, content: 81, floating: 82 })
    expect(second).toEqual({ order: 1, overlay: 84, content: 85, floating: 86 })
    expect(second?.overlay).toBeGreaterThan(first?.floating ?? Number.POSITIVE_INFINITY)
    expect(registry.topFloatingLayer()).toBe(second?.floating)

    unregisterFirst()
    expect(registry.layerFor('second')).toEqual({ order: 0, overlay: 80, content: 81, floating: 82 })
  })

  it('blocks every user close route while confirmation is pending', () => {
    expect(canCloseDialog(false, 'escape')).toBe(true)
    expect(canCloseDialog(true, 'escape')).toBe(false)
    expect(canCloseDialog(true, 'outside')).toBe(false)
    expect(canCloseDialog(true, 'close-button')).toBe(false)
    expect(canCloseDialog(true, 'cancel')).toBe(false)
  })
})

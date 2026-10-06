import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Banner,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Pressable,
  Select,
  Switch,
  Textarea,
} from '../src/ui-kit/index.ts'

describe('ui-kit control semantics', () => {
  it('keeps ordinary buttons out of surrounding form submission by default', () => {
    const markup = renderToStaticMarkup(
      <>
        <Button>普通操作</Button>
        <Button type="submit">提交</Button>
        <IconButton label="更多操作">
          <span>+</span>
        </IconButton>
        <Pressable>行</Pressable>
      </>,
    )
    expect(markup.match(/type="button"/gu)).toHaveLength(3)
    expect(markup).toContain('type="submit"')
    expect(markup).toContain('aria-label="更多操作"')
  })

  it('associates the label, hint and error with the single control of a field', () => {
    const hinted = renderToStaticMarkup(
      <Field label="名称" hint="频道里显示的名字">
        <Input />
      </Field>,
    )
    const id = /<input[^>]*id="([^"]+)"/u.exec(hinted)?.[1]
    expect(id).toBeTruthy()
    expect(hinted).toContain(`for="${id}"`)
    const describedBy = /aria-describedby="([^"]+)"/u.exec(hinted)?.[1]
    expect(describedBy).toBeTruthy()
    expect(hinted).toMatch(new RegExp(`id="${describedBy}"[^>]*>频道里显示的名字`, 'u'))

    const failed = renderToStaticMarkup(
      <Field label="说明" error="不能为空">
        <Textarea />
      </Field>,
    )
    expect(failed).toContain('aria-invalid="true"')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('不能为空')
  })

  it('gives a switch its accessible name, also when disabled', () => {
    const markup = renderToStaticMarkup(
      <Switch checked={false} onCheckedChange={() => undefined} label="允许主动发送" disabled />,
    )
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-label="允许主动发送"')
    expect(markup).toContain('disabled')
  })

  it('renders a select as a labelled combobox that shows the chosen label or the placeholder', () => {
    const options = [
      { value: '', label: '跟随主模型' },
      { value: 'vision', label: '识图模型' },
    ]
    const chosen = renderToStaticMarkup(<Select aria-label="识图模型" options={options} value="vision" />)
    expect(chosen).toContain('role="combobox"')
    expect(chosen).toContain('aria-label="识图模型"')
    expect(chosen).toContain('>识图模型<')
    // The empty value is a real option, not the placeholder.
    const empty = renderToStaticMarkup(<Select aria-label="识图" options={options} value="" placeholder="请选择" />)
    expect(empty).toContain('跟随主模型')
    const unknown = renderToStaticMarkup(
      <Select aria-label="识图" options={options} value="missing" placeholder="请选择" disabled />,
    )
    expect(unknown).toContain('请选择')
    expect(unknown).toContain('disabled')
  })

  it('announces problems as alerts and confirmations as status', () => {
    expect(renderToStaticMarkup(<Banner tone="bad">连接失败</Banner>)).toContain('role="alert"')
    expect(renderToStaticMarkup(<Banner tone="warn">即将过期</Banner>)).toContain('role="alert"')
    expect(renderToStaticMarkup(<Banner tone="ok">已保存</Banner>)).toContain('role="status"')
    expect(renderToStaticMarkup(<Banner tone="info">提示</Banner>)).toContain('role="status"')
  })

  it('keeps the empty-state title and its next step together', () => {
    const markup = renderToStaticMarkup(
      <EmptyState title="还没有频道" action={<Button>添加频道</Button>}>
        创建智能体会自动建立内置频道。
      </EmptyState>,
    )
    expect(markup).toContain('还没有频道')
    expect(markup).toContain('创建智能体会自动建立内置频道。')
    expect(markup).toContain('添加频道')
  })
})

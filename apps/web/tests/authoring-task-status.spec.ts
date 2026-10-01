import { describe, expect, it } from 'vitest'
import { authoringTaskPresentation } from '../src/authoring-task-status.js'

const client = { status: 'pending' }
const absent = { status: 'absent' }

describe('authoring task presentation', () => {
  it('names the task page when an interface candidate waits on a browser', () => {
    expect(authoringTaskPresentation({ status: 'awaiting-approval' })).toMatchObject({
      label: '等待确认运行',
      nextStep: { channel: expect.stringContaining('打开任务') as unknown },
    })
    expect(
      authoringTaskPresentation({ status: 'running', candidateAttempt: { state: 'loading-client', client } }),
    ).toMatchObject({ label: '等待界面验证' })
  })

  it('keeps Host-only startup as agent work', () => {
    const presentation = authoringTaskPresentation({
      status: 'running',
      candidateAttempt: { state: 'starting-host', client: absent },
    })
    expect(presentation.label).toBe('正在开发')
    expect(presentation.nextStep).toBeUndefined()
  })
})

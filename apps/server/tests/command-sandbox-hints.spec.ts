import { describe, expect, it } from 'vitest'
import { sandboxHint, sandboxProblem } from '../src/command-sandbox-hints.ts'

describe('command sandbox hints', () => {
  it('tells a sandbox that cannot start from a refused file operation and an unanswerable approval', () => {
    expect(
      sandboxProblem(
        '[sandbox: the sandbox runner itself failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure]',
      ),
    ).toBe('unavailable')
    expect(sandboxProblem('windows-acl-run: SetNamedSecurityInfo failed (5)')).toBe('unavailable')
    expect(
      sandboxProblem('sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host'),
    ).toBe('unavailable')
    expect(sandboxProblem('rm: cannot remove x\n[sandbox: file access denied under workspace-write mode]')).toBe(
      'denied',
    )
    expect(
      sandboxProblem(
        'sandbox escalation to "danger-full-access" requires approval, but no approval service is composed',
      ),
    ).toBe('approval')
    expect(sandboxProblem('mv: cannot stat a.txt: No such file or directory')).toBeUndefined()
  })

  it('says what to ask the administrator, with the likely cause on each system', () => {
    const windows = sandboxHint('unavailable', 'win32')
    expect(windows).toContain('不是命令本身的问题')
    expect(windows).toContain('NTFS')
    expect(windows).toContain('「完整访问」')
    expect(sandboxHint('unavailable', 'linux')).toContain('bubblewrap')
    expect(sandboxHint('unavailable', 'linux')).not.toContain('设置 → 存储')
    expect(sandboxHint('denied', 'darwin')).toContain('只允许在你的工作区里')
    expect(sandboxHint('approval', 'win32')).toContain('告诉管理员')
  })
})

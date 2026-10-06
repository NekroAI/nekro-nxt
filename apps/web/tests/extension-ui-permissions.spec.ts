import { HostUiPermissionSchema } from '@nekro-nxt/contracts'
import { describe, expect, it } from 'vitest'
import { PERMISSION_LABELS, permissionLines } from '../src/extension-ui/permissions.ts'

describe('extension permission wording', () => {
  it('labels every permission the contract allows', () => {
    for (const permission of HostUiPermissionSchema.options) expect(PERMISSION_LABELS[permission]).toBeTruthy()
  })

  it('lists permissions and names each network origin instead of a generic network line', () => {
    expect(
      permissionLines({
        permissions: ['agents.read', 'network.request'],
        networkOrigins: ['https://api.example.invalid'],
      }),
    ).toEqual(['查看智能体', '访问 https://api.example.invalid'])
    expect(permissionLines(undefined)).toEqual([])
  })
})

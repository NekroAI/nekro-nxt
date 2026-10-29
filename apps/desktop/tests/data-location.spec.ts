import { describe, expect, it } from 'vitest'
import {
  dataLocationFiles,
  parseDataLocationPointer,
  resolveDesktopUserData,
  serializeDataLocationPointer,
} from '../src/data-location.ts'
import { getDesktopDistribution } from '../src/distribution.ts'

const preview = getDesktopDistribution('preview')
const files = dataLocationFiles('/application-data', preview)

const resolve = (override: string | undefined, texts: Record<string, string>, failing?: string) =>
  resolveDesktopUserData({
    appDataRoot: '/application-data',
    distribution: preview,
    override,
    readText: (file) => {
      if (file === failing) throw new Error('EACCES: permission denied')
      return texts[file]
    },
  })

describe('Desktop data location', () => {
  it('keeps the pointer and the move record beside the default userData, outside every data directory', () => {
    expect(files).toEqual({
      pointer: '/application-data/NekroNxt Preview.data-location.json',
      record: '/application-data/NekroNxt Preview.data-move.json',
      migrationSession: '/application-data/NekroNxt Preview.data-move-session',
    })
  })

  it('resolves the environment variable first, then the pointer, then the default', () => {
    const pointer = { [files.pointer]: serializeDataLocationPointer('/volumes/fast/NekroNXT') }
    expect(resolve('/isolated/NekroNxt', pointer)).toEqual({
      root: '/isolated/NekroNxt',
      source: 'environment',
      defaultRoot: '/application-data/NekroNxt Preview',
    })
    expect(resolve(undefined, pointer)).toMatchObject({ root: '/volumes/fast/NekroNXT', source: 'pointer' })
    expect(resolve('  ', pointer)).toMatchObject({ root: '/volumes/fast/NekroNXT', source: 'pointer' })
    expect(resolve(undefined, {})).toEqual({
      root: '/application-data/NekroNxt Preview',
      source: 'default',
      defaultRoot: '/application-data/NekroNxt Preview',
    })
    expect(() => resolve('relative-data', pointer)).toThrow('绝对路径')
  })

  it('reports an unreadable or invalid pointer instead of silently trusting it', () => {
    expect(
      resolve(undefined, { [files.pointer]: '{"format":"nxt.desktop-data-location","version":1,"userData":"rel"}' }),
    ).toMatchObject({ source: 'default', pointerProblem: 'Desktop data location pointer is invalid.' })
    expect(resolve(undefined, { [files.pointer]: '{' })).toMatchObject({ source: 'default' })
    expect(resolve(undefined, {}, files.pointer)).toMatchObject({
      source: 'default',
      pointerProblem: 'EACCES: permission denied',
    })
  })

  it('round-trips the pointer format', () => {
    expect(parseDataLocationPointer(serializeDataLocationPointer('/a/b/../c'))).toBe('/a/c')
  })
})

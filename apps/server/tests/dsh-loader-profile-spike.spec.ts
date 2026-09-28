import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { auditStartupEntries, composeEntries } from '@deepseek-ai/dsh-app-boot'
import PluginInventory from '@deepseek-ai/dsh-host-plugin-inventory'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const moduleUrl = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`

const PluginInventorySnapshotSchema = z
  .object({
    entries: z.array(
      z
        .object({
          entryId: z.string(),
          moduleName: z.string(),
          enabled: z.boolean(),
          fiberPhase: z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
const PluginEntryIdSchema = z.string().min(1)

interface PluginInventoryService {
  readonly list: () => Promise<unknown>
}

const isPluginInventoryService = (value: unknown): value is PluginInventoryService =>
  typeof value === 'object' && value !== null && 'list' in value && typeof value.list === 'function'

describe('DSH 0.1.7-rc.2 Loader/Profile compatibility spike', () => {
  it('loads, updates, inventories, removes, and fully retracts a public Cordis plugin entry', async () => {
    const context = new Context()
    await context.plugin(Loader, { baseUrl: import.meta.url })
    await context.plugin(PluginInventory)
    const inventory: unknown = context.get('pluginInventory')
    if (!isPluginInventoryService(inventory)) {
      throw new TypeError('DSH plugin inventory service is unavailable.')
    }
    const listInventory = async () => PluginInventorySnapshotSchema.parse(await inventory.list())
    const name = moduleUrl(`
      export default function apply(ctx, config) {
        ctx.reflect.provide('nxtSpike', { value: config.value })
      }
    `)
    try {
      const id = PluginEntryIdSchema.parse(await context.loader.create({ name, config: { value: 1 } }))
      await context.loader.await()
      await auditStartupEntries(context, 'nekro-nxt-loader-spike')
      expect(context.get('nxtSpike')).toEqual({ value: 1 })
      expect((await listInventory()).entries).toEqual([
        expect.objectContaining({ entryId: id, moduleName: name, enabled: true, fiberPhase: 'active' }),
      ])

      await context.loader.update(id, { config: { value: 2 } })
      await context.loader.await()
      await auditStartupEntries(context, 'nekro-nxt-loader-spike')
      expect(context.get('nxtSpike')).toEqual({ value: 2 })

      await context.loader.resolve(id).fiber?.dispose()
      context.loader.remove(id)
      await context.loader.await()
      expect(context.get('nxtSpike')).toBeUndefined()
      expect((await listInventory()).entries).toEqual([])
    } finally {
      await context.fiber.dispose()
    }
  })

  it('detects a failed activation and fully retracts the provisional entry', async () => {
    const context = new Context()
    await context.plugin(Loader, { baseUrl: import.meta.url })
    const name = moduleUrl(`
      export default function apply(ctx) {
        ctx.reflect.provide('nxtFailedSpike', { leaked: true })
        throw new Error('intentional loader spike failure')
      }
    `)
    try {
      const id = PluginEntryIdSchema.parse(await context.loader.create({ name }))
      await context.loader.await()
      const warnings: string[] = []
      await auditStartupEntries(context, 'nekro-nxt-loader-spike', (line) => warnings.push(line))
      expect(warnings.join('\n')).toContain('intentional loader spike failure')
      // Loader 1.0.5 retains failed entries for diagnostics. The owner must await
      // disposal before removing the entry; create() no longer rejects.
      await context.loader.resolve(id).fiber?.dispose()
      context.loader.remove(id)
      await context.loader.await()
      expect(context.get('nxtFailedSpike')).toBeUndefined()
      expect([...context.loader.entries()]).toEqual([])
    } finally {
      await context.fiber.dispose()
    }
  })

  it('keeps host-private services invisible when the user layer receives an isolated context', async () => {
    const root = new Context()
    root.reflect.provide('nxtPrivateService', { secret: 'host-only' })
    const isolated = root.isolate('nxtPrivateService')
    await isolated.plugin(Loader, { baseUrl: import.meta.url })
    const name = moduleUrl(`
      export default function apply(ctx) {
        ctx.reflect.provide('nxtIsolationProbe', { sawPrivate: ctx.get('nxtPrivateService') !== undefined })
      }
    `)
    try {
      await isolated.loader.create({ name })
      await isolated.loader.await()
      expect(isolated.get('nxtIsolationProbe')).toEqual({ sawPrivate: false })
      expect(root.get('nxtPrivateService')).toEqual({ secret: 'host-only' })
    } finally {
      await root.fiber.dispose()
    }
  })

  it('confirms Profile patches can describe entries but do not provide a NekroNxt authorization boundary', () => {
    const entries = composeEntries([
      [
        {
          insert: [
            {
              id: 'profile-plugin',
              name: '@example/dsh-plugin',
              config: { enabled: true },
            },
          ],
        },
      ],
    ])
    expect(entries).toEqual([
      expect.objectContaining({ id: 'profile-plugin', name: '@example/dsh-plugin', config: { enabled: true } }),
    ])
    expect(entries[0]).not.toHaveProperty('agentRevisionId')
    expect(entries[0]).not.toHaveProperty('channelId')
  })
})

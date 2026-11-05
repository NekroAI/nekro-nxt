import { defineTool } from '@deepseek-ai/dsh-tools'
import { releaseIdentity } from './product-updates.js'
import { PRODUCT_VERSION } from './product-version.js'

export interface ProductVersionInfo {
  readonly version: string
  /** The release build, e.g. one of several preview builds of the same day; null for a source checkout. */
  readonly build: string | null
  readonly channel: 'stable' | 'preview' | 'development' | null
}

/** `releaseId` is absent where the host did not pass one; a source checkout reads as `development`. */
export const productVersionInfo = (releaseId: string | undefined): ProductVersionInfo => {
  if (releaseId === undefined) return { version: PRODUCT_VERSION, build: null, channel: null }
  const identity = releaseIdentity(releaseId)
  return identity.channel === 'development'
    ? { version: PRODUCT_VERSION, build: null, channel: 'development' }
    : { version: PRODUCT_VERSION, build: releaseId.trim(), channel: identity.channel }
}

export const productVersionTool = (releaseId: string | undefined) =>
  defineTool({
    name: 'nekro_nxt_version',
    description: '查看正在运行的 NekroNXT 版本、构建号和发布渠道；有人问版本或写问题反馈时使用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'string', required: true },
          build: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          channel: {
            oneOf: [{ type: 'string', enum: ['stable', 'preview', 'development'] }, { type: 'null' }],
            required: true,
          },
        },
      },
      render: (_arguments, value) => [{ type: 'text', text: `NekroNXT 版本：${JSON.stringify(value)}` }],
    },
    execute: () => Promise.resolve(productVersionInfo(releaseId)),
  })

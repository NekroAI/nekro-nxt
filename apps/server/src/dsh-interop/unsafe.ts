import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  defineTool,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'

const IMAGE_MEDIA_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isImageMediaType = (value: unknown): value is ImageMediaType =>
  typeof value === 'string' && IMAGE_MEDIA_TYPES.has(value)

interface RuntimeCheckedDefineToolOptions {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (...args: readonly unknown[]) => unknown
  }
  readonly execute: (...args: readonly unknown[]) => unknown
  readonly timeoutMs?: number
  readonly finalizeContent?: (...args: readonly unknown[]) => unknown
  readonly isConcurrencySafe?: (...args: readonly unknown[]) => unknown
  readonly presentCall?: (...args: readonly unknown[]) => unknown
  readonly presentResult?: (...args: readonly unknown[]) => unknown
}

const invokeRuntimeCheckedDefineTool = defineTool as (options: RuntimeCheckedDefineToolOptions) => unknown

export function parseDshImageAttachmentRef(input: unknown): ImageAttachmentRef {
  if (!isRecord(input)) throw new TypeError('DSH image attachment reference must be an object.')
  if (typeof input['attachmentId'] !== 'string' || input['attachmentId'].length === 0) {
    throw new TypeError('DSH image attachment reference requires a non-empty attachmentId.')
  }
  if (!isImageMediaType(input['mediaType'])) {
    throw new TypeError('DSH image attachment reference has an unsupported mediaType.')
  }
  if (!isNonNegativeInteger(input['bytes'])) {
    throw new TypeError('DSH image attachment reference requires a non-negative integer byte size.')
  }
  if (!isNonNegativeInteger(input['width']) || !isNonNegativeInteger(input['height'])) {
    throw new TypeError('DSH image attachment reference requires non-negative integer dimensions.')
  }
  if (input['name'] !== undefined && typeof input['name'] !== 'string') {
    throw new TypeError('DSH image attachment reference name must be a string when provided.')
  }
  return {
    attachmentId: AttachmentId(input['attachmentId']),
    mediaType: input['mediaType'],
    bytes: input['bytes'],
    width: input['width'],
    height: input['height'],
    ...(input['name'] === undefined ? {} : { name: input['name'] }),
  }
}

function assertDefineToolOptions(input: unknown): asserts input is RuntimeCheckedDefineToolOptions {
  if (!isRecord(input)) throw new TypeError('Extension Tool definition must be an object.')
  if (typeof input['name'] !== 'string' || input['name'].length === 0) {
    throw new TypeError('Extension Tool definition requires a non-empty name.')
  }
  if (typeof input['description'] !== 'string') {
    throw new TypeError('Extension Tool definition requires a description.')
  }
  if (!isRecord(input['parameters'])) {
    throw new TypeError('Extension Tool definition parameters must be an object.')
  }
  const output = input['output']
  if (!isRecord(output) || !isRecord(output['schema']) || typeof output['render'] !== 'function') {
    throw new TypeError('Extension Tool definition requires an output schema and render function.')
  }
  if (typeof input['execute'] !== 'function') {
    throw new TypeError('Extension Tool definition requires an execute function.')
  }
  for (const callback of ['finalizeContent', 'isConcurrencySafe', 'presentCall', 'presentResult'] as const) {
    if (input[callback] !== undefined && typeof input[callback] !== 'function') {
      throw new TypeError(`Extension Tool definition ${callback} must be a function when provided.`)
    }
  }
  if (
    input['timeoutMs'] !== undefined &&
    (typeof input['timeoutMs'] !== 'number' || !Number.isFinite(input['timeoutMs']) || input['timeoutMs'] <= 0)
  ) {
    throw new TypeError('Extension Tool definition timeoutMs must be a positive finite number when provided.')
  }
}

export function defineDshToolFromUnknown(input: unknown): ToolDefinition {
  assertDefineToolOptions(input)
  // DSH compiles and validates both author-facing schemas before publishing the definition.
  const definition = invokeRuntimeCheckedDefineTool(input)
  return parseDshToolDefinition(definition)
}

function assertDshToolDefinition(input: unknown): asserts input is ToolDefinition {
  if (!isRecord(input)) throw new TypeError('Extension Tool definition must be an object.')
  if (typeof input['name'] !== 'string' || input['name'].length === 0) {
    throw new TypeError('Extension Tool definition requires a non-empty name.')
  }
  if (typeof input['description'] !== 'string') {
    throw new TypeError('Extension Tool definition requires a description.')
  }
  assertObjectJsonSchema(input['parameters'])
  const output = input['output']
  if (!isRecord(output) || typeof output['render'] !== 'function') {
    throw new TypeError('Extension Tool definition requires an output schema and render function.')
  }
  assertSupportedJsonSchema(output['schema'])
  if (typeof input['execute'] !== 'function') {
    throw new TypeError('Extension Tool definition requires an execute function.')
  }
  for (const callback of ['finalizeContent', 'isConcurrencySafe', 'presentCall', 'presentResult'] as const) {
    if (input[callback] !== undefined && typeof input[callback] !== 'function') {
      throw new TypeError(`Extension Tool definition ${callback} must be a function when provided.`)
    }
  }
  if (
    input['timeoutMs'] !== undefined &&
    (typeof input['timeoutMs'] !== 'number' || !Number.isFinite(input['timeoutMs']) || input['timeoutMs'] <= 0)
  ) {
    throw new TypeError('Extension Tool definition timeoutMs must be a positive finite number when provided.')
  }
}

/** Validate an already compiled DSH ToolDefinition before passing it to ToolRuntime.register(). */
export function parseDshToolDefinition(input: unknown): ToolDefinition {
  assertDshToolDefinition(input)
  return input
}

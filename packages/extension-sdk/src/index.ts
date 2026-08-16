export type ExtensionJsonValue =
  null | boolean | number | string | readonly ExtensionJsonValue[] | { readonly [key: string]: ExtensionJsonValue }

export interface ExtensionPluginDefinition {
  readonly inject?: readonly string[]
  apply(context: unknown): void | Promise<void>
}

export interface ExtensionHostEnvironment {
  readonly harness: {
    defineTool(options: unknown): unknown
    registerTool(context: unknown, tool: unknown): () => void
    handle(
      method: string,
      handler: (input: ExtensionJsonValue) => ExtensionJsonValue | Promise<ExtensionJsonValue>,
    ): () => void
  }
  readonly config: ExtensionJsonValue
}

export interface ExtensionClientEnvironment {
  readonly React: unknown
  readonly host: { call(method: string, input?: ExtensionJsonValue): Promise<ExtensionJsonValue> }
  readonly styles: Readonly<Record<string, string>>
}

export type ExtensionPluginFactory<Environment> = (
  environment: Environment,
) => ExtensionPluginDefinition | Promise<ExtensionPluginDefinition>

/** Browser/Host-neutral implementation bundled by the controlled Extension builder. */
export const EXTENSION_SDK_BUNDLE_SOURCE = `
export const defineHostExtension = (factory) => factory
export const defineClientExtension = (factory) => factory
`

/** Marks a Host entry factory without executing it during build or import. */
export const defineHostExtension = <T extends ExtensionPluginFactory<ExtensionHostEnvironment>>(factory: T): T =>
  factory

/** Marks a Client entry factory without executing it during build or import. */
export const defineClientExtension = <T extends ExtensionPluginFactory<ExtensionClientEnvironment>>(factory: T): T =>
  factory

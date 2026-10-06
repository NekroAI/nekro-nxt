/**
 * Extension UI V6 (Decision 2026-10-04 §5): one runtime for every extension Client, semantic placement by anchor,
 * host-owned frames and one configuration form.
 */
export { ExtensionUiProvider, ExtensionUiRuntime, useExtensionUiRuntime } from './runtime.js'
export { PanelSlot, ToolView, MessageRendererSlot, panelsForAnchor, type PanelAnchor } from './slots.js'
export { ContributionFrame, ContributionBoundary, type ContributionFrameProps } from './contribution-frame.js'
export {
  ContributionRegistry,
  type ContributionOwner,
  type PanelEntry,
  type ToolViewEntry,
  type MessageRendererEntry,
} from './registry.js'
export {
  ConfigForm,
  configDefaults,
  configIssues,
  secretIssues,
  type ConfigFormProps,
  type ConfigValue,
} from './config-form.js'
export { createClientContext, mountClient, type MountedClient } from './client.js'
export { createExtensionData } from './data.js'
export { extensionUiKit, extensionReactFacade } from './ui-kit.js'
export { HOST_ICONS } from './icons.js'
export { useExtensionActivation } from './activation.js'
export { ExtensionConfigEditor, activeConfigSchema } from './config-editor.js'
export { PERMISSION_LABELS, permissionLines } from './permissions.js'
export {
  HostUiPageCanvas as ExtensionPageCanvas,
  HostUiObjectPane as ExtensionPageNavigation,
} from '../host-ui-client.js'

/** Synthetic verification evidence for tests that assemble a saved Revision directly. */
export const extensionVerification = (tools: readonly string[] = [], rpc: readonly string[] = []) => ({
  dshVersion: 'synthetic',
  contractVersion: 'nekro-nxt-extension-v5' as const,
  origin: { episodeId: 'eps_FIXTURE', pluginId: 'fixture', packageId: 'fixture', pluginRunId: 'fixture' },
  toolInvocations: tools.map((name) => ({ name, succeeded: true })),
  rpcMethods: [...rpc],
  renderedPanels: [],
  renderedToolViews: [],
  renderedMessageRenderers: [],
  permissions: { permissions: [], networkOrigins: [] },
})

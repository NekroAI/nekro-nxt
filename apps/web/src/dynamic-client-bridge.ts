interface DynamicClientApprovalBridge {
  approve(agentId: string, requestId: string): Promise<void>
  decline(agentId: string, requestId: string): Promise<void>
}

let activeBridge: DynamicClientApprovalBridge | null = null

export const setDynamicClientApprovalBridge = (bridge: DynamicClientApprovalBridge | null): void => {
  activeBridge = bridge
}

export const approveDynamicClientRequest = async (agentId: string, requestId: string): Promise<boolean> => {
  if (!activeBridge) return false
  await activeBridge.approve(agentId, requestId)
  return true
}

export const declineDynamicClientRequest = async (agentId: string, requestId: string): Promise<boolean> => {
  if (!activeBridge) return false
  await activeBridge.decline(agentId, requestId)
  return true
}

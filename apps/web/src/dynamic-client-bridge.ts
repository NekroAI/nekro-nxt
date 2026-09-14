export interface DynamicClientApprovalBridge {
  approve(agentId: string, requestId: string): Promise<void>
  decline(agentId: string, requestId: string): Promise<void>
}

export function createDynamicClientApprovalBridge() {
  let bridge: DynamicClientApprovalBridge | null = null
  return {
    register(next: DynamicClientApprovalBridge): () => void {
      bridge = next
      return () => {
        if (bridge === next) bridge = null
      }
    },
    async approve(agentId: string, requestId: string): Promise<boolean> {
      if (!bridge) return false
      await bridge.approve(agentId, requestId)
      return true
    },
    async decline(agentId: string, requestId: string): Promise<boolean> {
      if (!bridge) return false
      await bridge.decline(agentId, requestId)
      return true
    },
  }
}

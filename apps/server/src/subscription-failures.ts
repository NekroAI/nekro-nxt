/** OpenAI's plan-usage refusals, as the person using NekroNXT can act on them. */
const SUBSCRIPTION_FAILURES: Record<string, string> = {
  subscription_sharing_user_not_eligible:
    '这个 ChatGPT 账号不能把套餐额度用于 NekroNXT，账号、工作区或管理员策略不允许。可以换一个账号，或改用 API 密钥。',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT 套餐的额度已用完，可以在 ChatGPT 使用量设置中查看。',
  subscription_sharing_usage_unavailable: 'ChatGPT 暂时无法确认套餐额度，请稍后再试。',
  subscription_sharing_unsupported_capability: 'ChatGPT 套餐不支持这次请求用到的功能，例如某个工具或模型。',
  subscription_sharing_invalid_user: 'ChatGPT 账号校验没有通过，请重新登录。',
}

/** A readable reason when a model failure is one of the plan-usage refusals, otherwise undefined. */
export function describeSubscriptionFailure(message: string): string | undefined {
  const code = /subscription_sharing_[a-z_]+/u.exec(message)?.[0]
  return code === undefined ? undefined : SUBSCRIPTION_FAILURES[code]
}

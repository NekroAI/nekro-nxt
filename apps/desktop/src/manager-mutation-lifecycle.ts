import { InstanceOperationError } from './instance-operation-error.js'
import type { SerialTaskQueue } from './serial-task-queue.js'

export interface ManagerMutationToken {
  readonly generation: number
}

export class ManagerMutationLifecycle {
  #generation = 0
  #disposed = false

  capture(): ManagerMutationToken {
    return { generation: this.#generation }
  }

  isActive(token: ManagerMutationToken): boolean {
    return !this.#disposed && token.generation === this.#generation
  }

  assertActive(token: ManagerMutationToken): void {
    if (!this.isActive(token)) {
      throw new InstanceOperationError('operation-failed', 'Desktop 已关闭，实例操作已取消。')
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
  }
}

export const runManagerMutation = <T>(
  queue: SerialTaskQueue,
  lifecycle: ManagerMutationLifecycle,
  operation: (token: ManagerMutationToken) => Promise<T>,
): Promise<T> => {
  const token = lifecycle.capture()
  return queue.run(async () => {
    lifecycle.assertActive(token)
    return operation(token)
  })
}

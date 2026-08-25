export class SerialTaskQueueClosedError extends Error {
  constructor() {
    super('操作已取消，因为 Desktop 已关闭。')
    this.name = 'SerialTaskQueueClosedError'
  }
}

interface PendingTask {
  readonly execute: () => Promise<void>
  readonly rejectPending: (cause: unknown) => void
}

export class SerialTaskQueue {
  readonly #pending: PendingTask[] = []
  #running = false
  #closed = false

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new SerialTaskQueueClosedError())
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({
        execute: async () => {
          try {
            resolve(await task())
          } catch (cause) {
            reject(cause instanceof Error ? cause : new Error('串行任务失败。', { cause }))
          }
        },
        rejectPending: reject,
      })
      this.#drain()
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const cause = new SerialTaskQueueClosedError()
    for (const task of this.#pending.splice(0)) task.rejectPending(cause)
  }

  #drain(): void {
    if (this.#running) return
    const pending = this.#pending.shift()
    if (pending === undefined) return
    this.#running = true
    const execute = async (): Promise<void> => {
      try {
        await pending.execute()
      } finally {
        this.#running = false
        this.#drain()
      }
    }
    void execute()
  }
}

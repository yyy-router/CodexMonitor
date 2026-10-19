/**
 * 运行时状态持久化（~/.codexmonitor/）。
 *
 * 额度状态必须落盘 —— 进程不可能连续存活 7 天（§4.4）。
 */

export type StateStore = {
  load<T>(key: string): T | null
  save<T>(key: string, value: T): void
}

export function createStateStore(_dir: string): StateStore {
  throw new Error('Not implemented: createStateStore')
}

/**
 * 增量 tail（IO）。
 *
 * 并发跟踪多个会话文件，每个文件维护独立 (offset, size)，只读新增字节；
 * 解析为 CodexEvent，按 ts 升序排序后返回（§4.1）。
 *
 * 通过注入 parseLine / parseSessionMeta 复用 parse.ts，便于单测替身。
 */

import type { CodexEvent, SessionContext } from '../events.js'

export type TailerOptions = {
  /** 会话日志根目录（~/.codex/sessions） */
  sessionsDir: string
  maxTrackedFiles: number
  /** 单行 JSONL → 事件（依赖注入，来自 watcher/parse.ts） */
  parseLine: (line: string, ctx: SessionContext) => CodexEvent[]
  /** 提取会话上下文（session_meta 首行） */
  parseSessionMeta: (line: string) => SessionContext | null
  /** 可注入时钟，便于测试 */
  now?: () => number
}

export type Tailer = {
  /** 读一轮新增字节 → 解析 → 按 ts 升序返回事件 */
  tick(): Promise<CodexEvent[]>
  /** 手动纳入一个文件跟踪（文件旋转 / 新会话） */
  addFile(path: string): void
}

export function createTailer(_opts: TailerOptions): Tailer {
  throw new Error('Not implemented: createTailer')
}

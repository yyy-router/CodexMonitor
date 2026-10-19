/**
 * 额度状态机（纯函数 + 持久化封装，§4.4）。
 *
 * 全局单实例（额度是账号级，多窗口共享）。仅维护 5h(300) 与 7d(10080) 两个窗口，
 * 其他 window_minutes 记日志忽略。
 *
 * 重置检测双路径：
 *   路径 A（事件驱动，主）：新 token_count 的用量从 ≥90 骤降到 <50 且 resets_at 变大。
 *   路径 B（倒计时兜底）：waiting && now >= resetsAt。
 */

import type { CodexEvent, Notification } from '../events.js'
import type { Thresholds } from './classify.js'

export type WindowState = {
  windowMinutes: 300 | 10080
  usedPercent: number
  /** 计划重置时刻，unix 秒；null=缺失 */
  resetsAt: number | null
  /** 是否处于「等待重置」 */
  waiting: boolean
  notifiedExhausted: boolean
  notifiedReset: boolean
  /** 已处理事件的最大 ts，丢弃陈旧事件（多窗口必需） */
  lastProcessedTs: number
  lastUpdatedAt: number
}

export type QuotaSnapshot = {
  fiveHour?: WindowState
  sevenDay?: WindowState
}

export type QuotaTrackerConfig = {
  thresholds: Thresholds
}

export type QuotaTracker = {
  /** 处理一条 quota 事件（路径 A 在此触发） */
  process(ev: Extract<CodexEvent, { kind: 'quota' }>, now: number): Notification[]
  /** tick 循环调用（路径 B 倒计时在此触发） */
  tick(now: number): Notification[]
  snapshot(): QuotaSnapshot
  restore(s: QuotaSnapshot): void
}

export function createQuotaTracker(_cfg: QuotaTrackerConfig): QuotaTracker {
  throw new Error('Not implemented: createQuotaTracker')
}

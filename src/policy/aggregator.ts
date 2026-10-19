/**
 * 聚合窗口（纯函数，§4.3）。
 *
 * 任务完成事件入池，聚合消息只在「有内容」且「距上次发送 ≥ minIntervalMs」
 * 且「未超 maxPerDay」时才产出。一天没干活就一条都不发。
 */

import type { Notification } from '../events.js'
import type { Config } from '../config.js'

export type CompletedItem = {
  /** 项目名（cwd basename） */
  project: string
  summary: string
  durationMs: number
  ts: number
}

export type AggregatorConfig = Config['notify']['aggregate']

export type Aggregator = {
  add(item: CompletedItem, now: number): void
  /** 满足条件时产出聚合通知，否则返回 null */
  maybeFlush(now: number): Notification | null
}

export function createAggregator(_cfg: AggregatorConfig): Aggregator {
  throw new Error('Not implemented: createAggregator')
}

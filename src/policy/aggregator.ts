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

export function createAggregator(cfg: AggregatorConfig): Aggregator {
  let items: CompletedItem[] = []
  let lastFlushAt: number | null = null
  let dayKey: number | null = null
  let sentToday = 0

  return {
    add(item: CompletedItem, _now: number): void {
      items.push(item)
    },

    maybeFlush(now: number): Notification | null {
      if (items.length === 0) return null

      // 跨 UTC 日重置每日计数
      const dk = Math.floor(now / 86_400_000)
      if (dayKey !== dk) {
        dayKey = dk
        sentToday = 0
      }
      if (sentToday >= cfg.maxPerDay) return null
      if (lastFlushAt != null && now - lastFlushAt < cfg.minIntervalMs) return null

      // 条数上限：超过 maxItems 时按 ts 倒序保留最新 N 条，更旧的丢弃
      let batch = items
      if (batch.length > cfg.maxItems) {
        batch = [...batch].sort((a, b) => b.ts - a.ts).slice(0, cfg.maxItems)
      }
      batch = [...batch].sort((a, b) => a.ts - b.ts)

      const text = [
        `📦 ${batch.length} 个任务完成`,
        ...batch.map((it) => `  · [${it.project}] ${it.summary}`),
      ].join('\n')

      items = []
      lastFlushAt = now
      sentToday += 1

      return {
        id: `agg-${now}`,
        ts: now,
        severity: 'info',
        text,
        source: 'turnCompleteAggregated',
      }
    },
  }
}

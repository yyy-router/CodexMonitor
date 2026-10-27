/**
 * 投递日志（§4.5）。
 *
 * 每次发送追加一条 JSONL（~/.codexmonitor/delivery.jsonl），留痕审计。
 *
 * 写盘失败一律吞掉：监控工具不该因为日志写不进去而中断投递。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Severity } from '../events.js'

export type DeliveryLogEntry = {
  ts: number
  severity: Severity
  source: string
  text: string
  ok: boolean
  reason?: string
  errcode?: number
  messageId?: string
}

export type DeliveryLog = {
  record(entry: DeliveryLogEntry): void
}

export function createDeliveryLog(dir: string): DeliveryLog {
  const file = path.join(dir, 'delivery.jsonl')
  let dirReady = false

  return {
    record(entry) {
      try {
        if (!dirReady) {
          mkdirSync(dir, { recursive: true })
          dirReady = true
        }
        appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
      } catch {
        // 日志属于旁路能力，失败不影响主流程
      }
    },
  }
}

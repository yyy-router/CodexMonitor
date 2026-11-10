/**
 * 静默通知日志（~/.codexmonitor/suppressed.jsonl）。
 *
 * 工作时间外被抑制的通知不经过 Notifier，只在这里留痕，供 TUI 事后查看。
 * 写盘失败一律吞掉：日志属于旁路能力，不能影响主流程。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Severity } from '../events.js'

export type SuppressedEntry = {
  ts: number
  severity: Severity
  source: string
  text: string
  /** 静默原因；目前固定为 workHours */
  reason: string
}

export type SuppressedLog = {
  record(entry: SuppressedEntry): void
  /** 读取最近 limit 条；文件不存在或损坏行自动跳过 */
  read(limit: number): SuppressedEntry[]
}

const isEntry = (v: unknown): v is SuppressedEntry => {
  if (typeof v !== 'object' || v == null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.ts === 'number' &&
    typeof e.severity === 'string' &&
    typeof e.source === 'string' &&
    typeof e.text === 'string' &&
    typeof e.reason === 'string'
  )
}

export function createSuppressedLog(dir: string): SuppressedLog {
  const file = path.join(dir, 'suppressed.jsonl')
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
        // 旁路能力，失败不影响推送判断
      }
    },

    read(limit) {
      if (!Number.isFinite(limit) || limit <= 0) return []
      try {
        const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
        const entries: SuppressedEntry[] = []
        for (const line of lines) {
          if (line === '') continue
          try {
            const parsed: unknown = JSON.parse(line)
            if (isEntry(parsed)) entries.push(parsed)
          } catch {
            // 跳过损坏的行
          }
        }
        return entries.slice(-Math.trunc(limit))
      } catch {
        return []
      }
    },
  }
}

/**
 * 额度状态机（纯函数 + 持久化封装，§4.4）。
 *
 * 全局单实例（额度是账号级，多窗口共享）。仅维护 5h(300) 与 7d(10080) 两个窗口，
 * 其他 window_minutes 忽略（记日志在 main 层处理）。
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

const LABEL: Record<300 | 10080, string> = { 300: '5 小时', 10080: '7 天' }

export function createQuotaTracker(cfg: QuotaTrackerConfig): QuotaTracker {
  let fiveHour: WindowState | undefined
  let sevenDay: WindowState | undefined

  const get = (wm: 300 | 10080): WindowState | undefined =>
    wm === 300 ? fiveHour : sevenDay
  const set = (wm: 300 | 10080, s: WindowState): void => {
    if (wm === 300) fiveHour = s
    else sevenDay = s
  }

  const exhausted = (wm: 300 | 10080, p: number, now: number): Notification => ({
    id: `quota-exhausted-${wm}-${now}`,
    ts: now,
    severity: 'alert',
    text: `⚠️ ${LABEL[wm]}额度已用尽（${Math.round(p)}%）`,
    source: 'quotaExhausted',
  })

  const resetA = (wm: 300 | 10080, p: number, now: number): Notification => ({
    id: `quota-reset-${wm}-${now}`,
    ts: now,
    severity: 'info',
    text: `✅ ${LABEL[wm]}额度已重置（检测到用量回落至 ${Math.round(p)}%）`,
    source: 'quotaReset',
  })

  const resetB = (wm: 300 | 10080, now: number): Notification => ({
    id: `quota-reset-${wm}-${now}`,
    ts: now,
    severity: 'info',
    text: `⏰ ${LABEL[wm]}额度已到计划重置时间`,
    source: 'quotaReset',
  })

  return {
    process(ev, now) {
      const wm = ev.window.windowMinutes
      if (wm !== 300 && wm !== 10080) return []

      const st = get(wm)
      const p = ev.window.usedPercent
      const resetsAt = ev.window.resetsAt
      const ts = ev.ts

      // 陈旧事件：ts <= lastProcessedTs 丢弃（多窗口乱序防护）
      if (st && ts <= st.lastProcessedTs) return []

      if (!st) {
        // 首次事件：建状态，走下方统一判定
        set(wm, {
          windowMinutes: wm,
          usedPercent: p,
          resetsAt,
          waiting: false,
          notifiedExhausted: false,
          notifiedReset: false,
          lastProcessedTs: ts,
          lastUpdatedAt: now,
        })
      }

      const s = get(wm)!
      const wasWaiting = s.waiting
      const oldUsedPercent = s.usedPercent
      const oldResetsAt = s.resetsAt

      s.usedPercent = p
      s.resetsAt = resetsAt
      s.lastProcessedTs = ts
      s.lastUpdatedAt = now

      // 耗尽：进入等待状态 + 推 alert（notifiedExhausted 去重）
      if (p >= cfg.thresholds.quotaExhausted && !s.notifiedExhausted) {
        s.waiting = true
        s.notifiedExhausted = true
        s.notifiedReset = false
        return [exhausted(wm, p, now)]
      }

      // 路径 A：用量 ≥90 → <50 且 resetsAt 变大 且 此前 waiting
      if (
        wasWaiting &&
        oldUsedPercent >= 90 &&
        p < 50 &&
        resetsAt != null &&
        oldResetsAt != null &&
        resetsAt > oldResetsAt
      ) {
        s.waiting = false
        s.notifiedReset = true
        s.notifiedExhausted = false
        return [resetA(wm, p, now)]
      }

      return []
    },

    tick(now) {
      const notes: Notification[] = []
      for (const wm of [300, 10080] as const) {
        const s = get(wm)
        if (!s) continue
        // 路径 B：waiting 且到计划重置时间 且 未通知过
        if (s.waiting && !s.notifiedReset && s.resetsAt != null && now >= s.resetsAt * 1000) {
          s.waiting = false
          s.notifiedReset = true
          s.notifiedExhausted = false
          notes.push(resetB(wm, now))
        }
      }
      return notes
    },

    snapshot() {
      const out: QuotaSnapshot = {}
      if (fiveHour) out.fiveHour = { ...fiveHour }
      if (sevenDay) out.sevenDay = { ...sevenDay }
      return out
    },

    restore(s) {
      fiveHour = s.fiveHour ? { ...s.fiveHour } : undefined
      sevenDay = s.sevenDay ? { ...s.sevenDay } : undefined
    },
  }
}

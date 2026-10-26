import { describe, it, expect } from 'vitest'
import { createQuotaTracker, type QuotaTrackerConfig } from '../../src/policy/quota-tracker.js'
import type { CodexEvent } from '../../src/events.js'

const cfg: QuotaTrackerConfig = {
  thresholds: {
    quotaWarn: 80,
    quotaCritical: 95,
    quotaExhausted: 100,
    quotaWarnCooldownMs: 1800000,
    warnEnabled: false,
  },
}

const quota = (
  windowMinutes: number,
  usedPercent: number,
  resetsAt: number | null,
  ts: number,
): Extract<CodexEvent, { kind: 'quota' }> => ({
  ts,
  sessionId: 'sess-1',
  cwd: '/proj',
  kind: 'quota',
  window: { windowMinutes, usedPercent, resetsAt },
})

describe('createQuotaTracker', () => {
  it('耗尽（≥100%）进入等待状态并推一条 alert', () => {
    const t = createQuotaTracker(cfg)
    const notes = t.process(quota(300, 100, 1000, 1), 1)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('alert')
    expect(notes[0]!.source).toBe('quotaExhausted')
    expect(notes[0]!.text).toContain('5 小时额度已用尽')
    expect(t.snapshot().fiveHour!.waiting).toBe(true)
    expect(t.snapshot().fiveHour!.notifiedExhausted).toBe(true)
  })

  it('已耗尽再次收到 100% 不重复推（notifiedExhausted 去重）', () => {
    const t = createQuotaTracker(cfg)
    expect(t.process(quota(300, 100, 1000, 1), 1)).toHaveLength(1)
    expect(t.process(quota(300, 100, 1000, 2), 2)).toHaveLength(0)
  })

  it('路径 A：用量从 ≥90 回落到 <50 且 resetsAt 变大 → 推重置 info', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 100, 1000, 1), 1) // 进入等待
    const notes = t.process(quota(300, 4, 2000, 2), 2)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('info')
    expect(notes[0]!.source).toBe('quotaReset')
    expect(notes[0]!.text).toContain('5 小时额度已重置')
    expect(t.snapshot().fiveHour!.waiting).toBe(false)
    expect(t.snapshot().fiveHour!.notifiedReset).toBe(true)
    expect(t.snapshot().fiveHour!.notifiedExhausted).toBe(false)
  })

  it('路径 A：用量回落但 resetsAt 没变大 → 不判重置', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 100, 1000, 1), 1)
    expect(t.process(quota(300, 4, 1000, 2), 2)).toHaveLength(0) // resetsAt 未变
  })

  it('路径 A：此前未等待（用量未满 100）→ 不判重置', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 60, 1000, 1), 1) // 未耗尽
    expect(t.process(quota(300, 4, 2000, 2), 2)).toHaveLength(0) // 无 waiting 前提
  })

  it('路径 B：waiting 且 now ≥ resetsAt → 推倒计时重置 info', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 100, 1000, 1), 1) // resetsAt = 1000 秒
    const notes = t.tick(1000 * 1000) // now = 1000000 ms
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('info')
    expect(notes[0]!.text).toContain('已到计划重置时间')
    expect(t.snapshot().fiveHour!.waiting).toBe(false)
    expect(t.snapshot().fiveHour!.notifiedReset).toBe(true)
  })

  it('路径 B：resetsAt 缺失 → 跳过倒计时（不崩）', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 100, null, 1), 1)
    expect(t.tick(999999999)).toHaveLength(0)
  })

  it('双窗口独立：5h 与 7d 各自状态互不影响', () => {
    const t = createQuotaTracker(cfg)
    expect(t.process(quota(300, 100, 1000, 1), 1)).toHaveLength(1)
    expect(t.process(quota(10080, 100, 2000, 2), 2)).toHaveLength(1)
    expect(t.snapshot().fiveHour!.waiting).toBe(true)
    expect(t.snapshot().sevenDay!.waiting).toBe(true)
    // 5h 通过路径 A 重置，7d 仍等待
    const notes = t.process(quota(300, 4, 3000, 3), 3)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toContain('5 小时额度已重置')
    expect(t.snapshot().fiveHour!.waiting).toBe(false)
    expect(t.snapshot().sevenDay!.waiting).toBe(true)
  })

  it('陈旧事件（ts ≤ lastProcessedTs）丢弃，状态不回退', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 80, 1000, 10), 10)
    // 晚到的旧事件：100% 但 ts=5 < 10 → 应被丢弃，不触发耗尽
    expect(t.process(quota(300, 100, 1000, 5), 20)).toHaveLength(0)
    expect(t.snapshot().fiveHour!.usedPercent).toBe(80)
    expect(t.snapshot().fiveHour!.waiting).toBe(false)
  })

  it('未知窗口（如 43200）忽略', () => {
    const t = createQuotaTracker(cfg)
    expect(t.process(quota(43200, 100, 1000, 1), 1)).toHaveLength(0)
    expect(t.snapshot()).toEqual({})
  })

  it('路径 B 重置后，同周期 100% 事件不再重复耗尽（防循环）', () => {
    const t = createQuotaTracker(cfg)
    t.process(quota(300, 100, 1000, 1), 1) // 耗尽，resetsAt = 1000
    expect(t.tick(1000 * 1000)).toHaveLength(1) // 路径 B 重置
    // 同周期（resetsAt 仍 1000）再来 100% 事件：不应再次耗尽
    expect(t.process(quota(300, 100, 1000, 2), 1000 * 1000 + 1)).toHaveLength(0)
  })

  it('snapshot / restore 往返：恢复后去重标志仍生效', () => {
    const a = createQuotaTracker(cfg)
    a.process(quota(300, 100, 1000, 1), 1) // 耗尽
    const snap = a.snapshot()

    const b = createQuotaTracker(cfg)
    b.restore(snap)
    // 恢复后同一窗口再收到 100% 不重复推（notifiedExhausted 已持久化）
    expect(b.process(quota(300, 100, 1000, 2), 2)).toHaveLength(0)
    // 但路径 A 重置仍能触发
    const notes = b.process(quota(300, 4, 2000, 3), 3)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.source).toBe('quotaReset')
  })
})

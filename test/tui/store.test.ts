import { describe, it, expect, vi } from 'vitest'
import {
  MAX_LOG,
  MAX_SUPPRESSED_LOG,
  TOAST_MS,
  createInitialState,
  createTuiStore,
  reduce,
  type TuiState,
} from '../../src/tui/store.js'
import type { Notification } from '../../src/events.js'
import type { RuntimeEvent } from '../../src/runtime.js'

const note = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  ts: 0,
  severity: 'alert',
  text: '🚨 [大论文] 任务被中断',
  source: 'turnAborted',
  ...over,
})

const initial = (): TuiState =>
  createInitialState({ channel: 'feishu', probeEnabled: true, now: 1_000 })

const apply = (state: TuiState, event: RuntimeEvent, now = 2_000): TuiState =>
  reduce(state, { type: 'event', event, now })

describe('createInitialState', () => {
  it('额度阈值默认 80 / 95，可注入', () => {
    expect(initial().quotaWarnAt).toBe(80)
    expect(initial().quotaCriticalAt).toBe(95)

    const custom = createInitialState({
      channel: 'console',
      probeEnabled: true,
      now: 0,
      thresholds: { warn: 70, critical: 90 },
    })
    expect(custom.quotaWarnAt).toBe(70)
    expect(custom.quotaCriticalAt).toBe(90)
  })
})

describe('reduce: delivered', () => {
  it('成功：计数 +1，日志含原文，最近结果 ok', () => {
    const s = apply(initial(), { type: 'delivered', note: note(), result: { ok: true } })
    expect(s.deliveredCount).toBe(1)
    expect(s.lastDeliveryOk).toBe(true)
    expect(s.log).toHaveLength(1)
    expect(s.log[0]).toMatchObject({ severity: 'alert', text: '🚨 [大论文] 任务被中断', ok: true })
  })

  it('失败：计数不变，最近结果 false', () => {
    const s = apply(initial(), {
      type: 'delivered',
      note: note(),
      result: { ok: false, reason: 'down' },
    })
    expect(s.deliveredCount).toBe(0)
    expect(s.lastDeliveryOk).toBe(false)
    expect(s.log[0]!.ok).toBe(false)
  })

  it(`日志上限 ${MAX_LOG} 条，丢弃最旧的`, () => {
    let s = initial()
    for (let i = 0; i < MAX_LOG + 10; i++) {
      s = apply(s, {
        type: 'delivered',
        note: note({ id: `n${i}`, text: `第 ${i} 条` }),
        result: { ok: true },
      })
    }
    expect(s.log).toHaveLength(MAX_LOG)
    expect(s.log[s.log.length - 1]!.text).toBe(`第 ${MAX_LOG + 9} 条`)
    expect(s.log[0]!.text).toBe('第 10 条')
  })
})

describe('reduce: suppressed', () => {
  const suppressed = (text: string) =>
    apply(initial(), {
      type: 'suppressed',
      entry: {
        ts: 70_000,
        severity: 'alert',
        source: 'probeDown',
        text,
        reason: 'workHours',
      },
    })

  it('静默条目进入独立列表并带 suppressed 标记', () => {
    const s = suppressed('静默告警')
    expect(s.log).toHaveLength(0)
    expect(s.suppressedLog).toHaveLength(1)
    expect(s.suppressedLog[0]).toMatchObject({
      at: 70_000,
      severity: 'alert',
      text: '静默告警',
      suppressed: true,
    })
  })

  it('suppressedHistory 替换历史列表', () => {
    let s = suppressed('旧条目')
    s = apply(s, {
      type: 'suppressedHistory',
      entries: [
        { ts: 1, severity: 'info', source: 'a', text: '历史 1', reason: 'workHours' },
        { ts: 2, severity: 'info', source: 'b', text: '历史 2', reason: 'workHours' },
      ],
    })
    expect(s.suppressedLog.map((e) => e.text)).toEqual(['历史 1', '历史 2'])
  })

  it(`静默列表上限 ${MAX_SUPPRESSED_LOG} 条`, () => {
    let s = initial()
    for (let i = 0; i < MAX_SUPPRESSED_LOG + 5; i++) {
      s = apply(s, {
        type: 'suppressed',
        entry: {
          ts: i,
          severity: 'info',
          source: 'x',
          text: `第 ${i} 条`,
          reason: 'workHours',
        },
      })
    }
    expect(s.suppressedLog).toHaveLength(MAX_SUPPRESSED_LOG)
    expect(s.suppressedLog[s.suppressedLog.length - 1]!.text).toBe(
      `第 ${MAX_SUPPRESSED_LOG + 4} 条`,
    )
  })

  it('toggleSuppressed 切换查看状态', () => {
    expect(initial().showSuppressed).toBe(false)
    const on = reduce(initial(), { type: 'toggleSuppressed' })
    expect(on.showSuppressed).toBe(true)
    expect(reduce(on, { type: 'toggleSuppressed' }).showSuppressed).toBe(false)
  })
})

describe('reduce: 其它事件', () => {
  it('pending 更新待发数量', () => {
    const s = apply(initial(), { type: 'pending', count: 3 })
    expect(s.pendingCount).toBe(3)
  })

  it('probe 更新网络行', () => {
    const s = apply(
      initial(),
      {
        type: 'probe',
        result: {
          mode: 'proxy',
          l1: { ok: true, status: null, latencyMs: 1 },
          l2: { ok: true, status: 401, latencyMs: 942 },
          l3: { ok: true, status: 200, latencyMs: 1 },
          verdict: 'ok',
        },
        transition: 'none',
        state: 'normal',
      },
      5_000,
    )
    expect(s.probe).toEqual({
      verdict: 'ok',
      status: 401,
      latencyMs: 942,
      at: 5_000,
      state: 'normal',
    })
  })

  it('quota 替换快照', () => {
    const snapshot = {
      fiveHour: {
        windowMinutes: 300 as const,
        usedPercent: 62,
        resetsAt: null,
        waiting: false,
        notifiedExhausted: false,
        notifiedReset: false,
        notifiedCritical: false,
        lastResetResetsAt: null,
        lastProcessedTs: 1,
        lastUpdatedAt: 1,
      },
    }
    const s = apply(initial(), { type: 'quota', snapshot })
    expect(s.quota).toBe(snapshot)
  })
})

describe('reduce: toast / tick / 暂停', () => {
  it('toast 在 TOAST_MS 后过期', () => {
    let s = reduce(initial(), { type: 'toast', text: '正在发送', now: 10_000 })
    expect(s.toast?.text).toBe('正在发送')

    s = reduce(s, { type: 'tick', now: 10_000 + TOAST_MS })
    expect(s.toast).not.toBeNull()

    s = reduce(s, { type: 'tick', now: 10_000 + TOAST_MS + 1 })
    expect(s.toast).toBeNull()
  })

  it('probePaused 更新暂停标志与时钟', () => {
    const s = reduce(initial(), { type: 'probePaused', paused: true, now: 9_000 })
    expect(s.probePaused).toBe(true)
    expect(s.now).toBe(9_000)
  })

  it('config 动作同步探针开关与额度阈值；关闭时清掉暂停', () => {
    const paused = reduce(initial(), { type: 'probePaused', paused: true, now: 2_000 })
    const off = reduce(paused, {
      type: 'config',
      probeEnabled: false,
      quotaWarnAt: 70,
      quotaCriticalAt: 90,
      workHours: {
        enabled: true,
        start: '08:00',
        end: '18:00',
        days: [1, 2, 3],
        timezone: 'UTC',
      },
      now: 3_000,
    })
    expect(off.probeEnabled).toBe(false)
    expect(off.probePaused).toBe(false)
    expect(off.quotaWarnAt).toBe(70)
    expect(off.quotaCriticalAt).toBe(90)
    expect(off.workHours.start).toBe('08:00')
    expect(off.now).toBe(3_000)

    const on = reduce(off, {
      type: 'config',
      probeEnabled: true,
      quotaWarnAt: 80,
      quotaCriticalAt: 95,
      workHours: {
        enabled: false,
        start: '09:00',
        end: '19:00',
        days: [1, 2, 3, 4, 5],
        timezone: '',
      },
      now: 4_000,
    })
    expect(on.probeEnabled).toBe(true)
    expect(on.probePaused).toBe(false)
    expect(on.quotaCriticalAt).toBe(95)
    expect(on.workHours.enabled).toBe(false)
  })
})

describe('createTuiStore', () => {
  it('dispatch 通知订阅者，状态更新', () => {
    const store = createTuiStore(initial())
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.dispatch({ type: 'event', event: { type: 'pending', count: 2 }, now: 2_000 })
    expect(store.getState().pendingCount).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.dispatch({ type: 'event', event: { type: 'pending', count: 3 }, now: 3_000 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

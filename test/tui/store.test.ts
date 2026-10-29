import { describe, it, expect, vi } from 'vitest'
import {
  MAX_LOG,
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

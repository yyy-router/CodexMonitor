import { describe, it, expect } from 'vitest'
import { classify } from '../../src/policy/classify.js'
import { createAggregator } from '../../src/policy/aggregator.js'
import { createQuotaTracker } from '../../src/policy/quota-tracker.js'
import { createQuotaGuard } from '../../src/policy/quota-guard.js'
import { createPolicyEngine, type PolicyDeps } from '../../src/policy/engine.js'
import type { CodexEvent, NetEvent } from '../../src/events.js'

const thresholds = {
  quotaWarn: 80,
  quotaCritical: 95,
  quotaExhausted: 100,
  quotaWarnCooldownMs: 1800000,
  warnEnabled: false,
}

const makeDeps = (over: Partial<PolicyDeps> = {}): PolicyDeps => ({
  classify: (ev) => classify(ev, thresholds),
  aggregator: createAggregator({ minIntervalMs: 1000, maxItems: 5, maxPerDay: 4 }),
  quotaTracker: createQuotaTracker({ thresholds }),
  ...over,
})

const base = { ts: 1, sessionId: 'sess-1', cwd: '/proj' }
const turnComplete = (over: Partial<Extract<CodexEvent, { kind: 'turnComplete' }>> = {}): CodexEvent => ({
  ...base,
  kind: 'turnComplete',
  turnId: 't1',
  durationMs: 1000,
  timeToFirstTokenMs: null,
  lastAgentMessage: 'done',
  ...over,
})
const turnAborted = (): CodexEvent => ({ ...base, kind: 'turnAborted', turnId: 't1', reason: 'interrupted' })
const quota = (usedPercent: number): CodexEvent => ({
  ...base,
  kind: 'quota',
  window: { windowMinutes: 300, usedPercent, resetsAt: null },
})
const net = (verdict: NetEvent['verdict']): NetEvent => ({ ts: 1, verdict, latencyMs: null })

describe('createPolicyEngine', () => {
  it('turnComplete 入聚合池，tick 产出 info，含 Windows 路径的项目名', () => {
    const eng = createPolicyEngine(makeDeps())
    const ev = turnComplete({ cwd: 'd:\\code_store\\大论文', lastAgentMessage: '改引用' })
    expect(eng.onEvent(ev, 0)).toEqual([]) // 聚合不即时发
    const notes = eng.tick(0)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('info')
    expect(notes[0]!.text).toContain('大论文')
  })

  it('turnAborted → 立即推 alert', () => {
    const eng = createPolicyEngine(makeDeps())
    const notes = eng.onEvent(turnAborted(), 0)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('alert')
    expect(notes[0]!.source).toBe('turnAborted')
  })

  it('NetEvent 故障 → alert；ok / slow → 无', () => {
    const eng = createPolicyEngine(makeDeps())
    const down = eng.onEvent(net('proxyDown'), 0)
    expect(down).toHaveLength(1)
    expect(down[0]!.source).toBe('proxyDown')
    expect(eng.onEvent(net('ok'), 0)).toEqual([])
    expect(eng.onEvent(net('slow'), 0)).toEqual([])
  })

  it('quota 100% → 仅 tracker 推一条耗尽 alert（不双发）', () => {
    const eng = createPolicyEngine(makeDeps())
    const notes = eng.onEvent(quota(100), 0)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.source).toBe('quotaExhausted')
    expect(notes[0]!.severity).toBe('alert')
  })

  it('quota 95% → critical', () => {
    const eng = createPolicyEngine(makeDeps())
    const notes = eng.onEvent(quota(95), 0)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('critical')
    expect(notes[0]!.source).toBe('quotaCritical')
  })

  it('quota 80% 且 warnEnabled → warn', () => {
    const eng = createPolicyEngine(
      makeDeps({ classify: (ev) => classify(ev, { ...thresholds, warnEnabled: true }) }),
    )
    const notes = eng.onEvent(quota(80), 0)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.severity).toBe('warn')
    expect(notes[0]!.source).toBe('quotaWarn')
  })

  it('守卫闸门：info 被砍，alert 仍通过', () => {
    const guard = createQuotaGuard({ perActivation: 10, reserveForAlerts: 6, autoReply: false })
    for (let i = 0; i < 4; i++) guard.onSent({ ok: true }) // remaining → 6
    const eng = createPolicyEngine(makeDeps({ quotaGuard: guard }))
    // info（聚合）被砍
    eng.onEvent(turnComplete(), 0)
    expect(eng.tick(0)).toEqual([])
    // alert（turnAborted）仍通过
    expect(eng.onEvent(turnAborted(), 0)).toHaveLength(1)
  })

  it('onDelivery / onInbound 透传给守卫', () => {
    const guard = createQuotaGuard({ perActivation: 10, reserveForAlerts: 6, autoReply: false })
    const eng = createPolicyEngine(makeDeps({ quotaGuard: guard }))
    eng.onDelivery({ ok: true })
    expect(guard.remaining()).toBe(9)
    eng.onInbound({ userId: 'u', text: 'hi', ts: 1 })
    expect(guard.remaining()).toBe(10)
  })

  it('无守卫（飞书）→ 恒放行', () => {
    const eng = createPolicyEngine(makeDeps()) // 不注入 quotaGuard
    expect(eng.onEvent(turnAborted(), 0)).toHaveLength(1)
  })
})

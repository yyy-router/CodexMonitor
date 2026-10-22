import { describe, it, expect } from 'vitest'
import { classify, type Thresholds } from '../../src/policy/classify.js'
import type { CodexEvent, NetEvent } from '../../src/events.js'

const t: Thresholds = {
  quotaWarn: 80,
  quotaCritical: 95,
  quotaExhausted: 100,
  quotaWarnCooldownMs: 1800000,
  warnEnabled: false,
}

const base = { ts: 1, sessionId: 'sess-1', cwd: '/proj' }

const turnComplete: CodexEvent = {
  ...base,
  kind: 'turnComplete',
  turnId: 't1',
  durationMs: 1000,
  timeToFirstTokenMs: null,
  lastAgentMessage: 'done',
}
const turnAborted: CodexEvent = { ...base, kind: 'turnAborted', turnId: 't1', reason: 'x' }
const turnStarted: CodexEvent = { ...base, kind: 'turnStarted', turnId: 't1', rootTurnId: null }

const quota = (usedPercent: number): CodexEvent => ({
  ...base,
  kind: 'quota',
  window: { windowMinutes: 300, usedPercent, resetsAt: null },
})

const net = (verdict: NetEvent['verdict']): NetEvent => ({ ts: 1, verdict, latencyMs: null })

describe('classify', () => {
  it('task_complete → info', () => {
    expect(classify(turnComplete, t)).toBe('info')
  })

  it('turn_aborted → alert', () => {
    expect(classify(turnAborted, t)).toBe('alert')
  })

  it('turnStarted 不推（null）', () => {
    expect(classify(turnStarted, t)).toBeNull()
  })

  it('额度耗尽（≥ quotaExhausted）→ alert', () => {
    expect(classify(quota(100), t)).toBe('alert')
  })

  it('额度 ≥ quotaCritical → critical', () => {
    expect(classify(quota(95), t)).toBe('critical')
    expect(classify(quota(99.9), t)).toBe('critical')
  })

  it('额度 ≥ quotaWarn 且 warnEnabled → warn', () => {
    expect(classify(quota(80), { ...t, warnEnabled: true })).toBe('warn')
    expect(classify(quota(94.9), { ...t, warnEnabled: true })).toBe('warn')
  })

  it('额度 ≥ quotaWarn 但 warnEnabled=false → 不推', () => {
    expect(classify(quota(80), t)).toBeNull()
    expect(classify(quota(94.9), t)).toBeNull()
  })

  it('额度低于 quotaWarn → 不推', () => {
    expect(classify(quota(79.9), { ...t, warnEnabled: true })).toBeNull()
  })

  it('探针 proxyDown / netDown / proxyNotRunning → alert', () => {
    expect(classify(net('proxyDown'), t)).toBe('alert')
    expect(classify(net('netDown'), t)).toBe('alert')
    expect(classify(net('proxyNotRunning'), t)).toBe('alert')
  })

  it('探针 ok → 不推（恢复通知由状态机跃迁在上层产出）', () => {
    expect(classify(net('ok'), t)).toBeNull()
  })

  it('探针 slow → 不推（通但慢，非故障）', () => {
    expect(classify(net('slow'), t)).toBeNull()
  })
})

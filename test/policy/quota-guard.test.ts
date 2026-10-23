import { describe, it, expect } from 'vitest'
import { createQuotaGuard, type QuotaGuardConfig } from '../../src/policy/quota-guard.js'

const cfg: QuotaGuardConfig = { perActivation: 10, reserveForAlerts: 6, autoReply: false }

describe('createQuotaGuard', () => {
  it('初始 remaining = perActivation，非静默', () => {
    const g = createQuotaGuard(cfg)
    expect(g.remaining()).toBe(10)
    expect(g.isSilenced()).toBe(false)
  })

  it('alert / critical 恒可发（remaining > 0 即可）', () => {
    const g = createQuotaGuard(cfg)
    expect(g.canSend('alert')).toBe(true)
    expect(g.canSend('critical')).toBe(true)
  })

  it('info / warn 需 remaining > reserveForAlerts', () => {
    const g = createQuotaGuard(cfg) // remaining 10, reserve 6
    expect(g.canSend('info')).toBe(true)
    expect(g.canSend('warn')).toBe(true)
    // 连发 4 条成功 → remaining 6 → info 被砍，alert 仍可发
    for (let i = 0; i < 4; i++) g.onSent({ ok: true })
    expect(g.remaining()).toBe(6)
    expect(g.canSend('info')).toBe(false)
    expect(g.canSend('warn')).toBe(false)
    expect(g.canSend('alert')).toBe(true)
    expect(g.canSend('critical')).toBe(true)
  })

  it('onSent ok → remaining 递减', () => {
    const g = createQuotaGuard(cfg)
    g.onSent({ ok: true })
    expect(g.remaining()).toBe(9)
  })

  it('onSent errcode -2 → remaining 归零并静默（含 alert 也被砍）', () => {
    const g = createQuotaGuard(cfg)
    g.onSent({ ok: false, errcode: -2 })
    expect(g.remaining()).toBe(0)
    expect(g.isSilenced()).toBe(true)
    expect(g.canSend('alert')).toBe(false)
  })

  it('onSent 其他失败（非 -2）→ 不扣额度', () => {
    const g = createQuotaGuard(cfg)
    g.onSent({ ok: false, reason: 'network error' })
    expect(g.remaining()).toBe(10)
    expect(g.isSilenced()).toBe(false)
  })

  it('onInbound → remaining 重置为 perActivation 并解除静默', () => {
    const g = createQuotaGuard(cfg)
    g.onSent({ ok: false, errcode: -2 }) // 静默
    expect(g.isSilenced()).toBe(true)
    g.onInbound()
    expect(g.remaining()).toBe(10)
    expect(g.isSilenced()).toBe(false)
  })

  it('remaining 递减到 0 后全静默（含 alert）', () => {
    const g = createQuotaGuard(cfg)
    for (let i = 0; i < 10; i++) g.onSent({ ok: true })
    expect(g.remaining()).toBe(0)
    expect(g.isSilenced()).toBe(true)
    expect(g.canSend('alert')).toBe(false)
    expect(g.canSend('critical')).toBe(false)
    expect(g.canSend('info')).toBe(false)
  })
})

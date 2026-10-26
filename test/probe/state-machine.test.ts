import { describe, it, expect } from 'vitest'
import { createProbeStateMachine } from '../../src/probe/state-machine.js'

const mk = (over: { confirmAttempts?: number; recoverAttempts?: number } = {}) =>
  createProbeStateMachine({ confirmAttempts: 2, recoverAttempts: 2, ...over })

const feed = (
  sm: ReturnType<typeof mk>,
  verdicts: Parameters<ReturnType<typeof mk>['next']>[0]['verdict'][],
) => verdicts.map((verdict, i) => sm.next({ verdict, now: i * 1000 }))

describe('createProbeStateMachine', () => {
  it('初始为 normal', () => {
    expect(mk().state()).toBe('normal')
  })

  it('正常态单次非 ok 属抖动，不报警', () => {
    const sm = mk()
    expect(sm.next({ verdict: 'proxyDown', now: 0 })).toEqual({
      transition: 'none',
      state: 'normal',
    })
  })

  it('连续 confirmAttempts 次非 ok → enteredAlert', () => {
    const sm = mk()
    const out = feed(sm, ['proxyDown', 'netDown'])
    expect(out[0]).toEqual({ transition: 'none', state: 'normal' })
    expect(out[1]).toEqual({ transition: 'enteredAlert', state: 'alert' })
  })

  it('抖动被 ok 打断后重新计数', () => {
    const sm = mk()
    const out = feed(sm, ['proxyDown', 'ok', 'proxyDown'])
    expect(out[2]!.transition).toBe('none')
    expect(sm.state()).toBe('normal')
  })

  it('slow 视为链路可用，不计入失败', () => {
    const sm = mk()
    const out = feed(sm, ['slow', 'slow', 'slow'])
    expect(out.every((o) => o.transition === 'none')).toBe(true)
    expect(sm.state()).toBe('normal')
  })

  it('报警态需连续 recoverAttempts 次 ok 才恢复', () => {
    const sm = mk()
    feed(sm, ['proxyDown', 'proxyDown'])
    expect(sm.state()).toBe('alert')

    expect(sm.next({ verdict: 'ok', now: 0 }).transition).toBe('none')
    expect(sm.next({ verdict: 'ok', now: 1000 })).toEqual({
      transition: 'recovered',
      state: 'normal',
    })
  })

  it('报警态恢复过程被非 ok 打断，需重新计数', () => {
    const sm = mk()
    feed(sm, ['proxyDown', 'proxyDown'])
    const out = feed(sm, ['ok', 'netDown', 'ok'])
    expect(out.every((o) => o.transition === 'none')).toBe(true)
    expect(sm.state()).toBe('alert')
  })

  it('自定义阈值：confirmAttempts=3 时两次非 ok 不报警', () => {
    const sm = mk({ confirmAttempts: 3 })
    const out = feed(sm, ['proxyDown', 'proxyDown'])
    expect(out[1]!.state).toBe('normal')
    expect(sm.next({ verdict: 'proxyDown', now: 2000 }).transition).toBe('enteredAlert')
  })
})

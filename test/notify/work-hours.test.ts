import { describe, it, expect } from 'vitest'
import { isWithinWorkHours } from '../../src/notify/work-hours.js'
import { DEFAULT_CONFIG } from '../../src/config.js'

const cfg = (over: Partial<typeof DEFAULT_CONFIG.notify.workHours> = {}) => ({
  ...DEFAULT_CONFIG.notify.workHours,
  timezone: 'UTC',
  ...over,
})
const at = (iso: string): number => Date.parse(iso)

describe('isWithinWorkHours', () => {
  it('工作日 09:00 生效、19:00 失效', () => {
    expect(isWithinWorkHours(at('2026-11-02T08:59:00Z'), cfg())).toBe(false)
    expect(isWithinWorkHours(at('2026-11-02T09:00:00Z'), cfg())).toBe(true)
    expect(isWithinWorkHours(at('2026-11-02T18:59:00Z'), cfg())).toBe(true)
    expect(isWithinWorkHours(at('2026-11-02T19:00:00Z'), cfg())).toBe(false)
  })

  it('默认周末全天静默', () => {
    expect(isWithinWorkHours(at('2026-11-07T10:00:00Z'), cfg())).toBe(false)
    expect(isWithinWorkHours(at('2026-11-08T10:00:00Z'), cfg())).toBe(false)
  })

  it('可选择周末作为工作日', () => {
    expect(isWithinWorkHours(at('2026-11-07T10:00:00Z'), cfg({ days: [6] }))).toBe(true)
    expect(isWithinWorkHours(at('2026-11-08T10:00:00Z'), cfg({ days: [0] }))).toBe(true)
  })

  it('按配置时区计算', () => {
    const shanghai = cfg({ timezone: 'Asia/Shanghai' })
    expect(isWithinWorkHours(at('2026-11-02T00:59:00Z'), shanghai)).toBe(false)
    expect(isWithinWorkHours(at('2026-11-02T01:00:00Z'), shanghai)).toBe(true)
    expect(isWithinWorkHours(at('2026-11-02T10:59:00Z'), shanghai)).toBe(true)
    expect(isWithinWorkHours(at('2026-11-02T11:00:00Z'), shanghai)).toBe(false)
  })

  it('关闭后不限时间', () => {
    expect(isWithinWorkHours(at('2026-11-07T23:00:00Z'), cfg({ enabled: false }))).toBe(true)
  })
})

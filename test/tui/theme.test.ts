import { describe, it, expect } from 'vitest'
import { quotaColor, severityBold, severityColor, verdictColor } from '../../src/tui/theme.js'

describe('severityColor', () => {
  it('按级别映射颜色', () => {
    expect(severityColor('info')).toBe('gray')
    expect(severityColor('warn')).toBe('yellow')
    expect(severityColor('critical')).toBe('red')
    expect(severityColor('alert')).toBe('red')
  })

  it('critical / alert 加粗', () => {
    expect(severityBold('info')).toBe(false)
    expect(severityBold('warn')).toBe(false)
    expect(severityBold('critical')).toBe(true)
    expect(severityBold('alert')).toBe(true)
  })
})

describe('verdictColor', () => {
  it('探针关闭为灰', () => {
    expect(verdictColor('ok', false)).toBe('gray')
  })

  it('按判定映射', () => {
    expect(verdictColor('ok', true)).toBe('green')
    expect(verdictColor('slow', true)).toBe('yellow')
    expect(verdictColor('proxyDown', true)).toBe('red')
    expect(verdictColor('netDown', true)).toBe('red')
    expect(verdictColor('proxyNotRunning', true)).toBe('red')
  })
})

describe('quotaColor', () => {
  it('按阈值映射', () => {
    expect(quotaColor(0, 80, 95)).toBe('green')
    expect(quotaColor(79, 80, 95)).toBe('green')
    expect(quotaColor(80, 80, 95)).toBe('yellow')
    expect(quotaColor(94, 80, 95)).toBe('yellow')
    expect(quotaColor(95, 80, 95)).toBe('red')
    expect(quotaColor(100, 80, 95)).toBe('red')
  })
})

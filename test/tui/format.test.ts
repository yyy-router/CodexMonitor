import { describe, it, expect } from 'vitest'
import {
  formatClock,
  formatCountdown,
  formatLatency,
  formatRelative,
  formatUptime,
  progressBar,
  severityIcon,
  stripEmoji,
  verdictIcon,
} from '../../src/tui/format.js'

describe('stripEmoji', () => {
  it('去掉行首 emoji', () => {
    expect(stripEmoji('🚨 [大论文] 任务被中断')).toBe('[大论文] 任务被中断')
    expect(stripEmoji('✅ 网络已恢复正常')).toBe('网络已恢复正常')
    expect(stripEmoji('📦 2 个任务完成')).toBe('2 个任务完成')
  })

  it('去掉行中 emoji 与 ZWJ 组合', () => {
    expect(stripEmoji('a🚨b')).toBe('ab')
    expect(stripEmoji('👨‍👩‍👧 家庭')).toBe('家庭')
  })

  it('去掉国旗（区域指示符）与变体选择符', () => {
    expect(stripEmoji('🇨🇳 中国')).toBe('中国')
    expect(stripEmoji('❤️ 爱心')).toBe('爱心')
  })

  it('纯文本原样返回', () => {
    expect(stripEmoji('[项目] 任务完成')).toBe('[项目] 任务完成')
    expect(stripEmoji('')).toBe('')
  })
})

describe('progressBar', () => {
  it('按百分比填充，10 格', () => {
    expect(progressBar(0)).toBe('----------')
    expect(progressBar(50)).toBe('#####-----')
    expect(progressBar(62)).toBe('######----')
    expect(progressBar(100)).toBe('##########')
  })

  it('越界钳制', () => {
    expect(progressBar(-10)).toBe('----------')
    expect(progressBar(150)).toBe('##########')
    expect(progressBar(Number.NaN)).toBe('----------')
  })

  it('支持自定义宽度', () => {
    expect(progressBar(50, 4)).toBe('##--')
  })
})

describe('verdictIcon', () => {
  it('关闭 / 暂停优先', () => {
    expect(verdictIcon('ok', { paused: false, enabled: false })).toBe('[off]')
    expect(verdictIcon('proxyDown', { paused: true, enabled: true })).toBe('[--]')
  })

  it('按判定映射', () => {
    expect(verdictIcon('ok', { paused: false, enabled: true })).toBe('[OK]')
    expect(verdictIcon('slow', { paused: false, enabled: true })).toBe('[~~]')
    expect(verdictIcon('proxyDown', { paused: false, enabled: true })).toBe('[!!]')
    expect(verdictIcon('netDown', { paused: false, enabled: true })).toBe('[!!]')
    expect(verdictIcon('proxyNotRunning', { paused: false, enabled: true })).toBe('[!!]')
  })
})

describe('severityIcon', () => {
  it('四个级别', () => {
    expect(severityIcon('info')).toBe('[i]')
    expect(severityIcon('warn')).toBe('[!]')
    expect(severityIcon('critical')).toBe('[!!]')
    expect(severityIcon('alert')).toBe('[!!!]')
  })
})

describe('时间格式', () => {
  it('formatClock 输出本地时分秒', () => {
    const ts = new Date(2026, 0, 1, 13, 5, 9).getTime()
    expect(formatClock(ts)).toBe('13:05:09')
  })

  it('formatUptime 输出 HH:MM:SS', () => {
    expect(formatUptime(0)).toBe('00:00:00')
    expect(formatUptime(3_723_000)).toBe('01:02:03')
  })

  it('formatRelative', () => {
    expect(formatRelative(999)).toBe('刚刚')
    expect(formatRelative(3_000)).toBe('3s 前')
    expect(formatRelative(90_000)).toBe('1m 前')
    expect(formatRelative(3_600_000)).toBe('1h 前')
  })

  it('formatLatency', () => {
    expect(formatLatency(null)).toBe('-')
    expect(formatLatency(942)).toBe('942ms')
  })

  it('formatCountdown', () => {
    expect(formatCountdown(0)).toBe('已到重置时间')
    expect(formatCountdown(-5_000)).toBe('已到重置时间')
    expect(formatCountdown(30_000)).toBe('30s')
    expect(formatCountdown(90_000)).toBe('1m')
    expect(formatCountdown(2 * 3_600_000 + 13 * 60_000)).toBe('2h 13m')
    expect(formatCountdown((5 * 24 + 3) * 3_600_000)).toBe('5d 3h')
  })
})

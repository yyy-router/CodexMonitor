import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Wordmark } from '../../src/tui/components/Wordmark.js'
import { StatusPanel } from '../../src/tui/components/StatusPanel.js'
import { NotificationList } from '../../src/tui/components/NotificationList.js'
import { createInitialState, reduce, type TuiState } from '../../src/tui/store.js'

const initial = (): TuiState =>
  createInitialState({ channel: 'feishu', probeEnabled: true, now: 1_000_000 })

describe('Wordmark', () => {
  it('渲染 CodexMonitor 大字', () => {
    const { lastFrame, unmount } = render(<Wordmark seconds={0} />)
    expect(lastFrame() ?? '').toContain('CodexMonitor')
    unmount()
  })
})

describe('StatusPanel', () => {
  const withQuota = (): TuiState =>
    reduce(initial(), {
      type: 'event',
      event: {
        type: 'quota',
        snapshot: {
          fiveHour: {
            windowMinutes: 300,
            usedPercent: 62,
            resetsAt: 1_000 + 2 * 3_600 + 13 * 60,
            waiting: false,
            notifiedExhausted: false,
            notifiedReset: false,
            notifiedCritical: false,
            lastResetResetsAt: null,
            lastProcessedTs: 1,
            lastUpdatedAt: 1,
          },
        },
      },
      now: 1_000_000,
    })

  it('渲染额度条与重置倒计时；缺失窗口显示 --', () => {
    const { lastFrame, unmount } = render(<StatusPanel state={withQuota()} width={26} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('5h')
    expect(frame).toContain('62%')
    expect(frame).toContain('重置 2h 13m 后')
    expect(frame).toContain('7d --')
    unmount()
  })

  it('渲染投递统计', () => {
    const state = reduce(withQuota(), { type: 'event', event: { type: 'pending', count: 2 }, now: 1_000_000 })
    const { lastFrame, unmount } = render(<StatusPanel state={state} width={26} />)
    expect(lastFrame() ?? '').toContain('待发 2')
    unmount()
  })

  it('重置时间已过：显示「已到重置时间」', () => {
    const state = reduce(initial(), {
      type: 'event',
      event: {
        type: 'quota',
        snapshot: {
          fiveHour: {
            windowMinutes: 300,
            usedPercent: 62,
            resetsAt: 900,
            waiting: false,
            notifiedExhausted: false,
            notifiedReset: false,
            notifiedCritical: false,
            lastResetResetsAt: null,
            lastProcessedTs: 1,
            lastUpdatedAt: 1,
          },
        },
      },
      now: 1_000_000,
    })
    const { lastFrame, unmount } = render(<StatusPanel state={state} width={26} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('已到重置时间')
    expect(frame).not.toContain('即将重置')
    unmount()
  })
})

describe('NotificationList', () => {
  const withNotes = (): TuiState => {
    let s = initial()
    s = reduce(s, {
      type: 'event',
      event: {
        type: 'delivered',
        note: { id: 'n1', ts: 0, severity: 'alert', text: '🚨 [大论文] 任务被中断', source: 'x' },
        result: { ok: true },
      },
      now: 70_000,
    })
    s = reduce(s, {
      type: 'event',
      event: {
        type: 'delivered',
        note: { id: 'n2', ts: 0, severity: 'info', text: '📦 2 个任务完成', source: 'x' },
        result: { ok: false, reason: 'down' },
      },
      now: 71_000,
    })
    return s
  }

  it('正文去掉 emoji，失败条目带 FAIL 标记', () => {
    const { lastFrame, unmount } = render(<NotificationList state={withNotes()} width={60} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[大论文] 任务被中断')
    expect(frame).toContain('2 个任务完成')
    expect(frame).not.toContain('🚨')
    expect(frame).not.toContain('📦')
    expect(frame).toContain('(FAIL)')
    unmount()
  })

  it('长正文被截断时 FAIL 标记仍可见', () => {
    let s = initial()
    s = reduce(s, {
      type: 'event',
      event: {
        type: 'delivered',
        note: { id: 'n', ts: 0, severity: 'info', text: 'x'.repeat(300), source: 'x' },
        result: { ok: false, reason: 'down' },
      },
      now: 70_000,
    })
    const { lastFrame, unmount } = render(<NotificationList state={s} width={40} />)
    expect(lastFrame() ?? '').toContain('(FAIL)')
    unmount()
  })

  it('无通知时显示空状态', () => {
    const { lastFrame, unmount } = render(<NotificationList state={initial()} width={60} />)
    expect(lastFrame() ?? '').toContain('暂无通知')
    unmount()
  })
})

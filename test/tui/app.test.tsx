import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { App } from '../../src/tui/app.js'
import { createInitialState, createTuiStore } from '../../src/tui/store.js'
import type { Controls } from '../../src/index.js'
import type { WorkHoursConfig } from '../../src/config.js'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const setup = (init: { now?: number; workHours?: WorkHoursConfig } = {}) => {
  const store = createTuiStore(
    createInitialState({
      channel: 'console',
      probeEnabled: true,
      now: init.now ?? 0,
      workHours: init.workHours,
    }),
  )
  const calls: string[] = []
  const controls: Controls = {
    sendTest: async () => {
      calls.push('sendTest')
    },
    setProbePaused: (paused) => {
      calls.push(`pause:${paused}`)
    },
    stop: async () => {},
  }
  return { store, controls, calls }
}

describe('App', () => {
  it('渲染状态头与快捷键', () => {
    const { store, controls } = setup()
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('通道 console')
    expect(frame).toContain('[q] 退出')
    unmount()
  })

  it('显示工作时间段与当前推送状态', () => {
    const workHours: WorkHoursConfig = {
      enabled: true,
      start: '09:00',
      end: '19:00',
      days: [1, 2, 3, 4, 5],
      timezone: 'UTC',
    }
    const { store, controls } = setup({ now: Date.UTC(2026, 10, 2, 10, 0), workHours })
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={100} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('工作 周一–周五 09:00–19:00')
    expect(frame).toContain('推送中')
    unmount()
  })

  it('工作时间外显示静默中', () => {
    const workHours: WorkHoursConfig = {
      enabled: true,
      start: '09:00',
      end: '19:00',
      days: [1, 2, 3, 4, 5],
      timezone: 'UTC',
    }
    const { store, controls } = setup({ now: Date.UTC(2026, 10, 2, 20, 0), workHours })
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={100} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('工作 周一–周五 09:00–19:00')
    expect(frame).toContain('静默中')
    unmount()
  })

  it('通知正文去掉 emoji 后显示', () => {
    const { store, controls } = setup()
    store.dispatch({
      type: 'event',
      event: {
        type: 'delivered',
        note: { id: 'n1', ts: 0, severity: 'alert', text: '🚨 [大论文] 任务被中断', source: 'x' },
        result: { ok: true },
      },
      now: 1000,
    })
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[大论文] 任务被中断')
    expect(frame).not.toContain('🚨')
    unmount()
  })

  it('窄终端退化为单列，仍显示全部区块', () => {
    const { store, controls } = setup()
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={60} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('额度')
    expect(frame).toContain('投递')
    expect(frame).toContain('最近通知')
    unmount()
  })

  it('通知很多时按终端高度收口，顶部状态不被顶出屏幕', () => {
    const { store, controls } = setup()
    for (let i = 0; i < 10; i++) {
      store.dispatch({
        type: 'event',
        event: {
          type: 'delivered',
          note: { id: `n${i}`, ts: i, severity: 'info', text: `任务${i}\n详情${i}`, source: 'x' },
          result: { ok: true },
        },
        now: 1000 + i,
      })
    }
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={100} rows={16} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('额度')
    expect(frame).toContain('任务9 详情9')
    expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(16)
    unmount()
  })

  const quotaWindow = (
    windowMinutes: 300 | 10080,
    usedPercent: number,
    resetsAt: number,
  ) => ({
    windowMinutes,
    usedPercent,
    resetsAt,
    waiting: false,
    notifiedExhausted: false,
    notifiedReset: false,
    notifiedCritical: false,
    lastResetResetsAt: null,
    lastProcessedTs: 0,
    lastUpdatedAt: 0,
  })

  const pushQuota = (store: ReturnType<typeof setup>['store']): void => {
    store.dispatch({
      type: 'event',
      event: {
        type: 'quota',
        snapshot: {
          fiveHour: quotaWindow(300, 84, 2_000),
          sevenDay: quotaWindow(10080, 21, 3_000),
        },
      },
      now: 1000,
    })
  }

  const pushNotes = (store: ReturnType<typeof setup>['store'], count: number): void => {
    for (let i = 0; i < count; i++) {
      store.dispatch({
        type: 'event',
        event: {
          type: 'delivered',
          note: { id: `q${i}`, ts: i, severity: 'info', text: `通知${i}\n详情${i}`, source: 'x' },
          result: { ok: true },
        },
        now: 1000 + i,
      })
    }
  }

  it('60x18 且双额度倒计时：顶部仍可见且不超屏', () => {
    const { store, controls } = setup()
    pushQuota(store)
    pushNotes(store, 3)
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={60} rows={18} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('CodexMonitor')
    expect(frame).toContain('额度')
    expect(frame).toContain('5h')
    expect(frame).toContain('最近通知')
    expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(18)
    unmount()
  })

  it('60x16 极矮终端：进入紧凑模式，额度仍可见', () => {
    const { store, controls } = setup()
    pushQuota(store)
    pushNotes(store, 3)
    const { lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} columns={60} rows={16} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('额度')
    expect(frame).toContain('5h')
    expect(frame).toContain('7d')
    expect(frame).not.toContain('投递')
    expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(16)
    unmount()
  })

  it('按 n 在最近通知与静默通知之间切换', async () => {
    const { store, controls } = setup()
    store.dispatch({
      type: 'event',
      event: {
        type: 'suppressed',
        entry: {
          ts: 1000,
          severity: 'alert',
          source: 'probeDown',
          text: '静默告警',
          reason: 'workHours',
        },
      },
      now: 1000,
    })
    store.dispatch({
      type: 'event',
      event: {
        type: 'delivered',
        note: { id: 'n', ts: 0, severity: 'info', text: '已发送通知', source: 'x' },
        result: { ok: true },
      },
      now: 1001,
    })

    const { stdin, lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    stdin.write('n')
    await delay(20)
    expect(lastFrame() ?? '').toContain('静默通知（1）')
    expect(lastFrame() ?? '').toContain('静默告警')

    stdin.write('n')
    await delay(20)
    expect(lastFrame() ?? '').toContain('最近通知')
    expect(lastFrame() ?? '').toContain('已发送通知')
    unmount()
  })

  it('按 t 触发测试通知', async () => {
    const { store, controls, calls } = setup()
    const { stdin, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    stdin.write('t')
    await delay(20)
    expect(calls).toContain('sendTest')
    unmount()
  })

  it('按 p 暂停探针并提示', async () => {
    const { store, controls, calls } = setup()
    const { stdin, lastFrame, unmount } = render(
      <App store={store} controls={controls} onReload={async () => 'ok'} />,
    )
    stdin.write('p')
    await delay(20)
    expect(calls).toContain('pause:true')
    expect(lastFrame() ?? '').toContain('探针已暂停')
    unmount()
  })
})

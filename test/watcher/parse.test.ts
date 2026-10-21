import { describe, it, expect } from 'vitest'
import { parseLine, parseSessionMeta } from '../../src/watcher/parse.js'

const ctx = { sessionId: 'sess-1', cwd: 'd:\\code_store\\大论文', isRoot: true }

describe('parseSessionMeta', () => {
  it('提取 session_id、cwd 与 isRoot（根会话 id === session_id）', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'abc-123', session_id: 'abc-123', cwd: 'd:\\code_store\\大论文' },
    })
    expect(parseSessionMeta(line)).toEqual({
      sessionId: 'abc-123',
      cwd: 'd:\\code_store\\大论文',
      isRoot: true,
    })
  })

  it('子线程（id !== session_id）isRoot 为 false', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'child-1', session_id: 'abc-123', cwd: 'd:\\code_store\\大论文' },
    })
    expect(parseSessionMeta(line)).toEqual({
      sessionId: 'abc-123',
      cwd: 'd:\\code_store\\大论文',
      isRoot: false,
    })
  })

  it('非 session_meta 返回 null', () => {
    expect(parseSessionMeta(JSON.stringify({ type: 'event_msg' }))).toBeNull()
  })

  it('非法 JSON 返回 null', () => {
    expect(parseSessionMeta('not json')).toBeNull()
  })
})

describe('parseLine', () => {
  it('解析 task_started 为 turnStarted', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:17:25.508Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', root_turn_id: 'root-1' },
    })
    expect(parseLine(line, ctx)).toEqual([
      {
        kind: 'turnStarted',
        ts: Date.parse('2026-10-14T06:17:25.508Z'),
        sessionId: 'sess-1',
        cwd: 'd:\\code_store\\大论文',
        turnId: 'turn-1',
        rootTurnId: 'root-1',
      },
    ])
  })

  it('解析 task_complete 为 turnComplete', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:30:49.090Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        duration_ms: 803583,
        time_to_first_token_ms: 119782,
        last_agent_message: '完成',
      },
    })
    const evts = parseLine(line, ctx)
    expect(evts).toHaveLength(1)
    expect(evts[0]).toMatchObject({
      kind: 'turnComplete',
      turnId: 'turn-1',
      durationMs: 803583,
      timeToFirstTokenMs: 119782,
      lastAgentMessage: '完成',
    })
  })

  it('解析 turn_aborted 为 turnAborted', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-15T02:23:49.527Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-9', reason: 'interrupted' },
    })
    expect(parseLine(line, ctx)).toMatchObject([
      { kind: 'turnAborted', turnId: 'turn-9', reason: 'interrupted' },
    ])
  })

  it('解析 token_count：rate_limits 在 payload 顶层，产出 primary + secondary 两个 quota 事件', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:19:27.088Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { rate_limits: null }, // 陷阱：info.rate_limits 恒为 null
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 61.0, window_minutes: 300, resets_at: 1789024602 },
          secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: 1789533808 },
        },
      },
    })
    const evts = parseLine(line, ctx)
    expect(evts).toHaveLength(2)
    expect(evts[0]).toMatchObject({
      kind: 'quota',
      window: { windowMinutes: 300, usedPercent: 61.0, resetsAt: 1789024602 },
    })
    expect(evts[1]).toMatchObject({
      kind: 'quota',
      window: { windowMinutes: 10080, usedPercent: 10.0, resetsAt: 1789533808 },
    })
  })

  it('window_minutes 为 null 时保留 null', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:19:27.088Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 5.0, window_minutes: null, resets_at: null },
        },
      },
    })
    const evts = parseLine(line, ctx)
    expect(evts).toHaveLength(1)
    expect(evts[0]).toMatchObject({
      kind: 'quota',
      window: { windowMinutes: null, usedPercent: 5.0, resetsAt: null },
    })
  })

  it('resets_at 缺失时置 null（不崩溃）', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:19:27.088Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 5.0, window_minutes: 300 } },
      },
    })
    expect(parseLine(line, ctx)).toMatchObject([
      { kind: 'quota', window: { resetsAt: null } },
    ])
  })

  it('used_percent 为 null 时跳过该窗口', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:19:27.088Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: null, window_minutes: 300, resets_at: 1 } },
      },
    })
    expect(parseLine(line, ctx)).toEqual([])
  })

  it('忽略无关类型（response_item 等）', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:17:26.000Z',
      type: 'response_item',
      payload: { type: 'message' },
    })
    expect(parseLine(line, ctx)).toEqual([])
  })

  it('忽略未知 payload.type', () => {
    const line = JSON.stringify({
      timestamp: '2026-10-14T06:17:26.000Z',
      type: 'event_msg',
      payload: { type: 'something_unknown' },
    })
    expect(parseLine(line, ctx)).toEqual([])
  })

  it('非法 JSON 返回空数组', () => {
    expect(parseLine('not json', ctx)).toEqual([])
  })
})

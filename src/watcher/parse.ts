import type { CodexEvent, EventBase, QuotaWindow, SessionContext } from '../events.js'

type Json = Record<string, unknown>

function safeParse(line: string): Json | null {
  try {
    const v = JSON.parse(line)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
  } catch {
    return null
  }
}

function asObj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 解析 session_meta 行，提取会话上下文。
 * 每个 rollout 文件的首行通常是 session_meta，包含 session_id 与 cwd。
 */
export function parseSessionMeta(line: string): SessionContext | null {
  const obj = safeParse(line)
  if (!obj || obj.type !== 'session_meta') return null
  const p = asObj(obj.payload)
  if (!p) return null
  const sessionId = str(p.session_id)
  const cwd = str(p.cwd)
  if (!sessionId) return null
  return { sessionId, cwd }
}

/**
 * 解析一行事件，返回规范化的事件数组。
 *
 * 正常情况下返回 0 或 1 个事件；token_count 因包含 primary + secondary
 * 两个额度窗口，会返回 0~2 个 quota 事件。
 */
export function parseLine(line: string, ctx: SessionContext): CodexEvent[] {
  const obj = safeParse(line)
  if (!obj || obj.type !== 'event_msg') return []
  const p = asObj(obj.payload)
  if (!p) return []

  const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
  if (Number.isNaN(ts)) return []

  const base: EventBase = { ts, sessionId: ctx.sessionId, cwd: ctx.cwd }

  switch (p.type) {
    case 'task_started':
      return [
        {
          ...base,
          kind: 'turnStarted',
          turnId: str(p.turn_id),
          rootTurnId: p.root_turn_id == null ? null : str(p.root_turn_id),
        },
      ]
    case 'task_complete':
      return [
        {
          ...base,
          kind: 'turnComplete',
          turnId: str(p.turn_id),
          durationMs: num(p.duration_ms) ?? 0,
          timeToFirstTokenMs: p.time_to_first_token_ms == null ? null : num(p.time_to_first_token_ms),
          lastAgentMessage: str(p.last_agent_message),
        },
      ]
    case 'turn_aborted':
      return [
        {
          ...base,
          kind: 'turnAborted',
          turnId: str(p.turn_id),
          reason: str(p.reason),
        },
      ]
    case 'token_count':
      return parseTokenCount(base, p)
    default:
      return []
  }
}

function parseTokenCount(base: EventBase, payload: Json): CodexEvent[] {
  // 实测：rate_limits 在 payload.rate_limits；payload.info.rate_limits 恒为 null。
  // 用 ?? 回退到 info.rate_limits 以兼容旧格式。
  const info = asObj(payload.info)
  const rl = asObj(payload.rate_limits) ?? asObj(info?.rate_limits)
  if (!rl) return []

  const out: CodexEvent[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const w = asObj(rl[key])
    if (!w) continue

    const usedPercent = num(w.used_percent)
    if (usedPercent == null) continue // used_percent 缺失 → 跳过该窗口

    const window: QuotaWindow = {
      windowMinutes: w.window_minutes == null ? null : num(w.window_minutes),
      usedPercent,
      resetsAt: w.resets_at == null ? null : num(w.resets_at),
    }
    out.push({ ...base, kind: 'quota', window })
  }
  return out
}

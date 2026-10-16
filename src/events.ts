/**
 * 事件类型定义。
 *
 * Codex 会话日志（~/.codex/sessions/**\/rollout-*.jsonl）的每一行是一个 JSON。
 * 顶层结构：{ timestamp, ordinal, type, payload }。
 * 我们关心的三类顶层 type：
 *   - `session_meta`  —— 会话元信息（cwd、session_id、source），用于给事件补充来源标识
 *   - `event_msg`     —— 带业务语义的事件，见 payload.type（task_started / task_complete / token_count / turn_aborted …）
 *   - 其余（response_item / token_usage_record / world_state / compacted …）忽略
 */

/** 会话上下文，来自每个文件首行的 session_meta，由 tailer 维护并注入到每个事件 */
export type SessionContext = {
  sessionId: string
  cwd: string
}

export type EventBase = {
  /** 事件发生时间，unix 毫秒 */
  ts: number
  sessionId: string
  cwd: string
}

/**
 * 额度窗口。实测要点（见 AGENTS.md）：
 * - `rate_limits` 在 `payload.rate_limits`，不在 `payload.info.rate_limits`
 * - 窗口按 `window_minutes` 识别（300=5h、10080=7d），不能按 primary/secondary 位置
 * - `window_minutes` 可能出现 null / 未知值（如 43200），`resets_at` 可能缺失
 */
export type QuotaWindow = {
  /** 300=5 小时窗口，10080=7 天窗口，null=脏数据，其他=未知窗口（由上层忽略） */
  windowMinutes: number | null
  /** 0~100，已用百分比 */
  usedPercent: number
  /** 计划重置时刻，unix 秒；null=缺失（倒计时跳过） */
  resetsAt: number | null
}

export type CodexEvent =
  | (EventBase & {
      kind: 'turnStarted'
      turnId: string
      rootTurnId: string | null
    })
  | (EventBase & {
      kind: 'turnComplete'
      turnId: string
      durationMs: number
      timeToFirstTokenMs: number | null
      lastAgentMessage: string
    })
  | (EventBase & {
      kind: 'turnAborted'
      turnId: string
      reason: string
    })
  | (EventBase & {
      kind: 'quota'
      window: QuotaWindow
    })

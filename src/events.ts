/**
 * 事件类型定义。
 *
 * Codex 会话日志（~/.codex/sessions/**\/rollout-*.jsonl）的每一行是一个 JSON。
 * 顶层结构：{ timestamp, ordinal, type, payload }。
 * 我们关心的三类顶层 type：
 *   - `session_meta`  —— 会话元信息（cwd、session_id、source），用于给事件补充来源标识
 *   - `event_msg`     —— 带业务语义的事件，见 payload.type（task_started / task_complete / token_count / turn_aborted …）
 *   - 其余（response_item / token_usage_record / world_state / compacted …）忽略
 *
 * 除 Codex 事件外，本文件还承载跨模块的三种核心类型：
 *   - NetEvent / ProbeVerdict —— 网络探针产出
 *   - Notification / Severity —— PolicyEngine 产出、Notifier 投递
 */

/** 会话上下文，来自每个文件首行的 session_meta，由 tailer 维护并注入到每个事件 */
export type SessionContext = {
  sessionId: string
  cwd: string
  /** 是否为根会话（id === session_id）；子线程为 false，tailer 据此过滤避免重复通知 */
  isRoot: boolean
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

/**
 * 通知级别，按严重程度递增：info < warn < critical < alert。
 * 分级依据见设计文档 §4.3 / §5；`alert` 与 `critical` 永不被配额守卫砍掉。
 */
export type Severity = 'info' | 'warn' | 'critical' | 'alert'

/**
 * PolicyEngine 产出、交给 Notifier 投递的通知。
 * 这是「该不该推 / 推什么」决策的最终产物，尚未经过任何网络 IO。
 */
export type Notification = {
  /** 幂等去重键，同一逻辑事件重复触发时值相同 */
  id: string
  /** 产生时间，unix 毫秒 */
  ts: number
  severity: Severity
  /** 最终发送给用户的完整文案 */
  text: string
  /** 触发来源标识（turnComplete / quotaExhausted / probeDown …），供投递日志与去重 */
  source: string
}

/**
 * 网络探针判定（§4.2）：
 *   ok=链路通，slow=通但延迟高，proxyDown=代理节点挂了，
 *   netDown=整体断网，proxyNotRunning=代理程序未运行。
 */
export type ProbeVerdict = 'ok' | 'slow' | 'proxyDown' | 'netDown' | 'proxyNotRunning'

/** NetProbe 产出、进入 PolicyEngine 的事件。网络是全局的，与 Codex 会话解耦。 */
export type NetEvent = {
  ts: number
  verdict: ProbeVerdict
  /** 出口链路耗时（L2），毫秒；探测失败时为 null */
  latencyMs: number | null
}

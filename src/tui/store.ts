/** TUI 状态：纯 reducer + 一个极小的可订阅 store（供 useSyncExternalStore） */

import type { Channel } from '../config.js'
import type { ProbeVerdict, Severity } from '../events.js'
import type { QuotaSnapshot } from '../policy/quota-tracker.js'
import type { ProbeState } from '../probe/state-machine.js'
import type { RuntimeEvent } from '../runtime.js'

export const MAX_LOG = 50
export const TOAST_MS = 5_000

export type LogEntry = {
  at: number
  severity: Severity
  /** 原文（含 emoji），渲染时再净化 */
  text: string
  /** null = 本地提示，非投递结果 */
  ok: boolean | null
}

export type TuiState = {
  startedAt: number
  now: number
  channel: Channel
  probeEnabled: boolean
  probePaused: boolean
  probe: {
    verdict: ProbeVerdict
    status: number | null
    latencyMs: number | null
    at: number
    state: ProbeState
  } | null
  quota: QuotaSnapshot
  deliveredCount: number
  pendingCount: number
  lastDeliveryOk: boolean | null
  log: LogEntry[]
  toast: { text: string; at: number } | null
}

export type TuiAction =
  | { type: 'event'; event: RuntimeEvent; now: number }
  | { type: 'tick'; now: number }
  | { type: 'toast'; text: string; now: number }
  | { type: 'probePaused'; paused: boolean; now: number }
  | { type: 'config'; probeEnabled: boolean; now: number }

export function createInitialState(input: {
  channel: Channel
  probeEnabled: boolean
  now: number
}): TuiState {
  return {
    startedAt: input.now,
    now: input.now,
    channel: input.channel,
    probeEnabled: input.probeEnabled,
    probePaused: false,
    probe: null,
    quota: {},
    deliveredCount: 0,
    pendingCount: 0,
    lastDeliveryOk: null,
    log: [],
    toast: null,
  }
}

export function reduce(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'event': {
      const e = action.event
      switch (e.type) {
        case 'delivered':
          return {
            ...state,
            deliveredCount: state.deliveredCount + (e.result.ok ? 1 : 0),
            lastDeliveryOk: e.result.ok,
            log: [
              ...state.log,
              { at: action.now, severity: e.note.severity, text: e.note.text, ok: e.result.ok },
            ].slice(-MAX_LOG),
          }
        case 'pending':
          return { ...state, pendingCount: e.count }
        case 'probe':
          return {
            ...state,
            probe: {
              verdict: e.result.verdict,
              status: e.result.l2.status,
              latencyMs: e.result.l2.latencyMs,
              at: action.now,
              state: e.state,
            },
          }
        case 'quota':
          return { ...state, quota: e.snapshot }
      }
      return state
    }
    case 'tick': {
      const toast = state.toast && action.now - state.toast.at > TOAST_MS ? null : state.toast
      return { ...state, now: action.now, toast }
    }
    case 'toast':
      return { ...state, toast: { text: action.text, at: action.now } }
    case 'probePaused':
      return { ...state, probePaused: action.paused, now: action.now }
    case 'config':
      return {
        ...state,
        probeEnabled: action.probeEnabled,
        // 探针被关掉时暂停标志必须一起清掉，否则界面会一直显示「已暂停」
        probePaused: action.probeEnabled ? state.probePaused : false,
        now: action.now,
      }
    default:
      // 运行时防御：未知 action 不改状态，避免把 state 变成 undefined
      return state
  }
}

export type TuiStore = {
  getState(): TuiState
  dispatch(action: TuiAction): void
  subscribe(listener: () => void): () => void
}

export function createTuiStore(initial: TuiState): TuiStore {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action)
      if (next === state) return
      state = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

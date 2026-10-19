/**
 * 探针状态机（纯函数，§4.2）。
 *
 * 带滞回：正常 → 连续 confirmAttempts 次非 ok → 报警；
 * 报警 → 连续 recoverAttempts 次 ok → 恢复。
 * 抖动过滤：正常态下短暂的非 ok 若在下一次 ok 前未凑满 confirmAttempts，不报警。
 *
 * 「3s 快速重试」的调度属 probe 循环（retryDelayMs），本状态机只做连续计数，
 * 因此是纯 reducer，可完整单测。now 仅用于记账，不影响状态迁移判定。
 */

import type { ProbeVerdict } from '../events.js'

export type ProbeState = 'normal' | 'alert'

export type StateTransition = 'none' | 'enteredAlert' | 'recovered'

export type StateMachineConfig = {
  /** 连续多少次非 ok 才进入报警 */
  confirmAttempts: number
  /** 连续多少次 ok 才恢复 */
  recoverAttempts: number
}

export type ProbeStateMachine = {
  /** 喂入一次探测判定，返回本次迁移与当前状态 */
  next(input: { verdict: ProbeVerdict; now: number }): {
    transition: StateTransition
    state: ProbeState
  }
  state(): ProbeState
}

export function createProbeStateMachine(_cfg: StateMachineConfig): ProbeStateMachine {
  throw new Error('Not implemented: createProbeStateMachine')
}

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

/** slow 表示链路仍通（只是慢），不参与报警判定；报警文案里也从未出现它 */
const isHealthy = (v: ProbeVerdict): boolean => v === 'ok' || v === 'slow'

export function createProbeStateMachine(cfg: StateMachineConfig): ProbeStateMachine {
  let state: ProbeState = 'normal'
  let failStreak = 0
  let okStreak = 0

  return {
    next({ verdict }) {
      if (state === 'normal') {
        if (isHealthy(verdict)) {
          failStreak = 0
          return { transition: 'none', state }
        }
        failStreak += 1
        if (failStreak >= cfg.confirmAttempts) {
          state = 'alert'
          failStreak = 0
          okStreak = 0
          return { transition: 'enteredAlert', state }
        }
        return { transition: 'none', state }
      }

      // alert 态：只有连续 ok 才恢复；slow 同样视为链路已通
      if (isHealthy(verdict)) {
        okStreak += 1
        if (okStreak >= cfg.recoverAttempts) {
          state = 'normal'
          failStreak = 0
          okStreak = 0
          return { transition: 'recovered', state }
        }
      } else {
        okStreak = 0
      }
      return { transition: 'none', state }
    },

    state() {
      return state
    },
  }
}

/**
 * 组装 + 生命周期 + tick 循环（§3）。
 *
 * 单一常驻 Node 进程，模块间用 EventEmitter 解耦：
 *   config → tailer / probe / policyEngine / notifier / deliveryLog / stateStore
 *   tick 循环：tailer.tick() + quotaTracker.tick() + aggregator flush → 通知 → 配额守卫 → 投递
 *   probe 定时器：每 intervalMs 跑一轮 → 状态机 → NetEvent → policyEngine
 */

import type { Config } from './config.js'

/** 组装全部模块并启动常驻循环；返回的 Promise 在收到停止信号后 resolve */
export async function main(_config?: Config): Promise<void> {
  throw new Error('Not implemented: main')
}

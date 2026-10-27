/**
 * 开发 / 测试用 Notifier，打印到 stdout。
 * 用于集成测试替身（见设计文档 §8）。
 */

import type { Notification } from '../events.js'
import type { Notifier, DeliveryResult, InboundMessage } from './notifier.js'

export type ConsoleNotifierOptions = {
  /** 输出函数，测试可注入；默认 console.log */
  log?: (line: string) => void
}

export class ConsoleNotifier implements Notifier {
  private readonly log: (line: string) => void

  constructor(opts: ConsoleNotifierOptions = {}) {
    this.log = opts.log ?? ((line) => console.log(line))
  }

  /** 无资源需初始化 */
  async start(): Promise<void> {}

  /** 无资源需释放 */
  async stop(): Promise<void> {}

  async send(n: Notification): Promise<DeliveryResult> {
    this.log(`[${n.severity}] ${n.text}`)
    return { ok: true, messageId: `console-${n.id}` }
  }

  /** 控制台通道没有入站消息；仅为满足接口，收到 handler 也不会有回调 */
  onInbound(_handler: (msg: InboundMessage) => void): void {}
}

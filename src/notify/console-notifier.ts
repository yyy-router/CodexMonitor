/**
 * 开发 / 测试用 Notifier，打印到 stdout。
 * 用于集成测试替身（见设计文档 §8）。
 */

import type { Notification } from '../events.js'
import type { Notifier, DeliveryResult, InboundMessage } from './notifier.js'

export class ConsoleNotifier implements Notifier {
  async start(): Promise<void> {
    throw new Error('Not implemented: ConsoleNotifier.start')
  }

  async stop(): Promise<void> {
    throw new Error('Not implemented: ConsoleNotifier.stop')
  }

  async send(_n: Notification): Promise<DeliveryResult> {
    throw new Error('Not implemented: ConsoleNotifier.send')
  }

  onInbound(_handler: (msg: InboundMessage) => void): void {
    throw new Error('Not implemented: ConsoleNotifier.onInbound')
  }
}

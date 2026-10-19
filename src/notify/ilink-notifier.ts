/**
 * iLink 推送实现，基于 @wechatbot/wechatbot（§3）。
 *
 * SDK 踩坑见 AGENTS.md「@wechatbot/wechatbot@2.2.0 的坑」：
 *   1. loginCallbacks 必须传给 bot.login({ callbacks })
 *   2. contextStore.load() 只在 start() 里调用
 *   3. start() 阻塞到轮询结束
 *   4. 发送失败返回 HTTP 200 + errcode -2
 */

import type { Notification } from '../events.js'
import type { Notifier, DeliveryResult, InboundMessage } from './notifier.js'

export type ILinkNotifierOptions = {
  userId: string
  storageDir: string
}

export class ILinkNotifier implements Notifier {
  constructor(_opts: ILinkNotifierOptions) {}

  async start(): Promise<void> {
    throw new Error('Not implemented: ILinkNotifier.start')
  }

  async stop(): Promise<void> {
    throw new Error('Not implemented: ILinkNotifier.stop')
  }

  async send(_n: Notification): Promise<DeliveryResult> {
    throw new Error('Not implemented: ILinkNotifier.send')
  }

  onInbound(_handler: (msg: InboundMessage) => void): void {
    throw new Error('Not implemented: ILinkNotifier.onInbound')
  }
}

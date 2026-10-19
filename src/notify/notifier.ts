/**
 * Notifier 接口 + 分片逻辑（§4.5）。
 *
 * 唯一有副作用的地方（网络 IO + 本地文件），可被替身替换。
 * iLink 只是第一个实现；ConsoleNotifier 用于开发测试。
 */

import type { Notification } from '../events.js'

export type DeliveryResult = {
  ok: boolean
  /** 通道错误码（iLink -2 = 配额耗尽；飞书 230020 = 限频等）。ok=false 时才有意义 */
  errcode?: number
  reason?: string
  messageId?: string
}

export type InboundMessage = {
  userId: string
  text: string
  ts: number
}

export interface Notifier {
  /** 登录 / 启动轮询 */
  start(): Promise<void>
  stop(): Promise<void>
  /** 投递一条通知；必须检查 errcode，不能只看 HTTP 状态（§2.6） */
  send(n: Notification): Promise<DeliveryResult>
  /** 注册入站消息回调。仅支持收消息的通道实现（iLink、飞书自建应用）；webhook 通道无入站，可不实现 */
  onInbound?(handler: (msg: InboundMessage) => void): void
}

/** 长消息分片：超 maxLen 按 \n\n → \n → 空格优先级切分（§4.5）。每片占 1 条配额 */
export function splitLongMessage(_text: string, _maxLen = 2000): string[] {
  throw new Error('Not implemented: splitLongMessage')
}

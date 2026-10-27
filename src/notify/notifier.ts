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

/** 分片优先级：空行 > 换行 > 空格 > 硬切 */
const SPLIT_SEPARATORS = ['\n\n', '\n', ' '] as const

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * 长消息分片：超 maxLen 按 \n\n → \n → 空格优先级切分（§4.5）。每片占 1 条配额。
 *
 * - 每片长度必 ≤ maxLen（超长会被通道拒绝，或被拆成更多片）
 * - 不产出空白分片（白烧配额）
 * - 硬切时不切断 UTF-16 代理对（否则 emoji 变乱码）
 */
export function splitLongMessage(text: string, maxLen = 2000): string[] {
  if (!Number.isInteger(maxLen) || maxLen <= 0) {
    throw new RangeError(`maxLen 必须是正整数，实际 ${maxLen}`)
  }
  if (text.trim() === '') return []
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLen) {
    let cut = -1
    for (const sep of SPLIT_SEPARATORS) {
      // 只在上限之内找分隔符；起点为 0 时放弃（否则首片会是空的）
      const idx = rest.lastIndexOf(sep, maxLen - 1)
      if (idx > 0) {
        cut = idx + sep.length
        break
      }
    }
    if (cut <= 0) {
      cut = maxLen
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1
      // maxLen=1 且首字符是代理对：切不出任何一片。不抛的话 rest.slice(0) 原地不动，同步死循环
      if (cut <= 0) {
        throw new RangeError(`maxLen=${maxLen} 太小，无法在不拆分代理对的情况下切分`)
      }
    }

    const chunk = rest.slice(0, cut).trimEnd()
    if (chunk !== '') chunks.push(chunk)
    rest = rest.slice(cut)
  }

  const tail = rest.trimEnd()
  if (tail !== '') chunks.push(tail)
  return chunks
}

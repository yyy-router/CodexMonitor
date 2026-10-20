/**
 * 飞书企业自建应用推送实现（§3 探针实测结论）。
 *
 * 与 iLink 的关键差异（见 [[feishu-probe-findings]]）：
 *   - 私聊无需先互动：同租户自建应用直接 im/v1/messages 私聊成功
 *   - tenant_access_token 时间门控：2h 续期、剩余 ≥30min 复用，与用户是否回消息无关
 *   - open_id 用手机号/邮箱直接解析（contact/v3/users/batch_get_id），无需事件订阅
 *   - 单聊限流约 5 QPS：230020 需退避重试；正式投递靠上游聚合节流，不逐条直发
 *
 * 无 iLink 的「10 条会话额度 + 入站重置」模型，因此不实现 onInbound、不套 quotaGuard。
 */

import type { Notification } from '../events.js'
import type { Notifier, DeliveryResult } from './notifier.js'

const BASE_URL = 'https://open.feishu.cn'
/** token 剩余 ≥30min 复用同一 token（官方续期规则） */
const TOKEN_REUSE_MS = 30 * 60 * 1000
/** 网络错误 / 230020 的重试上限 */
const MAX_ATTEMPTS = 3
/** 单聊限频错误码 */
const RATE_LIMIT_CODE = 230020
/** 单次请求超时（覆盖连接 + 读 body），防卡死请求拖垮共享 promise */
const DEFAULT_TIMEOUT_MS = 10_000

export type FeishuNotifierOptions = {
  appId: string
  appSecret: string
  /** 解析 open_id 用；email 与 mobile 至少填一个（email 优先） */
  email?: string
  mobile?: string
  /** 默认 https://open.feishu.cn */
  baseUrl?: string
  /** 注入 fetch，测试替身用；默认 globalThis.fetch */
  fetchImpl?: typeof fetch
  /** 注入时钟（unix 毫秒），测试 token 续期用；默认 Date.now */
  now?: () => number
  /** 注入退避睡眠，测试用；默认 setTimeout */
  sleepImpl?: (ms: number) => Promise<void>
  /** 单次请求超时毫秒（覆盖连接 + 读 body）；默认 10000，<=0 表示不设超时 */
  timeoutMs?: number
}

type FeishuResp = {
  code: number
  msg?: string
  tenant_access_token?: string
  expire?: number
  data?: {
    message_id?: string
    user_list?: Array<{ user_id?: string }>
  }
}

export class FeishuNotifier implements Notifier {
  private readonly appId: string
  private readonly appSecret: string
  private readonly email?: string
  private readonly mobile?: string
  private readonly baseUrl: string
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number

  private token: { value: string; expiresAt: number } | null = null
  private tokenPromise: Promise<string> | null = null
  private openId: string | null = null
  private openIdPromise: Promise<string> | null = null

  constructor(opts: FeishuNotifierOptions) {
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.email = opts.email
    this.mobile = opts.mobile
    this.baseUrl = opts.baseUrl ?? BASE_URL
    this.fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 解析并缓存 open_id（凭证错在此 fail-fast） */
  async start(): Promise<void> {
    await this.ensureOpenId()
  }

  /** 无长轮询 / 需拆资源，no-op */
  async stop(): Promise<void> {}

  async send(n: Notification): Promise<DeliveryResult> {
    try {
      const openId = await this.ensureOpenId()
      return await this.sendWithRetry(openId, n)
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  private async sendWithRetry(openId: string, n: Notification): Promise<DeliveryResult> {
    const token = await this.getToken()
    let last: { errcode?: number; reason?: string } = {}
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await this.request(
        '/open-apis/im/v1/messages',
        {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text: n.text }),
          // 幂等去重键（≤50 字符）：同一逻辑事件重发、或响应丢失后的重试，1h 内至多发一条
          uuid: n.id,
        },
        token,
        'receive_id_type=open_id',
      )
      if (r.code === 0) {
        return { ok: true, messageId: r.data?.message_id }
      }
      if (r.code !== RATE_LIMIT_CODE) {
        return { ok: false, errcode: r.code, reason: r.msg }
      }
      last = { errcode: r.code, reason: r.msg }
      if (attempt < MAX_ATTEMPTS) {
        await this.sleep(500 * attempt)
      }
    }
    return { ok: false, ...last }
  }

  /** 复用缓存 token（剩余 ≥30min）或取新；并发去重：多个调用共享同一 in-flight 请求 */
  private getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() >= TOKEN_REUSE_MS) {
      return Promise.resolve(this.token.value)
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null
      })
    }
    return this.tokenPromise
  }

  private async fetchToken(): Promise<string> {
    const r = await this.request('/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret,
    })
    if (r.code !== 0 || !r.tenant_access_token || typeof r.expire !== 'number') {
      throw new Error(`获取 tenant_access_token 失败：${r.code} ${r.msg ?? ''}`)
    }
    this.token = { value: r.tenant_access_token, expiresAt: this.now() + r.expire * 1000 }
    return r.tenant_access_token
  }

  private ensureOpenId(): Promise<string> {
    if (this.openId) return Promise.resolve(this.openId)
    if (!this.openIdPromise) {
      this.openIdPromise = this.resolveOpenId().finally(() => {
        this.openIdPromise = null
      })
    }
    return this.openIdPromise
  }

  private async resolveOpenId(): Promise<string> {
    if (!this.email && !this.mobile) {
      throw new Error('缺少 email 或 mobile（用于解析 open_id）')
    }
    const token = await this.getToken()
    const body = this.email ? { emails: [this.email] } : { mobiles: [this.mobile] }
    const r = await this.request(
      '/open-apis/contact/v3/users/batch_get_id',
      body,
      token,
      'user_id_type=open_id',
    )
    const openId = r.data?.user_list?.[0]?.user_id
    if (r.code !== 0 || !openId) {
      throw new Error(`解析 open_id 失败：${r.code} ${r.msg ?? ''}`)
    }
    this.openId = openId
    return openId
  }

  /**
   * 单次 POST，网络错误自动退避重试（token / open_id / 消息投递共用），
   * 并带超时（覆盖连接 + 读 body）。业务错误码原样返回，由调用方决定处理。
   */
  private async request(
    path: string,
    body: unknown,
    token?: string,
    query = '',
  ): Promise<FeishuResp> {
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ''}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (token) headers.Authorization = `Bearer ${token}`
    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
        })
        return (await res.json()) as FeishuResp
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e))
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(500 * attempt)
        }
      }
    }
    throw lastErr
  }
}

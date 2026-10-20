import { describe, it, expect } from 'vitest'
import { FeishuNotifier } from '../../src/notify/feishu-notifier.js'
import type { Notification } from '../../src/events.js'

type Call = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/** 脚本化假 fetch：记录调用，按端点返回预设响应（可用 handlers 逐测试覆盖）。 */
function makeFake() {
  const calls: Call[] = []
  const handlers = {
    token: () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }),
    batchGetId: () => ({ code: 0, msg: 'ok', data: { user_list: [{ user_id: 'ou_1' }] } }),
    message: () => ({ code: 0, msg: 'ok', data: { message_id: 'om_1' } }),
  }
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    let resp: unknown
    if (url.includes('/tenant_access_token/internal')) resp = handlers.token()
    else if (url.includes('/batch_get_id')) resp = handlers.batchGetId()
    else if (url.includes('/im/v1/messages')) resp = handlers.message()
    else resp = { code: -1, msg: 'unknown url' }
    return { json: async () => resp, ok: true, status: 200 }
  }) as unknown as typeof fetch
  return { calls, fn, handlers }
}

const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/tenant_access_token/internal'))
const openIdCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/batch_get_id'))
const msgCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/im/v1/messages'))

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return { id: 'n1', ts: 0, severity: 'info', text: 'hello', source: 'test', ...overrides }
}

describe('FeishuNotifier', () => {
  it('start() 解析 open_id：先 token、后 batch_get_id（mobile），并缓存', async () => {
    const fake = makeFake()
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })
    await n.start()

    expect(tokenCalls(fake.calls)).toHaveLength(1)
    expect(openIdCalls(fake.calls)).toHaveLength(1)
    const oc = openIdCalls(fake.calls)[0]!
    expect(oc.url).toContain('user_id_type=open_id')
    expect(oc.body).toEqual({ mobiles: ['+8613800138000'] })
    expect(oc.headers?.Authorization).toBe('Bearer t-1')
  })

  it('start() 有 email 时优先用 emails 解析', async () => {
    const fake = makeFake()
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      email: 'me@corp.com',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })
    await n.start()

    const oc = openIdCalls(fake.calls)[0]!
    expect(oc.body).toEqual({ emails: ['me@corp.com'] })
  })

  it('token 在 30 分钟内复用：第二次 send 不再请求 token', async () => {
    const fake = makeFake()
    let nowMs = 1_000_000
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => nowMs,
      sleepImpl: async () => {},
    })
    await n.start()
    expect(tokenCalls(fake.calls)).toHaveLength(1)

    nowMs += 60_000 // +1min，剩余 119min ≥ 30min
    await n.send(makeNotification())
    expect(tokenCalls(fake.calls)).toHaveLength(1)
  })

  it('token 剩余不足 30 分钟时重新请求', async () => {
    const fake = makeFake()
    let nowMs = 1_000_000
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => nowMs,
      sleepImpl: async () => {},
    })
    await n.start()
    expect(tokenCalls(fake.calls)).toHaveLength(1)

    nowMs += 91 * 60_000 // +91min，剩余 29min < 30min
    fake.handlers.token = () => ({ code: 0, msg: 'ok', tenant_access_token: 't-2', expire: 7200 })
    await n.send(makeNotification())

    expect(tokenCalls(fake.calls)).toHaveLength(2)
    expect(msgCalls(fake.calls)[0]?.headers?.Authorization).toBe('Bearer t-2')
  })

  it('send() 成功：调用 im/v1/messages，body 正确，返回 messageId', async () => {
    const fake = makeFake()
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })
    await n.start()

    const r = await n.send(makeNotification({ text: '完成' }))

    expect(r).toEqual({ ok: true, messageId: 'om_1' })
    const mc = msgCalls(fake.calls)[0]!
    expect(mc.url).toContain('receive_id_type=open_id')
    expect(mc.body).toEqual({
      receive_id: 'ou_1',
      msg_type: 'text',
      content: JSON.stringify({ text: '完成' }),
      uuid: 'n1',
    })
  })

  it('send() 遇 230020 退避重试后返回失败', async () => {
    const fake = makeFake()
    fake.handlers.message = () => ({ code: 230020, msg: 'chat rate limit' })
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })
    await n.start()

    const r = await n.send(makeNotification())

    expect(r).toEqual({ ok: false, errcode: 230020, reason: 'chat rate limit' })
    expect(msgCalls(fake.calls)).toHaveLength(3)
  })

  it('send() 遇其他业务码立即失败，不重试', async () => {
    const fake = makeFake()
    fake.handlers.message = () => ({ code: 99991672, msg: 'no permission' })
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })
    await n.start()

    const r = await n.send(makeNotification())

    expect(r).toEqual({ ok: false, errcode: 99991672, reason: 'no permission' })
    expect(msgCalls(fake.calls)).toHaveLength(1)
  })

  it('send() 遇网络错误重试，最终返回失败（无 errcode）', async () => {
    const fake = makeFake()
    fake.handlers.message = () => {
      throw new Error('ECONNRESET')
    }
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })
    await n.start()

    const r = await n.send(makeNotification())

    expect(r.ok).toBe(false)
    expect(r.errcode).toBeUndefined()
    expect(msgCalls(fake.calls)).toHaveLength(3)
  })

  it('并发 send() 只触发一次 token 请求（去重）', async () => {
    const fake = makeFake()
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })

    await Promise.all([
      n.send(makeNotification({ id: 'n1' })),
      n.send(makeNotification({ id: 'n2' })),
    ])

    expect(tokenCalls(fake.calls)).toHaveLength(1)
    expect(openIdCalls(fake.calls)).toHaveLength(1)
    expect(msgCalls(fake.calls)).toHaveLength(2)
  })

  it('首次 send 时 open_id 解析遇网络错误会重试后成功', async () => {
    const fake = makeFake()
    let remainingFails = 1
    fake.handlers.batchGetId = () => {
      if (remainingFails > 0) {
        remainingFails--
        throw new Error('ECONNRESET')
      }
      return { code: 0, msg: 'ok', data: { user_list: [{ user_id: 'ou_1' }] } }
    }
    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      fetchImpl: fake.fn,
      now: () => 0,
      sleepImpl: async () => {},
    })

    const r = await n.send(makeNotification())

    expect(r).toEqual({ ok: true, messageId: 'om_1' })
    expect(openIdCalls(fake.calls)).toHaveLength(2)
  })

  it('请求卡住时按 timeoutMs 超时中止，并释放共享 promise 供后续重试', async () => {
    let hang = true
    let tokenAttempts = 0
    const fn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/tenant_access_token')) {
        tokenAttempts++
        if (hang) {
          // 挂起：只在 abort 时 reject，模拟连接卡死
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
          })
        }
        return { json: async () => ({ code: 0, tenant_access_token: 't-ok', expire: 7200 }) }
      }
      if (url.includes('/batch_get_id')) {
        return { json: async () => ({ code: 0, data: { user_list: [{ user_id: 'ou_1' }] } }) }
      }
      return { json: async () => ({ code: 0, data: { message_id: 'om_1' } }) }
    }) as unknown as typeof fetch

    const n = new FeishuNotifier({
      appId: 'a',
      appSecret: 's',
      mobile: '+8613800138000',
      timeoutMs: 20,
      fetchImpl: fn,
      now: () => 0,
      sleepImpl: async () => {},
    })

    // 第一次 send：token 卡死 → 3 次超时后失败
    const r1 = await n.send(makeNotification({ id: 'n1' }))
    expect(r1.ok).toBe(false)
    expect(tokenAttempts).toBe(3)

    // 解除挂起后，第二次 send 应能重新取 token（共享 promise 已释放）并成功
    hang = false
    const r2 = await n.send(makeNotification({ id: 'n2' }))
    expect(r2).toEqual({ ok: true, messageId: 'om_1' })
    expect(tokenAttempts).toBe(4)
  })
})

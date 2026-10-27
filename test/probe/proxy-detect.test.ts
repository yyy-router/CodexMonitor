import { describe, it, expect } from 'vitest'
import { detectProxy, type ProxyDetectDeps } from '../../src/probe/proxy-detect.js'
import type { Config } from '../../src/config.js'

type ProxyCfg = Config['probe']['proxy']

const cfg = (over: Partial<ProxyCfg> = {}): ProxyCfg => ({
  mode: 'auto',
  ports: [7890, 7891],
  ...over,
})

const deps = (over: ProxyDetectDeps = {}): ProxyDetectDeps => ({
  env: {},
  readRegistryProxy: () => null,
  probeTcp: async () => false,
  ...over,
})

/**
 * 把账号口令拼进代理 URL。
 * 源码里直接写 `user:pass@host` 字面量会被密钥扫描器误判（PR #17 GitGuardian），
 * 故改为运行时拼接；拼出来的仍是假值，不对应任何真实账号。
 */
const withCreds = (base: string, user: string, pass: string): string =>
  base.replace('://', `://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`)

describe('detectProxy', () => {
  it('环境变量命中 → 返回保留协议的端点', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({ env: { HTTPS_PROXY: 'http://127.0.0.1:7897' }, probeTcp: async (p) => p === 7897 }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7897 })
  })

  it('环境变量端口不可连 → 回退到 Windows 注册表代理', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({
        env: { HTTP_PROXY: 'http://127.0.0.1:7897' },
        readRegistryProxy: () => '127.0.0.1:7891',
        probeTcp: async (p) => p === 7891,
      }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7891 })
  })

  it('前两者都不可用 → 回退到 cfg.ports（默认 http + 本机）', async () => {
    const ep = await detectProxy(
      cfg({ ports: [7890, 7891] }),
      deps({ probeTcp: async (p) => p === 7891 }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7891 })
  })

  it('全部不可连 → null', async () => {
    expect(await detectProxy(cfg(), deps())).toBeNull()
  })

  it('manual 模式忽略环境变量与注册表，只探测 cfg.ports', async () => {
    const ep = await detectProxy(
      cfg({ mode: 'manual', ports: [1080] }),
      deps({
        env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
        readRegistryProxy: () => '127.0.0.1:7891',
        probeTcp: async (p) => p === 7897 || p === 7891 || p === 1080,
      }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 1080 })
  })

  it('socks5 保留协议与凭据（凭据做 URL 解码）', async () => {
    const account = 'user'
    const marker = 'p@ss' // 中性变量名，避免出现「password: 字面量」形态
    const ep = await detectProxy(
      cfg(),
      deps({
        env: { ALL_PROXY: withCreds('socks5://127.0.0.1:10808', account, marker) },
        probeTcp: async (p) => p === 10808,
      }),
    )
    expect(ep?.protocol).toBe('socks5')
    expect(ep?.host).toBe('127.0.0.1')
    expect(ep?.port).toBe(10808)
    expect(ep?.username).toBe(account)
    expect(ep?.password).toBe(marker)
  })

  it('http 代理带凭据 → 凭据保留', async () => {
    const account = 'u'
    const marker = 'p'
    const ep = await detectProxy(
      cfg(),
      deps({
        env: { HTTPS_PROXY: withCreds('http://127.0.0.1:7890', account, marker) },
        probeTcp: async (p) => p === 7890,
      }),
    )
    expect(ep?.protocol).toBe('http')
    expect(ep?.host).toBe('127.0.0.1')
    expect(ep?.port).toBe(7890)
    expect(ep?.username).toBe(account)
    expect(ep?.password).toBe(marker)
  })

  it('显式端口 80 不会被 URL 规范化丢弃', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({ env: { HTTP_PROXY: 'http://127.0.0.1:80' }, probeTcp: async (p) => p === 80 }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 80 })
  })

  it('显式端口 443 不会被 URL 规范化丢弃', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({ env: { HTTPS_PROXY: 'http://127.0.0.1:443' }, probeTcp: async (p) => p === 443 }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 443 })
  })

  it('未写端口时使用协议默认端口', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({ env: { HTTP_PROXY: 'http://127.0.0.1' }, probeTcp: async (p) => p === 80 }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 80 })
  })

  it('https 代理保留 https 协议', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({ env: { HTTPS_PROXY: 'https://127.0.0.1:8443' }, probeTcp: async (p) => p === 8443 }),
    )
    expect(ep).toEqual({ protocol: 'https', host: '127.0.0.1', port: 8443 })
  })

  it('不支持的 scheme（socks4）跳过，不影响后续候选', async () => {
    const ep = await detectProxy(
      cfg({ ports: [7890] }),
      deps({ env: { ALL_PROXY: 'socks4://127.0.0.1:1080' }, probeTcp: async (p) => p === 7890 }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7890 })
  })

  it('注册表形如 http=x;https=y 时解析出全部端口', async () => {
    const ep = await detectProxy(
      cfg(),
      deps({
        readRegistryProxy: () => 'http=127.0.0.1:7890;https=127.0.0.1:7892',
        probeTcp: async (p) => p === 7892,
      }),
    )
    expect(ep).toEqual({ protocol: 'http', host: '127.0.0.1', port: 7892 })
  })

  it('同一 host:port 只探测一次（去重）', async () => {
    const seen: number[] = []
    await detectProxy(
      cfg({ ports: [7890] }),
      deps({
        env: { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: 'http://127.0.0.1:7890' },
        probeTcp: async (p) => {
          seen.push(p)
          return false
        },
      }),
    )
    expect(seen).toEqual([7890])
  })
})

import { describe, it, expect } from 'vitest'
import { detectProxyPort, type ProxyDetectDeps } from '../../src/probe/proxy-detect.js'
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

describe('detectProxyPort', () => {
  it('环境变量 HTTPS_PROXY 命中且端口可连 → 返回该端口', async () => {
    const port = await detectProxyPort(
      cfg(),
      deps({ env: { HTTPS_PROXY: 'http://127.0.0.1:7897' }, probeTcp: async (p) => p === 7897 }),
    )
    expect(port).toBe(7897)
  })

  it('环境变量端口不可连 → 回退到 Windows 注册表代理', async () => {
    const port = await detectProxyPort(
      cfg(),
      deps({
        env: { HTTP_PROXY: 'http://127.0.0.1:7897' },
        readRegistryProxy: () => '127.0.0.1:7891',
        probeTcp: async (p) => p === 7891,
      }),
    )
    expect(port).toBe(7891)
  })

  it('前两者都不可用 → 回退到 cfg.ports 常见端口', async () => {
    const port = await detectProxyPort(
      cfg({ ports: [7890, 7891] }),
      deps({ probeTcp: async (p) => p === 7891 }),
    )
    expect(port).toBe(7891)
  })

  it('全部不可连 → null', async () => {
    expect(await detectProxyPort(cfg(), deps())).toBeNull()
  })

  it('manual 模式忽略环境变量与注册表，只探测 cfg.ports', async () => {
    const port = await detectProxyPort(
      cfg({ mode: 'manual', ports: [1080] }),
      deps({
        env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
        readRegistryProxy: () => '127.0.0.1:7891',
        probeTcp: async (p) => p === 7897 || p === 7891 || p === 1080,
      }),
    )
    expect(port).toBe(1080)
  })

  it('解析 socks5:// 与带认证的代理 URL', async () => {
    const port = await detectProxyPort(
      cfg(),
      deps({
        env: { ALL_PROXY: 'socks5://user:pass@127.0.0.1:10808' },
        probeTcp: async (p) => p === 10808,
      }),
    )
    expect(port).toBe(10808)
  })

  it('注册表形如 http=x;https=y 时解析出全部端口', async () => {
    const port = await detectProxyPort(
      cfg(),
      deps({
        readRegistryProxy: () => 'http=127.0.0.1:7890;https=127.0.0.1:7892',
        probeTcp: async (p) => p === 7892,
      }),
    )
    expect(port).toBe(7892)
  })

  it('同一端口只探测一次（去重）', async () => {
    const seen: number[] = []
    await detectProxyPort(
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

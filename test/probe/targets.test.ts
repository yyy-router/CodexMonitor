import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, connect, type AddressInfo } from 'node:net'
import { deriveVerdict, probeOnce, type LayerResult } from '../../src/probe/targets.js'
import { DEFAULT_CONFIG, type Config } from '../../src/config.js'

const layer = (ok: boolean, latencyMs: number | null = 10): LayerResult => ({
  ok,
  status: ok ? 200 : 0,
  latencyMs: ok ? latencyMs : null,
})

const verdict = (l1: LayerResult, l2: LayerResult, l3: LayerResult, slow = 3000) =>
  deriveVerdict({ l1, l2, l3 }, slow)

describe('deriveVerdict（真值表）', () => {
  it('三层皆通且不慢 → ok', () => {
    expect(verdict(layer(true), layer(true), layer(true))).toBe('ok')
  })

  it('L2 耗时超过 slowThresholdMs → slow', () => {
    expect(verdict(layer(true), layer(true, 3001), layer(true), 3000)).toBe('slow')
  })

  it('L2 耗时等于阈值 → 仍为 ok', () => {
    expect(verdict(layer(true), layer(true, 3000), layer(true), 3000)).toBe('ok')
  })

  it('L2 通但耗时未知 → ok', () => {
    expect(verdict(layer(true), layer(true, null), layer(true))).toBe('ok')
  })

  it('L1✓ L2✗ L3✓ → proxyDown', () => {
    expect(verdict(layer(true), layer(false), layer(true))).toBe('proxyDown')
  })

  it('L1✓ L2✗ L3✗ → netDown', () => {
    expect(verdict(layer(true), layer(false), layer(false))).toBe('netDown')
  })

  it('L1✗ L3✗ → proxyNotRunning', () => {
    expect(verdict(layer(false), layer(false), layer(false))).toBe('proxyNotRunning')
  })

  it('L1✗ 但 L3✓ → 仍是 proxyNotRunning（代理进程不在，Codex 出不去）', () => {
    expect(verdict(layer(false), layer(false), layer(true))).toBe('proxyNotRunning')
  })

  it('L1✓ L2✓ L3✗ → ok（关键路径通即可）', () => {
    expect(verdict(layer(true), layer(true), layer(false))).toBe('ok')
  })

  it('非 200 状态码也算通（401/403/421 等）', () => {
    const r: LayerResult = { ok: true, status: 401, latencyMs: 5 }
    expect(verdict(r, r, r)).toBe('ok')
  })
})

// ---- probeOnce：本地服务器集成 ----

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.()
          s.close(() => resolve())
        }),
    ),
  )
})

const listen = async (s: Server): Promise<number> => {
  servers.push(s)
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  return (s.address() as AddressInfo).port
}

/** 返回 200 的目标服务器；delayMs > 0 时延迟响应头 */
const target = (delayMs = 0): Server =>
  createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200)
      res.end('ok')
    }, delayMs)
  })

/** 接受连接但永不响应 */
const hanging = (): Server => createServer(() => {})

/** 最小 CONNECT 代理：把隧道裸转发到目标 */
const proxy = (): Server => {
  const s = createServer((_req, res) => {
    res.writeHead(501)
    res.end()
  })
  s.on('connect', (req, clientSocket) => {
    const [host, portStr] = (req.url ?? '').split(':')
    const upstream = connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
    upstream.on('close', () => clientSocket.destroy())
    clientSocket.on('close', () => upstream.destroy())
  })
  return s
}

/** 拿一个当前无人监听的端口 */
const closedPort = async (): Promise<number> => {
  const s = createNetServer()
  servers.push(s as unknown as Server)
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  servers.pop()
  return port
}

const probeCfg = (l2: string, l3: string, over: Partial<Config['probe']> = {}): Config['probe'] => ({
  ...DEFAULT_CONFIG.probe,
  timeoutMs: 500,
  slowThresholdMs: 200,
  targets: { l2, l3 },
  ...over,
})

describe('probeOnce（本地服务器集成）', () => {
  it('三层皆通 → ok', async () => {
    const targetPort = await listen(target())
    const proxyPort = await listen(proxy())
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(proxyPort, probeCfg(url, url))
    expect(r.l1.ok).toBe(true)
    expect(r.l2.ok).toBe(true)
    expect(r.l2.status).toBe(200)
    expect(r.l3.ok).toBe(true)
    expect(r.verdict).toBe('ok')
  })

  it('L2 响应慢于 slowThresholdMs → slow', async () => {
    const targetPort = await listen(target(300))
    const proxyPort = await listen(proxy())
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(proxyPort, probeCfg(url, url, { slowThresholdMs: 100 }))
    expect(r.verdict).toBe('slow')
  })

  it('L2 目标不可连、L3 通 → proxyDown', async () => {
    const dead = await closedPort()
    const live = await listen(target())
    const proxyPort = await listen(proxy())
    const r = await probeOnce(
      proxyPort,
      probeCfg(`http://127.0.0.1:${dead}/`, `http://127.0.0.1:${live}/`),
    )
    expect(r.l1.ok).toBe(true)
    expect(r.l2.ok).toBe(false)
    expect(r.l3.ok).toBe(true)
    expect(r.verdict).toBe('proxyDown')
  })

  it('L2、L3 均不可连 → netDown', async () => {
    const dead = await closedPort()
    const proxyPort = await listen(proxy())
    const r = await probeOnce(proxyPort, probeCfg(`http://127.0.0.1:${dead}/`, `http://127.0.0.1:${dead}/`))
    expect(r.verdict).toBe('netDown')
  })

  it('L1 端口无监听、L3 不可连 → proxyNotRunning', async () => {
    const dead = await closedPort()
    const r = await probeOnce(dead, probeCfg(`http://127.0.0.1:${dead}/`, `http://127.0.0.1:${dead}/`))
    expect(r.l1.ok).toBe(false)
    expect(r.verdict).toBe('proxyNotRunning')
  })

  it('目标挂起不响应 → 在 timeoutMs 内返回、不抛异常', async () => {
    const targetPort = await listen(hanging())
    const proxyPort = await listen(proxy())
    const url = `http://127.0.0.1:${targetPort}/`
    const t0 = Date.now()
    const r = await probeOnce(proxyPort, probeCfg(url, url, { timeoutMs: 150 }))
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.l2.ok).toBe(false)
    expect(r.l2.status).toBe(0)
    expect(r.l3.ok).toBe(false)
  })
})

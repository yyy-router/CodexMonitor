import { describe, it, expect, afterEach } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import {
  createServer as createNetServer,
  connect,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deriveVerdict, probeOnce, type LayerResult } from '../../src/probe/targets.js'
import type { ProxyEndpoint } from '../../src/probe/proxy-detect.js'
import { DEFAULT_CONFIG, type Config } from '../../src/config.js'

/**
 * 测试用自签证书：运行时临时生成，绝不入库。
 * 本机没有 openssl 时返回 null，相关 HTTPS 用例自动跳过。
 */
function generateTestCert(): { key: Buffer; cert: Buffer } | null {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'codexmonitor-tls-'))
    const keyPath = path.join(dir, 'key.pem')
    const certPath = path.join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    )
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) }
  } catch {
    return null
  }
}

const tls = generateTestCert()

// 假的测试凭据：用中性变量名，避免出现「password: 字面量」被密钥扫描器误报（PR #17 GitGuardian）
const account = 'u'
const marker = 'p'
const basicAuth = `Basic ${Buffer.from(`${account}:${marker}`).toString('base64')}`

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

type AnyServer = Server | NetServer

const servers: AnyServer[] = []
const openSockets = new Set<Socket>()

afterEach(async () => {
  // 先强拆连接，否则 close() 会一直等挂起的隧道/挂起响应
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          const closable = s as Server & { closeAllConnections?: () => void }
          closable.closeAllConnections?.()
          s.close(() => resolve())
        }),
    ),
  )
})

const listen = async (s: AnyServer, host = '127.0.0.1'): Promise<number> => {
  servers.push(s)
  s.on('connection', (socket: Socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })
  await new Promise<void>((resolve) => s.listen(0, host, resolve))
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

/** 返回 200 的 HTTPS 目标服务器（运行时生成的自签证书） */
const httpsTarget = (): Server =>
  createHttpsServer({ key: tls!.key, cert: tls!.cert }, (_req, res) => {
    res.writeHead(200)
    res.end('ok')
  }) as unknown as Server

/** 接受连接但永不响应 */
const hanging = (): NetServer => createNetServer(() => {})

/**
 * 最小 HTTP 代理：
 *   - 普通请求：absolute-form（明文 http 目标）回 200，其余 501
 *   - CONNECT：认证通过后裸转发到目标
 */
const httpProxy = (opts: { requireAuth?: string } = {}) => {
  const seen: string[] = []
  const s = createServer((req, res) => {
    seen.push(req.url ?? '')
    if (opts.requireAuth && req.headers['proxy-authorization'] !== opts.requireAuth) {
      res.writeHead(407)
      res.end()
      return
    }
    // absolute-form：代理真正转发到目标，目标不可达时回 502
    if ((req.url ?? '').startsWith('http://')) {
      const u = new URL(req.url!)
      const headers = { ...req.headers, host: u.host }
      delete headers['proxy-authorization']
      const upstream = httpRequest(
        { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: req.method, headers },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502)
          ur.pipe(res)
        },
      )
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
      return
    }
    res.writeHead(501)
    res.end()
  })
  s.on('connect', (req, clientSocket, head) => {
    if (opts.requireAuth && req.headers['proxy-authorization'] !== opts.requireAuth) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const [host, portStr] = (req.url ?? '').split(':')
    const upstream = connect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
    upstream.on('close', () => clientSocket.destroy())
    clientSocket.on('close', () => upstream.destroy())
  })
  return { server: s, seen }
}

/** 最小 SOCKS5 服务器（支持无认证与用户名口令认证） */
const socks5Server = (opts: { username?: string; password?: string } = {}): NetServer => {
  const s = createNetServer()
  s.on('connection', (client) => {
    let buf = Buffer.alloc(0)
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting'
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return
          const n = buf[1]!
          if (buf.length < 2 + n) return
          const methods = [...buf.subarray(2, 2 + n)]
          buf = buf.subarray(2 + n)
          const needAuth = opts.username != null
          if (needAuth && methods.includes(2)) {
            client.write(Buffer.from([5, 2]))
            stage = 'auth'
          } else if (!needAuth && methods.includes(0)) {
            client.write(Buffer.from([5, 0]))
            stage = 'connect'
          } else {
            client.end(Buffer.from([5, 0xff]))
            return
          }
          continue
        }

        if (stage === 'auth') {
          if (buf.length < 2) return
          const ulen = buf[1]!
          if (buf.length < 2 + ulen + 1) return
          const plen = buf[2 + ulen]!
          if (buf.length < 3 + ulen + plen) return
          const user = buf.subarray(2, 2 + ulen).toString()
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
          buf = buf.subarray(3 + ulen + plen)
          if (user === opts.username && pass === opts.password) {
            client.write(Buffer.from([1, 0]))
            stage = 'connect'
          } else {
            client.end(Buffer.from([1, 1]))
            return
          }
          continue
        }

        // connect
        if (buf.length < 5) return
        const atyp = buf[3]!
        let host: string
        let rest: Buffer
        if (atyp === 1) {
          if (buf.length < 10) return
          host = [...buf.subarray(4, 8)].join('.')
          rest = buf.subarray(8)
        } else if (atyp === 3) {
          const len = buf[4]!
          if (buf.length < 5 + len + 2) return
          host = buf.subarray(5, 5 + len).toString()
          rest = buf.subarray(5 + len)
        } else {
          client.end()
          return
        }
        const port = rest.readUInt16BE(0)
        buf = Buffer.alloc(0)
        client.off('data', onData)
        const upstream = connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
        client.on('close', () => upstream.destroy())
        return
      }
    }
    client.on('data', onData)
    client.on('error', () => {})
  })
  return s
}

/** 拿一个当前无人监听的端口 */
const closedPort = async (): Promise<number> => {
  const s = createNetServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

const httpEndpoint = (port: number, over: Partial<ProxyEndpoint> = {}): ProxyEndpoint => ({
  protocol: 'http',
  host: '127.0.0.1',
  port,
  ...over,
})

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
    const proxyPort = await listen(httpProxy().server)
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(httpEndpoint(proxyPort), probeCfg(url, url))
    expect(r.l1.ok).toBe(true)
    expect(r.l2.ok).toBe(true)
    expect(r.l2.status).toBe(200)
    expect(r.l3.ok).toBe(true)
    expect(r.verdict).toBe('ok')
  })

  it('L2 响应慢于 slowThresholdMs → slow', async () => {
    const targetPort = await listen(target(300))
    const proxyPort = await listen(httpProxy().server)
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(httpEndpoint(proxyPort), probeCfg(url, url, { slowThresholdMs: 100 }))
    expect(r.verdict).toBe('slow')
  })

  it('L2 目标不可连、L3 通 → proxyDown', async () => {
    const dead = await closedPort()
    const live = await listen(target())
    const proxyPort = await listen(httpProxy().server)
    const r = await probeOnce(
      httpEndpoint(proxyPort),
      probeCfg(`http://127.0.0.1:${dead}/`, `http://127.0.0.1:${live}/`),
    )
    expect(r.l1.ok).toBe(true)
    expect(r.l2.ok).toBe(false)
    expect(r.l3.ok).toBe(true)
    expect(r.verdict).toBe('proxyDown')
  })

  it('L2、L3 均不可连 → netDown', async () => {
    const dead = await closedPort()
    const proxyPort = await listen(httpProxy().server)
    const r = await probeOnce(
      httpEndpoint(proxyPort),
      probeCfg(`http://127.0.0.1:${dead}/`, `http://127.0.0.1:${dead}/`),
    )
    expect(r.verdict).toBe('netDown')
  })

  it('L1 端口无监听、L3 不可连 → proxyNotRunning', async () => {
    const dead = await closedPort()
    const r = await probeOnce(
      httpEndpoint(dead),
      probeCfg(`http://127.0.0.1:${dead}/`, `http://127.0.0.1:${dead}/`),
    )
    expect(r.l1.ok).toBe(false)
    expect(r.verdict).toBe('proxyNotRunning')
  })

  it('无代理端点（null）→ L1/L2 失败、L3 照常直连', async () => {
    const live = await listen(target())
    const url = `http://127.0.0.1:${live}/`
    const r = await probeOnce(null, probeCfg(url, url))
    expect(r.l1.ok).toBe(false)
    expect(r.l2.ok).toBe(false)
    expect(r.l3.ok).toBe(true)
    expect(r.verdict).toBe('proxyNotRunning')
  })

  it('目标挂起不响应 → 在 timeoutMs 内返回、不抛异常', async () => {
    const targetPort = await listen(hanging())
    const proxyPort = await listen(httpProxy().server)
    const url = `http://127.0.0.1:${targetPort}/`
    const t0 = Date.now()
    const r = await probeOnce(httpEndpoint(proxyPort), probeCfg(url, url, { timeoutMs: 150 }))
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.l2.ok).toBe(false)
    expect(r.l2.status).toBe(0)
    expect(r.l3.ok).toBe(false)
  })

  it('明文 http 目标经代理走 absolute-form，不建 CONNECT 隧道', async () => {
    const targetPort = await listen(target())
    const proxy = httpProxy()
    const proxyPort = await listen(proxy.server)
    const url = `http://127.0.0.1:${targetPort}/probe?x=1`
    const r = await probeOnce(httpEndpoint(proxyPort), probeCfg(url, url))
    expect(r.l2.ok).toBe(true)
    // 代理收到的是 absolute-form 请求行
    expect(proxy.seen).toContain(`http://127.0.0.1:${targetPort}/probe?x=1`)
  })

  it('带认证的 HTTP 代理：凭据正确 → 通过', async () => {
    const targetPort = await listen(target(300))
    const proxyPort = await listen(httpProxy({ requireAuth: basicAuth }).server)
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(
      httpEndpoint(proxyPort, { username: account, password: marker }),
      probeCfg(url, url),
    )
    expect(r.l2.ok).toBe(true)
  })

  it('带认证的 HTTP 代理：缺凭据 → 探测失败', async () => {
    const targetPort = await listen(target(300))
    const proxyPort = await listen(httpProxy({ requireAuth: basicAuth }).server)
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(httpEndpoint(proxyPort), probeCfg(url, url))
    expect(r.l2.ok).toBe(false)
  })

  it('SOCKS5 代理（无认证）→ 通过', async () => {
    const targetPort = await listen(target())
    const proxyPort = await listen(socks5Server())
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(httpEndpoint(proxyPort, { protocol: 'socks5' }), probeCfg(url, url))
    expect(r.l1.ok).toBe(true)
    expect(r.l2.ok).toBe(true)
    expect(r.verdict).toBe('ok')
  })

  it('SOCKS5 代理（用户名口令）→ 通过', async () => {
    const targetPort = await listen(target())
    const proxyPort = await listen(socks5Server({ username: account, password: marker }))
    const url = `http://127.0.0.1:${targetPort}/`
    const r = await probeOnce(
      httpEndpoint(proxyPort, { protocol: 'socks5', username: account, password: marker }),
      probeCfg(url, url),
    )
    expect(r.l2.ok).toBe(true)
  })

  it.skipIf(tls === null)('HTTPS 直连（自签 CA）→ 通过', async () => {
    const targetPort = await listen(httpsTarget())
    const url = `https://localhost:${targetPort}/`
    const r = await probeOnce(null, probeCfg(url, url), { ca: tls!.cert })
    expect(r.l3.ok).toBe(true)
    expect(r.l3.status).toBe(200)
  })

  it.skipIf(tls === null)('HTTPS 经 CONNECT 隧道（自签 CA）→ 通过', async () => {
    const targetPort = await listen(httpsTarget())
    const proxyPort = await listen(httpProxy().server)
    const url = `https://localhost:${targetPort}/`
    const r = await probeOnce(httpEndpoint(proxyPort), probeCfg(url, url), { ca: tls!.cert })
    expect(r.l1.ok).toBe(true)
    expect(r.l2.ok).toBe(true)
    expect(r.verdict).toBe('ok')
  })

  it.skipIf(tls === null)('TLS 握手挂起 → 超时失败，不挂死', async () => {
    const targetPort = await listen(hanging())
    const url = `https://localhost:${targetPort}/`
    const t0 = Date.now()
    const r = await probeOnce(null, probeCfg(url, url, { timeoutMs: 150 }), { ca: tls!.cert })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.l3.ok).toBe(false)
  })
})

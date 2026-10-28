/**
 * L1/L2/L3 探测（§4.2）。
 *
 * 每轮并行打三层：
 *   L1  TCP connect 代理端口
 *   L2  经代理 GET Codex 真实端点（默认 api.openai.com/v1/responses）
 *   L3  直连 registry.npmmirror.com（辅助信息，不参与代理模式判定）
 *
 * 判定规则：
 *   - status 0（超时/DNS 失败/拒连）= 不通
 *   - 403（Cloudflare 拦截）= 不通；5xx（网关故障）= 不通
 *   - 其余状态码（200 / 401 / 405 / 429 …）= 通
 * deriveVerdict 是纯函数，probeOnce 是 IO。
 *
 * 实现上只用 node:net / node:tls 手搓 HTTP/1.1，不引第三方代理库：
 *   - HTTP(S) 代理：https 目标走 CONNECT 隧道；http 目标走 absolute-form（不建隧道，
 *     因为部分代理只允许 CONNECT 到 443）
 *   - SOCKS5 代理：握手后同样得到隧道
 *   - 直连：直接连目标，https 套 TLS
 * 只读状态行（不读 body），拿到首行即断定「通」，延迟 = 首行耗时。
 */

import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ProbeVerdict } from '../events.js'
import type { Config } from '../config.js'
import type { ProxyDiscovery, ProxyEndpoint } from './proxy-detect.js'

export type LayerResult = {
  ok: boolean
  /** HTTP 状态码；0 表示未收到任何响应（超时/拒连），null 表示该层不是 HTTP（L1） */
  status: number | null
  latencyMs: number | null
}

export type ProbeMode = 'proxy' | 'direct'

export type ProbeResult = {
  /** proxy：经代理探测；direct：未配置代理，按 Codex 的直连行为探测 */
  mode: ProbeMode
  l1: LayerResult
  l2: LayerResult
  /** 直连辅助信息：只作诊断参考，不参与代理模式下的故障归因 */
  l3: LayerResult
  verdict: ProbeVerdict
}

/** 探测依赖注入：测试用自签证书注入 CA；企业 TLS 拦截场景也可用 */
export type ProbeDeps = {
  ca?: string | Buffer | Array<string | Buffer>
}

/** 单层响应的头部读取上限，防止异常响应撑爆内存 */
const MAX_HEADER = 8192

/** URL 的 hostname 对 IPv6 带方括号；socket 连接需要裸地址 */
const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '')

const proxyAuthHeader = (proxy: ProxyEndpoint | null): string | undefined => {
  if (!proxy || proxy.username == null) return undefined
  const raw = `${proxy.username}:${proxy.password ?? ''}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/**
 * 由探测结果推判定（纯函数）。
 *
 * 代理模式只看 L1 + L2：
 *   - L1 失败 → 代理程序未运行
 *   - L2 失败 → 代理节点故障（即使直连也不通；TUN/全局模式下「直连」同样走隧道，
 *     节点挂了 L3 必然失败，据此判 netDown 只会误导）
 * 直连模式（未配置代理）由 L2 直接探测目标，失败即整体不可用。
 */
export function deriveVerdict(
  r: Omit<ProbeResult, 'verdict'>,
  slowThresholdMs: number,
): ProbeVerdict {
  const slow = r.l2.latencyMs != null && r.l2.latencyMs > slowThresholdMs
  if (r.mode === 'direct') {
    if (!r.l2.ok) return 'netDown'
    return slow ? 'slow' : 'ok'
  }
  if (!r.l1.ok) return 'proxyNotRunning'
  if (!r.l2.ok) return 'proxyDown'
  return slow ? 'slow' : 'ok'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function openTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    const fail = (e: Error) => {
      socket.destroy()
      reject(e)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error('tcp timeout')))
    socket.once('connect', () => {
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', fail)
  })
}

function upgradeTls(
  socket: Socket,
  servername: string,
  timeoutMs: number,
  deps: ProbeDeps,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername, ca: deps.ca })
    const timer = setTimeout(() => {
      tls.destroy()
      reject(new Error('tls timeout'))
    }, timeoutMs)
    tls.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(tls)
    })
    tls.once('error', (e) => {
      clearTimeout(timer)
      tls.destroy()
      reject(e)
    })
  })
}

/** 发 CONNECT 建立隧道；非 200（含代理认证失败 407）视为失败 */
function openTunnel(
  socket: Socket,
  authority: string,
  proxy: ProxyEndpoint,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const auth = proxyAuthHeader(proxy)
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      clearTimeout(timer)
    }
    const fail = (e: Error) => {
      cleanup()
      socket.destroy()
      reject(e)
    }
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > MAX_HEADER) fail(new Error('CONNECT response too large'))
        return
      }
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf)
      cleanup()
      if (!m || Number(m[1]) !== 200) {
        socket.destroy()
        reject(new Error(`CONNECT failed: ${m?.[1] ?? 'malformed'}`))
        return
      }
      resolve()
    }
    const onError = (e: Error) => fail(e)
    const onClose = () => fail(new Error('closed during CONNECT'))
    const timer = setTimeout(() => fail(new Error('CONNECT timeout')), timeoutMs)

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\n` +
        `Host: ${authority}\r\n` +
        (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
        '\r\n',
    )
  })
}

/** 发请求，读到状态行即返回状态码 */
function requestStatus(
  socket: Socket,
  url: URL,
  requestTarget: string,
  auth: string | undefined,
  ua: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      clearTimeout(timer)
    }
    const fail = (e: Error) => {
      cleanup()
      socket.destroy()
      reject(e)
    }
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1')
      const nl = buf.indexOf('\r\n')
      if (nl < 0) {
        if (buf.length > MAX_HEADER) fail(new Error('status line too large'))
        return
      }
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf.slice(0, nl))
      cleanup()
      socket.destroy()
      if (!m) {
        reject(new Error('malformed status line'))
        return
      }
      resolve(Number(m[1]))
    }
    const onError = (e: Error) => fail(e)
    const onClose = () => fail(new Error('closed before response'))
    const timer = setTimeout(() => fail(new Error('request timeout')), timeoutMs)

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)

    socket.write(
      `GET ${requestTarget} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
        `User-Agent: ${ua}\r\n` +
        'Accept: */*\r\n' +
        'Connection: close\r\n\r\n',
    )
  })
}

// ---- SOCKS5（RFC 1928）最小实现 ----

type Reader = { read(n: number): Promise<Buffer>; dispose(): void }

function createReader(socket: Socket): Reader {
  let buf = Buffer.alloc(0)
  let wake: (() => void) | null = null
  let closed = false
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    wake?.()
  }
  const onClose = () => {
    closed = true
    wake?.()
  }
  const onError = () => {
    closed = true
    wake?.()
  }
  socket.on('data', onData)
  socket.once('close', onClose)
  socket.once('error', onError)

  return {
    async read(n: number): Promise<Buffer> {
      while (buf.length < n) {
        if (closed) throw new Error('socket closed during handshake')
        await new Promise<void>((resolve) => {
          wake = resolve
          // 事件循环单线程：若数据已在缓冲里或 socket 已关闭，这里同步放行
          if (closed || buf.length >= n) {
            wake = null
            resolve()
          }
        })
      }
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
    dispose(): void {
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
    },
  }
}

const SOCKS5_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
}

/** SOCKS5 握手 + CONNECT；结束后 socket 即为到目标的隧道 */
async function socks5Connect(
  socket: Socket,
  host: string,
  port: number,
  proxy: ProxyEndpoint,
): Promise<void> {
  const reader = createReader(socket)
  try {
    const withAuth = proxy.username != null
    socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))

    const greet = await reader.read(2)
    if (greet[0] !== 0x05) throw new Error('not a SOCKS5 proxy')
    const method = greet[1]
    if (method === 0xff) throw new Error('socks5: no acceptable auth method')

    if (method === 0x02) {
      const user = Buffer.from(proxy.username ?? '', 'utf8')
      const pass = Buffer.from(proxy.password ?? '', 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const auth = await reader.read(2)
      if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Error('socks5: auth failed')
    } else if (method !== 0x00) {
      throw new Error(`socks5: unsupported method ${method}`)
    }

    const request: number[] = [0x05, 0x01, 0x00]
    const ipType = isIP(host)
    if (ipType === 4) {
      request.push(0x01, ...host.split('.').map(Number))
    } else if (ipType === 6) {
      // 纯 IPv6 字面量转 16 字节过于繁琐；按域名下发，代理会自行解析
      const name = Buffer.from(host, 'utf8')
      request.push(0x03, name.length, ...name)
    } else {
      const name = Buffer.from(host, 'utf8')
      request.push(0x03, name.length, ...name)
    }
    request.push(port >> 8, port & 0xff)
    socket.write(Buffer.from(request))

    const head = await reader.read(4)
    if (head[0] !== 0x05) throw new Error('socks5: bad reply version')
    const rep = head[1]!
    if (rep !== 0x00) throw new Error(`socks5: ${SOCKS5_ERRORS[rep] ?? `error ${rep}`}`)

    // 消费绑定地址与端口，保证隧道起点对齐
    const atyp = head[3]
    if (atyp === 0x01) await reader.read(4 + 2)
    else if (atyp === 0x03) {
      const len = (await reader.read(1))[0]!
      await reader.read(len + 2)
    } else if (atyp === 0x04) await reader.read(16 + 2)
    else throw new Error(`socks5: unsupported address type ${String(atyp)}`)
  } finally {
    reader.dispose()
  }
}

/** 一轮 HTTP 探测；任何异常都收敛成 ok=false，绝不抛出 */
async function probeHttp(
  target: string,
  proxy: ProxyEndpoint | null,
  ua: string,
  timeoutMs: number,
  deps: ProbeDeps,
): Promise<LayerResult> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  let socket: Socket | undefined
  try {
    const url = new URL(target)
    const host = stripBrackets(url.hostname)
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    const https = url.protocol === 'https:'

    if (proxy) {
      socket = await withTimeout(openTcp(proxy.host, proxy.port, timeoutMs), remaining())
      if (proxy.protocol === 'https') {
        socket = await withTimeout(upgradeTls(socket, proxy.host, remaining(), deps), remaining())
      }
      if (proxy.protocol === 'socks5') {
        await withTimeout(socks5Connect(socket, host, port, proxy), remaining())
      } else if (https) {
        await withTimeout(openTunnel(socket, `${url.hostname}:${port}`, proxy, remaining()), remaining())
      }
      // http 目标经 HTTP(S) 代理：absolute-form 直发，不建隧道
    } else {
      socket = await withTimeout(openTcp(host, port, timeoutMs), remaining())
    }

    if (https) {
      socket = await withTimeout(upgradeTls(socket, host, remaining(), deps), remaining())
    }

    const viaHttpProxy = proxy != null && proxy.protocol !== 'socks5'
    const absoluteForm = viaHttpProxy && !https
    const requestTarget = absoluteForm ? url.href : `${url.pathname}${url.search}`
    const status = await withTimeout(
      requestStatus(socket, url, requestTarget, viaHttpProxy ? proxyAuthHeader(proxy) : undefined, ua, remaining()),
      remaining(),
    )
    // absolute-form 下 407 由代理生成（认证失败），请求并没有到目标
    const proxyRejected = absoluteForm && status === 407
    // 403 = 被 Cloudflare 拦截（节点 IP 被封，Codex 同样会被拦）；5xx = 网关故障。
    // 两者都不算「通」——只认 2xx / 其他 4xx（如 401 未认证）
    const ok = status > 0 && status !== 403 && status < 500 && !proxyRejected
    return { ok, status, latencyMs: Date.now() - startedAt }
  } catch {
    return { ok: false, status: 0, latencyMs: null }
  } finally {
    socket?.destroy()
  }
}

/** L1：能否 TCP 连上本地代理端口 */
async function probeTcp(proxy: ProxyEndpoint, timeoutMs: number): Promise<LayerResult> {
  const startedAt = Date.now()
  try {
    const socket = await openTcp(proxy.host, proxy.port, timeoutMs)
    socket.destroy()
    return { ok: true, status: null, latencyMs: Date.now() - startedAt }
  } catch {
    return { ok: false, status: null, latencyMs: null }
  }
}

/** 跑一轮探测（IO）；三层并行，任一失败不影响其余 */
export async function probeOnce(
  discovery: ProxyDiscovery,
  cfg: Config['probe'],
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  // 配了代理却连不上：不做无意义的 L2/L3 请求，直接判「代理程序未运行」
  if (discovery.kind === 'unreachable') {
    const unavailable: LayerResult = { ok: false, status: null, latencyMs: null }
    return {
      mode: 'proxy',
      l1: unavailable,
      l2: { ok: false, status: 0, latencyMs: null },
      l3: unavailable,
      verdict: 'proxyNotRunning',
    }
  }

  const endpoint: ProxyEndpoint | null = discovery.kind === 'found' ? discovery.endpoint : null
  const mode: ProbeMode = endpoint ? 'proxy' : 'direct'
  const notApplicable: LayerResult = { ok: false, status: null, latencyMs: null }
  const [l1, l2, l3] = await Promise.all([
    endpoint ? probeTcp(endpoint, cfg.timeoutMs) : Promise.resolve(notApplicable),
    // 没有代理配置时，Codex 也走直连 —— L2 直接探测目标
    probeHttp(cfg.targets.l2, endpoint, cfg.userAgent, cfg.timeoutMs, deps),
    probeHttp(cfg.targets.l3, null, cfg.userAgent, cfg.timeoutMs, deps),
  ])
  return {
    mode,
    l1,
    l2,
    l3,
    verdict: deriveVerdict({ mode, l1, l2, l3 }, cfg.slowThresholdMs),
  }
}

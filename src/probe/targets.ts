/**
 * L1/L2/L3 探测（§4.2）。
 *
 * 每轮并行打三层：
 *   L1  TCP connect 代理端口
 *   L2  经代理 GET https://chatgpt.com/（浏览器 UA）
 *   L3  直连 https://registry.npmmirror.com/
 *
 * 判定规则：HTTP 000（超时/DNS 失败/拒连）= 不通，其他任何状态码 = 通。
 * deriveVerdict 是纯函数（真值表），probeOnce 是 IO。
 *
 * 实现上只用 node:net / node:tls 手搓 HTTP/1.1，不引第三方代理库：
 *   - 经代理：先 CONNECT 建隧道，https 再套 TLS
 *   - 直连：直接连目标，https 套 TLS
 * 只读状态行（不读 body），拿到首行即断定「通」，延迟 = 首行耗时。
 */

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ProbeVerdict } from '../events.js'
import type { Config } from '../config.js'

export type LayerResult = {
  ok: boolean
  /** HTTP 状态码；0 表示未收到任何响应（超时/拒连），null 表示该层不是 HTTP（L1） */
  status: number | null
  latencyMs: number | null
}

export type ProbeResult = {
  l1: LayerResult
  l2: LayerResult
  l3: LayerResult
  verdict: ProbeVerdict
}

const PROXY_HOST = '127.0.0.1'
/** 单层响应的状态行读取上限，防止恶意/异常响应撑爆内存 */
const MAX_HEADER = 8192

/** 由 L1/L2/L3 结果推判定（纯函数，真值表见 §4.2） */
export function deriveVerdict(
  r: Omit<ProbeResult, 'verdict'>,
  slowThresholdMs: number,
): ProbeVerdict {
  // 代理程序不在：无论能否直连外网，Codex 都出不去
  if (!r.l1.ok) return 'proxyNotRunning'
  if (!r.l2.ok) return r.l3.ok ? 'proxyDown' : 'netDown'
  const slow = r.l2.latencyMs != null && r.l2.latencyMs > slowThresholdMs
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

function upgradeTls(socket: Socket, servername: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername })
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

/** 经 HTTP 代理建 CONNECT 隧道；非 200 视为失败 */
function openTunnel(socket: Socket, host: string, port: number, timeoutMs: number): Promise<void> {
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
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
  })
}

/** 发 GET，读到状态行即返回状态码 */
function requestStatus(socket: Socket, url: URL, ua: string, timeoutMs: number): Promise<number> {
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

    const hostHeader = url.port !== '' ? `${url.hostname}:${url.port}` : url.hostname
    socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        `User-Agent: ${ua}\r\n` +
        'Accept: */*\r\n' +
        'Connection: close\r\n\r\n',
    )
  })
}

/** 一轮 HTTP 探测；任何异常都收敛成 ok=false，绝不抛出 */
async function probeHttp(
  target: string,
  proxyPort: number | null,
  ua: string,
  timeoutMs: number,
): Promise<LayerResult> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  let socket: Socket | undefined
  try {
    const url = new URL(target)
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    const viaProxy = proxyPort != null

    socket = await withTimeout(
      openTcp(
        viaProxy ? PROXY_HOST : url.hostname,
        proxyPort != null ? proxyPort : port,
        timeoutMs,
      ),
      remaining(),
    )
    if (viaProxy) {
      await withTimeout(openTunnel(socket, url.hostname, port, remaining()), remaining())
    }
    if (url.protocol === 'https:') {
      socket = await withTimeout(upgradeTls(socket, url.hostname, remaining()), remaining())
    }

    const status = await withTimeout(requestStatus(socket, url, ua, remaining()), remaining())
    return { ok: status > 0, status, latencyMs: Date.now() - startedAt }
  } catch {
    return { ok: false, status: 0, latencyMs: null }
  } finally {
    socket?.destroy()
  }
}

/** L1：能否 TCP 连上本地代理端口 */
async function probeTcp(port: number, timeoutMs: number): Promise<LayerResult> {
  const startedAt = Date.now()
  try {
    const socket = await openTcp(PROXY_HOST, port, timeoutMs)
    socket.destroy()
    return { ok: true, status: null, latencyMs: Date.now() - startedAt }
  } catch {
    return { ok: false, status: null, latencyMs: null }
  }
}

/** 跑一轮三层探测（IO）；三层并行，任一失败不影响其余 */
export async function probeOnce(
  proxyPort: number,
  cfg: Config['probe'],
): Promise<ProbeResult> {
  const [l1, l2, l3] = await Promise.all([
    probeTcp(proxyPort, cfg.timeoutMs),
    probeHttp(cfg.targets.l2, proxyPort, cfg.userAgent, cfg.timeoutMs),
    probeHttp(cfg.targets.l3, null, cfg.userAgent, cfg.timeoutMs),
  ])
  return { l1, l2, l3, verdict: deriveVerdict({ l1, l2, l3 }, cfg.slowThresholdMs) }
}

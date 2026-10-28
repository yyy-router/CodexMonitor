/**
 * 代理端点推导（§4.2）。
 *
 * 代理端口会漂移（7897 → 7890），写死必然失效。按序尝试，命中即用：
 *   1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   2. Windows 系统代理（注册表 ProxyServer，且 ProxyEnable=1）
 *
 * **auto 模式不再回退扫常见端口**：否则会在「系统代理已关、环境变量也已清空」
 * 时仍然找到一个本地代理并报 ok，而 Codex 实际走直连、完全不可用。两者都没有
 * 时返回 null，由上层按直连探测（匹配 Codex 的真实行为）。
 * mode='manual' 表示用户显式指定，只探测 cfg.ports。
 *
 * 只保留端口是不够的：SOCKS5 与 HTTP 代理的建连方式完全不同，带认证的代理
 * 还需要凭据。因此返回完整端点（协议 + 主机 + 端口 + 可选凭据）。
 *
 * 候选端点一律先做 TCP 探测，避免被失效的旧环境变量带偏。
 */

import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import type { Config } from '../config.js'

/** 探针支持的代理协议；https 指「到代理本身走 TLS」 */
export type ProxyProtocol = 'http' | 'https' | 'socks5'

export type ProxyEndpoint = {
  protocol: ProxyProtocol
  host: string
  port: number
  /** HTTP 代理的 Proxy-Authorization / SOCKS5 的用户名口令认证 */
  username?: string
  password?: string
}

/**
 * 代理发现结果。null 不足以表达三种状态：
 *   found       —— 找到可连的代理，按代理模式探测
 *   unreachable —— 配置/候选存在但都连不上（应判「代理程序未运行」）
 *   none        —— 没有任何代理配置（Codex 会走直连，按直连模式探测）
 */
export type ProxyDiscovery =
  | { kind: 'found'; endpoint: ProxyEndpoint }
  | { kind: 'unreachable' }
  | { kind: 'none' }

export type ProxyDetectDeps = {
  /** 环境变量来源，默认 process.env */
  env?: NodeJS.ProcessEnv
  /** Windows 系统代理原始值（ProxyServer），默认读注册表 */
  readRegistryProxy?: () => string | null
  /** 端口是否可连，默认真做 TCP connect */
  probeTcp?: (port: number) => Promise<boolean>
}

const ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** URL 协议 → 探针协议；不在表内的（socks4 等）不支持，直接跳过 */
const PROTOCOL_MAP: Record<string, ProxyProtocol | undefined> = {
  'http:': 'http',
  'https:': 'https',
  'socks5:': 'socks5',
  'socks5h:': 'socks5',
}

/**
 * 协议默认端口。
 * WHATWG URL 会把 `http://host:80` 的端口规范化为空串，所以显式写出的默认端口
 * 必须靠这张表补回来，否则跑在 80/443 上的代理会被静默跳过。
 */
const DEFAULT_PORT: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'socks5:': 1080,
  'socks5h:': 1080,
}

/** URL 的 hostname 对 IPv6 带方括号；socket 连接与比较需要裸地址 */
const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '')

/** `http://u:p@host:7890` / `socks5://host:1080` / `host:7890` → 端点 */
function parseEndpoint(value: string): ProxyEndpoint | null {
  const v = value.trim()
  if (v === '') return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`)
  } catch {
    return null
  }
  const protocol = PROTOCOL_MAP[url.protocol]
  if (!protocol) return null

  const host = stripBrackets(url.hostname)
  if (host === '') return null

  const portText = url.port !== '' ? url.port : String(DEFAULT_PORT[url.protocol] ?? '')
  const port = Number(portText)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null

  const endpoint: ProxyEndpoint = { protocol, host, port }
  if (url.username !== '') endpoint.username = decodeURIComponent(url.username)
  if (url.password !== '') endpoint.password = decodeURIComponent(url.password)
  return endpoint
}

/** 注册表可能是 `http=127.0.0.1:7890;https=127.0.0.1:7891`，逐段解析 */
function parseProxyValue(raw: string): ProxyEndpoint[] {
  const endpoints: ProxyEndpoint[] = []
  for (const seg of raw.split(/[;,]/)) {
    const eq = seg.indexOf('=')
    const endpoint = parseEndpoint(eq >= 0 ? seg.slice(eq + 1) : seg)
    if (endpoint) endpoints.push(endpoint)
  }
  return endpoints
}

/** 读 Windows 系统代理；未启用 / 非 Windows / 读取失败均返回 null */
function readWindowsRegistryProxy(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const enabled = execFileSync('reg', ['query', REG_PATH, '/v', 'ProxyEnable'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return null
    const server = execFileSync('reg', ['query', REG_PATH, '/v', 'ProxyServer'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(server)
    return m?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

function probeTcpPort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** 推导代理端点，并区分「没有配置」「配置了但连不上」「找到」 */
export async function detectProxy(
  cfg: Config['probe']['proxy'],
  deps: ProxyDetectDeps = {},
): Promise<ProxyDiscovery> {
  const env = deps.env ?? process.env
  const readRegistry = deps.readRegistryProxy ?? readWindowsRegistryProxy
  const probe = deps.probeTcp ?? probeTcpPort

  const candidates: ProxyEndpoint[] = []
  if (cfg.mode === 'manual') {
    for (const port of cfg.ports) {
      candidates.push({ protocol: 'http', host: '127.0.0.1', port })
    }
  } else {
    for (const key of ENV_KEYS) {
      const raw = env[key]
      if (raw) candidates.push(...parseProxyValue(raw))
    }
    const registry = readRegistry()
    if (registry) candidates.push(...parseProxyValue(registry))
  }

  if (candidates.length === 0) return { kind: 'none' }

  const seen = new Set<string>()
  for (const endpoint of candidates) {
    const key = `${endpoint.host}:${endpoint.port}`
    if (seen.has(key)) continue
    seen.add(key)
    if (await probe(endpoint.port)) return { kind: 'found', endpoint }
  }
  return { kind: 'unreachable' }
}

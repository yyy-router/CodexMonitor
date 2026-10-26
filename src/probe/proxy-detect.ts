/**
 * 代理端口推导（§4.2）。
 *
 * 代理端口会漂移（7897 → 7890），写死必然失效。按序尝试，命中即用：
 *   1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   2. Windows 系统代理（注册表 ProxyServer）
 *   3. 常见端口探测（cfg.ports）
 *
 * 候选端口一律先做 TCP 探测，避免被失效的旧环境变量带偏。
 * mode='manual' 表示用户显式指定，只探测 cfg.ports。
 */

import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import type { Config } from '../config.js'

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

/** `http://u:p@host:7890` / `socks5://host:1080` / `host:7890` → 7890 / 1080 / 7890 */
function parsePort(value: string): number | null {
  const v = value.trim()
  if (v === '') return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`)
  } catch {
    return null
  }
  if (url.port === '') return null
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/** 注册表可能是 `http=127.0.0.1:7890;https=127.0.0.1:7891`，逐段解析 */
function parseProxyValue(raw: string): number[] {
  const ports: number[] = []
  for (const seg of raw.split(/[;,]/)) {
    const eq = seg.indexOf('=')
    const port = parsePort(eq >= 0 ? seg.slice(eq + 1) : seg)
    if (port != null) ports.push(port)
  }
  return ports
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

/** 返回推导出的代理端口；推导失败返回 null */
export async function detectProxyPort(
  cfg: Config['probe']['proxy'],
  deps: ProxyDetectDeps = {},
): Promise<number | null> {
  const env = deps.env ?? process.env
  const readRegistry = deps.readRegistryProxy ?? readWindowsRegistryProxy
  const probe = deps.probeTcp ?? probeTcpPort

  const candidates: number[] = []
  if (cfg.mode === 'auto') {
    for (const key of ENV_KEYS) {
      const raw = env[key]
      if (raw) candidates.push(...parseProxyValue(raw))
    }
    const registry = readRegistry()
    if (registry) candidates.push(...parseProxyValue(registry))
  }
  candidates.push(...cfg.ports)

  const seen = new Set<number>()
  for (const port of candidates) {
    if (seen.has(port)) continue
    seen.add(port)
    if (await probe(port)) return port
  }
  return null
}

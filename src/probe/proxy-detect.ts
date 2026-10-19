/**
 * 代理端口推导（§4.2）。
 *
 * 代理端口会漂移（7897 → 7890），写死必然失效。按序尝试，命中即用：
 *   1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   2. Windows 系统代理（注册表 ProxyServer）
 *   3. 常见端口探测（cfg.ports）
 */

import type { Config } from '../config.js'

/** 返回推导出的代理端口；推导失败返回 null */
export async function detectProxyPort(_cfg: Config['probe']['proxy']): Promise<number | null> {
  throw new Error('Not implemented: detectProxyPort')
}

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
 */

import type { ProbeVerdict } from '../events.js'
import type { Config } from '../config.js'

export type LayerResult = {
  ok: boolean
  /** HTTP 状态码；0 表示未收到任何响应（超时/拒连） */
  status: number | null
  latencyMs: number | null
}

export type ProbeResult = {
  l1: LayerResult
  l2: LayerResult
  l3: LayerResult
  verdict: ProbeVerdict
}

/** 由 L1/L2/L3 结果推判定（纯函数，真值表见 §4.2） */
export function deriveVerdict(
  _r: Omit<ProbeResult, 'verdict'>,
  _slowThresholdMs: number,
): ProbeVerdict {
  throw new Error('Not implemented: deriveVerdict')
}

/** 跑一轮三层探测（IO） */
export async function probeOnce(
  _proxyPort: number,
  _cfg: Config['probe'],
): Promise<ProbeResult> {
  throw new Error('Not implemented: probeOnce')
}

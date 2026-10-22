/**
 * 会话文件发现（纯函数）。
 *
 * 输入：递归扫描 ~/.codex/sessions/**\/rollout-*.jsonl 得到的文件列表。
 * 输出：按 mtime 取最新的 N 个，作为待 tail 集合（§4.1）。
 * 扫描的 IO 由调用方（tailer / index）完成，本模块只做选择，便于单测。
 */

export type SessionFile = {
  path: string
  /** 文件最后修改时间，unix 毫秒 */
  mtimeMs: number
  size: number
}

/** 按 mtimeMs 降序，取前 maxTracked 个。纯函数：不改入参。 */
export function selectFiles(files: SessionFile[], maxTracked: number): SessionFile[] {
  const n = Math.max(0, maxTracked)
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, n)
}

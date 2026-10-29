/** 路径工具：Node 不做 shell 展开，配置里的 `~` 要自己展开 */

import { homedir } from 'node:os'
import path from 'node:path'

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2))
  return p
}

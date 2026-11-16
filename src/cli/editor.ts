/** 解析并启动外部编辑器。不经过 shell，配置路径始终作为独立参数传入 */

import { spawn } from 'node:child_process'

export type EditorEnv = {
  EDITOR?: string | undefined
  VISUAL?: string | undefined
}

export type EditorCommand = { command: string; args: string[] }

export type OpenResult =
  | { ok: true; editor: string; fellBack: boolean }
  | { ok: false; reason: string }

const FALLBACK_EDITOR = 'notepad.exe'

/** 双引号 / 单引号 / 普通 token；不支持 shell 变量与转义 */
const TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g

export function parseEditorCommand(text: string): EditorCommand | null {
  const parts = [...text.matchAll(TOKEN)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
  const command = parts.shift() ?? ''
  if (command === '') return null
  return { command, args: parts }
}

/** EDITOR → VISUAL → notepad.exe；空字符串视为未设置 */
export function resolveEditor(env: EditorEnv): EditorCommand {
  for (const raw of [env.EDITOR, env.VISUAL]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const parsed = parseEditorCommand(raw.trim())
    if (parsed) return parsed
  }
  return { command: FALLBACK_EDITOR, args: [] }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function runEditor(
  command: string,
  args: string[],
  filePath: string,
  spawnFn: typeof spawn,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: true } | { ok: false; reason: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn(command, [...args, filePath], { stdio: 'inherit' })
    } catch (e) {
      finish({ ok: false, reason: errText(e) })
      return
    }

    child.once('error', (e) => finish({ ok: false, reason: errText(e) }))
    child.once('exit', () => finish({ ok: true }))
  })
}

/** 启动编辑器并等待退出；首选无法启动时回退 notepad */
export async function openConfigInEditor(
  filePath: string,
  options: { env?: EditorEnv; spawn?: typeof spawn } = {},
): Promise<OpenResult> {
  const editor = resolveEditor(options.env ?? process.env)
  const spawnFn = options.spawn ?? spawn

  const first = await runEditor(editor.command, editor.args, filePath, spawnFn)
  if (first.ok) return { ok: true, editor: editor.command, fellBack: false }

  if (editor.command.toLowerCase() === FALLBACK_EDITOR) {
    return { ok: false, reason: first.reason }
  }

  const fallback = await runEditor(FALLBACK_EDITOR, [], filePath, spawnFn)
  if (fallback.ok) return { ok: true, editor: FALLBACK_EDITOR, fellBack: true }

  return {
    ok: false,
    reason: `${editor.command}: ${first.reason}; ${FALLBACK_EDITOR}: ${fallback.reason}`,
  }
}

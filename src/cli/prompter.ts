/** 终端问答：普通输入回显，密钥输入掩码。手写 keypress 读取，便于单测 */

import readline from 'node:readline'

export type PromptInput = NodeJS.ReadStream & {
  isRaw?: boolean
  setRawMode?(mode: boolean): void
}

export type Prompter = {
  ask(question: string): Promise<string>
  askSecret(question: string): Promise<string>
  close(): void
}

function readLine(
  input: PromptInput,
  output: NodeJS.WritableStream,
  mask: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(input)
    const wasRaw = input.isRaw === true
    if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(true)
    input.resume()

    let value = ''

    const finish = (err?: Error): void => {
      input.off('keypress', onKey)
      if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(wasRaw)
      input.pause()
      output.write('\n')
      if (err) reject(err)
      else resolve(value)
    }

    const onKey = (str: string | undefined, key: readline.Key): void => {
      if (key?.ctrl && key.name === 'c') return finish(new Error('已取消配置向导'))
      if (key?.name === 'return') return finish()
      if (key?.name === 'backspace') {
        if (value !== '') {
          value = value.slice(0, -1)
          output.write('\b \b')
        }
        return
      }
      if (str && !key?.ctrl && !key?.meta) {
        value += str
        output.write(mask ? '*' : str)
      }
    }

    input.on('keypress', onKey)
  })
}

export function createPrompter(
  input: PromptInput = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter {
  return {
    ask(question) {
      output.write(question)
      return readLine(input, output, false)
    },
    askSecret(question) {
      output.write(question)
      return readLine(input, output, true)
    },
    close() {
      // 无长驻资源；raw mode 在每次读取结束后已恢复
    },
  }
}

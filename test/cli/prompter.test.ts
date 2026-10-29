import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { createPrompter, type PromptInput } from '../../src/cli/prompter.js'

const makeInput = (): PromptInput => {
  const input = new PassThrough() as unknown as PromptInput
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode
  }
  return input
}

const key = (input: PromptInput, str: string | undefined, name: string, ctrl = false): void => {
  input.emit('keypress', str, { name, ctrl, meta: false })
}

/** PassThrough 每次 read() 只返回一个 write 块，需要循环排空 */
const drain = (stream: PassThrough): string => {
  let text = ''
  let chunk: Buffer | null
  while ((chunk = stream.read() as Buffer | null) !== null) text += chunk.toString()
  return text
}

describe('createPrompter', () => {
  it('ask：回显输入并返回整行', async () => {
    const input = makeInput()
    const output = new PassThrough()
    const prompter = createPrompter(input, output)

    const answer = prompter.ask('名字：')
    key(input, 'a', 'a')
    key(input, 'b', 'b')
    key(input, 'c', 'c')
    key(input, undefined, 'return')

    await expect(answer).resolves.toBe('abc')
    expect(drain(output)).toContain('名字：abc')
    expect(input.isRaw).toBe(false)
  })

  it('askSecret：不回显明文，只回显星号', async () => {
    const input = makeInput()
    const output = new PassThrough()
    const prompter = createPrompter(input, output)

    const answer = prompter.askSecret('Secret：')
    key(input, 'p', 'p')
    key(input, '@', '@')
    key(input, 's', 's')
    key(input, undefined, 'return')

    await expect(answer).resolves.toBe('p@s')
    const text = drain(output)
    expect(text).toContain('***')
    expect(text).not.toContain('p@s')
  })

  it('askSecret：退格删除', async () => {
    const input = makeInput()
    const output = new PassThrough()
    const prompter = createPrompter(input, output)

    const answer = prompter.askSecret('Secret：')
    key(input, 'a', 'a')
    key(input, 'b', 'b')
    key(input, undefined, 'backspace')
    key(input, undefined, 'return')

    await expect(answer).resolves.toBe('a')
  })

  it('Ctrl+C 中止并拒绝', async () => {
    const input = makeInput()
    const output = new PassThrough()
    const prompter = createPrompter(input, output)

    const answer = prompter.askSecret('Secret：')
    input.emit('keypress', undefined, { name: 'c', ctrl: true, meta: false })

    await expect(answer).rejects.toThrow(/取消/)
  })
})

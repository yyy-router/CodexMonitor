#!/usr/bin/env node
/**
 * iLink 可行性探针
 *
 * 目的：在写主体程序之前，实测微信 iLink 协议的实际能力与限制。
 *
 * 用法：
 *   node demo/ilink-probe.mjs login            扫码登录
 *   node demo/ilink-probe.mjs listen           长轮询收消息（先运行它，然后给 Bot 发一条消息）
 *   node demo/ilink-probe.mjs send "你好"      发一条消息
 *   node demo/ilink-probe.mjs flood 15 1200    连发 15 条（间隔 1200ms）—— 探测推送配额
 *
 * 产物（全部在 demo/.wechatbot/ 下，已被 .gitignore 忽略）：
 *   credentials / context_token  由 SDK 自行持久化
 *   state.json                   本项目额外记录（userId 等）
 *   probe-log.jsonl              每次发送的结果，供事后分析
 *
 * ─────────────────────────────────────────────────────────────
 * 踩过的坑（@wechatbot/wechatbot@2.2.0 实测，勿"顺手改回去"）：
 *
 *  1. 构造函数里的 `loginCallbacks` 会被忽略。
 *     必须把 callbacks 传给 `bot.login({ callbacks })`，否则 onQrUrl 永不触发，
 *     表现为"运行后完全没反应，直到超时"。已实测 A/B 对比确认。
 *
 *  2. `contextStore.load()` 只在 `start()` 里被调用。
 *     所以不 start() 就 `send()` 必然抛 NoContextError，即使登录过、收到过消息。
 *     发消息前必须先 start()（见 withPolling）。
 *
 *  3. `start()` 会一直阻塞到轮询结束，其后的代码不会执行。
 *     提示文案必须打印在 `await bot.start()` 之前。
 * ─────────────────────────────────────────────────────────────
 */

import { WeChatBot, ApiError, NoContextError } from '@wechatbot/wechatbot'
import qrcode from 'qrcode-terminal'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(HERE, '.wechatbot')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const LOG_FILE = path.join(DATA_DIR, 'probe-log.jsonl')

fs.mkdirSync(DATA_DIR, { recursive: true })

// ---------- 本地状态与日志 ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveState(patch) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 2))
}

function logResult(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

// ---------- 登录回调 ----------
// 注意：必须通过 login({ callbacks }) 传入，构造函数里的同名选项会被忽略（见文件头坑 #1）。

const LOGIN_CALLBACKS = {
  onQrUrl(url) {
    console.log('\n' + '─'.repeat(70))
    console.log('用微信扫描下面的二维码：')
    console.log('─'.repeat(70) + '\n')
    try {
      // small:true 在部分终端（尤其 VSCode 集成终端）会渲染错乱，
      // 所以下面永远同时给出纯文本链接作为兜底。
      qrcode.generate(url, { small: true })
    } catch (err) {
      console.log('（二维码渲染失败：' + err.message + '）')
    }
    console.log('\n二维码显示不正常？把下面的链接粘到任意在线二维码生成器，用微信扫：\n')
    console.log('  ' + url + '\n')
  },
  onScanned() {
    console.log('✅ 已扫码，请在手机上确认…')
  },
  onExpired() {
    console.log('⚠️  二维码已过期，正在重新获取…')
  },
}

// ---------- Bot 构造 ----------

function createBot() {
  return new WeChatBot({
    storage: 'file',
    storageDir: DATA_DIR,
    // 默认 info：SDK 自身的 "Scan this QR code..." 等日志是重要的可见信号，
    // 压到 warn 会让脚本出问题时彻底无声（这是最初"没反应"的一个成因）。
    logLevel: process.env.LOG_LEVEL || 'info',
    botAgent: 'CodexMonitor-probe/0.1',
    loginCallbacks: LOGIN_CALLBACKS, // 保留以防 SDK 日后修复，但当前不依赖它
  })
}

/** 登录（有凭证时 SDK 会自动跳过扫码）。callbacks 必须走 options。 */
async function loginBot(bot, force = false) {
  console.log('检查登录状态…')
  const creds = await bot.login({ force, callbacks: LOGIN_CALLBACKS })
  saveState({
    accountId: creds.accountId,
    botUserId: creds.userId,
    loggedInAt: creds.savedAt,
  })
  return creds
}

/**
 * 启动轮询 → 执行 fn → 停止。
 *
 * 发消息前必须先走这里：`send()` 依赖 `contextStore`，
 * 而 `contextStore.load()` 只在 `start()` 内部被调用（见文件头坑 #2）。
 */
async function withPolling(bot, fn) {
  const ready = new Promise((resolve) => bot.on('poll:start', resolve))
  const polling = bot.start() // 不 await —— 它会阻塞到停止为止
  try {
    await ready // 等到 context_store / 游标都已加载
    return await fn()
  } finally {
    bot.stop()
    await polling.catch(() => {})
  }
}

/** 发送一条文本，返回结构化结果（绝不抛异常，便于 flood 统计） */
async function trySend(bot, userId, text) {
  const t0 = Date.now()
  try {
    await bot.send(userId, text)
    return { ok: true, ms: Date.now() - t0 }
  } catch (err) {
    const info = { ok: false, ms: Date.now() - t0, name: err?.constructor?.name, message: err?.message }
    if (err instanceof ApiError) {
      info.httpStatus = err.httpStatus
      info.errcode = err.errcode
      info.isSessionExpired = err.isSessionExpired
    }
    if (err instanceof NoContextError) info.noContext = true
    return info
  }
}

// ---------- 命令实现 ----------

async function cmdLogin() {
  const bot = createBot()
  const creds = await loginBot(bot, true)
  console.log('\n✅ 登录成功')
  console.log('   账号 ID    :', creds.accountId)
  console.log('   Bot userId :', creds.userId)
  console.log('   凭证已保存到:', DATA_DIR)
  console.log('\n下一步：运行 `node demo/ilink-probe.mjs listen`，然后用微信给这个 Bot 发一条消息。\n')
}

async function cmdListen() {
  const bot = createBot()
  await loginBot(bot)

  bot.onMessage(async (msg) => {
    console.log(`\n[${new Date().toLocaleTimeString()}] 收到 ${msg.type} 来自 ${msg.userId}: ${msg.text}`)
    saveState({ userId: msg.userId, lastInboundAt: new Date().toISOString() })
    logResult({ kind: 'inbound', userId: msg.userId, type: msg.type, text: msg.text })
    // 回执结果也写日志 —— 否则"收到 N 条入站"无法反推"发出几条出站、成没成功"
    const t0 = Date.now()
    try {
      await bot.reply(msg, '✅ CodexMonitor 探针已收到你的消息，现在可以主动推送了。')
      const ms = Date.now() - t0
      console.log(`   ↳ 已回执（${ms}ms）`)
      logResult({ kind: 'reply', userId: msg.userId, ok: true, ms })
    } catch (err) {
      console.error('   ↳ 回执失败:', err?.message)
      logResult({ kind: 'reply', userId: msg.userId, ok: false, ms: Date.now() - t0, message: err?.message })
    }
  })

  bot.on('session:expired', () => console.log('⚠️  会话已过期，需要重新扫码'))
  bot.on('error', (err) => console.error('轮询错误:', err?.message ?? err))
  bot.on('poll:start', () => {
    console.log('\n📡 正在监听… 现在用微信给 Bot 发一条消息。（Ctrl+C 退出）')
    console.log('   收到消息后，本项目就具备了主动推送能力。\n')
  })

  // 坑 #3：await start() 会阻塞到轮询结束，之后的代码不会执行。所以提示打在前面。
  console.log('正在启动轮询…')
  await bot.start()
}

async function cmdSend(text) {
  if (!text) throw new Error('用法: node demo/ilink-probe.mjs send "要发送的文本"')
  const { userId } = loadState()
  if (!userId) throw new Error('还不知道推给谁。请先运行 listen 并给 Bot 发一条消息。')

  const bot = createBot()
  await loginBot(bot)

  const result = await withPolling(bot, () => trySend(bot, userId, text))
  logResult({ kind: 'send', userId, text, ...result })

  if (result.ok) {
    console.log(`✅ 发送成功（${result.ms}ms）`)
  } else {
    console.log(`❌ 发送失败（${result.ms}ms）`)
    console.log('   ', JSON.stringify(result, null, 2))
    if (result.noContext) {
      console.log('\n   → 没有 context_token。请先运行 listen 并给 Bot 发一条消息激活会话。')
    }
  }
}

async function cmdFlood(count, delayMs, prime = false) {
  const { userId } = loadState()
  if (!userId) throw new Error('还不知道推给谁。请先运行 listen 并给 Bot 发一条消息。')

  const bot = createBot()
  await loginBot(bot)

  const outcome = await withPolling(bot, async () => {
    // --prime：先等一条入站消息。作用有二：
    //   1. 服务端据此把配额重置为 10
    //   2. 轮询器顺手刷新 context_token（否则用的是缓存里的旧 token）
    // 注意：这里注册的 handler 只用于唤醒，不回执 —— 回执会白白消耗 1 条额度。
    if (prime) {
      console.log('\n⏳ 等待你给 Bot 发一条消息（用于重置配额）… 最多等 120 秒')
      console.log('   现在切到微信，随便发一条。')
      let waited = 0
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 120_000)
        bot.onMessage((msg) => {
          clearTimeout(timer)
          waited = Date.now()
          console.log(`   ✅ 收到: ${JSON.stringify(msg.text)}`)
          resolve()
        })
      })
      if (!waited) throw new Error('等待超时，没收到任何入站消息。')
      // 留一点时间让 context_token 落盘
      await new Promise((r) => setTimeout(r, 800))
      console.log('   配额应已重置为 10，且 context_token 已刷新。\n')
    }

    console.log(`🚀 配额探测：准备连发 ${count} 条，间隔 ${delayMs}ms`)
    console.log('   观察每一条的返回，第一条失败的位置就是配额边界。\n')

    let succeeded = 0
    let firstFailure = null
    const startedAt = Date.now()

    for (let i = 1; i <= count; i++) {
      const result = await trySend(bot, userId, `[探针 ${i}/${count}] ${new Date().toLocaleTimeString()}`)
      logResult({ kind: 'flood', index: i, total: count, ...result })

      if (result.ok) {
        succeeded++
        console.log(`   ${String(i).padStart(3)}/${count}  ✅  ${String(result.ms).padStart(5)}ms`)
      } else {
        if (!firstFailure) firstFailure = { index: i, ...result }
        const detail = result.errcode !== undefined ? `errcode=${result.errcode}` : (result.name ?? 'Error')
        console.log(`   ${String(i).padStart(3)}/${count}  ❌  ${String(result.ms).padStart(5)}ms  ${detail}  ${result.message ?? ''}`)
      }

      if (i < count) await new Promise((r) => setTimeout(r, delayMs))
    }

    return { succeeded, firstFailure, elapsed: Date.now() - startedAt }
  })

  console.log('\n────────── 汇总 ──────────')
  console.log(`   尝试次数   : ${count}`)
  console.log(`   成功       : ${outcome.succeeded}`)
  console.log(`   失败       : ${count - outcome.succeeded}`)
  console.log(`   首次失败于 : ${outcome.firstFailure ? `第 ${outcome.firstFailure.index} 条` : '未出现失败'}`)
  console.log(`   总耗时     : ${(outcome.elapsed / 1000).toFixed(1)}s`)
  if (outcome.firstFailure) {
    console.log('\n   首次失败详情:')
    console.log('   ' + JSON.stringify(outcome.firstFailure, null, 2).split('\n').join('\n   '))
  }
  console.log(`\n   完整记录已写入: ${path.relative(process.cwd(), LOG_FILE)}`)
  console.log('   注意：微信端实际收到几条，需要在手机上人工核对——接口返回成功 != 用户收到。\n')

  saveState({
    lastFlood: {
      at: new Date().toISOString(),
      attempted: count,
      succeeded: outcome.succeeded,
      firstFailureIndex: outcome.firstFailure?.index ?? null,
    },
  })
}

// ---------- 入口 ----------

const [cmd, ...rest] = process.argv.slice(2)

const USAGE = `
iLink 可行性探针

  node demo/ilink-probe.mjs login                   扫码登录
  node demo/ilink-probe.mjs listen                  长轮询收消息（先跑它，再给 Bot 发消息）
  node demo/ilink-probe.mjs send "文本"             发送一条
  node demo/ilink-probe.mjs flood [n] [delay]       连发 n 条（默认 15 条 / 1200ms）探测配额
  node demo/ilink-probe.mjs flood 12 1000 --prime   先等你发一条消息重置配额，再连发
`

try {
  switch (cmd) {
    case 'login':
      await cmdLogin()
      break
    case 'listen':
      await cmdListen()
      break
    case 'send':
      await cmdSend(rest.join(' '))
      break
    case 'flood': {
      const prime = rest.includes('--prime')
      const nums = rest.filter((a) => !a.startsWith('--'))
      await cmdFlood(Number(nums[0]) || 15, Number(nums[1]) || 1200, prime)
      break
    }
    default:
      console.log(USAGE)
      process.exit(cmd ? 1 : 0)
  }
} catch (err) {
  console.error('\n❌ ' + (err?.message ?? err))
  if (process.env.DEBUG) console.error(err)
  process.exit(1)
}

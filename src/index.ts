/**
 * 组装 + 生命周期 + tick 循环（§3）。
 *
 * 单一常驻 Node 进程，模块间用 EventEmitter 解耦：
 *   config → tailer / probe / policyEngine / notifier / deliveryLog / stateStore
 *   tick 循环：tailer.tick() + quotaTracker.tick() + aggregator flush → 通知 → 配额守卫 → 投递
 *   probe 定时器：每 intervalMs 跑一轮 → 状态机 → NetEvent → policyEngine
 *
 * 编排逻辑在 runtime.ts；这里只负责装配、定时器与信号收尾。
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig, type Config } from './config.js'
import { classify } from './policy/classify.js'
import { createAggregator } from './policy/aggregator.js'
import { createQuotaTracker } from './policy/quota-tracker.js'
import { createQuotaGuard } from './policy/quota-guard.js'
import { createPolicyEngine } from './policy/engine.js'
import { createTailer } from './watcher/tailer.js'
import { parseLine, parseSessionMeta } from './watcher/parse.js'
import { FeishuNotifier } from './notify/feishu-notifier.js'
import { ConsoleNotifier } from './notify/console-notifier.js'
import { createDeliveryLog } from './notify/delivery-log.js'
import { createStateStore } from './store/state-store.js'
import { detectProxy } from './probe/proxy-detect.js'
import { probeOnce, type ProbeResult } from './probe/targets.js'
import { createRuntime } from './runtime.js'
import type { Notifier } from './notify/notifier.js'

/** tick 循环间隔：决定聚合 flush 与额度倒计时的检查频率 */
const TICK_INTERVAL_MS = 1000

export type MainDeps = {
  /** 注入通道（测试替身 / ConsoleNotifier）；缺省按配置创建 */
  notifier?: Notifier
  /** 注入探测实现，缺省走真实网络 */
  probe?: () => Promise<ProbeResult>
  now?: () => number
  log?: (line: string) => void
  /** 测试注入：触发后优雅退出；缺省监听 SIGINT / SIGTERM */
  signal?: AbortSignal
  /** tick 循环间隔（毫秒），默认 1000；集成测试可缩短 */
  tickIntervalMs?: number
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 展开配置里的 `~` 前缀（Node 不做 shell 展开） */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2))
  return p
}

/** 按配置创建推送通道；iLink 本轮不实现，明确报错而不是静默降级 */
export function createNotifier(cfg: Config): Notifier {
  switch (cfg.notify.channel) {
    case 'feishu':
      return new FeishuNotifier({
        appId: cfg.feishu.appId,
        appSecret: cfg.feishu.appSecret,
        email: cfg.feishu.email,
        mobile: cfg.feishu.mobile,
      })
    case 'console':
      return new ConsoleNotifier()
    case 'ilink':
      throw new Error(
        "iLink 通道尚未实现（本轮不兼容 iLink），请把 notify.channel 设为 'feishu' 或 'console'",
      )
  }
}

/** 默认停止信号：SIGINT / SIGTERM */
function createStopSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    },
  }
}

/** 组装全部模块并启动常驻循环；返回的 Promise 在收到停止信号后 resolve */
export async function main(config?: Config, deps: MainDeps = {}): Promise<void> {
  const cfg = config ?? loadConfig()
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((line: string): void => console.log(`[codexmonitor] ${line}`))

  const notifier = deps.notifier ?? createNotifier(cfg)
  const thresholds = cfg.notify.thresholds
  const quota = createQuotaTracker({ thresholds })
  const policy = createPolicyEngine({
    classify: (ev) => classify(ev, thresholds),
    aggregator: createAggregator(cfg.notify.aggregate),
    quotaTracker: quota,
    // 只有 iLink 有会话额度模型；飞书 / 控制台不设防
    quotaGuard: cfg.notify.channel === 'ilink' ? createQuotaGuard(cfg.ilink.quota) : undefined,
  })

  const stateDir = expandHome(cfg.state.dir)
  const stateStore = createStateStore(stateDir)
  const deliveryLog = createDeliveryLog(stateDir)
  const tailer = createTailer({
    sessionsDir: expandHome(cfg.codex.sessionsDir),
    maxTrackedFiles: cfg.codex.maxTrackedFiles,
    parseLine,
    parseSessionMeta,
  })

  const probe =
    deps.probe ??
    (async (): Promise<ProbeResult> => probeOnce(await detectProxy(cfg.probe.proxy), cfg.probe))

  const runtime = createRuntime({
    cfg,
    notifier,
    policy,
    quota,
    stateStore,
    deliveryLog,
    probe,
    now,
    log,
  })

  const { signal, dispose } = deps.signal
    ? { signal: deps.signal, dispose: (): void => {} }
    : createStopSignal()

  let stopped = false
  let ticking = false
  let tickTimer: NodeJS.Timeout | undefined
  let probeTimer: NodeJS.Timeout | undefined
  const inFlight = new Set<Promise<void>>()

  const track = (task: Promise<void>): void => {
    inFlight.add(task)
    const done = (): void => {
      inFlight.delete(task)
    }
    task.then(done, done)
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (tickTimer) clearInterval(tickTimer)
    if (probeTimer) clearTimeout(probeTimer)
    // 等本轮 tick / 探针跑完，避免「已停止」之后还有消息发出、状态还在写
    await Promise.allSettled([...inFlight])
    try {
      await runtime.stop()
    } catch (e) {
      log(`停止时出错：${errText(e)}`)
    }
    dispose()
    log('已停止')
  }

  try {
    await runtime.start()
  } catch (e) {
    // 启动失败也要移除信号监听，否则宿主进程会残留指向废弃 controller 的 handler
    dispose()
    throw e
  }

  // 启动过程中就可能已收到停止信号（例如通道启动失败后主动退出）
  if (signal.aborted) {
    await stop()
    return
  }

  const onTick = async (): Promise<void> => {
    try {
      const events = await tailer.tick()
      if (events.length > 0) await runtime.ingest(events)
      await runtime.tick()
    } catch (e) {
      log(`tick 失败：${errText(e)}`)
    }
  }

  const scheduleProbe = (delayMs: number): void => {
    if (stopped) return
    probeTimer = setTimeout(() => {
      if (stopped) return
      track(onProbe())
    }, delayMs)
  }

  const onProbe = async (): Promise<void> => {
    if (stopped) return
    let delay = cfg.probe.intervalMs
    try {
      const { verdict, state } = await runtime.probeRound()
      const healthy = verdict === 'ok' || verdict === 'slow'
      // 正常态下出现故障：先快速重试确认，而不是等满一个间隔（§4.2）
      delay = !healthy && state === 'normal' ? cfg.probe.retryDelayMs : cfg.probe.intervalMs
    } catch (e) {
      log(`探针失败：${errText(e)}`)
      delay = cfg.probe.retryDelayMs
    }
    scheduleProbe(delay)
  }

  tickTimer = setInterval(() => {
    if (stopped || ticking) return
    ticking = true
    const task = onTick().finally(() => {
      ticking = false
    })
    track(task)
  }, deps.tickIntervalMs ?? TICK_INTERVAL_MS)

  if (cfg.probe.enabled) scheduleProbe(cfg.probe.intervalMs)

  log(`已启动（通道：${cfg.notify.channel}）`)

  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  await stop()
}

/** 仅在直接执行 dist/index.js 时启动；被测试 import 时不触发 */
const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  void main().catch((e) => {
    console.error(`[codexmonitor] 启动失败：${errText(e)}`)
    process.exitCode = 1
  })
}

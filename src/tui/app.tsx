/** Ink 看板：头部品牌区 + 左侧状态卡 + 右侧通知流 + 底部快捷键。图标全部为 ASCII */

import React, { useEffect, useSyncExternalStore } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import type { Controls } from '../index.js'
import { Header } from './components/Header.js'
import { NotificationList } from './components/NotificationList.js'
import { StatusPanel } from './components/StatusPanel.js'
import type { TuiStore } from './store.js'

export type AppProps = {
  store: TuiStore
  controls: Controls
  /** 重载配置；返回给用户看的提示文案 */
  onReload: () => Promise<string>
  /** 终端列数；缺省读 stdout，测试可注入 */
  columns?: number
}

/** 低于该宽度退化为单列，并隐藏品牌字 */
const WIDE_MIN = 80
const LEFT_WIDTH = 26

const KEY_BAR = '[t] 测试通知  [p] 暂停探针  [r] 重载配置  [q] 退出'

export function App({ store, controls, onReload, columns: columnsProp }: AppProps): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const { stdout } = useStdout()
  const { exit } = useApp()
  const columns = columnsProp ?? (stdout as { columns?: number }).columns ?? 80
  const wide = columns >= WIDE_MIN
  const rightWidth = Math.max(24, columns - LEFT_WIDTH - 9)

  const quotaLines = (w: { resetsAt: number | null } | undefined): number =>
    w == null ? 1 : w.resetsAt == null ? 1 : 2
  const leftLines = 1 + quotaLines(state.quota.fiveHour) + quotaLines(state.quota.sevenDay) + 1 + 2
  const dividerLines = Math.max(leftLines, 1 + Math.max(1, state.log.slice(-6).length))

  useEffect(() => {
    const timer = setInterval(() => {
      store.dispatch({ type: 'tick', now: Date.now() })
    }, 1000)
    return () => clearInterval(timer)
  }, [store])

  useInput((input) => {
    const now = Date.now()
    if (input === 'q') {
      exit()
      return
    }
    if (input === 't') {
      store.dispatch({ type: 'toast', text: '正在发送测试通知…', now })
      void controls.sendTest()
      return
    }
    if (input === 'p') {
      if (!state.probeEnabled) {
        store.dispatch({ type: 'toast', text: '探针已关闭', now })
        return
      }
      const paused = !state.probePaused
      controls.setProbePaused(paused)
      store.dispatch({ type: 'probePaused', paused, now })
      store.dispatch({ type: 'toast', text: paused ? '探针已暂停' : '探针已恢复', now })
      return
    }
    if (input === 'r') {
      store.dispatch({ type: 'toast', text: '正在重载配置…', now })
      void onReload().then((text) => {
        store.dispatch({ type: 'toast', text, now: Date.now() })
      })
    }
  })

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Header state={state} wide={wide} />

      <Box marginTop={1} flexDirection={wide ? 'row' : 'column'}>
        <StatusPanel state={state} width={wide ? LEFT_WIDTH : undefined} />
        {wide && (
          // 手工竖线：Ink 的部分边框对象不支持，按两栏内容高度画 │
          <Box flexDirection="column" marginLeft={2} marginRight={2}>
            {Array.from({ length: dividerLines }, (_, i) => (
              <Text key={i} dimColor>
                │
              </Text>
            ))}
          </Box>
        )}
        <Box marginTop={wide ? 0 : 1} flexGrow={1}>
          <NotificationList
            state={state}
            width={wide ? rightWidth : Math.max(24, columns - 4)}
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text>{state.toast ? state.toast.text : KEY_BAR}</Text>
      </Box>
    </Box>
  )
}

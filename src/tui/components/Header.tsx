/** 头部：宽屏放品牌字 + 右侧运行信息；窄屏退化为三行文字 */

import React from 'react'
import { Box, Text } from 'ink'
import {
  formatLatency,
  formatRelative,
  formatUptime,
  formatWorkDays,
  verdictIcon,
} from '../format.js'
import { isWithinWorkHours } from '../../notify/work-hours.js'
import { verdictColor } from '../theme.js'
import type { TuiState } from '../store.js'
import { Wordmark } from './Wordmark.js'

export function Header({
  state,
  wide,
}: {
  state: TuiState
  wide: boolean
}): React.ReactElement {
  const probe = state.probe
  const verdict = probe?.verdict ?? 'ok'
  const icon = verdictIcon(verdict, { paused: state.probePaused, enabled: state.probeEnabled })
  const color = state.probePaused ? 'gray' : verdictColor(verdict, state.probeEnabled)
  const detail = probe
    ? `L2 ${probe.status == null ? '-' : probe.status} · ${formatLatency(probe.latencyMs)} · ${formatRelative(state.now - probe.at)}`
    : '等待首次探测'
  const meta = `通道 ${state.channel} · 运行 ${formatUptime(state.now - state.startedAt)}`
  const within = isWithinWorkHours(state.now, state.workHours)
  const workLabel = state.workHours.enabled
    ? `工作 ${formatWorkDays(state.workHours.days)} ${state.workHours.start}–${state.workHours.end}`
    : '工作 不限时'
  const workStatus = within ? '推送中' : '静默中'
  const workColor = !state.workHours.enabled ? 'gray' : within ? 'green' : 'yellow'

  const workLine = (
    <Text wrap="truncate">
      <Text dimColor>{workLabel} · </Text>
      <Text color={workColor}>{workStatus}</Text>
    </Text>
  )

  if (!wide) {
    return (
      <Box flexDirection="column">
        <Text bold>CodexMonitor</Text>
        <Text dimColor>{meta}</Text>
        <Text>
          网络 <Text color={color}>{icon}</Text> {detail}
        </Text>
        {workLine}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Wordmark />
      <Box flexDirection="column" alignItems="flex-end">
        <Text dimColor>{meta}</Text>
        <Text>
          网络 <Text color={color}>{icon}</Text> {detail}
        </Text>
        {workLine}
      </Box>
    </Box>
  )
}

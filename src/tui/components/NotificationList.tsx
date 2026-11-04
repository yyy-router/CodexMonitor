/** 右侧通知流：时间 / 级别 / 正文，正文去掉 emoji 并按宽度截断 */

import React from 'react'
import { Box, Text } from 'ink'
import { formatClock, severityIcon, stripEmoji } from '../format.js'
import { severityBold, severityColor } from '../theme.js'
import type { TuiState } from '../store.js'

export const MAX_NOTIFICATION_ROWS = 6

/** 一条通知只占一行：折叠换行与连续空白，避免挤掉顶部状态区 */
const oneLine = (text: string): string => stripEmoji(text).replace(/\s+/g, ' ').trim()

export function NotificationList({
  state,
  width,
  maxRows = MAX_NOTIFICATION_ROWS,
}: {
  state: TuiState
  width: number
  /** 可见条数上限；由 App 按终端高度计算 */
  maxRows?: number
}): React.ReactElement {
  const limit = Math.max(0, Math.min(MAX_NOTIFICATION_ROWS, Math.trunc(maxRows)))
  const recent = limit === 0 ? [] : state.log.slice(-limit)

  return (
    <Box flexDirection="column" width={width}>
      <Text bold dimColor>
        {limit === 0 ? '最近通知（终端过矮，已隐藏）' : '最近通知'}
      </Text>
      {limit === 0 ? null : recent.length === 0 ? (
        <Text dimColor>暂无通知</Text>
      ) : (
        recent.map((entry, index) => (
          <Box key={`${entry.at}-${index}`} width={width}>
            <Text wrap="truncate">
              <Text dimColor>{formatClock(entry.at)} </Text>
              <Text color={severityColor(entry.severity)} bold={severityBold(entry.severity)}>
                {severityIcon(entry.severity)}
              </Text>
              {' '}
              {entry.ok === false ? <Text color="red">(FAIL) </Text> : null}
              {oneLine(entry.text)}
            </Text>
          </Box>
        ))
      )}
    </Box>
  )
}

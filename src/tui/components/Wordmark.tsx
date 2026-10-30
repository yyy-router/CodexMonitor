/** 头部品牌字：ascii.rest 的 scramble 逐字解码。只取帧函数，不使用 play() */

import React, { useEffect, useState } from 'react'
import { Text } from 'ink'
import * as scramble from 'ascii.rest/pieces/scramble'

const PHRASES = ['CodexMonitor']

/** 解码完成后停在 frame 0（settled），之后不再重渲染 */
export function Wordmark({ seconds = 3 }: { seconds?: number }): React.ReactElement {
  const [t, setT] = useState(0)

  useEffect(() => {
    if (seconds <= 0) return
    const started = Date.now()
    const timer = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000
      if (elapsed >= seconds) {
        setT(0)
        clearInterval(timer)
        return
      }
      setT(elapsed)
    }, 50)
    return () => clearInterval(timer)
  }, [seconds])

  // scramble 的画布是 44×3，但只在中间一行落字；裁掉空行，头部只占 1 行
  const frame = scramble.default({ phrases: PHRASES })(t)
  const line = frame.split('\n').find((l) => l.trim() !== '') ?? PHRASES[0]
  return <Text color="cyan">{line}</Text>
}

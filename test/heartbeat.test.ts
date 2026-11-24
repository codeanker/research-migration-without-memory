import test from 'node:test'
import assert from 'node:assert/strict'
import { formatHeartbeatLine, lastHeartbeatTick, parseHeartbeatLine } from '../shared/heartbeat.ts'

const AT = '2026-09-04T10:00:00.400Z'

test('format and parse roundtrip', () => {
  const tick = parseHeartbeatLine(formatHeartbeatLine(AT, 7, 42))
  assert.deepEqual(tick, { at: AT, counter: 7, pid: 42 })
})

test('truncated line', () => {
  assert.equal(parseHeartbeatLine(''), null)
  assert.equal(parseHeartbeatLine(null), null)
  assert.equal(parseHeartbeatLine(`${AT} counter=7`), null, 'missing pid')
  assert.equal(parseHeartbeatLine(`${AT} counter=7 pid=`), null)
  assert.equal(parseHeartbeatLine('not-a-date counter=7 pid=42'), null)
  assert.equal(parseHeartbeatLine('2026-13-45T10:00:00.400Z counter=7 pid=42'), null)
  assert.equal(parseHeartbeatLine(`${AT} counter=7 pid=42 extra`), null)
  assert.equal(lastHeartbeatTick(''), null)
})

test('lastHeartbeatTick mid-write', () => {
  const log =
    `${formatHeartbeatLine('2026-09-04T10:00:00.100Z', 1, 42)}\n` +
    `${formatHeartbeatLine('2026-09-04T10:00:00.200Z', 2, 42)}\n` +
    '2026-09-04T10:00:00.300Z counte'
  const tick = lastHeartbeatTick(log)
  assert.deepEqual(tick, { at: '2026-09-04T10:00:00.200Z', counter: 2, pid: 42 })
})

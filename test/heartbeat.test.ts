import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HEARTBEAT_FORMATTER_SRC,
  formatHeartbeatLine,
  lastHeartbeatTick,
  parseHeartbeatLine,
} from '../shared/heartbeat.ts'
import { HEARTBEAT_JS } from '../browser/src/payload.ts'

const AT = '2026-09-04T10:00:00.400Z'

test('what the formatter writes is what the parser reads', () => {
  const tick = parseHeartbeatLine(formatHeartbeatLine(AT, 7, 42))
  assert.deepEqual(tick, { at: AT, counter: 7, pid: 42 })
})

test('the formatter embedded in the payload behaves like the imported one', () => {
  const embedded = new Function(`${HEARTBEAT_FORMATTER_SRC}; return formatHeartbeatLine`)()
  assert.equal(embedded(AT, 7, 42), formatHeartbeatLine(AT, 7, 42))
  assert.ok(HEARTBEAT_JS.includes('formatHeartbeatLine('), 'payload does not call the formatter')
  assert.ok(HEARTBEAT_JS.includes(HEARTBEAT_FORMATTER_SRC), 'payload does not embed the formatter')
})

test('a truncated or incomplete line is not a tick', () => {
  assert.equal(parseHeartbeatLine(''), null)
  assert.equal(parseHeartbeatLine(null), null)
  assert.equal(parseHeartbeatLine(`${AT} counter=7`), null, 'missing pid')
  assert.equal(parseHeartbeatLine(`${AT} counter=7 pid=`), null)
  assert.equal(parseHeartbeatLine('not-a-date counter=7 pid=42'), null)
  assert.equal(parseHeartbeatLine(`${AT} counter=7 pid=42 extra`), null)
})

test('lastHeartbeatTick skips a line caught mid-write', () => {
  const log =
    `${formatHeartbeatLine('2026-09-04T10:00:00.100Z', 1, 42)}\n` +
    `${formatHeartbeatLine('2026-09-04T10:00:00.200Z', 2, 42)}\n` +
    '2026-09-04T10:00:00.300Z counte'
  const tick = lastHeartbeatTick(log)
  assert.deepEqual(tick, { at: '2026-09-04T10:00:00.200Z', counter: 2, pid: 42 })
})

test('an empty log has no last tick', () => {
  assert.equal(lastHeartbeatTick(''), null)
})

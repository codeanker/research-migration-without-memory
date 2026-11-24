import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkTimingSanity,
  computeInterruption,
  pollRestMs,
  loadedCounter,
  stateRestored,
  tickCorrectedDurations,
} from '../runner/timing.ts'
import type { TimingRow } from '../runner/timing.ts'

const STOP_AT = Date.parse('2026-09-04T10:00:00.000Z')
const FIRST_TICK_AT = '2026-09-04T10:00:00.400Z'
const RESTORE_ISSUED_AT = STOP_AT + 300
const RESTORE_MARK_NS = BigInt(Date.parse('2026-09-04T10:00:00.360Z')) * 1000000n

test('interruption_ms', () => {
  const out = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: STOP_AT - 30,
    firstTickAt: FIRST_TICK_AT,
    offsetMs: 0,
    restoreIssuedAt: RESTORE_ISSUED_AT,
    restoreMarkNs: RESTORE_MARK_NS,
  })
  assert.equal(out.interruption_ms, 400)
  assert.equal(out.interruption_gap_ms, 430)
  assert.equal(out.interruption_split_ms, 340)
  assert.equal(out.restore_dispatch_ms, 60)
  const ahead = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: STOP_AT - 30,
    firstTickAt: FIRST_TICK_AT,
    offsetMs: 5000,
    restoreIssuedAt: RESTORE_ISSUED_AT,
    restoreMarkNs: RESTORE_MARK_NS,
  })
  assert.equal(ahead.interruption_split_ms, 340)
})

test('clock offset', () => {
  const out = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: null,
    firstTickAt: FIRST_TICK_AT,
    offsetMs: 250,
    restoreIssuedAt: null,
    restoreMarkNs: null,
  })
  assert.equal(out.interruption_ms, 150)
  assert.equal(out.interruption_gap_ms, '')
  assert.equal(out.interruption_split_ms, '')
})

test('missing reference point', () => {
  const out = computeInterruption({
    stopAtMs: null,
    lastSourceTickMs: null,
    firstTickAt: '',
    offsetMs: 0,
    restoreIssuedAt: null,
    restoreMarkNs: null,
  })
  assert.deepEqual(out, {
    interruption_ms: '',
    interruption_gap_ms: '',
    interruption_split_ms: '',
    restore_dispatch_ms: '',
  })
})

test('dispatch without tick', () => {
  const out = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: null,
    firstTickAt: '',
    offsetMs: 0,
    restoreIssuedAt: RESTORE_ISSUED_AT,
    restoreMarkNs: RESTORE_MARK_NS,
  })
  assert.equal(out.interruption_ms, '')
  assert.equal(out.restore_dispatch_ms, 60)
})

test('pollRestMs', () => {
  const detectAt = Date.parse(FIRST_TICK_AT) + 280
  const pollRest = pollRestMs({ firstTickAt: FIRST_TICK_AT, offsetMs: 0, detectAt })
  assert.equal(pollRest, 280)
  const corrected = tickCorrectedDurations({ aliveMs: 300, totalWallMs: 900, pollRest })
  assert.equal(corrected.alive_to_tick_ms, 20)
  assert.equal(corrected.total_wall_to_tick_ms, 620)
  assert.equal(pollRestMs({ firstTickAt: FIRST_TICK_AT, offsetMs: 250, detectAt }), 530)
})

test('pollRestMs without detectAt', () => {
  const pollRest = pollRestMs({ firstTickAt: FIRST_TICK_AT, offsetMs: 0, detectAt: null })
  assert.equal(pollRest, null)
  assert.deepEqual(tickCorrectedDurations({ aliveMs: 300, totalWallMs: 900, pollRest }), {
    alive_to_tick_ms: '',
    total_wall_to_tick_ms: '',
  })
})

test('stateRestored', () => {
  assert.equal(stateRestored(30, loadedCounter(31)), true)
  assert.equal(stateRestored(30, loadedCounter(1)), false)
  assert.equal(stateRestored(30, loadedCounter(32)), false)
  assert.equal(stateRestored(30, loadedCounter('')), false)
  assert.equal(stateRestored('', loadedCounter(31)), false)
})

function cleanRow(offsetMs = 0): TimingRow {
  const interruption = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: STOP_AT - 30,
    firstTickAt: FIRST_TICK_AT,
    offsetMs,
    restoreIssuedAt: RESTORE_ISSUED_AT,
    restoreMarkNs: RESTORE_MARK_NS,
  })
  return {
    kill_to_export_ms: 10,
    export_ms: 140,
    total_wall_ms: 500,
    total_sum_ms: 640,
    target_clock_offset_ms: offsetMs,
    target_clock_rtt_ms: 60,
    stop_at: new Date(STOP_AT).toISOString(),
    last_source_tick_at: new Date(STOP_AT - 30).toISOString(),
    first_tick_at: FIRST_TICK_AT,
    ...interruption,
  }
}

const context = { detectAt: Date.parse(FIRST_TICK_AT) + 280, restoreIssuedAt: RESTORE_ISSUED_AT }

test('sanity consistent run', () => {
  assert.deepEqual(checkTimingSanity(cleanRow(), context), [])
})

test('sanity offset off by 5000ms', () => {
  const warnings = checkTimingSanity(cleanRow(5000), context)
  assert.equal(warnings.length, 3, warnings.join(' | '))
  assert.match(warnings[0], /is not positive/)
  assert.match(warnings[1], /restore_dispatch_ms=-4940.0ms is negative/)
  assert.match(warnings[2], /before the restart command went out/)
})

test('sanity overshoot within half rtt', () => {
  const row = cleanRow()
  row.interruption_ms = 670
  assert.deepEqual(checkTimingSanity(row, context), [])
  row.interruption_ms = 690
  assert.ok(
    checkTimingSanity(row, context).some((w) => /exceeds the whole handover/.test(w)),
    'an overshoot beyond half a round trip still has to be reported'
  )
})

test('sanity poll bracket tolerance', () => {
  const firstTickMs = Date.parse(FIRST_TICK_AT)
  const bracket = (restoreIssuedAt: number, detectAt: number) =>
    checkTimingSanity(cleanRow(), { restoreIssuedAt, detectAt }).filter((w) =>
      /before the restart command went out|after the poll had already read it/.test(w)
    )
  assert.deepEqual(bracket(firstTickMs + 20, firstTickMs - 20), [])
  assert.equal(bracket(firstTickMs + 40, firstTickMs - 40).length, 2)
})

test('sanity phase sum', () => {
  const row: TimingRow = { ...cleanRow(), total_sum_ms: 640 + 400 }
  const warnings = checkTimingSanity(row, context)
  assert.match(warnings[0], /deviates from total_wall_ms/)
})

test('sanity missing interruption', () => {
  const row: TimingRow = { ...cleanRow(), interruption_ms: '' }
  const warnings = checkTimingSanity(row, context)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /interruption_ms not determined/)
})

test('sanity missing restore mark', () => {
  const row: TimingRow = { ...cleanRow(), interruption_split_ms: '' }
  const warnings = checkTimingSanity(row, context)
  assert.ok(
    warnings.some((w) => /cross-check unavailable/.test(w)),
    warnings.join(' | ')
  )
})

test('sanity stale source tick', () => {
  const row: TimingRow = {
    ...cleanRow(),
    last_source_tick_at: new Date(STOP_AT - 5000).toISOString(),
  }
  const warnings = checkTimingSanity(row, context)
  assert.ok(
    warnings.some((w) => /do not agree, or the process kept ticking/.test(w)),
    warnings.join(' | ')
  )
  const afterStop: TimingRow = { ...cleanRow(), last_source_tick_at: new Date(STOP_AT + 3).toISOString() }
  assert.ok(
    checkTimingSanity(afterStop, context).some((w) => /lies -3\.0ms before the stop/.test(w)),
    'a tick after the stop has to be reported'
  )
})

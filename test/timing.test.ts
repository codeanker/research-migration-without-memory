import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkTimingSanity,
  computeInterruption,
  pollRestMs,
  resumeCheckMessage,
  loadedCounter,
  stateRestored,
  tickCorrectedDurations,
} from '../runner/timing.ts'
import type { TimingRow } from '../runner/timing.ts'
import { makeEmptyRow } from '../runner/csv.ts'
import type { Row } from '../runner/csv.ts'

const STOP_AT = Date.parse('2026-09-04T10:00:00.000Z')
const FIRST_TICK_AT = '2026-09-04T10:00:00.400Z'
const RESTORE_ISSUED_AT = STOP_AT + 300
const RESTORE_MARK_NS = BigInt(Date.parse('2026-09-04T10:00:00.360Z')) * 1000000n

test('interruption_ms is the first tick converted into the runner clock, minus the stop', () => {
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
})

test('a target clock ahead by 250ms is subtracted out', () => {
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

test('a missing reference point yields an empty field, never a number', () => {
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

test('restore_dispatch_ms is what interruption_ms and interruption_split_ms differ by', () => {
  const out = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: STOP_AT - 30,
    firstTickAt: FIRST_TICK_AT,
    offsetMs: 0,
    restoreIssuedAt: RESTORE_ISSUED_AT,
    restoreMarkNs: RESTORE_MARK_NS,
  })
  assert.equal(out.restore_dispatch_ms, 60)
  assert.equal(Number(out.interruption_ms) - Number(out.interruption_split_ms), 60)
})

test('the dispatch latency is measurable for a run whose target never ticked', () => {
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

test('the poll rest is the distance between the tick and the poll that read it', () => {
  const detectAt = Date.parse(FIRST_TICK_AT) + 280
  const pollRest = pollRestMs({ firstTickAt: FIRST_TICK_AT, offsetMs: 0, detectAt })
  assert.equal(pollRest, 280)
  const corrected = tickCorrectedDurations({ aliveMs: 300, totalWallMs: 900, pollRest })
  assert.equal(corrected.alive_to_tick_ms, 20)
  assert.equal(corrected.total_wall_to_tick_ms, 620)
})

test('without a detection timestamp the corrected durations stay empty', () => {
  const pollRest = pollRestMs({ firstTickAt: FIRST_TICK_AT, offsetMs: 0, detectAt: null })
  assert.equal(pollRest, null)
  assert.deepEqual(tickCorrectedDurations({ aliveMs: 300, totalWallMs: 900, pollRest }), {
    alive_to_tick_ms: '',
    total_wall_to_tick_ms: '',
  })
})

test('the state counts as restored only if the first tick continues the transferred counter', () => {
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

test('a consistent run produces no warning', () => {
  assert.deepEqual(checkTimingSanity(cleanRow(), context), [])
})

test('an offset that is wrong by 5000ms trips all three independent checks', () => {
  const warnings = checkTimingSanity(cleanRow(5000), context)
  assert.equal(warnings.length, 3, warnings.join(' | '))
  assert.match(warnings[0], /is not positive/)
  assert.match(warnings[1], /restore_dispatch_ms=-4940.0ms is negative/)
  assert.match(warnings[2], /before the restart command went out/)
})

test('a slow but consistent command dispatch is not a warning', () => {
  const dispatchMs = 530
  const markNs = BigInt(RESTORE_ISSUED_AT + dispatchMs) * 1000000n
  const firstTickAt = new Date(RESTORE_ISSUED_AT + dispatchMs + 40).toISOString()
  const interruption = computeInterruption({
    stopAtMs: STOP_AT,
    lastSourceTickMs: STOP_AT - 30,
    firstTickAt,
    offsetMs: 0,
    restoreIssuedAt: RESTORE_ISSUED_AT,
    restoreMarkNs: markNs,
  })
  assert.equal(interruption.restore_dispatch_ms, dispatchMs)
  const row: TimingRow = {
    kill_to_export_ms: 10,
    export_ms: 140,
    total_wall_ms: 1000,
    total_sum_ms: 1140,
    target_clock_offset_ms: 0,
    target_clock_rtt_ms: 60,
    stop_at: new Date(STOP_AT).toISOString(),
    last_source_tick_at: new Date(STOP_AT - 30).toISOString(),
    first_tick_at: firstTickAt,
    ...interruption,
  }
  assert.deepEqual(
    checkTimingSanity(row, {
      detectAt: Date.parse(firstTickAt) + 100,
      restoreIssuedAt: RESTORE_ISSUED_AT,
    }),
    []
  )
})

test('an overshoot within half a round trip is not called impossible', () => {
  const row = cleanRow()
  row.interruption_ms = 670
  assert.deepEqual(checkTimingSanity(row, context), [])
  row.interruption_ms = 690
  assert.ok(
    checkTimingSanity(row, context).some((w) => /exceeds the whole handover/.test(w)),
    'an overshoot beyond half a round trip still has to be reported'
  )
})

test('an offset wrong in the other direction is caught by the poll bracket', () => {
  const warnings = checkTimingSanity(cleanRow(-5000), context)
  assert.ok(
    warnings.some((w) => /after the poll had already read it/.test(w)),
    warnings.join(' | ')
  )
  assert.ok(
    warnings.some((w) => /exceeds the whole handover/.test(w)),
    warnings.join(' | ')
  )
})

test('the poll bracket tolerates half a round trip on either side, not more', () => {
  const firstTickMs = Date.parse(FIRST_TICK_AT)
  const bracket = (restoreIssuedAt: number, detectAt: number) =>
    checkTimingSanity(cleanRow(), { restoreIssuedAt, detectAt }).filter((w) =>
      /before the restart command went out|after the poll had already read it/.test(w)
    )
  assert.deepEqual(bracket(firstTickMs + 20, firstTickMs - 20), [])
  assert.equal(bracket(firstTickMs + 40, firstTickMs - 40).length, 2)
})

test('a phase sum that does not add up to the wall clock is reported', () => {
  const row: TimingRow = { ...cleanRow(), total_sum_ms: 640 + 400 }
  const warnings = checkTimingSanity(row, context)
  assert.match(warnings[0], /deviates from total_wall_ms/)
})

test('a manifest run adds up only with install_ms in the phase sum', () => {
  const installMs = 1000
  const row: TimingRow = { ...cleanRow(), total_wall_ms: 500 + installMs, total_sum_ms: 640 + installMs }
  assert.deepEqual(checkTimingSanity(row, context), [])
  const withoutInstall: TimingRow = { ...row, total_sum_ms: 640 }
  assert.match(checkTimingSanity(withoutInstall, context)[0], /deviates from total_wall_ms/)
})

test('a push run adds up with boot_ms and install_ms left blank and the push phase outside', () => {
  const row: Row = {
    ...makeEmptyRow(),
    ...cleanRow(),
    boot_ms: '',
    install_ms: '',
    push_boot_ms: 900,
    push_install_ms: 2500,
    prepare_ms: 3600,
  }
  assert.deepEqual(checkTimingSanity(row, context), [])
})

test('a missing interruption value stops the checks with one clear message', () => {
  const row: TimingRow = { ...cleanRow(), interruption_ms: '' }
  const warnings = checkTimingSanity(row, context)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /interruption_ms not determined/)
})

test('a missing restore mark is reported as a lost cross-check', () => {
  const row: TimingRow = { ...cleanRow(), interruption_split_ms: '' }
  const warnings = checkTimingSanity(row, context)
  assert.ok(
    warnings.some((w) => /cross-check unavailable/.test(w)),
    warnings.join(' | ')
  )
})

test('the failed-resume message names both halves and survives missing values', () => {
  const message = resumeCheckMessage({
    row: {
      first_tick_counter: 31,
      resume_tick_counter: '',
      counter_expected: 30,
      resume_state_counter: 30,
    },
    baselineLines: 8,
    progressLines: 9,
    ticksKeptComing: false,
    stateKeptGrowing: false,
    waitedMs: 1400,
  })
  assert.match(message, /ticks stalled/)
  assert.match(message, /state write loop stalled/)
  assert.match(message, /31 -> -/)
  assert.match(message, /after 1400ms/)
})

test('a source tick that lies too far before the stop is reported', () => {
  const row: TimingRow = {
    ...cleanRow(),
    last_source_tick_at: new Date(STOP_AT - 5000).toISOString(),
  }
  const warnings = checkTimingSanity(row, context)
  assert.ok(
    warnings.some((w) => /do not agree, or the process kept ticking/.test(w)),
    warnings.join(' | ')
  )
})

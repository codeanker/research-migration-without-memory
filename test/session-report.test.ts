import test from 'node:test'
import assert from 'node:assert/strict'
import { pickRowFields, summarize } from '../runner/session-report.ts'
import type { RunRecord, SessionManifest } from '../runner/session-report.ts'
import type { CsvRowJson } from '../shared/browser-api.ts'
import type { PlanEntry } from '../runner/plan.ts'

let seq = 0

function planEntry(cellKey: string, extra: Partial<PlanEntry> = {}): PlanEntry {
  seq += 1
  const runLabel = String(seq).padStart(2, '0')
  return {
    seq,
    cellKey,
    stage: cellKey === 'large' ? 'large' : 'small',
    strategy: 'full',
    logIntervalMs: 1000,
    rep: seq,
    runLabel,
    runId: `${cellKey}-${runLabel}`,
    stopOffsetTargetMs: 100,
    positionInCycle: 1,
    firstRun: false,
    firstRunOfCell: false,
    ...extra,
  }
}

function runRecord(
  entry: PlanEntry,
  { ok = true, row = {} as CsvRowJson | null, warnings = [] as string[] } = {}
): RunRecord {
  return {
    ...entry,
    started_at: '2026-09-08T10:00:00.000Z',
    duration_ms: 12000,
    ok,
    timed_out: false,
    message: ok ? null : 'run failed',
    run_id: entry.runId,
    row: pickRowFields(row),
    stop_offset_actual_ms: 100,
    runner_warnings: warnings,
  }
}

function sessionOf(runs: RunRecord[]): SessionManifest {
  return { runs } as SessionManifest
}

test('error rate per run', () => {
  const plan = [planEntry('small'), planEntry('small'), planEntry('small')]
  const summary = summarize(
    sessionOf([
      runRecord(plan[0], { ok: false, row: null }),
      runRecord(plan[1], { ok: true, row: { error: 'sanity check failed' } }),
      runRecord(plan[2]),
    ]),
    plan
  )
  assert.equal(summary.done, 3)
  assert.equal(summary.failed, 1)
  assert.equal(summary.with_error_field, 1)
  assert.equal(summary.error_rate, 0.667)
})

test('error rate without runs', () => {
  const summary = summarize(sessionOf([]), [planEntry('small')])
  assert.equal(summary.error_rate, null)
})

test('medians per cell', () => {
  const small = [planEntry('small'), planEntry('small'), planEntry('small')]
  const large = [planEntry('large')]
  const summary = summarize(
    sessionOf([
      runRecord(small[0], { row: { total_wall_ms: 1000, total_wall_to_tick_ms: 900, export_ms: 5 } }),
      runRecord(small[1], { row: { total_wall_ms: 3000, total_wall_to_tick_ms: 2900, export_ms: 5 } }),
      runRecord(small[2], { row: { total_wall_ms: 2000, total_wall_to_tick_ms: 1900, export_ms: 5 } }),
      runRecord(large[0], { row: { total_wall_ms: 9000, export_ms: 10 } }),
    ]),
    [...small, ...large]
  )
  assert.equal(summary.cells['small'].total_ms_median, 2005)
  assert.equal(summary.cells['small'].total_to_tick_ms_median, 1905)
  assert.equal(summary.cells['large'].total_ms_median, 9010)
  assert.equal(summary.cells['large'].total_to_tick_ms_median, null)
})

test('cell without runs', () => {
  const plan = [planEntry('small'), planEntry('large')]
  const summary = summarize(sessionOf([runRecord(plan[0], { row: { interruption_ms: 800 } })]), plan)
  assert.equal(summary.planned, 2)
  assert.equal(summary.done, 1)
  const empty = summary.cells['large']
  assert.equal(empty.planned, 1)
  assert.equal(empty.done, 0)
  assert.equal(empty.ok, 0)
  assert.equal(empty.interruption_ms_median, null)
})

test('unconfirmed resume', () => {
  const plan = [planEntry('small'), planEntry('small'), planEntry('small')]
  const summary = summarize(
    sessionOf([
      runRecord(plan[0], { row: { resume_verified: true } }),
      runRecord(plan[1], { row: { resume_verified: false } }),
      runRecord(plan[2], { row: {} }),
    ]),
    plan
  )
  assert.equal(summary.cells['small'].resume_unverified, 2)
})

test('sanity warning sum', () => {
  const plan = [planEntry('small'), planEntry('small')]
  const summary = summarize(
    sessionOf([
      runRecord(plan[0], { warnings: ['stop offset off by 5000ms', 'phase sum does not add up'] }),
      runRecord(plan[1], { warnings: ['missing restore mark'] }),
    ]),
    plan
  )
  assert.equal(summary.runner_warnings, 3)
})

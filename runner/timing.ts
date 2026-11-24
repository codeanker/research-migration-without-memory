import { epochMsOf, fmt, fmtValue, num } from './util.ts'
import type { CsvNumber, Row } from './csv.ts'
import { HEARTBEAT_TICK_MS } from '../shared/heartbeat.ts'

interface InterruptionInput {
  stopAtMs: number | null
  lastSourceTickMs: number | null
  firstTickAt: string
  offsetMs: number
  restoreIssuedAt: number | null
  restoreMarkNs: bigint | null
}

interface InterruptionResult {
  interruption_ms: CsvNumber
  interruption_gap_ms: CsvNumber
  interruption_split_ms: CsvNumber
  restore_dispatch_ms: CsvNumber
}

export function computeInterruption({
  stopAtMs,
  lastSourceTickMs,
  firstTickAt,
  offsetMs,
  restoreIssuedAt,
  restoreMarkNs,
}: InterruptionInput): InterruptionResult {
  const out: InterruptionResult = {
    interruption_ms: '',
    interruption_gap_ms: '',
    interruption_split_ms: '',
    restore_dispatch_ms: '',
  }
  const markTargetMs = restoreMarkNs ? Number(restoreMarkNs / 1000000n) : null
  if (restoreIssuedAt !== null && markTargetMs !== null) {
    out.restore_dispatch_ms = markTargetMs - restoreIssuedAt - offsetMs
  }

  const firstTickTargetMs = epochMsOf(firstTickAt)
  if (firstTickTargetMs === null) return out

  const firstTickRunnerMs = firstTickTargetMs - offsetMs
  if (stopAtMs !== null) out.interruption_ms = firstTickRunnerMs - stopAtMs
  if (lastSourceTickMs !== null) out.interruption_gap_ms = firstTickRunnerMs - lastSourceTickMs

  if (stopAtMs !== null && restoreIssuedAt !== null && markTargetMs !== null) {
    out.interruption_split_ms = restoreIssuedAt - stopAtMs + (firstTickTargetMs - markTargetMs)
  }
  return out
}

export function pollRestMs({
  firstTickAt,
  offsetMs,
  detectAt,
}: {
  firstTickAt: string
  offsetMs: number | null
  detectAt: number | null | undefined
}): number | null {
  const firstTickTargetMs = epochMsOf(firstTickAt)
  if (firstTickTargetMs === null || detectAt === null || detectAt === undefined) return null
  if (offsetMs === null) return null
  return detectAt - (firstTickTargetMs - offsetMs)
}

export function tickCorrectedDurations({
  aliveMs,
  totalWallMs,
  pollRest,
}: {
  aliveMs: CsvNumber
  totalWallMs: CsvNumber
  pollRest: number | null | undefined
}): { alive_to_tick_ms: CsvNumber; total_wall_to_tick_ms: CsvNumber } {
  if (pollRest === null || pollRest === undefined) {
    return { alive_to_tick_ms: '', total_wall_to_tick_ms: '' }
  }
  return {
    alive_to_tick_ms: typeof aliveMs === 'number' ? aliveMs - pollRest : '',
    total_wall_to_tick_ms: typeof totalWallMs === 'number' ? totalWallMs - pollRest : '',
  }
}

export function loadedCounter(firstTickCounter: CsvNumber): CsvNumber {
  return typeof firstTickCounter === 'number' ? firstTickCounter - 1 : ''
}

export function stateRestored(expected: CsvNumber, loaded: CsvNumber): boolean {
  return typeof expected === 'number' && typeof loaded === 'number' && loaded === expected
}

export type TimingRow = Pick<
  Row,
  | 'total_sum_ms'
  | 'export_ms'
  | 'total_wall_ms'
  | 'kill_to_export_ms'
  | 'interruption_ms'
  | 'interruption_split_ms'
  | 'restore_dispatch_ms'
  | 'target_clock_offset_ms'
  | 'target_clock_rtt_ms'
  | 'first_tick_at'
  | 'stop_at'
  | 'last_source_tick_at'
>

export interface TimingContext {
  detectAt?: number | null
  restoreIssuedAt?: number | null
}

export function checkTimingSanity(
  row: TimingRow,
  { detectAt = null, restoreIssuedAt = null }: TimingContext = {}
): string[] {
  const warnings: string[] = []
  const warn = (msg: string) => warnings.push(msg)

  const sumWithoutExport = num(row.total_sum_ms) - num(row.export_ms)
  const diff = Math.abs(sumWithoutExport - num(row.total_wall_ms))
  const threshold = Math.max(50, num(row.total_wall_ms) * 0.1)
  if (diff > threshold) {
    warn(
      `(total_sum_ms - export_ms)=${sumWithoutExport.toFixed(1)}ms ` +
        `deviates from total_wall_ms=${fmt(row.total_wall_ms)}ms by ${diff.toFixed(1)}ms - ` +
        `one of the sub-measurements is likely wrong.`
    )
  }

  const interruptionMs = row.interruption_ms
  if (typeof interruptionMs !== 'number') {
    warn('interruption_ms not determined - X-Stop-At missing or no first tick timestamp.')
    return warnings
  }

  const handoverMs = num(row.kill_to_export_ms) + num(row.export_ms) + num(row.total_wall_ms)
  if (interruptionMs <= 0) {
    warn(
      `interruption_ms=${interruptionMs.toFixed(1)}ms is not positive - the target clock ` +
        `offset (${fmt(row.target_clock_offset_ms)}ms) or one of the two timestamps is wrong.`
    )
  } else if (interruptionMs > handoverMs + num(row.target_clock_rtt_ms) / 2) {
    warn(
      `interruption_ms=${interruptionMs.toFixed(1)}ms exceeds the whole handover ` +
        `(${handoverMs.toFixed(1)}ms) by more than half a round trip - impossible, ` +
        `check the clock offset.`
    )
  }

  const splitMs = row.interruption_split_ms
  const dispatchMs = row.restore_dispatch_ms
  const rttTolerance = Math.max(num(row.target_clock_rtt_ms) / 2, 5)
  if (typeof dispatchMs === 'number') {
    if (dispatchMs < -rttTolerance) {
      warn(
        `restore_dispatch_ms=${dispatchMs.toFixed(1)}ms is negative beyond half a round trip: ` +
          `the restore mark inside the target converts to a point in time before the command that ` +
          `wrote it was issued. The clock offset (${fmt(row.target_clock_offset_ms)}ms) is wrong.`
      )
    }
  }
  if (typeof splitMs !== 'number') {
    warn('interruption_split_ms not determined - restore mark missing, cross-check unavailable.')
  }

  const firstTickTargetMs = epochMsOf(row.first_tick_at)
  if (firstTickTargetMs !== null) {
    const firstTickRunnerMs = firstTickTargetMs - num(row.target_clock_offset_ms)
    if (restoreIssuedAt !== null && firstTickRunnerMs < restoreIssuedAt - rttTolerance) {
      warn(
        `the first tick converts to a point in time ${(restoreIssuedAt - firstTickRunnerMs).toFixed(1)}ms ` +
          `before the restart command went out - the clock offset is wrong.`
      )
    }
    if (detectAt !== null && firstTickRunnerMs > detectAt + rttTolerance) {
      warn(
        `the first tick converts to a point in time ${(firstTickRunnerMs - detectAt).toFixed(1)}ms ` +
          `after the poll had already read it - the clock offset is wrong.`
      )
    }
  }

  const stopAtMs = epochMsOf(row.stop_at)
  const lastTickMs = epochMsOf(row.last_source_tick_at)
  if (stopAtMs !== null && lastTickMs !== null) {
    const sinceLastTick = stopAtMs - lastTickMs
    if (sinceLastTick < 0 || sinceLastTick > HEARTBEAT_TICK_MS * 2) {
      warn(
        `the last source tick lies ${sinceLastTick.toFixed(1)}ms before the stop, outside ` +
          `[0, ${HEARTBEAT_TICK_MS * 2}]ms - the clock inside the WebContainer and the clock of the ` +
          `page do not agree, or the process kept ticking after the kill.`
      )
    }
  }

  return warnings
}

type ResumeCheckRow = Pick<
  Row,
  'first_tick_counter' | 'resume_tick_counter' | 'counter_expected' | 'resume_state_counter'
>

export function resumeCheckMessage({
  row,
  baselineLines,
  progressLines,
  ticksKeptComing,
  stateKeptGrowing,
  waitedMs,
}: {
  row: ResumeCheckRow
  baselineLines: number
  progressLines: number
  ticksKeptComing: boolean
  stateKeptGrowing: boolean
  waitedMs: number
}): string {
  return (
    `resume check: ticks ${ticksKeptComing ? 'ok' : 'stalled'} ` +
    `(first_tick_counter=${fmtValue(row.first_tick_counter)} -> ${fmtValue(row.resume_tick_counter)}, ` +
    `lines ${baselineLines + 1} -> ${progressLines}), state write loop ` +
    `${stateKeptGrowing ? 'ok' : 'stalled'} ` +
    `(counter_expected=${fmtValue(row.counter_expected)} -> ${fmtValue(row.resume_state_counter)}) ` +
    `after ${waitedMs}ms`
  )
}

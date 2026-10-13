import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { REPO_ROOT } from './child.ts'
import { orderCoverage, stopOffsetCoverage } from './plan.ts'
import type {
  CoverageEntry,
  ExperimentConfig,
  OrderCoverageEntry,
  PlanEntry,
} from './plan.ts'
import { fmt, median, pluck, readJson } from './util.ts'
import type { CsvColumn, Row } from './csv.ts'
import type { EnvInfo } from './env-info.ts'
import type { CsvRowJson } from '../shared/browser-api.ts'

export const SESSION_DIR = path.join(REPO_ROOT, 'data', 'sessions')

const ENV_COMPARE_FIELDS = [
  'node_version',
  'target_node_version',
  'node_version_aligned',
  'browser',
  'package_versions.e2b',
  'package_versions.vite',
  'package_versions.@webcontainer/api',
]

const PICKED_ROW_FIELDS = [
  'run_id',
  'session_label',
  'target',
  'stage',
  'strategy',
  'log_interval_ms',
  'payload_bytes',
  'interruption_ms',
  'interruption_split_ms',
  'total_wall_ms',
  'total_wall_to_tick_ms',
  'ingest_ms',
  'adapter_overhead_ms',
  'kill_to_export_ms',
  'export_ms',
  'install_ms',
  'state_loss_ticks',
  'stop_offset_target_ms',
  'stop_offset_actual_ms',
  'heartbeat_resumed',
  'state_restored',
  'resume_verified',
  'target_clock_rtt_ms',
  'first_run',
  'first_run_of_cell',
  'sanity_warnings',
  'error',
] as const satisfies readonly CsvColumn[]

type PickedField = (typeof PICKED_ROW_FIELDS)[number]

export type PickedRow = { [K in PickedField]: Row[K] | null }

export interface RunRecord extends PlanEntry {
  started_at: string
  duration_ms: number
  ok: boolean
  timed_out: boolean
  message: string | null
  run_id: string | null
  row: PickedRow | null
  stop_offset_actual_ms: number | null
  runner_warnings: string[]
}

export interface CellSummary {
  planned: number
  done: number
  ok: number
  failed: number
  with_error_field: number
  resume_unverified: number
  interruption_ms_median: number | null
  total_ms_median: number | null
  total_to_tick_ms_median: number | null
  state_loss_ticks_median: number | null
}

export interface SessionSummary {
  planned: number
  done: number
  failed: number
  with_error_field: number
  error_rate: number | null
  runner_warnings: number
  cells: Record<string, CellSummary>
}

export interface EnvDrift {
  previous_session: string | null
  differences: { field: string; previous: unknown; current: unknown }[]
  note?: string
}

export interface SessionManifest {
  label: string
  started_at: string
  finished_at: string | null
  aborted: string | null
  config: ExperimentConfig
  plan: PlanEntry[]
  stop_offset_coverage: Record<string, CoverageEntry>
  order_coverage: Record<string, OrderCoverageEntry>
  git: { commit: string | null; dirty: boolean | null }
  runtime: {
    node_version: string
    playwright_chromium: string | null
    headless: boolean
    browser_channel?: string
    user_agent?: string
  }
  env_info: EnvInfo | null
  env_drift: EnvDrift | null
  runs: RunRecord[]
  summary: SessionSummary | null
}

export function pickRowFields(row: CsvRowJson | null | undefined): PickedRow | null {
  if (!row) return null
  return Object.fromEntries(
    PICKED_ROW_FIELDS.map((key) => [key, row[key] ?? null])
  ) as unknown as PickedRow
}

export function formatRunResult(record: RunRecord): string {
  if (!record.ok) return `FAILED: ${record.message}`
  const row = record.row
  return (
    `ok in ${(record.duration_ms / 1000).toFixed(1)}s: run_id=${row?.run_id} ` +
    `interruption_ms=${fmt(row?.interruption_ms)} total_wall_ms=${fmt(row?.total_wall_ms)} ` +
    `state_loss_ticks=${row?.state_loss_ticks} stop_offset_actual=${fmt(row?.stop_offset_actual_ms)} ` +
    `resume_verified=${row?.resume_verified}${row?.error ? ` error=${row.error}` : ''}`
  )
}

interface CellAccumulator {
  planned: number
  done: number
  ok: number
  failed: number
  with_error_field: number
  resume_unverified: number
  interruption_ms: number[]
  total_ms: number[]
  total_to_tick_ms: number[]
  state_loss_ticks: number[]
}

export function summarize(session: SessionManifest, plan: PlanEntry[]): SessionSummary {
  const byCell: Record<string, CellAccumulator> = {}
  for (const entry of plan) {
    byCell[entry.cellKey] ??= {
      planned: 0,
      done: 0,
      ok: 0,
      failed: 0,
      with_error_field: 0,
      resume_unverified: 0,
      interruption_ms: [],
      total_ms: [],
      total_to_tick_ms: [],
      state_loss_ticks: [],
    }
  }
  for (const entry of plan) byCell[entry.cellKey].planned += 1

  for (const record of session.runs) {
    const cell = byCell[record.cellKey]
    cell.done += 1
    if (record.ok) cell.ok += 1
    else cell.failed += 1
    const row = record.row
    if (row?.error) cell.with_error_field += 1
    if (row && row.resume_verified !== true) cell.resume_unverified += 1
    if (typeof row?.interruption_ms === 'number') cell.interruption_ms.push(row.interruption_ms)
    if (typeof row?.total_wall_ms === 'number') {
      cell.total_ms.push(row.total_wall_ms + (Number(row.export_ms) || 0))
    }
    if (typeof row?.total_wall_to_tick_ms === 'number') {
      cell.total_to_tick_ms.push(row.total_wall_to_tick_ms + (Number(row.export_ms) || 0))
    }
    if (typeof row?.state_loss_ticks === 'number') cell.state_loss_ticks.push(row.state_loss_ticks)
  }

  const cells = Object.fromEntries(
    Object.entries(byCell).map(([key, cell]): [string, CellSummary] => [
      key,
      {
        planned: cell.planned,
        done: cell.done,
        ok: cell.ok,
        failed: cell.failed,
        with_error_field: cell.with_error_field,
        resume_unverified: cell.resume_unverified,
        interruption_ms_median: median(cell.interruption_ms),
        total_ms_median: median(cell.total_ms),
        total_to_tick_ms_median: median(cell.total_to_tick_ms),
        state_loss_ticks_median: median(cell.state_loss_ticks),
      },
    ])
  )
  const done = session.runs.length
  const failed = session.runs.filter((r) => !r.ok).length
  const withErrorField = session.runs.filter((r) => r.row?.error).length
  const notClean = session.runs.filter((r) => !r.ok || r.row?.error).length
  return {
    planned: plan.length,
    done,
    failed,
    with_error_field: withErrorField,
    error_rate: done === 0 ? null : Number((notClean / done).toFixed(3)),
    runner_warnings: session.runs.reduce((sum, r) => sum + r.runner_warnings.length, 0),
    cells,
  }
}

export function printPlan(config: ExperimentConfig, plan: PlanEntry[]): void {
  const cells = [...new Set(plan.map((e) => e.cellKey))]
  console.log(
    `[experiment] target=${config.target} repeats=${config.repeats} order=shuffled ` +
      `seed=${config.seed}${config.seedGenerated ? ' (generated)' : ''} ` +
      `stopOffset=${config.stopOffset.mode}${config.stopOffset.mode === 'fixed' ? ` ${config.stopOffset.valueMs}ms` : ''}`
  )
  console.log(`[experiment] ${plan.length} runs over ${cells.length} cells: ${cells.join(', ')}`)
  printStopOffsetCoverage(plan)
  printOrderCoverage(plan, cells.length)
  for (const entry of plan) {
    console.log(
      `  ${String(entry.seq).padStart(3)}  ${entry.cellKey.padEnd(12)} rep ${String(entry.rep).padStart(2)}  ` +
        `pos ${entry.positionInCycle}  ` +
        `stop offset ${entry.stopOffsetTargetMs === null ? 'off' : entry.stopOffsetTargetMs.toFixed(0) + 'ms'}` +
        `${entry.firstRun ? '  [first]' : ''}`
    )
  }
}

function printOrderCoverage(plan: PlanEntry[], cellCount: number): void {
  const coverage = orderCoverage(plan, cellCount)
  if (Object.keys(coverage).length === 0) return
  console.log('[experiment] positions in the cycle, per cell:')
  for (const [key, c] of Object.entries(coverage)) {
    const warning =
      c.missing_positions.length > 0
        ? `  <- never ran at position ${c.missing_positions.join(', ')} of ${cellCount}, ` +
          'the cell is confounded with the positions it did take'
        : ''
    console.log(
      `  ${key.padEnd(12)} n=${String(c.n).padStart(3)}: ${c.positions.join('/')}${warning}`
    )
  }
}

function printStopOffsetCoverage(plan: PlanEntry[]): void {
  const coverage = stopOffsetCoverage(plan)
  if (Object.keys(coverage).length === 0) return
  console.log('[experiment] stop offsets drawn, per cell:')
  for (const [key, c] of Object.entries(coverage)) {
    const warning =
      c.empty_quarters.length > 0
        ? `  <- quarter(s) ${c.empty_quarters.map((q) => q + 1).join(', ')} of 4 not sampled`
        : ''
    console.log(
      `  ${key.padEnd(12)} n=${String(c.n).padStart(3)} of [0, ${c.interval_ms})ms: ` +
        `min ${fmt(c.min_ms)} mean ${fmt(c.mean_ms)} max ${fmt(c.max_ms)} ` +
        `quarters ${c.quarters.join('/')}${warning}`
    )
  }
}

export function printEnvInfo(envInfo: EnvInfo | null, drift: EnvDrift | null): void {
  if (!envInfo) return
  console.log('\n[experiment] data/env.json after the first run:')
  for (const field of ENV_COMPARE_FIELDS) {
    console.log(`  ${field} = ${JSON.stringify(pluck(envInfo, field))}`)
  }
  if (envInfo.clock) {
    console.log(
      `  clock: offset ${fmt(envInfo.clock.target_clock_offset_ms)}ms, ` +
        `rtt ${fmt(envInfo.clock.target_clock_rtt_ms)}ms, ` +
        `half rtt ${fmt(envInfo.clock.target_clock_rtt_ms / 2)}ms plus 1ms resolution (this is the reportable accuracy)`
    )
  } else {
    console.log('  clock: MISSING - no successful clock measurement, check the runner output')
  }
  if (drift && !drift.previous_session) {
    console.log('  no earlier session to compare against, this is the reference for the next one')
  } else if (drift?.previous_session) {
    if (drift.differences.length === 0) {
      console.log(`  no drift against ${drift.previous_session}`)
    } else {
      console.log(`  DRIFT against ${drift.previous_session}:`)
      for (const diff of drift.differences) {
        console.log(
          `    ${diff.field}: ${JSON.stringify(diff.previous)} -> ${JSON.stringify(diff.current)}`
        )
      }
    }
  }
}

export function printSummary(session: SessionManifest, sessionPath: string): void {
  const s = session.summary
  if (!s) return
  console.log('\n=== Session summary ===')
  console.log(`Manifest: ${path.relative(REPO_ROOT, sessionPath)}`)
  console.log(
    `${s.done}/${s.planned} runs, ${s.failed} failed, ${s.with_error_field} with a set error field, ` +
      `error rate ${s.error_rate === null ? '-' : s.error_rate}, ` +
      `${s.runner_warnings} sanity warnings`
  )
  console.log('\ncell          plan done  ok fail err  resume?  interruption  total   state_loss')
  for (const [key, cell] of Object.entries(s.cells)) {
    console.log(
      `${key.padEnd(13)} ${String(cell.planned).padStart(4)} ${String(cell.done).padStart(4)} ` +
        `${String(cell.ok).padStart(3)} ${String(cell.failed).padStart(4)} ${String(cell.with_error_field).padStart(3)} ` +
        `${String(cell.resume_unverified).padStart(7)}  ${fmt(cell.interruption_ms_median).padStart(11)}  ` +
        `${fmt(cell.total_ms_median).padStart(6)}  ${fmt(cell.state_loss_ticks_median).padStart(10)}`
    )
  }
  console.log(
    '\nMedians, not means; "resume?" counts runs without a confirmed resume. "total" is ' +
      'export_ms + total_wall_ms; the manifest also carries total_to_tick_ms_median, the same ' +
      'value with the poll detection latency removed.'
  )
  if (session.aborted) console.log(`\nSession aborted: ${session.aborted}`)
  const emptyCells = Object.entries(s.cells).filter(([, cell]) => cell.ok === 0)
  if (emptyCells.length > 0) {
    console.log(
      `\nWARNING: no successful run in ${emptyCells.map(([key]) => key).join(', ')} - ` +
        'paper/figures/prepare-data.ts will abort with "no runs for <key>".'
    )
  }
  console.log('\nSecure the data now:')
  console.log(`  cp data/results.csv "data/results-$(date +%Y%m%d-%H%M).csv"`)
  console.log(
    `  git add data/results.csv data/env.json ${path.relative(REPO_ROOT, sessionPath)} && ` +
      `git commit -m "Data as of $(date +%Y-%m-%d): ${s.done} runs"`
  )
}

export async function compareWithPreviousSession(
  envInfo: EnvInfo | null,
  currentPath: string
): Promise<EnvDrift | null> {
  if (!envInfo) return null
  let files: string[]
  try {
    files = (await readdir(SESSION_DIR)).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return null
  }
  const candidates: { name: string; parsed: SessionManifest }[] = []
  for (const name of files) {
    if (path.join(SESSION_DIR, name) === currentPath) continue
    const parsed = await readJson<SessionManifest>(path.join(SESSION_DIR, name))
    if (parsed?.env_info && parsed.started_at) candidates.push({ name, parsed })
  }
  candidates.sort((a, b) => Date.parse(a.parsed.started_at) - Date.parse(b.parsed.started_at))
  const latest = candidates.pop()
  if (!latest) {
    return { previous_session: null, differences: [], note: 'no earlier session with an env.json' }
  }

  const differences: EnvDrift['differences'] = []
  for (const field of ENV_COMPARE_FIELDS) {
    const before = pluck(latest.parsed.env_info, field)
    const now = pluck(envInfo, field)
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      differences.push({ field, previous: before, current: now })
    }
  }
  return { previous_session: latest.name, differences }
}

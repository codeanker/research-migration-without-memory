import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT, RUNNER_READY, mirror, spawnRunner, streamsOf, waitForStdout } from './child.ts'
import { buildFakeExport } from './fake-export.ts'
import { HEADER } from '../shared/protocol.ts'
import type { CsvNumber, Row } from './csv.ts'

const PORT = 8799
const RUNNER_URL = `http://localhost:${PORT}/run`
const SMOKE_CSV = path.join(REPO_ROOT, 'data', 'smoke-results.csv')
const SMOKE_ENV = path.join(REPO_ROOT, 'data', 'smoke-env.json')

const LOG_INTERVALS = [250, 1000, 4000]
const INTERRUPTION_TOLERANCE_MS = 25

function grew(later: CsvNumber, earlier: CsvNumber): boolean {
  return typeof later === 'number' && typeof earlier === 'number' && later > earlier
}

async function main(): Promise<void> {
  const child = spawnRunner({
    target: 'local',
    port: PORT,
    csvPath: SMOKE_CSV,
    envPath: SMOKE_ENV,
    dataDir: await mkdtemp(path.join(tmpdir(), 'smoke-data-')),
  })
  await waitForStdout(child, RUNNER_READY, {
    name: 'runner',
    timeoutMs: 10000,
    echo: { stdout: '[runner]', stderr: '[runner-err]' },
  })
  mirror(streamsOf(child, 'runner').stderr, '[runner-err]')

  const results: Row[] = []
  try {
    for (let runIndex = 1; runIndex <= LOG_INTERVALS.length; runIndex++) {
      const logIntervalMs = LOG_INTERVALS[runIndex - 1]
      const priorCounter = runIndex

      const stopAt = Date.now()
      const lastSourceTickAt = stopAt - 30
      const tStop = performance.now()
      const zipBytes = await buildFakeExport({ priorCounter, logIntervalMs, lastSourceTickAt })
      const killToExportMs = performance.now() - tStop

      const t0 = performance.now()
      const response = await fetch(RUNNER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          [HEADER.exportMs]: '42',
          [HEADER.stage]: 'smoke',
          [HEADER.runIndex]: String(runIndex),
          [HEADER.sessionLabel]: 'smoke',
          [HEADER.stopAt]: new Date(stopAt).toISOString(),
          [HEADER.lastSourceTickAt]: new Date(lastSourceTickAt).toISOString(),
          [HEADER.killToExportMs]: String(killToExportMs),
          [HEADER.firstRun]: String(runIndex === 1),
          [HEADER.firstRunOfCell]: String(runIndex === 1),
          [HEADER.clientNow]: new Date().toISOString(),
        },
        body: zipBytes,
      })
      const body = (await response.json()) as Row
      console.log(
        `Run ${runIndex} (log_interval_ms=${logIntervalMs}): status=${response.status} ` +
          `heartbeat_resumed=${body.heartbeat_resumed} state_restored=${body.state_restored} ` +
          `counter_expected=${body.counter_expected} counter_actual=${body.counter_actual} ` +
          `state_loss_ticks=${body.state_loss_ticks} ` +
          `logging_overhead_ms=${body.logging_overhead_ms} error=${body.error || '-'} ` +
          `(client RTT ${(performance.now() - t0).toFixed(0)}ms)`
      )
      console.log(
        `  interruption_ms=${body.interruption_ms} gap=${body.interruption_gap_ms} ` +
          `split=${body.interruption_split_ms} alive_ms=${body.alive_ms} ` +
          `first_tick_at=${body.first_tick_at} first_tick_counter=${body.first_tick_counter}`
      )
      console.log(
        `  resume_verified=${body.resume_verified} resume_tick_counter=${body.resume_tick_counter} ` +
          `resume_state_counter=${body.resume_state_counter}`
      )
      console.log(
        `  total_wall_ms=${body.total_wall_ms} to_tick=${body.total_wall_to_tick_ms} ` +
          `ingest_ms=${body.ingest_ms} adapter_overhead_ms=${body.adapter_overhead_ms} ` +
          `payload_bytes=${body.payload_bytes} sanity=${body.sanity_warnings || '-'}`
      )
      results.push(body)
    }
  } finally {
    child.kill()
  }

  const resumed = results.every(
    (r) => r.heartbeat_resumed === true && r.state_restored === true && !r.error
  )
  const exact = results.every((r) => r.counter_actual === r.counter_expected)

  const measured = results.every(
    (r) => typeof r.interruption_ms === 'number' && r.interruption_ms > 0
  )
  const consistent = results.every(
    (r) =>
      typeof r.interruption_ms === 'number' &&
      typeof r.interruption_split_ms === 'number' &&
      Math.abs(r.interruption_ms - r.interruption_split_ms) <= INTERRUPTION_TOLERANCE_MS
  )
  const resumeVerified = results.every(
    (r) =>
      r.resume_verified === true &&
      grew(r.resume_tick_counter, r.first_tick_counter) &&
      grew(r.resume_state_counter, r.counter_expected)
  )
  const quiet = results.every((r) => !r.sanity_warnings)
  const recomputable = results.every((r) => {
    if (!r.restore_issued_at || !r.restore_mark_ns || !r.stop_at || !r.first_tick_at) return false
    if (typeof r.interruption_split_ms !== 'number') return false
    const split =
      Date.parse(r.restore_issued_at) -
      Date.parse(r.stop_at) +
      (Date.parse(r.first_tick_at) - Number(BigInt(r.restore_mark_ns) / 1000000n))
    return Math.abs(split - r.interruption_split_ms) <= 1
  })
  const ok = resumed && exact && measured && consistent && resumeVerified && quiet && recomputable

  if (!quiet) {
    console.log('\nSanity warnings in at least one run:')
    for (const r of results) {
      if (r.sanity_warnings) console.log(`  ${r.run_id}: ${r.sanity_warnings}`)
    }
  }
  if (!recomputable) {
    console.log(
      '\ninterruption_split_ms NOT recomputable from the raw columns: stop_at, restore_issued_at, ' +
        'restore_mark_ns or first_tick_at is missing, or the arithmetic does not match.'
    )
  }
  if (!resumeVerified) {
    console.log(
      '\nResume NOT confirmed: resume_verified is not true in every run, or the counters did not ' +
        'grow. The process starts but does not keep counting.'
    )
  }
  if (!exact) {
    console.log(
      '\nCounter offset NOT resolved: counter_actual != counter_expected in at least one run.'
    )
  }
  if (!measured) {
    console.log('\nInterruption time NOT measured: interruption_ms missing or not positive.')
  }
  if (!consistent) {
    console.log(
      `\nInterruption time INCONSISTENT: interruption_ms and interruption_split_ms deviate by ` +
        `more than ${INTERRUPTION_TOLERANCE_MS}ms, although both were taken from the same clock.`
    )
  }
  console.log(ok ? '\nSMOKE TEST OK: all 3 runs succeeded.' : '\nSMOKE TEST FAILED.')
  process.exit(ok ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

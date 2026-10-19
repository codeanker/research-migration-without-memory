import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { REPO_ROOT, RUNNER_READY, mirror, spawnRunner, streamsOf, waitForStdout } from './child.ts'
import { buildFakeExport } from './fake-export.ts'
import { HEADER } from '../shared/protocol.ts'
import { deltaIncludes, isPushStrategy } from '../shared/push.ts'
import type { CsvNumber, Row } from './csv.ts'
import type { Strategy } from '../shared/stages.ts'

const PORT = 8799
const RUNNER_URL = `http://localhost:${PORT}/run`
const PREPARE_URL = `http://localhost:${PORT}/prepare`
const SMOKE_CSV = path.join(REPO_ROOT, 'data', 'smoke-results.csv')
const SMOKE_ENV = path.join(REPO_ROOT, 'data', 'smoke-env.json')

const RUNS: { logIntervalMs: number; strategy: Strategy | '' }[] = [
  { logIntervalMs: 250, strategy: '' },
  { logIntervalMs: 1000, strategy: '' },
  { logIntervalMs: 4000, strategy: '' },
  { logIntervalMs: 1000, strategy: 'precopy' },
]
const DELTA_FILES = deltaIncludes(['heartbeat.log'])
const INTERRUPTION_TOLERANCE_MS = 25

async function prepare(runIndex: number, strategy: string, zipBytes: Buffer): Promise<string> {
  const response = await fetch(PREPARE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      [HEADER.stage]: 'smoke',
      [HEADER.strategy]: strategy,
      [HEADER.runIndex]: String(runIndex),
      [HEADER.sessionLabel]: 'smoke',
    },
    body: zipBytes,
  })
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!response.ok || !body.token) throw new Error(`/prepare failed: ${body.error ?? response.status}`)
  console.log(`Run ${runIndex} (${strategy}): prepared, push_bytes=${zipBytes.length}`)
  return body.token
}

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
    for (let runIndex = 1; runIndex <= RUNS.length; runIndex++) {
      const { logIntervalMs, strategy } = RUNS[runIndex - 1]
      const priorCounter = runIndex
      const push = isPushStrategy(strategy)
      const token = push
        ? await prepare(
            runIndex,
            strategy,
            await buildFakeExport({
              priorCounter: priorCounter - 1,
              logIntervalMs,
              lastSourceTickAt: Date.now(),
            })
          )
        : ''

      const stopAt = Date.now()
      const lastSourceTickAt = stopAt - 30
      const tStop = performance.now()
      const zipBytes = await buildFakeExport({
        priorCounter,
        logIntervalMs,
        lastSourceTickAt,
        files: push ? DELTA_FILES : undefined,
      })
      const killToExportMs = performance.now() - tStop

      const t0 = performance.now()
      const response = await fetch(RUNNER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          [HEADER.exportMs]: '42',
          [HEADER.stage]: 'smoke',
          ...(strategy ? { [HEADER.strategy]: strategy } : {}),
          ...(token ? { [HEADER.prepareToken]: token } : {}),
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
        `Run ${runIndex} (${strategy || 'no strategy'}, log_interval_ms=${logIntervalMs}): status=${response.status} ` +
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
      if (push) {
        console.log(
          `  push_bytes=${body.push_bytes} push_boot_ms=${body.push_boot_ms} ` +
            `push_unpack_ms=${body.push_unpack_ms} push_install_ms=${body.push_install_ms || '-'} ` +
            `boot_ms=${body.boot_ms || '-'} delta_files=${body.delta_files} delta_bytes=${body.delta_bytes}`
        )
      }
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
  const pushRows = results.filter((r) => isPushStrategy(r.strategy))
  const pushed =
    pushRows.length === RUNS.filter((r) => isPushStrategy(r.strategy)).length &&
    pushRows.every(
      (r) =>
        typeof r.push_bytes === 'number' &&
        typeof r.push_boot_ms === 'number' &&
        typeof r.push_upload_ms === 'number' &&
        typeof r.push_unpack_ms === 'number' &&
        r.push_install_ms === '' &&
        r.boot_ms === '' &&
        r.delta_files === DELTA_FILES.length
    )
  const ok =
    resumed && exact && measured && consistent && resumeVerified && quiet && recomputable && pushed

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
  if (!pushed) {
    console.log(
      '\nPush run NOT as expected: push row missing, push_bytes, push_boot_ms, push_upload_ms or push_unpack_ms missing, ' +
        `push_install_ms or boot_ms set, or delta_files != ${DELTA_FILES.length}.`
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
  console.log(ok ? `\nSMOKE TEST OK: all ${RUNS.length} runs succeeded.` : '\nSMOKE TEST FAILED.')
  process.exit(ok ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

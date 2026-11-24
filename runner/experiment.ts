import 'dotenv/config'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { REPO_ROOT, RUNNER_READY, mirror, spawnRunner, streamsOf, waitForStdout } from './child.ts'
import {
  resolveConfig,
  resolveDataPaths,
  buildPlan,
  orderCoverage,
  stopOffsetCoverage,
} from './plan.ts'
import type { ConfigOverrides, DataPaths, ExperimentConfig, FileConfig, PlanEntry } from './plan.ts'
import { errorMessage, readJson, writeJson } from './util.ts'
import type { EnvInfo } from './env-info.ts'
import {
  compareWithPreviousSession,
  formatRunResult,
  pickRowFields,
  printEnvInfo,
  printPlan,
  printSummary,
  summarize,
} from './session-report.ts'
import type { RunRecord, SessionManifest } from './session-report.ts'
import { withTimeout } from '../shared/timing.ts'
import type { CsvRowJson, HandoverApi, RunRequest, RunnerError } from '../shared/browser-api.ts'

declare const window: {
  __handover?: HandoverApi
  crossOriginIsolated?: boolean
}

const execFileAsync = promisify(execFile)
const BROWSER_DIR = path.join(REPO_ROOT, 'browser')

const BROWSER_CHANNEL = 'chromium'
const PAGE_READY_TIMEOUT_MS = 60000

interface RunnerArgs {
  config: string | null
  dryRun: boolean
  headed: boolean
  keepGoing: boolean
  runnerPort?: number
  vitePort?: number
  overrides: ConfigOverrides
}

interface DriveOutcome {
  ok: boolean
  row: CsvRowJson | null
  stop_offset_actual_ms: number | null
  message: string | null
  timedOut?: boolean
}

const children: ChildProcess[] = []
let browser: Browser | null = null
let interrupted = false

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const fileConfig: FileConfig = args.config
    ? (JSON.parse(await readFile(path.resolve(REPO_ROOT, args.config), 'utf8')) as FileConfig)
    : {}
  const config = resolveConfig(fileConfig, args.overrides)
  const plan = buildPlan(config)
  const paths = resolveDataPaths(config, REPO_ROOT)

  console.log(`[experiment] Config: ${args.config || '(defaults only)'}`)
  printPlan(config, plan, paths)
  if (args.dryRun) {
    console.log('\n[experiment] --dry-run: nothing started, nothing measured.')
    return 0
  }

  if (config.target === 'e2b' && !process.env.E2B_API_KEY) {
    throw new Error('E2B_API_KEY is not set (environment or .env)')
  }

  if (config.smokeFirst) {
    console.log('\n[experiment] Smoke test against target=local ...')
    const smoke = await runSmoke()
    if (!smoke.ok) {
      throw new Error(`smoke test failed (exit ${smoke.code}), session aborted`)
    }
    console.log('[experiment] Smoke test OK.')
  }

  const session: SessionManifest = {
    label: config.label,
    started_at: new Date().toISOString(),
    finished_at: null,
    aborted: null,
    config,
    plan,
    stop_offset_coverage: stopOffsetCoverage(plan),
    order_coverage: orderCoverage(plan, config.cells.length),
    git: await gitInfo(),
    runtime: {
      node_version: process.version,
      playwright_chromium: null,
      headless: !args.headed,
    },
    env_info: null,
    env_drift: null,
    runs: [],
    summary: null,
  }
  const sessionPath = path.join(
    paths.sessionDir,
    `${config.label}-${session.started_at.replace(/[:.]/g, '-')}.json`
  )
  await mkdir(paths.sessionDir, { recursive: true })

  const runnerPort = args.runnerPort ?? 8787
  const vitePort = args.vitePort ?? 5173

  await startRunner({ target: config.target, port: runnerPort, paths })
  const viteUrl = await startVite({ vitePort, runnerPort })
  browser = await chromium.launch({
    headless: !args.headed,
    channel: BROWSER_CHANNEL,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  session.runtime.playwright_chromium = browser.version()
  session.runtime.browser_channel = BROWSER_CHANNEL
  console.log(
    `[experiment] Chromium ${browser.version()} (channel ${BROWSER_CHANNEL}, ` +
      `${args.headed ? 'headed' : 'headless'}), page ${viteUrl}`
  )

  let page = await openPage(browser, viteUrl)
  session.runtime.user_agent = await page.evaluate(() => navigator.userAgent)
  let consecutiveErrors = 0
  const runnerUrl = `http://localhost:${runnerPort}/run`

  try {
    for (const entry of plan) {
      if (interrupted) {
        session.aborted = 'interrupted by SIGINT'
        break
      }
      const startedAt = Date.now()
      const label =
        `[${entry.seq}/${plan.length}] ${entry.cellKey} rep ${entry.rep}` +
        `${entry.firstRun ? ' [first]' : ''}` +
        ` stop offset ${entry.stopOffsetTargetMs.toFixed(0)}ms`
      console.log(`\n[experiment] ${label}`)

      let outcome: DriveOutcome
      let needsRecovery = false
      try {
        outcome = await withTimeout(
          driveRun(page, entry, config, runnerUrl),
          config.runTimeoutMs,
          `run exceeded runTimeoutMs=${config.runTimeoutMs}`
        )
      } catch (err: unknown) {
        outcome = {
          ok: false,
          message: errorMessage(err),
          row: null,
          stop_offset_actual_ms: null,
          timedOut: true,
        }
        needsRecovery = true
      }

      const durationMs = Date.now() - startedAt
      const warnings = splitWarnings(outcome.row?.sanity_warnings)
      if (durationMs > config.runTimeoutMs && !outcome.timedOut) {
        warnings.push(
          `the run took ${(durationMs / 1000).toFixed(0)}s, longer than ` +
            `runTimeoutMs=${config.runTimeoutMs}, without the timeout firing`
        )
      }

      const record: RunRecord = {
        ...entry,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: durationMs,
        ok: outcome.ok,
        timed_out: outcome.timedOut === true,
        message: outcome.message,
        run_id: typeof outcome.row?.run_id === 'string' ? outcome.row.run_id : null,
        row: pickRowFields(outcome.row),
        stop_offset_actual_ms: outcome.stop_offset_actual_ms,
        runner_warnings: warnings,
      }
      session.runs.push(record)
      console.log(`[experiment] ${formatRunResult(record)}`)
      await writeJson(sessionPath, session)

      if (needsRecovery) {
        try {
          page = await recoverPage(page, browser, viteUrl)
        } catch (err: unknown) {
          session.aborted = `page could not be reopened after a failed run: ${errorMessage(err)}`
          console.error(`\n[experiment] ABORT: ${session.aborted}`)
          break
        }
      }

      if (session.env_info === null && outcome.ok) {
        session.env_info = await readJson<EnvInfo>(paths.envPath)
        session.env_drift = await compareWithPreviousSession(session.env_info, sessionPath)
        printEnvInfo(session.env_info, session.env_drift, paths)
      }

      consecutiveErrors = outcome.ok && !record.row?.error ? 0 : consecutiveErrors + 1
      await writeJson(sessionPath, session)
      if (!args.keepGoing && consecutiveErrors >= config.maxConsecutiveErrors) {
        session.aborted = `${consecutiveErrors} runs in a row failed (maxConsecutiveErrors=${config.maxConsecutiveErrors})`
        console.error(`\n[experiment] ABORT: ${session.aborted}`)
        break
      }
      if (config.reloadBetweenRuns && entry.seq < plan.length) {
        await page.reload({ waitUntil: 'load' })
        await waitForHandover(page)
      }
    }
  } catch (err: unknown) {
    session.aborted = `session ended with an exception: ${errorMessage(err)}`
    throw err
  } finally {
    session.finished_at = new Date().toISOString()
    session.summary = summarize(session, plan)
    await writeJson(sessionPath, session)
    await shutdown()
  }

  printSummary(session, sessionPath)
  const failed = session.runs.filter((r) => !r.ok).length
  return session.aborted || failed > 0 ? 1 : 0
}

async function driveRun(
  page: Page,
  entry: PlanEntry,
  config: ExperimentConfig,
  runnerUrl: string
): Promise<DriveOutcome> {
  const request: RunRequest = {
    stage: entry.stage,
    strategy: entry.strategy,
    runIndex: entry.runLabel,
    sessionLabel: config.label,
    runnerUrl,
    logIntervalMs: entry.logIntervalMs,
    stopOffsetMs: entry.stopOffsetTargetMs,
    warmupStateWrites: config.warmupStateWrites,
    firstRun: entry.firstRun,
    firstRunOfCell: entry.firstRunOfCell,
    positionInCycle: entry.positionInCycle,
    cycle: entry.rep,
  }
  return page.evaluate(async (req: RunRequest): Promise<DriveOutcome> => {
    const api = window.__handover
    if (!api) throw new Error('window.__handover missing - the page did not load main.ts')
    try {
      const outcome = await api.runOnce(req)
      return {
        ok: true,
        row: outcome.row,
        stop_offset_actual_ms: outcome.stop_offset_actual_ms,
        message: null,
      }
    } catch (err: unknown) {
      const failure = err as RunnerError | null
      return {
        ok: false,
        message: failure?.message ? failure.message : String(err),
        row: failure?.row ?? null,
        stop_offset_actual_ms: null,
      }
    }
  }, request)
}

async function openPage(browserInstance: Browser, url: string): Promise<Page> {
  const page = await browserInstance.newPage()
  page.on('console', (msg) => {
    const text = msg.text()
    if (/^\[/.test(text)) console.log(`  [page] ${text}`)
  })
  page.on('pageerror', (err) => console.error(`  [page-error] ${err.message}`))
  await page.goto(url, { waitUntil: 'load', timeout: PAGE_READY_TIMEOUT_MS })
  await waitForHandover(page)
  const isolated = await page.evaluate(() => window.crossOriginIsolated === true)
  if (!isolated) {
    throw new Error('crossOriginIsolated is false in the automated Chromium')
  }
  return page
}

async function waitForHandover(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__handover), null, {
    timeout: PAGE_READY_TIMEOUT_MS,
  })
}

async function recoverPage(page: Page, browserInstance: Browser, url: string): Promise<Page> {
  try {
    await page.close()
  } catch {}
  console.log('[experiment] Page reopened after the timeout.')
  return openPage(browserInstance, url)
}

async function startRunner({
  target,
  port,
  paths,
}: {
  target: string
  port: number
  paths: DataPaths
}): Promise<void> {
  const child = spawnRunner({
    target,
    port,
    csvPath: paths.csvPath,
    envPath: paths.envPath,
    dataDir: paths.dataDir,
  })
  children.push(child)
  await waitForStdout(child, RUNNER_READY, { name: 'runner' })
  const { stdout, stderr } = streamsOf(child, 'runner')
  mirror(stdout, '  [runner]')
  mirror(stderr, '  [runner-err]')
}

async function startVite({
  vitePort,
  runnerPort,
}: {
  vitePort: number
  runnerPort: number
}): Promise<string> {
  const child = spawn('pnpm', ['exec', 'vite', '--port', String(vitePort), '--strictPort'], {
    cwd: BROWSER_DIR,
    env: { ...process.env, RUNNER_ORIGIN: `http://localhost:${runnerPort}` },
  })
  children.push(child)
  const output = await waitForStdout(child, /Local:\s+\S*http:\/\//, { name: 'vite' })
  mirror(streamsOf(child, 'vite').stderr, '  [vite-err]')
  const match = /Local:\s+(http:\/\/\S+)/.exec(output)
  if (!match) throw new Error(`could not read the dev server URL from the Vite output: ${output}`)
  return match[1].replace(/\/$/, '')
}

function runSmoke(): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['runner/smoke-local.ts'], { cwd: REPO_ROOT, stdio: 'inherit' })
    children.push(child)
    child.once('exit', (code) => resolve({ ok: code === 0, code }))
  })
}

async function shutdown(): Promise<void> {
  if (browser) {
    try {
      await browser.close()
    } catch {}
    browser = null
  }
  for (const child of children) {
    if (!child.killed) child.kill()
  }
}

async function gitInfo(): Promise<{ commit: string | null; dirty: boolean | null }> {
  try {
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
    })
    return { commit: commit.trim(), dirty: status.trim().length > 0 }
  } catch {
    return { commit: null, dirty: null }
  }
}

const NUMERIC_FLAGS = {
  repeats: 'repeats',
  seed: 'seed',
  'run-timeout-ms': 'runTimeoutMs',
  'max-consecutive-errors': 'maxConsecutiveErrors',
  'warmup-state-writes': 'warmupStateWrites',
} as const

const STRING_FLAGS = {
  target: 'target',
  label: 'label',
} as const

function setOverride<K extends keyof ConfigOverrides>(
  overrides: ConfigOverrides,
  key: K,
  value: ConfigOverrides[K]
): void {
  overrides[key] = value
}

function parseArgs(argv: string[]): RunnerArgs {
  const out: RunnerArgs = {
    config: null,
    dryRun: false,
    headed: false,
    keepGoing: false,
    overrides: {},
  }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s)
    const value = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[++i]
      if (next === undefined) throw new Error(`${flag} expects a value`)
      return next
    }
    const key = flag.replace(/^--/, '')
    const numericKey = NUMERIC_FLAGS[key as keyof typeof NUMERIC_FLAGS]
    const stringKey = STRING_FLAGS[key as keyof typeof STRING_FLAGS]
    if (key === 'config') out.config = value()
    else if (key === 'dry-run') out.dryRun = true
    else if (key === 'headed') out.headed = true
    else if (key === 'keep-going') out.keepGoing = true
    else if (key === 'smoke') out.overrides.smokeFirst = true
    else if (key === 'no-smoke') out.overrides.smokeFirst = false
    else if (key === 'no-reload') out.overrides.reloadBetweenRuns = false
    else if (key === 'runner-port') out.runnerPort = Number(value())
    else if (key === 'vite-port') out.vitePort = Number(value())
    else if (key === 'stages') out.overrides.stages = splitTrimmed(value(), ',')
    else if (key === 'strategies') out.overrides.strategies = splitTrimmed(value(), ',')
    else if (numericKey) setOverride(out.overrides, numericKey, Number(value()))
    else if (stringKey) setOverride(out.overrides, stringKey, value())
    else throw new Error(`unknown option: ${flag}`)
  }
  return out
}

function splitTrimmed(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean)
}

function splitWarnings(value: unknown): string[] {
  return typeof value === 'string' ? splitTrimmed(value, ';') : []
}

process.on('SIGINT', () => {
  interrupted = true
  console.log('\n[experiment] SIGINT: finishing the current run, then stopping.')
})

main()
  .then(async (code) => {
    await shutdown()
    process.exit(code)
  })
  .catch(async (err: unknown) => {
    console.error(`[experiment] ${errorMessage(err)}`)
    await shutdown()
    process.exit(1)
  })

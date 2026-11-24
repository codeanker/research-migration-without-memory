import { HEARTBEAT_FORMATTER_SRC, HEARTBEAT_TICK_MS } from '../../shared/heartbeat.ts'
import type { MeasurementStage } from '../../shared/stages.ts'
import lightLock from './lockfiles/light.json' with { type: 'json' }
import mediumLock from './lockfiles/medium.json' with { type: 'json' }
import largeLock from './lockfiles/large.json' with { type: 'json' }

const STAGE_DEPENDENCIES: Record<MeasurementStage, Record<string, string>> = {
  small: {},
  light: { express: '^4.21.0' },
  medium: { '@babel/preset-env': '^7.24.0' },
  large: { 'aws-sdk': '^2.1400.0' },
}

const STAGE_LOCKFILES: Record<MeasurementStage, object | null> = {
  small: null,
  light: lightLock,
  medium: mediumLock,
  large: largeLock,
}

export function stageNeedsInstall(stage: MeasurementStage): boolean {
  return Object.keys(STAGE_DEPENDENCIES[stage]).length > 0
}

export function packageJsonForStage(stage: MeasurementStage): string {
  const dependencies = STAGE_DEPENDENCIES[stage]
  return JSON.stringify(
    {
      name: 'heartbeat-payload',
      private: true,
      version: '1.0.0',
      ...(stageNeedsInstall(stage) ? { dependencies } : {}),
    },
    null,
    2
  )
}

export function lockfileForStage(stage: MeasurementStage): string | null {
  const lock = STAGE_LOCKFILES[stage]
  return lock === null ? null : JSON.stringify(lock, null, 2) + '\n'
}

export const HEARTBEAT_JS = `const fs = require('fs')

${HEARTBEAT_FORMATTER_SRC}

const HEARTBEAT_PATH = 'heartbeat.log'
const STATE_PATH = 'state.json'
const FAST_TICK_MS = ${HEARTBEAT_TICK_MS}
const logIntervalMs = Number(process.argv[2]) || 1000

let counter = 0
try {
  const prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  if (typeof prev.counter === 'number') counter = prev.counter
} catch (err) {
}

const loggingDurationsMs = []

function avgLoggingOverheadMs() {
  if (loggingDurationsMs.length === 0) return null
  return loggingDurationsMs.reduce((a, b) => a + b, 0) / loggingDurationsMs.length
}

function writeState() {
  const t0 = process.hrtime.bigint()
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      counter,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      loggingOverheadMs: avgLoggingOverheadMs(),
    })
  )
  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6
  loggingDurationsMs.push(durationMs)
  if (loggingDurationsMs.length > 50) loggingDurationsMs.shift()
}

function fastTick() {
  counter += 1
  fs.appendFileSync(
    HEARTBEAT_PATH,
    formatHeartbeatLine(new Date().toISOString(), counter, process.pid) + '\\n'
  )
}

writeState()
fastTick()
setInterval(fastTick, FAST_TICK_MS)
setInterval(writeState, logIntervalMs)
`

interface ProcessSnapshotInput {
  counter: number
  command: string
  logIntervalMs: number
  stateLossTicks: number | null
}

export function buildProcessSnapshot({
  counter,
  command,
  logIntervalMs,
  stateLossTicks,
}: ProcessSnapshotInput): string {
  return JSON.stringify(
    {
      command,
      cwd: '/work',
      counter,
      logIntervalMs,
      stateLossTicks,
    },
    null,
    2
  )
}

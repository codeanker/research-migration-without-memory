import path from 'node:path'
import { ADAPTER_NAMES, isKnownAdapter } from '../targets/registry.ts'
import type { AdapterName } from '../targets/registry.ts'
import { MEASUREMENT_STAGES, STRATEGIES, isMeasurementStage, isStrategy } from '../shared/stages.ts'
import type { MeasurementStage, Strategy } from '../shared/stages.ts'

interface StopOffset {
  mode: 'uniform'
}

export interface Cell {
  stage: MeasurementStage
  strategy: Strategy
}

interface DraftCell {
  stage: string
  strategy?: string
}

export interface FileConfig {
  label?: string
  target?: string
  repeats?: number
  cells?: DraftCell[]
  logIntervalMs?: number
  stopOffset?: { mode?: string }
  warmupStateWrites?: number
  runTimeoutMs?: number
  maxConsecutiveErrors?: number
  reloadBetweenRuns?: boolean
  smokeFirst?: boolean | null
  seed?: number | null
  dataDir?: string
  notes?: string[]
}

export interface ConfigOverrides {
  label?: string
  target?: string
  repeats?: number
  seed?: number
  runTimeoutMs?: number
  maxConsecutiveErrors?: number
  warmupStateWrites?: number
  reloadBetweenRuns?: boolean
  smokeFirst?: boolean
  stages?: string[]
  strategies?: string[]
}

interface DraftConfig {
  label: string
  target: string
  repeats: number
  cells: DraftCell[]
  logIntervalMs: number
  stopOffset: { mode: string }
  warmupStateWrites: number
  runTimeoutMs: number
  maxConsecutiveErrors: number
  reloadBetweenRuns: boolean
  smokeFirst: boolean | null
  seed?: number | null
  seedGenerated?: boolean
  dataDir?: string
  notes?: string[]
  stages?: string[]
  strategies?: string[]
}

export interface ExperimentConfig extends DraftConfig {
  target: AdapterName
  cells: Cell[]
  stopOffset: StopOffset
  smokeFirst: boolean
  seed: number
}

const DEFAULTS: DraftConfig = {
  label: 'unnamed',
  target: 'e2b',
  repeats: 10,
  cells: [],
  logIntervalMs: 1000,
  stopOffset: { mode: 'uniform' },
  warmupStateWrites: 3,
  runTimeoutMs: 240000,
  maxConsecutiveErrors: 3,
  reloadBetweenRuns: true,
  smokeFirst: null,
}

export function resolveConfig(
  fileConfig: FileConfig = {},
  overrides: ConfigOverrides = {}
): ExperimentConfig {
  const { stopOffset: fileStopOffset, ...plainFileConfig } = fileConfig
  const config: DraftConfig = {
    ...DEFAULTS,
    ...stripUndefined(plainFileConfig),
    ...stripUndefined(overrides),
    stopOffset: { mode: fileStopOffset?.mode ?? DEFAULTS.stopOffset.mode },
  }

  if (overrides.stages || overrides.strategies) {
    const stages = unique(overrides.stages ?? config.cells.map((cell) => cell.stage))
    const strategies = unique(overrides.strategies ?? config.cells.map((cell) => cell.strategy))
    config.cells = stages.flatMap((stage) => strategies.map((strategy) => ({ stage, strategy })))
  }

  if (config.seed === undefined || config.seed === null) {
    config.seed = Date.now() % 2147483647
    config.seedGenerated = true
  }
  if (config.smokeFirst === null) config.smokeFirst = config.target !== 'local'

  validate(config)
  return config
}

function validate(config: DraftConfig): asserts config is ExperimentConfig {
  if (!Array.isArray(config.cells) || config.cells.length === 0) {
    throw new Error('config: cells is empty - nothing to measure')
  }
  for (const cell of config.cells) {
    if (!isMeasurementStage(cell.stage)) {
      throw new Error(
        `config: unknown stage "${cell.stage}" - known: ${MEASUREMENT_STAGES.join(', ')}`
      )
    }
    if (typeof cell.strategy !== 'string' || !isStrategy(cell.strategy)) {
      throw new Error(
        `config: cell ${JSON.stringify(cell)} has no known strategy - known: ${STRATEGIES.join(', ')}`
      )
    }
  }
  if (unique(config.cells.map(cellKeyOf)).length !== config.cells.length) {
    throw new Error(
      `config: a stage-strategy pair appears twice in cells: ${JSON.stringify(config.cells)}`
    )
  }
  if (!Number.isInteger(config.logIntervalMs) || config.logIntervalMs <= 0) {
    throw new Error(`config: logIntervalMs must be a positive integer, got ${config.logIntervalMs}`)
  }
  if (!Number.isInteger(config.repeats) || config.repeats < 1) {
    throw new Error(`config: repeats must be >= 1, got ${config.repeats}`)
  }
  if (config.stopOffset.mode !== 'uniform') {
    throw new Error(`config: stopOffset.mode must be uniform, got "${config.stopOffset.mode}"`)
  }
  if (
    config.dataDir !== undefined &&
    (typeof config.dataDir !== 'string' || config.dataDir.trim() === '')
  ) {
    throw new Error(`config: dataDir must be a non-empty path, got ${JSON.stringify(config.dataDir)}`)
  }
  if (!isKnownAdapter(config.target)) {
    throw new Error(
      `config: target must be one of ${ADAPTER_NAMES.join(', ')}, got "${config.target}"`
    )
  }
}

export interface DataPaths {
  dataDir: string
  csvPath: string
  envPath: string
  sessionDir: string
}

export function resolveDataPaths(
  config: Pick<DraftConfig, 'dataDir'>,
  root: string,
  env: NodeJS.ProcessEnv = process.env
): DataPaths {
  const dataDir = env.DATA_DIR
    ? path.resolve(env.DATA_DIR)
    : path.resolve(root, config.dataDir ?? 'data')
  return {
    dataDir,
    csvPath: env.CSV_PATH ? path.resolve(env.CSV_PATH) : path.join(dataDir, 'results.csv'),
    envPath: env.ENV_PATH ? path.resolve(env.ENV_PATH) : path.join(dataDir, 'env.json'),
    sessionDir: path.join(dataDir, 'sessions'),
  }
}

export interface PlanEntry {
  seq: number
  cellKey: string
  stage: MeasurementStage
  strategy: Strategy
  logIntervalMs: number
  rep: number
  runLabel: string
  runId: string
  stopOffsetTargetMs: number
  positionInCycle: number
  firstRun: boolean
  firstRunOfCell: boolean
}

export function buildPlan(config: ExperimentConfig): PlanEntry[] {
  const offsetRng = mulberry32(config.seed)
  const orderRng = mulberry32((config.seed ^ 0x9e3779b9) >>> 0)

  interface Draw {
    cell: Cell
    rep: number
    stopOffsetTargetMs: number
  }
  const draw = (cell: Cell, rep: number): Draw => ({
    cell,
    rep,
    stopOffsetTargetMs: drawStopOffset(config.logIntervalMs, offsetRng),
  })

  const groups: Draw[][] = range(config.repeats).map((rep) =>
    config.cells.map((cell) => draw(cell, rep))
  )
  for (const group of groups) shuffleInPlace(group, orderRng)

  const plan: PlanEntry[] = []
  groups.flat().forEach(({ cell, rep, stopOffsetTargetMs }, index) => {
    const runLabel = String(rep + 1).padStart(2, '0')
    const cellKey = cellKeyOf(cell)
    plan.push({
      seq: index + 1,
      cellKey,
      stage: cell.stage,
      strategy: cell.strategy,
      logIntervalMs: config.logIntervalMs,
      rep: rep + 1,
      runLabel,
      runId: `${cellKey}-${runLabel}`,
      stopOffsetTargetMs,
      positionInCycle: (index % config.cells.length) + 1,
      firstRun: index === 0,
      firstRunOfCell: rep === 0,
    })
  })
  return plan
}

function cellKeyOf(cell: DraftCell): string {
  return `${cell.stage}-${cell.strategy}`
}

export function shuffleInPlace<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
}

export interface CoverageEntry {
  n: number
  interval_ms: number
  min_ms: number
  max_ms: number
  mean_ms: number
  quarters: number[]
  empty_quarters: number[]
}

export function stopOffsetCoverage(
  plan: readonly Pick<PlanEntry, 'cellKey' | 'logIntervalMs' | 'stopOffsetTargetMs'>[]
): Record<string, CoverageEntry> {
  const byCell: Record<string, { interval: number; offsets: number[] }> = {}
  for (const entry of plan) {
    const cell = (byCell[entry.cellKey] ??= { interval: entry.logIntervalMs, offsets: [] })
    cell.offsets.push(entry.stopOffsetTargetMs)
  }
  return Object.fromEntries(
    Object.entries(byCell).map(([key, { interval, offsets }]) => {
      const quarters = [0, 0, 0, 0]
      for (const offset of offsets) {
        quarters[Math.min(3, Math.floor((offset / interval) * 4))] += 1
      }
      return [
        key,
        {
          n: offsets.length,
          interval_ms: interval,
          min_ms: Math.min(...offsets),
          max_ms: Math.max(...offsets),
          mean_ms: Number((offsets.reduce((a, b) => a + b, 0) / offsets.length).toFixed(1)),
          quarters,
          empty_quarters: quarters.flatMap((count, index) => (count === 0 ? [index] : [])),
        },
      ]
    })
  )
}

export interface OrderCoverageEntry {
  n: number
  positions: number[]
  missing_positions: number[]
}

export function orderCoverage(
  plan: readonly Pick<PlanEntry, 'cellKey' | 'positionInCycle'>[],
  cellCount: number
): Record<string, OrderCoverageEntry> {
  const byCell: Record<string, number[]> = {}
  for (const entry of plan) {
    const positions = (byCell[entry.cellKey] ??= new Array<number>(cellCount).fill(0))
    positions[entry.positionInCycle - 1] += 1
  }
  return Object.fromEntries(
    Object.entries(byCell).map(([key, positions]) => [
      key,
      {
        n: positions.reduce((a, b) => a + b, 0),
        positions,
        missing_positions: positions.flatMap((count, index) => (count === 0 ? [index + 1] : [])),
      },
    ])
  )
}

function drawStopOffset(logIntervalMs: number, rng: () => number): number {
  return Math.round(rng() * logIntervalMs * 100) / 100
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stripUndefined<T extends object>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

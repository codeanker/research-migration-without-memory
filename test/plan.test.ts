import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../runner/child.ts'
import {
  buildPlan,
  mulberry32,
  orderCoverage,
  resolveConfig,
  resolveDataPaths,
  stopOffsetCoverage,
} from '../runner/plan.ts'
import type { FileConfig, PlanEntry } from '../runner/plan.ts'

const baseConfig: FileConfig = {
  label: 'test',
  target: 'local',
  seed: 20260904,
  repeats: 10,
  cells: [{ stage: 'small', strategy: 'full' }],
}

function planOf(overrides: FileConfig = {}): PlanEntry[] {
  return buildPlan(resolveConfig({ ...baseConfig, ...overrides }))
}

test('offsets within interval', () => {
  const interval = 1000
  const plan = planOf({ repeats: 10, logIntervalMs: interval })
  const offsets = plan.map((e) => e.stopOffsetTargetMs)
  assert.equal(offsets.length, 10)
  for (const offset of offsets) {
    assert.ok(offset >= 0 && offset < interval, `offset ${offset} outside [0, ${interval})`)
  }
  assert.ok(Math.min(...offsets) < interval / 2, `no offset in the lower half: ${offsets}`)
  assert.ok(Math.max(...offsets) > interval / 2, `no offset in the upper half: ${offsets}`)
})

test('mulberry32 uniform', () => {
  const rng = mulberry32(20260904)
  const quarters = [0, 0, 0, 0]
  let sum = 0
  const draws = 40000
  for (let i = 0; i < draws; i++) {
    const value = rng()
    quarters[Math.floor(value * 4)] += 1
    sum += value
  }
  assert.ok(Math.abs(sum / draws - 0.5) < 0.01, `mean ${sum / draws}`)
  for (const count of quarters) {
    assert.ok(Math.abs(count - draws / 4) < draws * 0.01, `quarters ${quarters}`)
  }
})

test('stopOffsetCoverage empty quarters', () => {
  const interval = 1000
  const coverage = stopOffsetCoverage([
    { cellKey: 'small', logIntervalMs: interval, stopOffsetTargetMs: 100 },
    { cellKey: 'small', logIntervalMs: interval, stopOffsetTargetMs: 300 },
    { cellKey: 'small', logIntervalMs: interval, stopOffsetTargetMs: 700 },
  ])
  assert.deepEqual(Object.keys(coverage), ['small'])
  assert.deepEqual(coverage['small'], {
    n: 3,
    interval_ms: 1000,
    min_ms: 100,
    max_ms: 700,
    mean_ms: 366.7,
    quarters: [1, 1, 1, 0],
    empty_quarters: [3],
  })
})

const TWO_CELLS = [
  { stage: 'small', strategy: 'full' },
  { stage: 'large', strategy: 'full' },
]

test('shuffle within cycle', () => {
  const plan = planOf({ cells: TWO_CELLS, repeats: 10 })
  const cycles: string[][] = []
  for (let i = 0; i < plan.length; i += 2) cycles.push(plan.slice(i, i + 2).map((e) => e.cellKey))

  for (const cycle of cycles) {
    assert.equal(new Set(cycle).size, 2, `a cell appears twice in one cycle: ${cycle}`)
  }
  const inConfigOrder = ['small-full', 'large-full']
  assert.ok(
    cycles.some((cycle) => cycle.join() !== inConfigOrder.join()),
    'no cycle was permuted at all - the shuffle is not running'
  )
})

test('permutation follows seed', () => {
  const keysFor = (seed: number) =>
    planOf({ cells: TWO_CELLS, repeats: 10, seed }).map((e) => e.cellKey)
  assert.notDeepEqual(keysFor(20260904), keysFor(20260905))
})

test('positionInCycle', () => {
  const plan = planOf({ cells: TWO_CELLS, repeats: 3 })
  assert.deepEqual(
    plan.map((e) => e.positionInCycle),
    [1, 2, 1, 2, 1, 2]
  )
})

test('orderCoverage missing positions', () => {
  const stuck = Array.from({ length: 5 }, () => ({ cellKey: 'small', positionInCycle: 1 }))
  const coverage = orderCoverage(stuck, 4)
  assert.deepEqual(coverage['small'].positions, [5, 0, 0, 0])
  assert.deepEqual(coverage['small'].missing_positions, [2, 3, 4])
  assert.deepEqual(orderCoverage([], 4), {})
})

test('firstRun and firstRunOfCell', () => {
  const plan = planOf({ cells: TWO_CELLS, repeats: 3 })
  assert.deepEqual(
    plan.map((e) => e.firstRun),
    [true, false, false, false, false, false]
  )
  assert.deepEqual(
    plan.map((e) => e.firstRunOfCell),
    [true, true, false, false, false, false]
  )
})

test('run_id format', () => {
  const plan = planOf({ repeats: 2 })
  assert.deepEqual(
    plan.map((e) => e.runId),
    ['small-full-01', 'small-full-02']
  )
})

test('config validation', () => {
  const cases: [FileConfig, RegExp][] = [
    [{ cells: [] }, /cells is empty/],
    [{ cells: [{ stage: 'larg', strategy: 'full' }] }, /unknown stage "larg"/],
    [{ cells: [{ stage: 'small' }] }, /no known strategy/],
    [{ cells: [{ stage: 'small', strategy: 'cold' }] }, /no known strategy/],
    [
      {
        cells: [
          { stage: 'small', strategy: 'full' },
          { stage: 'small', strategy: 'full' },
        ],
      },
      /appears twice/,
    ],
    [{ logIntervalMs: 0 }, /positive integer/],
    [{ repeats: 0 }, /repeats must be >= 1/],
    [{ target: 'docker' }, /target must be one of/],
    [{ stopOffset: { mode: 'fixed' } }, /stopOffset.mode must be uniform/],
  ]
  for (const [overrides, pattern] of cases) {
    assert.throws(() => resolveConfig({ ...baseConfig, ...overrides }), pattern)
  }
})

test('--stages with --strategies', () => {
  const config = resolveConfig(baseConfig, {
    stages: ['light', 'medium'],
    strategies: ['full', 'manifest'],
  })
  assert.deepEqual(
    config.cells.map((cell) => `${cell.stage}-${cell.strategy}`),
    ['light-full', 'light-manifest', 'medium-full', 'medium-manifest']
  )
})

test('--strategies keeps stages', () => {
  const config = resolveConfig(
    {
      ...baseConfig,
      cells: [
        { stage: 'small', strategy: 'full' },
        { stage: 'large', strategy: 'full' },
      ],
    },
    { strategies: ['manifest'] }
  )
  assert.deepEqual(
    config.cells.map((cell) => `${cell.stage}-${cell.strategy}`),
    ['small-manifest', 'large-manifest']
  )
})

test('generated seed', () => {
  const config = resolveConfig({ ...baseConfig, seed: undefined })
  assert.ok(Number.isInteger(config.seed) && config.seed >= 0 && config.seed < 2147483647, `seed ${config.seed}`)
  assert.equal(config.seedGenerated, true)
  assert.equal(resolveConfig({ ...baseConfig, seed: 7 }).seedGenerated, undefined)
})

const readJson = <T>(relpath: string): T =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, relpath), 'utf8')) as T

const LIVE_STUDY = readJson<FileConfig>('experiments/live-study.json')

test('study plans', () => {
  for (const [study, sessionDir] of [
    ['main-study', 'data/sessions'],
    ['live-study', 'data/live/sessions'],
  ]) {
    const manifests = readdirSync(path.join(REPO_ROOT, sessionDir)).filter((f) => f.endsWith('.json'))
    assert.equal(manifests.length, 1, sessionDir)
    const session = readJson<{ plan: PlanEntry[] }>(path.join(sessionDir, manifests[0]))
    const plan = buildPlan(resolveConfig(readJson<FileConfig>(`experiments/${study}.json`)))
    assert.deepEqual(plan, session.plan, study)
  }
})

test('live study paths', () => {
  const paths = resolveDataPaths(resolveConfig(LIVE_STUDY), REPO_ROOT, {})
  assert.equal(paths.csvPath, path.join(REPO_ROOT, 'data/live/results.csv'))
  assert.equal(paths.envPath, path.join(REPO_ROOT, 'data/live/env.json'))
  assert.equal(paths.sessionDir, path.join(REPO_ROOT, 'data/live/sessions'))
})

test('env overrides dataDir', () => {
  const paths = resolveDataPaths(resolveConfig(LIVE_STUDY), REPO_ROOT, {
    DATA_DIR: '/scratch/data',
    CSV_PATH: '/scratch/out/results.csv',
    ENV_PATH: '/scratch/out/env.json',
  })
  assert.equal(paths.dataDir, '/scratch/data')
  assert.equal(paths.csvPath, '/scratch/out/results.csv')
  assert.equal(paths.envPath, '/scratch/out/env.json')
  assert.equal(paths.sessionDir, '/scratch/data/sessions')
})

test('empty dataDir rejected', () => {
  assert.throws(() => resolveConfig({ ...baseConfig, dataDir: ' ' }), /dataDir must be a non-empty path/)
})

test('default dataDir', () => {
  const paths = resolveDataPaths(resolveConfig(baseConfig), REPO_ROOT, {})
  assert.equal(paths.csvPath, path.join(REPO_ROOT, 'data/results.csv'))
  assert.equal(paths.sessionDir, path.join(REPO_ROOT, 'data/sessions'))
})

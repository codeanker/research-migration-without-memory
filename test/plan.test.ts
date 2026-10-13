import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPlan,
  mulberry32,
  orderCoverage,
  resolveConfig,
  stopOffsetCoverage,
} from '../runner/plan.ts'
import type { ConfigOverrides, FileConfig, PlanEntry } from '../runner/plan.ts'

const baseConfig: FileConfig = {
  label: 'test',
  target: 'local',
  seed: 20260904,
  repeats: 10,
  cells: [{ stage: 'small', strategy: 'full' }],
}

function planOf(overrides: FileConfig = {}, cliOverrides: ConfigOverrides = {}): PlanEntry[] {
  return buildPlan(resolveConfig({ ...baseConfig, ...overrides }, cliOverrides))
}

test('same seed produces the same plan', () => {
  const first = planOf()
  const second = planOf()
  assert.deepEqual(first, second)
})

test('a different seed produces different stop offsets', () => {
  const a = planOf({ seed: 1 }).map((e) => e.stopOffsetTargetMs)
  const b = planOf({ seed: 2 }).map((e) => e.stopOffsetTargetMs)
  assert.notDeepEqual(a, b)
})

test('the drawn offsets stay inside the interval and reach both halves of it', () => {
  const interval = 1000
  const plan = planOf({ repeats: 10, logIntervalMs: interval })
  const offsets = plan.map((e) => e.stopOffsetTargetMs ?? -1)
  assert.equal(offsets.length, 10)
  for (const offset of offsets) {
    assert.ok(offset >= 0 && offset < interval, `offset ${offset} outside [0, ${interval})`)
  }
  assert.ok(Math.min(...offsets) < interval / 2, `no offset in the lower half: ${offsets}`)
  assert.ok(Math.max(...offsets) > interval / 2, `no offset in the upper half: ${offsets}`)
})

test('the generator itself is uniform over the interval', () => {
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

test('stopOffsetCoverage names the quarters a draw did not sample', () => {
  const interval = 1000
  const coverage = stopOffsetCoverage([
    { cellKey: 'small', logIntervalMs: interval, stopOffsetTargetMs: 100 },
    { cellKey: 'small', logIntervalMs: interval, stopOffsetTargetMs: 300 },
    { cellKey: 'small', logIntervalMs: interval, stopOffsetTargetMs: 700 },
    { cellKey: 'large', logIntervalMs: interval, stopOffsetTargetMs: null },
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

test('the planned session (seed 20260904) leaves the top of the interval unsampled', () => {
  const coverage = stopOffsetCoverage(planOf({ repeats: 10 }))['small-full']
  assert.ok(coverage.max_ms < 750, `max ${coverage.max_ms}`)
  assert.deepEqual(coverage.empty_quarters, [3])
})

test('a fixed offset is used verbatim, mode none draws nothing', () => {
  const fixed = planOf({}, { stopOffsetMs: 250 })
  assert.ok(fixed.every((e) => e.stopOffsetTargetMs === 250))
  const none = planOf({ stopOffset: { mode: 'none' } })
  assert.ok(none.every((e) => e.stopOffsetTargetMs === null))
})

const TWO_CELLS = [
  { stage: 'small', strategy: 'full' },
  { stage: 'large', strategy: 'full' },
]

test('shuffled order permutes inside a cycle and keeps one run of each cell per cycle', () => {
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

test('the permutation is reproducible from the seed and changes with it', () => {
  const keysFor = (seed: number) =>
    planOf({ cells: TWO_CELLS, repeats: 10, seed }).map((e) => e.cellKey)
  assert.deepEqual(keysFor(20260904), keysFor(20260904))
  assert.notDeepEqual(keysFor(20260904), keysFor(20260905))
})

test('the offsets come off the unpermuted seed stream, cell by cell within a cycle', () => {
  const seed = 20260904
  const rng = mulberry32(seed)
  const expected = new Map<string, number[]>()
  for (let rep = 0; rep < 3; rep++) {
    for (const cell of TWO_CELLS) {
      const offset = Math.round(rng() * 1000 * 100) / 100
      const key = `${cell.stage}-${cell.strategy}`
      expected.set(key, [...(expected.get(key) ?? []), offset])
    }
  }
  const drawn = new Map<string, number[]>()
  for (const entry of planOf({ cells: TWO_CELLS, repeats: 3, seed })) {
    drawn.set(entry.cellKey, [...(drawn.get(entry.cellKey) ?? []), entry.stopOffsetTargetMs ?? -1])
  }
  for (const [key, offsets] of expected) {
    assert.deepEqual([...(drawn.get(key) ?? [])].sort(), [...offsets].sort(), key)
  }
})

test('positionInCycle counts through the cycle', () => {
  const plan = planOf({ cells: TWO_CELLS, repeats: 3 })
  assert.deepEqual(
    plan.map((e) => e.positionInCycle),
    [1, 2, 1, 2, 1, 2]
  )
})

test('orderCoverage names the positions a cell never took', () => {
  const stuck = Array.from({ length: 5 }, () => ({ cellKey: 'small', positionInCycle: 1 }))
  const coverage = orderCoverage(stuck, 4)
  assert.deepEqual(coverage['small'].positions, [5, 0, 0, 0])
  assert.deepEqual(coverage['small'].missing_positions, [2, 3, 4])
  assert.deepEqual(orderCoverage([], 4), {})
})

test('the planned main study (30 repetitions) leaves no cell stuck at one position', () => {
  const plan = planOf({ cells: TWO_CELLS, repeats: 30 })
  const coverage = orderCoverage(plan, 2)
  for (const [cellKey, entry] of Object.entries(coverage)) {
    assert.equal(entry.n, 30, cellKey)
    assert.deepEqual(entry.missing_positions, [], `${cellKey} positions ${entry.positions}`)
  }
})

test('firstRun marks the first run of the session, firstRunOfCell the first run of each cell', () => {
  const plan = planOf({ cells: TWO_CELLS, repeats: 3 })
  assert.equal(plan.filter((e) => e.firstRun).length, 1)
  assert.equal(plan[0].firstRun, true)
  assert.equal(plan.filter((e) => e.firstRunOfCell).length, 2)
  assert.deepEqual(
    plan
      .filter((e) => e.firstRunOfCell)
      .map((e) => e.cellKey)
      .sort(),
    ['large-full', 'small-full']
  )
})

test('every entry carries the run_id the runner will write', () => {
  const plan = planOf({ repeats: 2 })
  assert.deepEqual(
    plan.map((e) => e.runId),
    ['small-full-01', 'small-full-02']
  )
})

test('validation rejects what would only surface mid-session', () => {
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
    [{ stopOffset: { mode: 'fixed', valueMs: 1000 } }, /not smaller than the logging interval/],
    [{ stopOffset: { mode: 'fixed', valueMs: -1 } }, /must be >= 0/],
    [{ stopOffset: { mode: 'sometimes' } }, /stopOffset.mode must be one of/],
  ]
  for (const [overrides, pattern] of cases) {
    assert.throws(() => resolveConfig({ ...baseConfig, ...overrides }), pattern)
  }
})

test('--stages and --strategies cross into one cell per pair', () => {
  const config = resolveConfig(baseConfig, {
    stages: ['light', 'medium'],
    strategies: ['full', 'manifest'],
  })
  assert.deepEqual(
    config.cells.map((cell) => `${cell.stage}-${cell.strategy}`),
    ['light-full', 'light-manifest', 'medium-full', 'medium-manifest']
  )
})

test('--strategies alone keeps the config stages', () => {
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

test('an unknown strategy on the command line names the known ones', () => {
  assert.throws(
    () => resolveConfig(baseConfig, { strategies: ['cold'] }),
    /no known strategy - known: full, manifest/
  )
})

test('an unseeded config gets a seed and says so', () => {
  const config = resolveConfig({ ...baseConfig, seed: undefined })
  assert.equal(typeof config.seed, 'number')
  assert.equal(config.seedGenerated, true)
})

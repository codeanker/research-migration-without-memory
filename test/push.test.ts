import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deltaIncludes,
  dirtyNodeModules,
  expectedTicks,
  isPushStrategy,
  pushInstalls,
  zipListingTotals,
} from '../shared/push.ts'

test('push strategies', () => {
  assert.equal(isPushStrategy('precopy'), true)
  assert.equal(isPushStrategy('manifest-push'), true)
  assert.equal(isPushStrategy('full'), false)
  assert.equal(isPushStrategy('manifest'), false)
  assert.equal(pushInstalls('manifest-push'), true)
  assert.equal(pushInstalls('precopy'), false)
})

test('delta files', () => {
  assert.deepEqual(deltaIncludes([]), ['state.json', 'process-snapshot.json'])
  assert.deepEqual(deltaIncludes(new Set(['heartbeat.log', 'state.json'])), [
    'heartbeat.log',
    'state.json',
    'process-snapshot.json',
  ])
})

test('zip listing totals', () => {
  const listing = [
    'Archive:  delta.zip',
    '  Length      Date    Time    Name',
    '---------  ---------- -----   ----',
    '        0  2026-10-19 12:33   work/',
    '     4500  2026-10-19 12:33   work/heartbeat.log',
    '       80  2026-10-19 12:33   work/state.json',
    '      150  2026-10-19 12:33   work/process-snapshot.json',
    '---------                     -------',
    '     4730                     4 files',
    '',
  ].join('\n')
  assert.deepEqual(zipListingTotals(listing), { files: 3, bytes: 4730 })
})

test('zip listing without table', () => {
  assert.throws(() => zipListingTotals('Archive:  broken.zip\n'), /unexpected unzip -l output/)
})

test('node_modules guard', () => {
  const dirty = new Set([
    'heartbeat.log',
    'node_modules/a/index.js',
    'state.json',
    'node_modules',
    'node_modules/b/deep/c.js',
    'my_node_modules/x.js',
    'lib/node_modules/y.js',
  ])
  assert.deepEqual(dirtyNodeModules(dirty), ['node_modules/a/index.js', 'node_modules', 'node_modules/b/deep/c.js'])
  assert.deepEqual(dirtyNodeModules(['heartbeat.log', 'state.json']), [])
})

test('expected ticks', () => {
  assert.equal(expectedTicks(0), 0)
  assert.equal(expectedTicks(99.9), 0)
  assert.equal(expectedTicks(100), 1)
  assert.equal(expectedTicks(4321.7), 43)
})

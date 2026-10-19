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

test('precopy and manifest-push are push strategies, only manifest-push installs on the target', () => {
  assert.equal(isPushStrategy('precopy'), true)
  assert.equal(isPushStrategy('manifest-push'), true)
  assert.equal(isPushStrategy('full'), false)
  assert.equal(isPushStrategy('manifest'), false)
  assert.equal(pushInstalls('manifest-push'), true)
  assert.equal(pushInstalls('precopy'), false)
})

test('the delta always carries state.json and process-snapshot.json, without duplicates', () => {
  assert.deepEqual(deltaIncludes([]), ['state.json', 'process-snapshot.json'])
  assert.deepEqual(deltaIncludes(new Set(['heartbeat.log', 'state.json'])), [
    'heartbeat.log',
    'state.json',
    'process-snapshot.json',
  ])
})

test('the zip listing counts files and their uncompressed bytes, not directories', () => {
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

test('a listing without the table is an error, not zero files', () => {
  assert.throws(() => zipListingTotals('Archive:  broken.zip\n'), /unexpected unzip -l output/)
})

test('the guard names every path under node_modules and leaves the others alone', () => {
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

test('expected ticks count whole 100 ms ticks in the window', () => {
  assert.equal(expectedTicks(0), 0)
  assert.equal(expectedTicks(99.9), 0)
  assert.equal(expectedTicks(100), 1)
  assert.equal(expectedTicks(4321.7), 43)
})

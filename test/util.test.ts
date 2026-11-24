import test from 'node:test'
import assert from 'node:assert/strict'
import { median } from '../runner/util.ts'

test('median', () => {
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([1.26, 1.3]), 1.3)
  assert.equal(median([]), null)
})

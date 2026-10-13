import test from 'node:test'
import assert from 'node:assert/strict'
import { MEASUREMENT_STAGES } from '../shared/stages.ts'
import { lockfileForStage, packageJsonForStage, stageNeedsInstall } from '../browser/src/payload.ts'

test('every stage with dependencies ships a lockfile that matches its package.json', () => {
  for (const stage of MEASUREMENT_STAGES) {
    const pkg = JSON.parse(packageJsonForStage(stage))
    const lockfile = lockfileForStage(stage)
    if (!stageNeedsInstall(stage)) {
      assert.equal(lockfile, null, `${stage} has no dependencies but a lockfile`)
      continue
    }
    assert.ok(lockfile, `${stage} has dependencies but no lockfile`)
    const root = JSON.parse(lockfile).packages['']
    assert.equal(root.name, pkg.name, stage)
    assert.equal(root.version, pkg.version, stage)
    assert.deepEqual(root.dependencies, pkg.dependencies, stage)
  }
})

test('the lockfile keeps the trailing newline npm writes', () => {
  for (const stage of MEASUREMENT_STAGES) {
    const lockfile = lockfileForStage(stage)
    if (lockfile !== null) assert.ok(lockfile.endsWith('}\n'), stage)
  }
})

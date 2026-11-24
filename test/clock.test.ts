import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalAdapter } from '../targets/local.ts'
import { ShellTargetAdapter } from '../targets/shell-adapter.ts'
import type { ExecResult, ShellHandle } from '../targets/shell-adapter.ts'
import { sleep } from '../shared/timing.ts'

const AHEAD_MS = 250

class FakeClockAdapter extends LocalAdapter {
  delays = [80, 20, 40, 60, 80]

  override async exec(): Promise<ExecResult> {
    const delay = this.delays.shift() ?? 0
    await sleep(delay / 2)
    const stamp = BigInt(Date.now() + AHEAD_MS) * 1000000n
    await sleep(delay / 2)
    return { exitCode: 0, stdout: `${stamp}\n`, stderr: '' }
  }
}

test('clockOffset', async () => {
  const clock = await ShellTargetAdapter.prototype.clockOffset.call(new FakeClockAdapter(), {
    home: '/',
  } as ShellHandle)
  assert.equal(clock.samples, 5)
  assert.ok(clock.rtt_ms >= 18 && clock.rtt_ms < 40, `rtt ${clock.rtt_ms}`)
  assert.ok(Math.abs(clock.offset_ms - AHEAD_MS) <= 4, `offset ${clock.offset_ms}`)
})

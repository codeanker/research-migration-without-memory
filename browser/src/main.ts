import { runOnce } from './experiment'
import { MEASUREMENT_STAGES, STRATEGIES } from '../../shared/stages.ts'
import type { HandoverApi } from '../../shared/browser-api.ts'

declare global {
  interface Window {
    __handover?: HandoverApi
  }
}

window.__handover = { runOnce }

const logEl = document.getElementById('log') as HTMLPreElement | null
const startBtn = document.getElementById('start') as HTMLButtonElement | null
const stageEl = document.getElementById('stage') as HTMLSelectElement | null
const strategyEl = document.createElement('select')
strategyEl.id = 'strategy'

function fillOptions(select: HTMLSelectElement, values: readonly string[]): void {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      return option
    })
  )
}

fillOptions(strategyEl, STRATEGIES)
if (stageEl) {
  fillOptions(stageEl, MEASUREMENT_STAGES)
  stageEl.after(' Strategy: ', strategyEl)
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  if (logEl) {
    logEl.textContent += line + '\n'
    logEl.scrollTop = logEl.scrollHeight
  }
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value
}

startBtn?.addEventListener('click', () => {
  startBtn.disabled = true
  const stage = inputValue('stage').trim() || MEASUREMENT_STAGES[0]
  const strategy = strategyEl.value
  const runs = Number(inputValue('runs')) || 3
  const runnerUrl = inputValue('runnerUrl').trim()
  const logIntervalMs = Number(inputValue('logInterval')) || 1000
  const stopOffsetRaw = inputValue('stopOffset').trim()
  main(stage, strategy, runs, runnerUrl, logIntervalMs, stopOffsetRaw).finally(() => {
    startBtn.disabled = false
  })
})

async function main(
  stage: string,
  strategy: string,
  runs: number,
  runnerUrl: string,
  logIntervalMs: number,
  stopOffsetRaw: string
): Promise<void> {
  for (let runIndex = 1; runIndex <= runs; runIndex++) {
    const firstMark = runIndex === 1 ? ' [first]' : ''
    const stopOffsetMs =
      stopOffsetRaw === '' ? Math.random() * logIntervalMs : Number(stopOffsetRaw)
    log(
      `Run ${runIndex}/${runs} (stage "${stage}", strategy "${strategy}", log interval ${logIntervalMs}ms, ` +
        `stop offset ${stopOffsetMs.toFixed(0)}ms${stopOffsetRaw === '' ? ', unseeded' : ''})${firstMark}`
    )
    try {
      const outcome = await runOnce({
        stage,
        strategy,
        runIndex,
        runnerUrl,
        logIntervalMs,
        stopOffsetMs,
        firstRun: runIndex === 1,
        firstRunOfCell: runIndex === 1,
        onLog: log,
      })
      log(`Result: ${JSON.stringify(outcome.row)}`)
    } catch (err) {
      log(`ERROR in run ${runIndex}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  log('All runs done. For a reproducible session use: pnpm run experiment')
}

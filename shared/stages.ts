export const MEASUREMENT_STAGES = ['small', 'light', 'medium', 'large'] as const

const CONTROL_STAGES = ['smoke'] as const

const KNOWN_STAGES: readonly string[] = [...MEASUREMENT_STAGES, ...CONTROL_STAGES]

export type MeasurementStage = (typeof MEASUREMENT_STAGES)[number]

export function isMeasurementStage(stage: string): stage is MeasurementStage {
  return (MEASUREMENT_STAGES as readonly string[]).includes(stage)
}

export function assertKnownStage(stage: string): void {
  if (!KNOWN_STAGES.includes(stage)) {
    throw new Error(`unknown stage "${stage}" (known: ${KNOWN_STAGES.join(', ')})`)
  }
}

export function assertMeasurementStage(stage: string): MeasurementStage {
  if (!isMeasurementStage(stage)) {
    throw new Error(
      `unknown stage "${stage}" - known measurement stages: ${MEASUREMENT_STAGES.join(', ')}`
    )
  }
  return stage
}

export const STRATEGIES = ['full', 'manifest', 'precopy', 'manifest-push'] as const

export type Strategy = (typeof STRATEGIES)[number]

export function isStrategy(strategy: string): strategy is Strategy {
  return (STRATEGIES as readonly string[]).includes(strategy)
}

export function assertStrategy(strategy: string): Strategy {
  if (!isStrategy(strategy)) {
    throw new Error(
      `unknown strategy "${strategy}" - known strategies: ${STRATEGIES.join(', ')}`
    )
  }
  return strategy
}

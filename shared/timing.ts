interface Timed<T> {
  value: T
  ms: number
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

export async function timed<T>(fn: () => Promise<T> | T): Promise<Timed<T>> {
  const t0 = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - t0 }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

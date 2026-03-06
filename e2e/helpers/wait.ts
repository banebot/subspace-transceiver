/**
 * Polling utilities for eventually-consistent assertions.
 * P2P systems are async — never assert synchronously after writes.
 */

/**
 * Poll a predicate until it returns true or a timeout elapses.
 * Throws with a descriptive error message if the deadline is missed.
 *
 * @example
 * await pollUntil(
 *   async () => (await getHealth(url)).globalPeers > 0,
 *   30_000,
 *   'agent to connect to at least 1 peer'
 * )
 */
export async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs: number = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown

  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (err) {
      lastErr = err
    }
    await sleep(intervalMs)
  }

  const errMsg = lastErr ? ` Last error: ${lastErr}` : ''
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for: ${description}.${errMsg}`
  )
}

/**
 * Wait for a condition to become false (i.e., something to go away).
 */
export async function pollUntilFalse(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs: number = 500
): Promise<void> {
  return pollUntil(async () => !(await fn()), timeoutMs, description, intervalMs)
}

/**
 * Simple promise-based sleep.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a function up to N times with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 200
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < maxAttempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, i))
      }
    }
  }
  throw lastErr
}

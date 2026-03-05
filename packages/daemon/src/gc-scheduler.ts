/**
 * Periodic TTL garbage collection scheduler for the Subspace Transceiver daemon.
 *
 * Runs runGC() on all active stores at a configurable interval (default: 1 hour).
 * Also runs immediately on startup to prune stale chunks from previous sessions (AC 17).
 */

import { runGC } from '@subspace/core'
import type { IMemoryStore } from '@subspace/core'

/**
 * Start the GC scheduler.
 * Runs once immediately, then on each interval tick.
 *
 * @param stores     Active stores to GC (can be updated externally — pass a live reference)
 * @param intervalMs GC interval in milliseconds (default: 3_600_000 = 1 hour)
 * @returns          Interval handle — call clearInterval() on daemon shutdown
 */
export function startGCScheduler(
  getStores: () => IMemoryStore[],
  intervalMs: number = 3_600_000
): ReturnType<typeof setInterval> {
  const runAll = async () => {
    const stores = getStores()
    if (stores.length === 0) return

    let totalPruned = 0
    for (const store of stores) {
      try {
        const { pruned } = await runGC(store)
        totalPruned += pruned
      } catch (err) {
        console.warn('[subspace] GC error on store:', err)
      }
    }

    if (totalPruned > 0) {
      console.log(`[subspace] GC: pruned ${totalPruned} expired chunk(s) at ${new Date().toISOString()}`)
    }
  }

  // Run immediately on startup (AC 17: prune stale chunks from previous session)
  void runAll()

  return setInterval(() => {
    void runAll()
  }, intervalMs)
}

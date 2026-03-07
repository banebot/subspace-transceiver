/**
 * Periodic TTL garbage collection and epoch rotation scheduler.
 *
 * Each interval tick:
 * 1. Runs TTL GC (tombstones expired chunks within the current epoch)
 * 2. Checks if any LoroEpochManager needs to rotate to a new epoch
 * 3. Drops expired epochs (physically deletes Loro snapshot files)
 *
 * The GC interval (default: 1 hour) handles both TTL enforcement and
 * epoch lifecycle checks. Epoch rotation itself is rare (weekly by default)
 * but the check is cheap (just a computeEpochId comparison).
 *
 * Also runs immediately on startup to prune stale chunks from previous sessions.
 */

import { runGC, type IMemoryStore, type LoroEpochManager } from '@subspace-net/core'

/**
 * Start the GC + epoch rotation scheduler.
 * Runs once immediately, then on each interval tick.
 *
 * @param getStores       Returns the active IMemoryStore list (live reference)
 * @param getEpochManagers Returns the active LoroEpochManager list for epoch lifecycle
 * @param intervalMs      GC interval in milliseconds (default: 3_600_000 = 1 hour)
 * @returns               Interval handle — call clearInterval() on daemon shutdown
 */
export function startGCScheduler(
  getStores: () => IMemoryStore[],
  getEpochManagers: () => LoroEpochManager[],
  // SUBSPACE_GC_INTERVAL_MS env var enables fast GC cycles in tests
  intervalMs: number = parseInt(process.env.SUBSPACE_GC_INTERVAL_MS ?? '3600000', 10)
): ReturnType<typeof setInterval> {
  const runAll = async () => {
    const now = Date.now()
    const stores = getStores()

    // ── 1. TTL GC (tombstone expired chunks within current epochs) ──────────
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
      console.log(`[subspace] GC: pruned ${totalPruned} expired chunk(s) at ${new Date(now).toISOString()}`)
    }

    // ── 2. Epoch rotation check ──────────────────────────────────────────────
    const epochManagers = getEpochManagers()
    let totalRotated = 0
    let totalDropped = 0
    let totalReclaimedBytes = 0

    for (const mgr of epochManagers) {
      try {
        const rotated = await mgr.maybeRotateEpoch(now)
        if (rotated) {
          totalRotated++
          // ── 3. Drop expired epochs (reclaim disk) ──────────────────────────
          const { dropped, reclaimedBytes } = await mgr.dropExpiredEpochs(now)
          totalDropped += dropped.length
          totalReclaimedBytes += reclaimedBytes
        }
      } catch (err) {
        console.warn('[subspace] GC epoch rotation error:', err)
      }
    }

    if (totalRotated > 0) {
      console.log(
        `[subspace] GC: rotated ${totalRotated} epoch(s), dropped ${totalDropped}, ` +
        `reclaimed ${(totalReclaimedBytes / 1024 / 1024).toFixed(1)} MB at ${new Date(now).toISOString()}`
      )
    }
  }

  // Run immediately on startup (AC 17: prune stale chunks from previous session)
  void runAll()

  return setInterval(() => {
    void runAll()
  }, intervalMs)
}

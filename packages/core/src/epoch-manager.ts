/**
 * Epoch utility functions and types.
 *
 * Shared utilities used by LoroEpochManager (loro-epoch-manager.ts)
 * and external callers (GC scheduler, API routes, daemon lifecycle).
 *
 * The active implementation is LoroEpochManager — this file only contains
 * the types and pure utility functions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpochConfig {
  /**
   * Duration of each epoch in milliseconds.
   * Default: 604_800_000 (7 days).
   */
  epochDurationMs: number
  /**
   * Number of past epochs to retain as readable after rotation.
   * Total visibility window = (retainEpochs + 1) × epochDurationMs.
   * Default: 1 (2 weeks total: current + 1 previous).
   */
  retainEpochs: number
  /**
   * Time before epoch end to start migrating permanent chunks (milliseconds).
   * Default: 3_600_000 (1 hour).
   */
  migrationLeadTimeMs: number
}

export const DEFAULT_EPOCH_CONFIG: EpochConfig = {
  epochDurationMs: 604_800_000, // 7 days
  retainEpochs: 1,
  migrationLeadTimeMs: 3_600_000, // 1 hour
}

export interface EpochInfo {
  /** Epoch identifier string (e.g. '2026-W10') */
  id: string
  /** Epoch start timestamp (ms since epoch) */
  startsAt: number
  /** Epoch end timestamp (ms since epoch) */
  endsAt: number
  /** Whether this is the current write-target epoch */
  isCurrent: boolean
  /** Approximate chunk count (from list()) */
  chunkCount: number
}

export interface DropResult {
  dropped: string[]
  reclaimedBytes: number
}

// ---------------------------------------------------------------------------
// Epoch ID computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic epoch identifier for a given timestamp.
 * Epochs are aligned to UTC week boundaries (ISO 8601 week numbers).
 * For sub-week durations, uses floor(timestamp / epochDurationMs) as the ID.
 */
export function computeEpochId(nowMs: number, epochDurationMs: number): string {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000

  if (epochDurationMs === WEEK_MS) {
    // ISO week-based naming for the standard 7-day epoch
    const d = new Date(nowMs)
    const thursday = new Date(d)
    thursday.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
    const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
    return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
  }

  const epochIndex = Math.floor(nowMs / epochDurationMs)
  return `epoch-${epochIndex}`
}

/**
 * Compute the start timestamp (ms) for a given epoch ID.
 */
export function epochStartMs(epochId: string, epochDurationMs: number): number {
  const weekMatch = epochId.match(/^(\d{4})-W(\d{2})$/)
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10)
    const week = parseInt(weekMatch[2], 10)
    const jan4 = new Date(Date.UTC(year, 0, 4))
    const weekStart = new Date(jan4)
    weekStart.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1)
    weekStart.setUTCDate(weekStart.getUTCDate() + (week - 1) * 7)
    return weekStart.getTime()
  }

  const indexMatch = epochId.match(/^epoch-(\d+)$/)
  if (indexMatch) {
    return parseInt(indexMatch[1], 10) * epochDurationMs
  }

  return 0
}

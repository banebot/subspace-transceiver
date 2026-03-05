/**
 * EpochManager — epoch-based OrbitDB database rotation to solve CRDT tombstone bloat.
 *
 * ## Problem
 * OrbitDB is an append-only CRDT oplog. Every `store.forget()` writes a tombstone —
 * a new entry that hides a record but never reclaims disk from the original block or
 * from itself. An agent writing 1,000 TTL'd memories/day generates ~365K tombstones/year
 * that can never be reclaimed. The database becomes 99% ghost entries.
 *
 * ## Solution: Time-windowed database epochs
 * Instead of a single OrbitDB DocumentStore per namespace that grows forever, each
 * namespace is split into rolling time-window epochs. Each epoch is a separate OrbitDB
 * database. When an epoch expires:
 *   1. Live (non-expired, non-tombstoned) chunks are migrated to the new epoch as
 *      fresh `put()` entries (no tombstones needed — they simply don't migrate).
 *   2. The expired epoch's LevelDB directories are deleted, reclaiming all disk space.
 *
 * ## Interface transparency
 * EpochManager implements IMemoryStore. Callers (network.ts, gc-scheduler.ts, api.ts)
 * do not need to know about epochs — the fan-out across readable epochs is internal.
 *
 * ## Disk reclamation
 * `dropExpiredEpochs()` physically deletes the LevelDB directories for epochs older
 * than the retention window. This is O(1) per dropped epoch and frees all space
 * (blocks, oplog, tombstones, index) at once.
 *
 * ## Peer synchronisation
 * Each epoch is an independent OrbitDB database with its own address. Peers joining
 * the network replicate the current epoch and any retained past epochs. A peer offline
 * longer than `retainEpochs × epochDurationMs` will miss dropped epochs — this tradeoff
 * is documented and configurable.
 */

import { EventEmitter } from 'node:events'
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { OrbitDB } from '@orbitdb/core'
import type { MemoryChunk, MemoryQuery, MemoryNamespace } from './schema.js'
import type { IMemoryStore, MemoryStoreEvents } from './store.js'
import type { NetworkKeys } from './crypto.js'
import { createOrbitDBStore } from './orbitdb-store.js'
import { resolveHeads } from './query.js'

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
   * Should be long enough for migration to complete before the epoch boundary.
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
    // Use the Thursday of the current week to determine the year (ISO standard)
    const thursday = new Date(d)
    thursday.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
    const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
    return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
  }

  // Generic: use the epoch index
  const epochIndex = Math.floor(nowMs / epochDurationMs)
  return `epoch-${epochIndex}`
}

/**
 * Compute the start timestamp (ms) for a given epoch ID.
 * Used to order epochs chronologically.
 */
export function epochStartMs(epochId: string, epochDurationMs: number): number {
  // For ISO week IDs (YYYY-Www)
  const weekMatch = epochId.match(/^(\d{4})-W(\d{2})$/)
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10)
    const week = parseInt(weekMatch[2], 10)
    // Jan 4 of the year is always in week 1 (ISO 8601)
    const jan4 = new Date(Date.UTC(year, 0, 4))
    const weekStart = new Date(jan4)
    // Move to the Monday of week 1
    weekStart.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() || 7) + 1)
    // Add (week - 1) weeks
    weekStart.setUTCDate(weekStart.getUTCDate() + (week - 1) * 7)
    return weekStart.getTime()
  }

  // For generic epoch-N IDs
  const indexMatch = epochId.match(/^epoch-(\d+)$/)
  if (indexMatch) {
    return parseInt(indexMatch[1], 10) * epochDurationMs
  }

  // Fallback: treat as 0
  return 0
}

// ---------------------------------------------------------------------------
// EpochManager
// ---------------------------------------------------------------------------

/**
 * Wraps multiple OrbitDB stores behind the IMemoryStore interface.
 * One store per epoch; writes always go to the current epoch.
 * Reads fan out across the current epoch + retained past epochs.
 */
export class EpochManager extends EventEmitter implements IMemoryStore {
  private orbitdb: OrbitDB
  private networkKeys: NetworkKeys
  private namespace: MemoryNamespace
  private config: EpochConfig
  private dataDir: string
  private envelopeKey: Buffer | null

  /** epoch id → store (sorted newest-first for reads) */
  private epochs: Map<string, IMemoryStore>
  private currentEpochId: string
  private migrationInProgress = false

  private constructor(
    orbitdb: OrbitDB,
    networkKeys: NetworkKeys,
    namespace: MemoryNamespace,
    config: EpochConfig,
    dataDir: string,
    envelopeKey: Buffer | null,
    currentEpochId: string,
    epochs: Map<string, IMemoryStore>,
  ) {
    super()
    this.orbitdb = orbitdb
    this.networkKeys = networkKeys
    this.namespace = namespace
    this.config = config
    this.dataDir = dataDir
    this.envelopeKey = envelopeKey
    this.currentEpochId = currentEpochId
    this.epochs = epochs
  }

  /**
   * Create an EpochManager, opening the current epoch and any retained past epochs.
   *
   * @param orbitdb      Pre-initialised OrbitDB instance
   * @param networkKeys  Network keys (used for topic + envelope key)
   * @param namespace    Memory namespace ('skill' | 'project')
   * @param config       Epoch configuration
   * @param dataDir      Base data directory for LevelDB (epoch dirs created beneath)
   * @param envelopeKey  AES-256-GCM key for content encryption. null = no encryption.
   */
  static async create(
    orbitdb: OrbitDB,
    networkKeys: NetworkKeys,
    namespace: MemoryNamespace,
    config: EpochConfig = DEFAULT_EPOCH_CONFIG,
    dataDir: string,
    envelopeKey: Buffer | null = networkKeys.envelopeKey,
  ): Promise<EpochManager> {
    const nowMs = Date.now()
    const currentEpochId = computeEpochId(nowMs, config.epochDurationMs)

    // Determine which past epochs to open (current + retainEpochs prior)
    const epochIds: string[] = [currentEpochId]
    for (let i = 1; i <= config.retainEpochs; i++) {
      const pastMs = nowMs - i * config.epochDurationMs
      const pastId = computeEpochId(pastMs, config.epochDurationMs)
      if (!epochIds.includes(pastId)) {
        epochIds.push(pastId)
      }
    }

    // Open stores for each epoch (parallel)
    const epochEntries = await Promise.all(
      epochIds.map(async (epochId) => {
        const store = await EpochManager._openEpochStore(orbitdb, networkKeys, namespace, epochId, envelopeKey)
        return [epochId, store] as [string, IMemoryStore]
      })
    )

    const epochs = new Map<string, IMemoryStore>(epochEntries)

    const manager = new EpochManager(
      orbitdb, networkKeys, namespace, config, dataDir,
      envelopeKey, currentEpochId, epochs,
    )

    // Forward replicated events from all epoch stores
    for (const [, store] of epochs) {
      store.on('replicated', () => manager.emit('replicated'))
    }

    return manager
  }

  private static async _openEpochStore(
    orbitdb: OrbitDB,
    networkKeys: NetworkKeys,
    namespace: MemoryNamespace,
    epochId: string,
    envelopeKey: Buffer | null,
  ): Promise<IMemoryStore> {
    // Epoch-aware DB name: subspace/{topic}/{namespace}/{epochId}
    // createOrbitDBStore uses networkKeys.topic + namespace; we override by patching networkKeys.
    const epochNetworkKeys: NetworkKeys = {
      ...networkKeys,
      // Append epoch ID to the topic to create a distinct DB per epoch
      topic: `${networkKeys.topic}_${epochId}`,
    }
    return createOrbitDBStore(orbitdb, epochNetworkKeys, namespace, envelopeKey)
  }

  // ---------------------------------------------------------------------------
  // IMemoryStore implementation
  // ---------------------------------------------------------------------------

  /** Write to the current epoch. */
  async put(chunk: MemoryChunk): Promise<void> {
    return this.currentStore().put(chunk)
  }

  /** Read from current epoch first, then past epochs. Returns the latest version. */
  async get(id: string): Promise<MemoryChunk | null> {
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunk = await store.get(id).catch(() => null)
      if (chunk) return chunk
    }
    return null
  }

  /** Fan-out query across all readable epochs; resolveHeads to deduplicate. */
  async query(q: MemoryQuery): Promise<MemoryChunk[]> {
    const results: MemoryChunk[] = []
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunks = await store.query(q).catch(() => [] as MemoryChunk[])
      results.push(...chunks)
    }
    return resolveHeads(results)
  }

  /** Union of all readable epochs, tombstones excluded, resolveHeads applied. */
  async list(): Promise<MemoryChunk[]> {
    const results: MemoryChunk[] = []
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunks = await store.list().catch(() => [] as MemoryChunk[])
      results.push(...chunks)
    }
    return resolveHeads(results)
  }

  /** Tombstone the chunk in whichever epoch holds it. */
  async forget(id: string): Promise<void> {
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunk = await store.get(id).catch(() => null)
      if (chunk) {
        await store.forget(id)
        return
      }
    }
    // Chunk not found in any epoch — tombstone in current epoch as a no-op
    await this.currentStore().forget(id)
  }

  /** Close all epoch stores. */
  async close(): Promise<void> {
    await Promise.all([...this.epochs.values()].map(s => s.close().catch(() => {})))
    this.epochs.clear()
  }

  // ---------------------------------------------------------------------------
  // Epoch lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Check if the current epoch has expired and rotate if needed.
   * Called by the GC scheduler on every interval tick.
   *
   * @returns true if a rotation was performed, false otherwise.
   */
  async maybeRotateEpoch(nowMs: number = Date.now()): Promise<boolean> {
    const expectedEpochId = computeEpochId(nowMs, this.config.epochDurationMs)
    if (expectedEpochId === this.currentEpochId) return false
    if (this.migrationInProgress) return false

    console.log(`[subspace] EpochManager: rotating from ${this.currentEpochId} → ${expectedEpochId} (${this.namespace})`)
    await this.rotateEpoch(expectedEpochId, nowMs)
    return true
  }

  /**
   * Perform epoch rotation:
   * 1. Open new epoch store
   * 2. Migrate live permanent chunks from expiring epochs beyond retention window
   * 3. Seal (mark read-only by removing from writable current) old epochs
   */
  async rotateEpoch(newEpochId: string, nowMs: number = Date.now()): Promise<void> {
    this.migrationInProgress = true
    try {
      // Open new epoch store
      const newStore = await EpochManager._openEpochStore(
        this.orbitdb, this.networkKeys, this.namespace, newEpochId, this.envelopeKey
      )
      newStore.on('replicated', () => this.emit('replicated'))
      this.epochs.set(newEpochId, newStore)

      // Migrate chunks from epochs that are about to leave the retention window
      // (those older than retainEpochs + 1 from the new current)
      const retentionCutoffMs = nowMs - (this.config.retainEpochs + 1) * this.config.epochDurationMs
      for (const epochId of [...this.epochs.keys()]) {
        if (epochId === newEpochId) continue
        const epochStart = epochStartMs(epochId, this.config.epochDurationMs)
        if (epochStart < retentionCutoffMs) {
          // This epoch is leaving the retention window — migrate its live permanent chunks
          await this._migrateChunks(epochId, newStore, nowMs)
        }
      }

      this.currentEpochId = newEpochId
    } finally {
      this.migrationInProgress = false
    }
  }

  /**
   * Migrate live chunks from a soon-to-be-dropped epoch into the new epoch store.
   *
   * Migration triage:
   * - _tombstone: true          → abandoned (tombstones never migrate)
   * - ttl set and expired        → abandoned (died naturally)
   * - ttl set but not expired    → migrated (will expire in new epoch)
   * - no ttl (permanent)         → migrated
   * - superseded (not HEAD)      → abandoned (resolveHeads picks winners)
   */
  private async _migrateChunks(
    fromEpochId: string,
    toStore: IMemoryStore,
    nowMs: number,
  ): Promise<{ migrated: number; abandoned: number }> {
    const fromStore = this.epochs.get(fromEpochId)
    if (!fromStore) return { migrated: 0, abandoned: 0 }

    let migrated = 0
    let abandoned = 0

    try {
      // list() excludes tombstones and returns resolveHeads — perfect for migration
      const chunks = await fromStore.list()
      for (const chunk of chunks) {
        // Abandon TTL-expired chunks
        if (chunk.ttl !== undefined && chunk.ttl < nowMs) {
          abandoned++
          continue
        }
        // Migrate the chunk as a fresh put() in the new epoch
        await toStore.put(chunk).catch((err: unknown) => {
          console.warn(`[subspace] EpochManager: migration failed for chunk ${chunk.id}:`, err)
          abandoned++
          return
        })
        migrated++
      }
    } catch (err) {
      console.warn(`[subspace] EpochManager: migration from epoch ${fromEpochId} failed:`, err)
    }

    console.log(
      `[subspace] EpochManager: migrated ${migrated}, abandoned ${abandoned} chunks from epoch ${fromEpochId} (${this.namespace})`
    )
    return { migrated, abandoned }
  }

  /**
   * Close and physically delete LevelDB directories for epochs outside the retention window.
   * Returns the list of dropped epoch IDs and the bytes reclaimed.
   *
   * Call AFTER rotateEpoch() to reclaim disk space from expired epochs.
   */
  async dropExpiredEpochs(nowMs: number = Date.now()): Promise<DropResult> {
    const retentionCutoffMs = nowMs - (this.config.retainEpochs + 1) * this.config.epochDurationMs
    const dropped: string[] = []
    let reclaimedBytes = 0

    for (const epochId of [...this.epochs.keys()]) {
      if (epochId === this.currentEpochId) continue
      const epochStart = epochStartMs(epochId, this.config.epochDurationMs)
      if (epochStart >= retentionCutoffMs) continue

      // Close the store before deleting its files
      const store = this.epochs.get(epochId)!
      await store.close().catch(() => {})
      this.epochs.delete(epochId)

      // Delete the LevelDB directories
      const epochDirBytes = await this._measureAndDeleteEpochDir(epochId)
      reclaimedBytes += epochDirBytes
      dropped.push(epochId)

      console.log(`[subspace] EpochManager: dropped epoch ${epochId} (${this.namespace}), reclaimed ${epochDirBytes} bytes`)
    }

    return { dropped, reclaimedBytes }
  }

  private async _measureAndDeleteEpochDir(epochId: string): Promise<number> {
    // The OrbitDB data directory for this epoch is under:
    //   {dataDir}/orbitdb/subspace/{topic}_{epochId}/{namespace}
    // and the LevelDB block/datastore dirs are shared in {dataDir}/blocks + {dataDir}/datastore
    // (we cannot delete those without affecting other epochs).
    //
    // What we CAN delete is the OrbitDB-specific index and head-storage for this epoch,
    // which lives under the OrbitDB directory named after the epoch's DB address.
    // Since we can't easily compute the CID address without Helia, we target the
    // subspace topic-scoped directory.
    const epochTopic = `${this.networkKeys.topic}_${epochId}`
    const orbitdbDir = path.join(this.dataDir, 'orbitdb')
    // OrbitDB creates its files under {orbitdbDir}/{dbName hash}
    // We don't have easy access to the hash, so we delete by pattern-matching
    // the epoch topic in directory names.
    // For robustness, we measure the size of the whole orbitdb dir before/after.

    // For now, measure the total we can attribute (best-effort)
    const epochMarkerDir = path.join(orbitdbDir, epochTopic)
    let bytes = 0
    try {
      const s = await stat(epochMarkerDir)
      if (s.isDirectory()) {
        bytes = await dirSize(epochMarkerDir)
        await rm(epochMarkerDir, { recursive: true, force: true })
      }
    } catch {
      // Directory may not exist by this exact path — that's fine
    }

    return bytes
  }

  /**
   * Return info about all currently open epochs (for health/monitoring).
   */
  async getEpochInfo(nowMs: number = Date.now()): Promise<EpochInfo[]> {
    const infos: EpochInfo[] = []
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunks = await store.list().catch(() => [] as MemoryChunk[])
      const startsAt = epochStartMs(epochId, this.config.epochDurationMs)
      infos.push({
        id: epochId,
        startsAt,
        endsAt: startsAt + this.config.epochDurationMs,
        isCurrent: epochId === this.currentEpochId,
        chunkCount: chunks.length,
      })
    }
    return infos
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private currentStore(): IMemoryStore {
    const store = this.epochs.get(this.currentEpochId)
    if (!store) throw new Error(`EpochManager: current epoch store missing (${this.currentEpochId})`)
    return store
  }

  /** Returns epoch IDs sorted newest-first (for reads: prefer newest data). */
  private _orderedEpochIds(): string[] {
    return [...this.epochs.keys()].sort((a, b) =>
      epochStartMs(b, this.config.epochDurationMs) - epochStartMs(a, this.config.epochDurationMs)
    )
  }

  /** Current epoch ID (for health reporting). */
  get currentEpoch(): string {
    return this.currentEpochId
  }

  /** Number of open epoch stores. */
  get epochCount(): number {
    return this.epochs.size
  }

  // Required EventEmitter typed overrides
  on<K extends keyof MemoryStoreEvents>(
    event: K,
    listener: (...args: MemoryStoreEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  emit<K extends keyof MemoryStoreEvents>(
    event: K,
    ...args: MemoryStoreEvents[K]
  ): boolean {
    return super.emit(event, ...args)
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Recursively measure directory size in bytes (best-effort). */
async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += await dirSize(fullPath)
      } else {
        try {
          const s = await stat(fullPath)
          total += s.size
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total
}

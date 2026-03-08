/**
 * LoroEpochManager — epoch-based Loro snapshot rotation.
 *
 * Loro CRDT-based epoch manager:
 * - Each epoch is a separate LoroMemoryStore backed by a binary snapshot file.
 * - Epoch rotation migrates live chunks to a new store, then drops old snapshot files.
 * - No LevelDB, no IPFS — just Loro CRDT snapshots on disk.
 *
 * ## Design
 * Epoch IDs follow the same computeEpochId() scheme as EpochManager.
 * Each epoch's snapshot is stored at:
 *   {dataDir}/epochs/{namespace}/{epochId}.bin
 *
 * ## Retention
 * After rotation, epochs older than `retainEpochs × epochDurationMs` are closed
 * and their snapshot files are deleted, reclaiming disk space.
 *
 * ## Delta sync
 * exportDelta() and importDelta() operate on the current epoch store.
 * Callers wanting full history should call exportDelta() on each epoch separately.
 */

import { EventEmitter } from 'node:events'
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { LoroMemoryStore, createPersistentLoroStore } from './loro-store.js'
import { computeEpochId, epochStartMs, type EpochConfig, DEFAULT_EPOCH_CONFIG, type EpochInfo, type DropResult } from './epoch-manager.js'
import { resolveHeads } from './query.js'
import type { MemoryChunk, MemoryQuery, MemoryNamespace } from './schema.js'
import type { IMemoryStore, MemoryStoreEvents } from './store.js'

// ---------------------------------------------------------------------------
// LoroEpochManager
// ---------------------------------------------------------------------------

export class LoroEpochManager extends EventEmitter implements IMemoryStore {
  private namespace: MemoryNamespace
  private config: EpochConfig
  private dataDir: string

  /** epoch id → LoroMemoryStore */
  private epochs: Map<string, LoroMemoryStore>
  private currentEpochId: string
  private migrationInProgress = false

  private constructor(
    namespace: MemoryNamespace,
    config: EpochConfig,
    dataDir: string,
    currentEpochId: string,
    epochs: Map<string, LoroMemoryStore>,
  ) {
    super()
    this.namespace = namespace
    this.config = config
    this.dataDir = dataDir
    this.currentEpochId = currentEpochId
    this.epochs = epochs
  }

  /**
   * Create a LoroEpochManager, opening the current epoch and any retained past epochs.
   *
   * @param namespace  Memory namespace ('skill' | 'project')
   * @param config     Epoch configuration
   * @param dataDir    Base data directory (epoch snapshot files created beneath)
   */
  static async create(
    namespace: MemoryNamespace,
    config: EpochConfig = DEFAULT_EPOCH_CONFIG,
    dataDir: string,
  ): Promise<LoroEpochManager> {
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
        const store = await LoroEpochManager._openEpochStore(dataDir, namespace, epochId)
        return [epochId, store] as [string, LoroMemoryStore]
      })
    )

    const epochs = new Map<string, LoroMemoryStore>(epochEntries)
    const manager = new LoroEpochManager(namespace, config, dataDir, currentEpochId, epochs)

    // Forward replicated events from all epoch stores
    for (const [, store] of epochs) {
      store.on('replicated', () => manager.emit('replicated'))
    }

    return manager
  }

  private static async _openEpochStore(
    dataDir: string,
    namespace: MemoryNamespace,
    epochId: string,
  ): Promise<LoroMemoryStore> {
    const snapshotPath = path.join(dataDir, 'epochs', namespace, `${epochId}.bin`)
    return createPersistentLoroStore(snapshotPath)
  }

  // ---------------------------------------------------------------------------
  // IMemoryStore implementation
  // ---------------------------------------------------------------------------

  async put(chunk: MemoryChunk): Promise<void> {
    await this.currentStore().put(chunk)
    this.emit('changed')
  }

  async get(id: string): Promise<MemoryChunk | null> {
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunk = await store.get(id).catch(() => null)
      if (chunk) return chunk
    }
    return null
  }

  async query(q: MemoryQuery): Promise<MemoryChunk[]> {
    const results: MemoryChunk[] = []
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunks = await store.query(q).catch(() => [] as MemoryChunk[])
      results.push(...chunks)
    }
    return resolveHeads(results)
  }

  async list(): Promise<MemoryChunk[]> {
    const results: MemoryChunk[] = []
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunks = await store.list().catch(() => [] as MemoryChunk[])
      results.push(...chunks)
    }
    return resolveHeads(results)
  }

  async forget(id: string): Promise<void> {
    for (const epochId of this._orderedEpochIds()) {
      const store = this.epochs.get(epochId)!
      const chunk = await store.get(id).catch(() => null)
      if (chunk) {
        await store.forget(id)
        this.emit('changed')
        return
      }
    }
    // Not found in any epoch — tombstone in current epoch as a no-op
    await this.currentStore().forget(id)
    this.emit('changed')
  }

  async close(): Promise<void> {
    await Promise.all([...this.epochs.values()].map(s => s.close().catch(() => {})))
    this.epochs.clear()
  }

  // ---------------------------------------------------------------------------
  // Delta sync API (pass-through to current epoch)
  // ---------------------------------------------------------------------------

  exportDelta(since?: Uint8Array): Uint8Array {
    return this.currentStore().exportDelta(since)
  }

  getVersionSnapshot(): Uint8Array {
    return this.currentStore().getVersionSnapshot()
  }

  importDelta(bytes: Uint8Array): void {
    this.currentStore().importDelta(bytes)
  }

  versionVector(): Uint8Array {
    return this.currentStore().versionVector()
  }

  // ---------------------------------------------------------------------------
  // Epoch lifecycle
  // ---------------------------------------------------------------------------

  async maybeRotateEpoch(nowMs: number = Date.now()): Promise<boolean> {
    const expectedEpochId = computeEpochId(nowMs, this.config.epochDurationMs)
    if (expectedEpochId === this.currentEpochId) return false
    if (this.migrationInProgress) return false

    console.log(`[subspace] LoroEpochManager: rotating ${this.currentEpochId} → ${expectedEpochId} (${this.namespace})`)
    await this.rotateEpoch(expectedEpochId, nowMs)
    return true
  }

  async rotateEpoch(newEpochId: string, nowMs: number = Date.now()): Promise<void> {
    this.migrationInProgress = true
    try {
      const newStore = await LoroEpochManager._openEpochStore(this.dataDir, this.namespace, newEpochId)
      newStore.on('replicated', () => this.emit('replicated'))
      this.epochs.set(newEpochId, newStore)

      // Migrate chunks from epochs about to leave the retention window
      const retentionCutoffMs = nowMs - (this.config.retainEpochs + 1) * this.config.epochDurationMs
      for (const epochId of [...this.epochs.keys()]) {
        if (epochId === newEpochId) continue
        const epochStart = epochStartMs(epochId, this.config.epochDurationMs)
        if (epochStart < retentionCutoffMs) {
          await this._migrateChunks(epochId, newStore, nowMs)
        }
      }

      this.currentEpochId = newEpochId
    } finally {
      this.migrationInProgress = false
    }
  }

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
      const chunks = await fromStore.list()
      for (const chunk of chunks) {
        if (chunk.ttl !== undefined && chunk.ttl < nowMs) {
          abandoned++
          continue
        }
        await toStore.put(chunk).catch(() => { abandoned++ })
        migrated++
      }
    } catch (err) {
      console.warn(`[subspace] LoroEpochManager: migration from epoch ${fromEpochId} failed:`, err)
    }

    console.log(
      `[subspace] LoroEpochManager: migrated ${migrated}, abandoned ${abandoned} from epoch ${fromEpochId} (${this.namespace})`
    )
    return { migrated, abandoned }
  }

  async dropExpiredEpochs(nowMs: number = Date.now()): Promise<DropResult> {
    const retentionCutoffMs = nowMs - (this.config.retainEpochs + 1) * this.config.epochDurationMs
    const dropped: string[] = []
    let reclaimedBytes = 0

    for (const epochId of [...this.epochs.keys()]) {
      if (epochId === this.currentEpochId) continue
      const epochStart = epochStartMs(epochId, this.config.epochDurationMs)
      if (epochStart >= retentionCutoffMs) continue

      const store = this.epochs.get(epochId)!
      await store.close().catch(() => {})
      this.epochs.delete(epochId)

      // Delete the snapshot file
      const snapshotPath = path.join(this.dataDir, 'epochs', this.namespace, `${epochId}.bin`)
      try {
        const s = await stat(snapshotPath)
        reclaimedBytes += s.size
        await rm(snapshotPath, { force: true })
      } catch {
        // File may not exist — that's fine
      }

      dropped.push(epochId)
      console.log(`[subspace] LoroEpochManager: dropped epoch ${epochId} (${this.namespace})`)
    }

    return { dropped, reclaimedBytes }
  }

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

  private currentStore(): LoroMemoryStore {
    const store = this.epochs.get(this.currentEpochId)
    if (!store) throw new Error(`LoroEpochManager: current epoch store missing (${this.currentEpochId})`)
    return store
  }

  private _orderedEpochIds(): string[] {
    return [...this.epochs.keys()].sort((a, b) =>
      epochStartMs(b, this.config.epochDurationMs) - epochStartMs(a, this.config.epochDurationMs)
    )
  }

  get currentEpoch(): string {
    return this.currentEpochId
  }

  get epochCount(): number {
    return this.epochs.size
  }

  // Typed EventEmitter overrides
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

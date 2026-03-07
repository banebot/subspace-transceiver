/**
 * Loro CRDT implementation of IMemoryStore.
 *
 * Uses:
 * - `loro-crdt` (WASM) as the CRDT + delta-sync layer
 * - A LoroDoc with a single root LoroMap named "chunks" for key-value storage
 * - Snapshot persistence to a binary file on disk
 * - Delta-state export/import for efficient P2P replication
 *
 * ## Storage model
 * Each MemoryChunk is stored as a JSON string value in a LoroMap<string, string>.
 * Key = chunk.id (UUID). Value = JSON.stringify(chunk).
 *
 * Tombstones are stored as regular chunks with _tombstone: true. On read,
 * tombstoned chunks are excluded. This ensures deletions propagate to peers
 * via delta sync (tombstones never disappear until the epoch is dropped).
 *
 * ## Replication
 * - `exportDelta(since?)` — export a Uint8Array of updates since a version vector.
 *   Pass undefined to export a full snapshot.
 * - `importDelta(bytes)` — apply a delta from a remote peer. Emits 'replicated'.
 *
 * ## Persistence
 * - `save(path)` — write a full snapshot to disk
 * - `load(path)` — create a LoroMemoryStore from a snapshot file
 */

import { EventEmitter } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import type { MemoryChunk, MemoryQuery } from './schema.js'
import { applyQuery } from './query.js'
import type { IMemoryStore, MemoryStoreEvents } from './store.js'
import { StoreError, ErrorCode } from './errors.js'

// ---------------------------------------------------------------------------
// LoroMemoryStore
// ---------------------------------------------------------------------------

/**
 * Loro CRDT-backed implementation of IMemoryStore.
 *
 * All state lives in a single LoroDoc. The root LoroMap "chunks" maps
 * chunk IDs → JSON-serialized MemoryChunk objects.
 *
 * Thread safety: LoroDoc is NOT thread-safe. All operations are synchronous
 * and Node.js's single-threaded event loop provides implicit serialisation.
 */
export class LoroMemoryStore extends EventEmitter implements IMemoryStore {
  private doc: LoroDoc
  /** Path to the snapshot file for persistence. Null = in-memory only. */
  private snapshotPath: string | null
  /** Whether a save is already scheduled (prevents duplicate timers). */
  private savePending: boolean = false

  private constructor(doc: LoroDoc, snapshotPath: string | null) {
    super()
    this.doc = doc
    this.snapshotPath = snapshotPath
  }

  // ---------------------------------------------------------------------------
  // Factory methods
  // ---------------------------------------------------------------------------

  /**
   * Create an in-memory store with no persistence.
   * Suitable for unit tests and ephemeral sessions.
   */
  static createInMemory(): LoroMemoryStore {
    const doc = new LoroDoc()
    // Ensure the root map container exists
    doc.getMap('chunks')
    return new LoroMemoryStore(doc, null)
  }

  /**
   * Create (or load) a persistent store backed by a snapshot file.
   *
   * If the file exists, the snapshot is loaded. Otherwise a fresh document
   * is initialised and the file will be created on the first `save()`.
   *
   * @param snapshotPath  Path to the binary snapshot file (e.g. `~/.subspace/networks/<id>/store-skill.bin`)
   */
  static async createPersistent(snapshotPath: string): Promise<LoroMemoryStore> {
    await mkdir(dirname(snapshotPath), { recursive: true })
    const doc = new LoroDoc()

    if (existsSync(snapshotPath)) {
      try {
        const bytes = await readFile(snapshotPath)
        if (bytes.length > 0) {
          doc.import(bytes)
        }
      } catch (err) {
        // Corrupted snapshot — start fresh
        console.warn(
          `[loro-store] Snapshot at ${snapshotPath} failed to load (${String(err)}). Starting fresh.`
        )
      }
    }

    // Ensure the root map container exists
    doc.getMap('chunks')

    return new LoroMemoryStore(doc, snapshotPath)
  }

  // ---------------------------------------------------------------------------
  // IMemoryStore implementation
  // ---------------------------------------------------------------------------

  async put(chunk: MemoryChunk): Promise<void> {
    try {
      const map = this.doc.getMap('chunks')
      const serialized = JSON.stringify(chunk)
      map.set(chunk.id, serialized)
      this.doc.commit()
      this.scheduleSave()
    } catch (err) {
      throw new StoreError(
        `Failed to write chunk ${chunk.id}: ${String(err)}`,
        ErrorCode.STORE_WRITE_FAILED,
        err
      )
    }
  }

  async get(id: string): Promise<MemoryChunk | null> {
    try {
      const map = this.doc.getMap('chunks')
      const raw = map.get(id)
      if (raw == null) return null
      const chunk = JSON.parse(raw as string) as MemoryChunk
      // Exclude tombstones from external get()
      if (chunk._tombstone) return null
      return chunk
    } catch (err) {
      throw new StoreError(
        `Failed to read chunk ${id}: ${String(err)}`,
        ErrorCode.STORE_READ_FAILED,
        err
      )
    }
  }

  async query(q: MemoryQuery): Promise<MemoryChunk[]> {
    try {
      const chunks = this._getAllChunks()
      // Filter out tombstones before applying the user query
      const live = chunks.filter(c => !c._tombstone)
      return applyQuery(live, q)
    } catch (err) {
      throw new StoreError(
        `Query failed: ${String(err)}`,
        ErrorCode.STORE_READ_FAILED,
        err
      )
    }
  }

  async list(): Promise<MemoryChunk[]> {
    try {
      // list() is used by GC and network handlers — exclude tombstones
      return this._getAllChunks().filter(c => !c._tombstone)
    } catch (err) {
      throw new StoreError(
        `List failed: ${String(err)}`,
        ErrorCode.STORE_READ_FAILED,
        err
      )
    }
  }

  async forget(id: string): Promise<void> {
    try {
      const map = this.doc.getMap('chunks')
      // Store a tombstone — propagates to peers via delta sync
      const tombstone: MemoryChunk = {
        id,
        _tombstone: true,
        type: 'project' as const,
        namespace: 'project' as const,
        topic: ['_tombstone'],
        content: '',
        source: { agentId: '_system', peerId: '_system', timestamp: Date.now() },
        confidence: 0,
        network: '',
        version: 0,
      }
      map.set(id, JSON.stringify(tombstone))
      this.doc.commit()
      this.scheduleSave()
    } catch (err) {
      throw new StoreError(
        `Failed to tombstone chunk ${id}: ${String(err)}`,
        ErrorCode.STORE_WRITE_FAILED,
        err
      )
    }
  }

  async close(): Promise<void> {
    // Flush any pending save
    if (this.savePending && this.snapshotPath) {
      this.savePending = false
      await this._saveSnapshot().catch(() => {})
    }
    // Free the WASM memory
    this.doc.free()
  }

  // ---------------------------------------------------------------------------
  // Delta-state sync API (called by network/replication layer)
  // ---------------------------------------------------------------------------

  /**
   * Export a binary delta of all changes since `since`.
   *
   * @param since  A version vector (opaque Uint8Array from a previous export).
   *               Pass undefined to export a full snapshot.
   * @returns  Uint8Array — the delta bytes to send to a remote peer.
   */
  exportDelta(since?: Uint8Array): Uint8Array {
    if (since != null) {
      // Parse the version vector and export only new updates
      try {
        const vv = this.doc.version()
        // Build a version vector from the `since` bytes.
        // loro-crdt v1.x represents version vectors as opaque Uint8Arrays
        // returned from `doc.version()`. We import the `since` bytes to get
        // the remote version vector for the `from` field.
        const remoteDoc = new LoroDoc()
        remoteDoc.import(since)
        const remoteVv = remoteDoc.version()
        remoteDoc.free()
        return this.doc.export({ mode: 'update', from: remoteVv })
      } catch {
        // Fallback to full snapshot on version vector parse failure
      }
    }
    return this.doc.export({ mode: 'snapshot' })
  }

  /**
   * Import a binary delta from a remote peer.
   * Emits 'replicated' after applying the delta.
   *
   * @param bytes  Delta bytes from a remote peer (from exportDelta).
   */
  importDelta(bytes: Uint8Array): void {
    try {
      this.doc.import(bytes)
      this.scheduleSave()
      this.emit('replicated')
    } catch (err) {
      this.emit('error', new StoreError(
        `Failed to import delta: ${String(err)}`,
        ErrorCode.STORE_READ_FAILED,
        err
      ))
    }
  }

  /**
   * Return the current version vector as opaque bytes.
   * Send this to a remote peer so they can compute the minimal delta.
   */
  versionVector(): Uint8Array {
    return this.doc.export({ mode: 'snapshot' })
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  /** Save a full snapshot to disk immediately. */
  async save(): Promise<void> {
    await this._saveSnapshot()
  }

  private async _saveSnapshot(): Promise<void> {
    if (!this.snapshotPath) return
    const bytes = this.doc.export({ mode: 'snapshot' })
    await writeFile(this.snapshotPath, bytes)
  }

  /** Schedule a deferred save (debounced to avoid O(write) I/O). */
  private scheduleSave(): void {
    if (this.savePending || !this.snapshotPath) return
    this.savePending = true
    setImmediate(() => {
      this.savePending = false
      this._saveSnapshot().catch((err) => {
        console.warn('[loro-store] Background save failed:', err)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Return all chunks (including tombstones) as MemoryChunk objects. */
  private _getAllChunks(): MemoryChunk[] {
    const map = this.doc.getMap('chunks')
    const entries = map.entries()
    const chunks: MemoryChunk[] = []
    for (const [, raw] of entries) {
      try {
        const chunk = JSON.parse(raw as string) as MemoryChunk
        chunks.push(chunk)
      } catch {
        // Skip malformed entries
      }
    }
    return chunks
  }

  // ---------------------------------------------------------------------------
  // Typed EventEmitter overrides
  // ---------------------------------------------------------------------------

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
// Factory functions (public API)
// ---------------------------------------------------------------------------

/**
 * Create an in-memory Loro store (no persistence). Suitable for tests.
 */
export function createLoroStore(): LoroMemoryStore {
  return LoroMemoryStore.createInMemory()
}

/**
 * Create or load a persistent Loro store from a snapshot file.
 *
 * @param snapshotPath  Path to the binary snapshot file.
 *                      Created on first use; loaded on subsequent uses.
 */
export async function createPersistentLoroStore(snapshotPath: string): Promise<LoroMemoryStore> {
  return LoroMemoryStore.createPersistent(snapshotPath)
}

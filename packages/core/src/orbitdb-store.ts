/**
 * OrbitDB v2 implementation of IMemoryStore.
 *
 * Uses:
 * - Helia (libp2p-backed IPFS) as the block layer
 * - OrbitDB v2 DocumentStore as the CRDT layer
 * - LevelDB (blockstore-level + datastore-level) for persistent local storage
 *
 * Tombstone semantics: forget() stores a tombstone document with _tombstone: true.
 * Tombstones propagate to all peers via OrbitDB CRDT replication, ensuring
 * deletions are consistent across the network without physical removal.
 *
 * Replication events: when OrbitDB merges remote peer data, this store
 * emits the 'replicated' event so callers can react to new data.
 */

import { EventEmitter } from 'node:events'
import { createOrbitDB, type OrbitDB, type DocumentsDatabase } from '@orbitdb/core'
import type { Helia } from 'helia'
import type { Libp2p } from 'libp2p'
import type { MemoryChunk, MemoryQuery, MemoryNamespace } from './schema.js'
import { applyQuery } from './query.js'
import type { IMemoryStore, MemoryStoreEvents } from './store.js'
import type { NetworkKeys } from './crypto.js'
import { StoreError, ErrorCode } from './errors.js'

// Internal document shape stored in OrbitDB (uses _id as OrbitDB's primary key).
// Index signature required for compatibility with @orbitdb/core's Record<string,unknown> API.
type OrbitDoc = MemoryChunk & { _id: string; [key: string]: unknown }

export class OrbitDBMemoryStore extends EventEmitter implements IMemoryStore {
  private db: DocumentsDatabase

  private constructor(db: DocumentsDatabase) {
    super()
    this.db = db

    // Forward OrbitDB replication events as 'replicated'
    // @ts-ignore — OrbitDB v2 event types may not be fully typed
    this.db.events.on('update', () => {
      this.emit('replicated')
    })
  }

  /**
   * Create a store backed by an already-initialised OrbitDB instance.
   * Helia and the libp2p node are owned by the caller (NetworkSession);
   * this store only manages the OrbitDB database handle.
   */
  static async create(
    orbitdb: OrbitDB,
    networkKeys: NetworkKeys,
    namespace: MemoryNamespace,
  ): Promise<OrbitDBMemoryStore> {
    // DB name includes topic (derived from PSK) + namespace for network isolation
    const dbName = `subspace/${networkKeys.topic}/${namespace}`
    const db = await orbitdb.open(dbName, { type: 'documents' }) as DocumentsDatabase

    return new OrbitDBMemoryStore(db)
  }

  async put(chunk: MemoryChunk): Promise<void> {
    try {
      // JSON round-trip removes `undefined` fields — IPLD cannot encode undefined.
      const doc: OrbitDoc = JSON.parse(JSON.stringify({ ...chunk, _id: chunk.id }))
      await this.db.put(doc)
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
      const results = await this.db.query((doc: Record<string, unknown>) => (doc as OrbitDoc)._id === id)
      if (results.length === 0) return null
      const doc = results[0] as unknown as OrbitDoc
      // Exclude tombstones from external get()
      if (doc._tombstone) return null
      return doc as unknown as MemoryChunk
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
      const all = await this.db.query((_doc: Record<string, unknown>) => true) as unknown as OrbitDoc[]
      // Filter out tombstones before applying the user query
      const chunks = all.filter(d => !d._tombstone).map(d => d as unknown as MemoryChunk)
      return applyQuery(chunks, q)
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
      const all = await this.db.query((_doc: Record<string, unknown>) => true) as unknown as OrbitDoc[]
      // Filter out tombstones — callers should never see soft-deleted chunks
      return all.filter(d => !d._tombstone).map(d => d as unknown as MemoryChunk)
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
      // Store a tombstone doc — propagates to peers via CRDT replication
      const tombstone: OrbitDoc = {
        _id: id,
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
      await this.db.put(JSON.parse(JSON.stringify(tombstone)))
    } catch (err) {
      throw new StoreError(
        `Failed to tombstone chunk ${id}: ${String(err)}`,
        ErrorCode.STORE_WRITE_FAILED,
        err
      )
    }
  }

  async close(): Promise<void> {
    await this.db.close()
    // Note: Helia is owned by NetworkSession and closed there, not here.
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

/**
 * Closeable resources returned alongside Helia/OrbitDB so the caller can
 * properly shut down Level databases that Helia's stop() does NOT close.
 *
 * WHY: Helia v6 uses `@libp2p/interface`'s `stop()`, which requires objects
 * to implement `start()`/`stop()`.  `LevelBlockstore` and `LevelDatastore`
 * only expose `open()`/`close()`, so Helia's `stop()` silently skips them.
 * The Level file locks are never released, and on restart `new Level(samePath)`
 * fails with "Database failed to open".
 */
export interface OrbitDBContext {
  helia: Helia
  orbitdb: OrbitDB
  /**
   * Close raw Level databases that Helia.stop() does not reach.
   * Call AFTER helia.stop() to release file locks.
   */
  closeLevelStores: () => Promise<void>
}

/**
 * Create a shared Helia + OrbitDB context for a network.
 * Returns both so the caller can stop Helia when leaving the network.
 */
export async function createOrbitDBContext(
  node: Libp2p,
  dataDir: string,
  /** Deterministic network identifier — passed as OrbitDB identity `id` so the
   *  same network always gets the same signing identity across restarts. */
  networkId: string,
): Promise<OrbitDBContext> {
  const { createHelia } = await import('helia')
  const { LevelBlockstore } = await import('blockstore-level')
  const { LevelDatastore } = await import('datastore-level')
  const path = await import('node:path')

  const blockstore = new LevelBlockstore(path.join(dataDir, 'blocks'))
  const datastore = new LevelDatastore(path.join(dataDir, 'datastore'))
  // LevelDatastore must be explicitly opened before passing to Helia.
  // Without this, Helia's assertDatastoreVersionIsCurrent() races with
  // Level's deferred-open queue, causing "Database is not open" on restart.
  await datastore.open()

  const helia = await createHelia({ libp2p: node, blockstore, datastore })

  // ── Blockstore compatibility shim ──
  // Helia v6 / blockstore-level v3 changed `Blockstore.get()` to return
  // `AsyncIterable<Uint8Array>` (async generator).  OrbitDB v3's
  // IPFSBlockStorage does `await ipfs.blockstore.get(cid)`, which awaits
  // the generator object itself (always truthy, never actual bytes).
  //
  // On first run this is masked because OrbitDB's ComposedStorage serves
  // entries from its in-memory LRU cache.  After a restart the LRU is
  // empty and the code falls through to IPFSBlockStorage → broken reads.
  //
  // Fix: wrap helia.blockstore.get() to consume the async iterable and
  // return the concatenated bytes as a Promise — matching the interface
  // OrbitDB expects.
  const originalGet = helia.blockstore.get.bind(helia.blockstore)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(helia.blockstore as any).get =
    async function (cid: any, options?: any) {
      const chunks: Uint8Array[] = []
      for await (const chunk of originalGet(cid, options)) {
        chunks.push(chunk as Uint8Array)
      }
      if (chunks.length === 0) return undefined
      if (chunks.length === 1) return chunks[0]
      // Multiple chunks: concatenate (unlikely for OrbitDB entries, but safe)
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const result = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        result.set(c, offset)
        offset += c.length
      }
      return result
    }

  const orbitdb: OrbitDB = await createOrbitDB({
    ipfs: helia,
    // A stable `id` ensures the same identity (and thus database address) is used
    // on every restart for the same network. Without this, OrbitDB calls createId()
    // which generates a random UUID → different signing key → different DB address.
    id: networkId,
    directory: path.join(dataDir, 'orbitdb'),
  })

  return {
    helia,
    orbitdb,
    closeLevelStores: async () => {
      await blockstore.close().catch(() => {})
      await datastore.close().catch(() => {})
    },
  }
}

/**
 * Factory function — creates and returns an IMemoryStore backed by OrbitDB v2.
 * Requires a pre-initialised OrbitDB instance (use createOrbitDBContext).
 */
export async function createOrbitDBStore(
  orbitdb: OrbitDB,
  networkKeys: NetworkKeys,
  namespace: MemoryNamespace,
): Promise<IMemoryStore> {
  return OrbitDBMemoryStore.create(orbitdb, networkKeys, namespace)
}

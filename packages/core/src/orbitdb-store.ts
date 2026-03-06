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
import type { MemoryChunk, MemoryQuery, MemoryNamespace, ContentEnvelope } from './schema.js'
import { applyQuery } from './query.js'
import type { IMemoryStore, MemoryStoreEvents } from './store.js'
import type { NetworkKeys } from './crypto.js'
import { encryptEnvelope, decryptEnvelope } from './crypto.js'
import { SubspaceAccessController } from './access-controller.js'
import { StoreError, ErrorCode } from './errors.js'

// ---------------------------------------------------------------------------
// Encrypted document shape
// ---------------------------------------------------------------------------
//
// When a chunk is stored with encryption enabled, the `content` and
// `contentEnvelope.body` fields are replaced with encrypted equivalents.
// All metadata fields (id, type, namespace, topic[], source, etc.) remain
// in plaintext so OrbitDB can index and filter them.
//
// Stored document layout:
//   _encrypted: true                     — marks the doc as using envelope encryption
//   encryptedContent: string (base64)    — AES-256-GCM ciphertext of `content`
//   contentIv: string (base64)           — 12-byte IV for encryptedContent
//   contentTag: string (base64)          — 16-byte GCM auth tag for encryptedContent
//   encryptedEnvelopeBody?: string       — AES-256-GCM ciphertext of contentEnvelope.body
//   envelopeBodyIv?: string              — IV for encryptedEnvelopeBody
//   envelopeBodyTag?: string             — auth tag for encryptedEnvelopeBody
//
// On read, decryptDoc() reconstructs the original MemoryChunk transparently.
// Legacy plaintext docs (no _encrypted flag) are returned as-is.

// Internal document shape stored in OrbitDB (uses _id as OrbitDB's primary key).
// Index signature required for compatibility with @orbitdb/core's Record<string,unknown> API.
type OrbitDoc = Omit<MemoryChunk, 'content' | 'contentEnvelope'> & {
  _id: string
  // Plaintext content (unencrypted stores) or empty string placeholder
  content: string
  contentEnvelope?: ContentEnvelope
  // Encryption fields (present when _encrypted: true)
  _encrypted?: boolean
  encryptedContent?: string
  contentIv?: string
  contentTag?: string
  encryptedEnvelopeBody?: string
  envelopeBodyIv?: string
  envelopeBodyTag?: string
  [key: string]: unknown
}

/**
 * Encrypt the content fields of a chunk before storing in OrbitDB.
 * Returns a modified OrbitDoc with `content` and `contentEnvelope.body`
 * replaced by their encrypted equivalents.
 */
function encryptDoc(chunk: MemoryChunk, key: Buffer): OrbitDoc {
  // Encrypt content
  const contentEnc = encryptEnvelope(Buffer.from(chunk.content, 'utf8'), key)

  const doc: OrbitDoc = {
    ...(chunk as unknown as OrbitDoc),
    _id: chunk.id,
    _encrypted: true,
    content: '',                                                         // placeholder — not queryable
    encryptedContent: contentEnc.ciphertext.toString('base64'),
    contentIv: contentEnc.iv.toString('base64'),
    contentTag: contentEnc.tag.toString('base64'),
  }

  // Encrypt contentEnvelope.body if present
  if (chunk.contentEnvelope?.body) {
    const bodyEnc = encryptEnvelope(Buffer.from(chunk.contentEnvelope.body, 'utf8'), key)
    doc.contentEnvelope = {
      ...chunk.contentEnvelope,
      body: '',  // placeholder
    }
    doc.encryptedEnvelopeBody = bodyEnc.ciphertext.toString('base64')
    doc.envelopeBodyIv = bodyEnc.iv.toString('base64')
    doc.envelopeBodyTag = bodyEnc.tag.toString('base64')
  }

  return doc
}

/**
 * Decrypt an OrbitDoc back to a MemoryChunk.
 * If the doc is not encrypted (_encrypted !== true), returns it as-is.
 */
function decryptDoc(doc: OrbitDoc, key: Buffer): MemoryChunk {
  if (!doc._encrypted) {
    // Legacy plaintext document — return without modification
    return doc as unknown as MemoryChunk
  }

  let content = ''
  if (doc.encryptedContent && doc.contentIv && doc.contentTag) {
    try {
      content = decryptEnvelope(
        Buffer.from(doc.encryptedContent, 'base64'),
        Buffer.from(doc.contentIv, 'base64'),
        Buffer.from(doc.contentTag, 'base64'),
        key
      ).toString('utf8')
    } catch {
      // Decryption failed — wrong key or corrupted doc; return empty content
      // rather than crashing. The chunk will be filtered by query/search.
      content = ''
    }
  }

  const chunk = {
    ...doc,
    content,
  } as unknown as MemoryChunk

  // Decrypt contentEnvelope.body if present
  if (doc.contentEnvelope && doc.encryptedEnvelopeBody && doc.envelopeBodyIv && doc.envelopeBodyTag) {
    try {
      const body = decryptEnvelope(
        Buffer.from(doc.encryptedEnvelopeBody, 'base64'),
        Buffer.from(doc.envelopeBodyIv, 'base64'),
        Buffer.from(doc.envelopeBodyTag, 'base64'),
        key
      ).toString('utf8')
      chunk.contentEnvelope = { ...doc.contentEnvelope, body }
    } catch {
      // Keep envelope with empty body on decryption failure
      chunk.contentEnvelope = { ...doc.contentEnvelope, body: '' }
    }
  }

  // Strip internal encryption bookkeeping fields from the returned chunk
  const chunkAny = chunk as unknown as Record<string, unknown>
  delete chunkAny._encrypted
  delete chunkAny.encryptedContent
  delete chunkAny.contentIv
  delete chunkAny.contentTag
  delete chunkAny.encryptedEnvelopeBody
  delete chunkAny.envelopeBodyIv
  delete chunkAny.envelopeBodyTag

  return chunk
}

export class OrbitDBMemoryStore extends EventEmitter implements IMemoryStore {
  private db: DocumentsDatabase
  /** AES-256-GCM key for encrypting content fields. Null = no encryption (tests/legacy). */
  private envelopeKey: Buffer | null

  private constructor(db: DocumentsDatabase, envelopeKey: Buffer | null) {
    super()
    this.db = db
    this.envelopeKey = envelopeKey

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
   *
   * @param envelopeKey When provided, content fields are encrypted at rest using
   *                    AES-256-GCM. Pass null to disable encryption (test/legacy mode).
   */
  static async create(
    orbitdb: OrbitDB,
    networkKeys: NetworkKeys,
    namespace: MemoryNamespace,
    envelopeKey: Buffer | null = networkKeys.envelopeKey,
  ): Promise<OrbitDBMemoryStore> {
    // Register the SubspaceAccessController globally so OrbitDB can look it up
    // when reopening existing databases that have 'subspace' in their manifest.
    // @ts-ignore — useAccessController is not in the @orbitdb/core type declarations
    // but IS exported from src/index.js at runtime.
    const orbitdbModule = await import('@orbitdb/core') as Record<string, unknown>
    const useAC = orbitdbModule.useAccessController as ((ac: unknown) => void) | undefined
    if (useAC) {
      try {
        useAC(SubspaceAccessController)
      } catch {
        // 'already added' — safe to ignore on subsequent calls
      }
    }

    // DB name includes topic (derived from PSK) + namespace for network isolation
    const dbName = `subspace/${networkKeys.topic}/${namespace}`
    const db = await orbitdb.open(dbName, {
      type: 'documents',
      // Validate every incoming replicated entry before accepting it.
      // This prevents malicious peers from injecting garbage into the CRDT oplog.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      AccessController: SubspaceAccessController() as any,
    }) as DocumentsDatabase

    return new OrbitDBMemoryStore(db, envelopeKey)
  }

  async put(chunk: MemoryChunk): Promise<void> {
    try {
      let doc: OrbitDoc
      if (this.envelopeKey) {
        doc = JSON.parse(JSON.stringify(encryptDoc(chunk, this.envelopeKey)))
      } else {
        // JSON round-trip removes `undefined` fields — IPLD cannot encode undefined.
        doc = JSON.parse(JSON.stringify({ ...chunk, _id: chunk.id }))
      }
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
      if (this.envelopeKey) return decryptDoc(doc, this.envelopeKey)
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
      const key = this.envelopeKey
      const chunks = all
        .filter(d => !d._tombstone)
        .map(d => key ? decryptDoc(d, key) : d as unknown as MemoryChunk)
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
      const key = this.envelopeKey
      return all
        .filter(d => !d._tombstone)
        .map(d => key ? decryptDoc(d, key) : d as unknown as MemoryChunk)
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
  // Fix: wrap helia.blockstore.get() with a dual-mode shim that handles both:
  //  - AsyncIterable<Uint8Array> (Helia v6 / blockstore-level v3)
  //  - Uint8Array directly         (Helia v5 and earlier, or future regressions)
  //
  // The shim detects the return type at runtime so it degrades gracefully if
  // Helia changes its API in a patch release.
  const originalGet = helia.blockstore.get.bind(helia.blockstore)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(helia.blockstore as any).get =
    async function (cid: any, options?: any) {
      // Await without consuming — if result is a Uint8Array we're done;
      // if it is an AsyncGenerator, awaiting it just returns the generator.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = await originalGet(cid, options)

      // Fast path: already a plain Uint8Array (Helia v5 or future revert)
      if (raw instanceof Uint8Array) return raw

      // Null / undefined → block not found
      if (raw == null) return undefined

      // AsyncIterable path (Helia v6+): consume and concatenate
      if (typeof raw[Symbol.asyncIterator] === 'function' || typeof raw[Symbol.iterator] === 'function') {
        const chunks: Uint8Array[] = []
        for await (const chunk of raw as AsyncIterable<Uint8Array>) {
          chunks.push(chunk)
        }
        if (chunks.length === 0) return undefined
        if (chunks.length === 1) return chunks[0]
        // Multiple chunks: concatenate (rare for OrbitDB entries, but correct)
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const result = new Uint8Array(total)
        let off = 0
        for (const c of chunks) { result.set(c, off); off += c.length }
        return result
      }

      // Unexpected return type — surface it so it's not silently swallowed
      throw new TypeError(
        `helia.blockstore.get() returned an unexpected type: ${Object.prototype.toString.call(raw)}. ` +
        'The Helia blockstore shim in orbitdb-store.ts may need updating.',
      )
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
 *
 * Content fields (`content` and `contentEnvelope.body`) are encrypted at rest
 * using AES-256-GCM with `networkKeys.envelopeKey`. Pass `envelopeKey: null`
 * to disable encryption (test/legacy mode).
 */
export async function createOrbitDBStore(
  orbitdb: OrbitDB,
  networkKeys: NetworkKeys,
  namespace: MemoryNamespace,
  envelopeKey: Buffer | null = networkKeys.envelopeKey,
): Promise<IMemoryStore> {
  return OrbitDBMemoryStore.create(orbitdb, networkKeys, namespace, envelopeKey)
}

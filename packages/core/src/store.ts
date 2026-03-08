/**
 * IMemoryStore — the core abstraction for Subspace Transceiver memory storage.
 *
 * All store operations go through this interface. The OrbitDB implementation
 * is hidden in orbitdb-store.ts. This separation guards against OrbitDB/Helia
 * API churn and allows alternative implementations (in-memory for tests, etc.).
 *
 * Write semantics: APPEND-ONLY. Never put() over an existing id.
 * Updates must use a new id + set supersedes: previousId.
 * Deletes must use tombstones (forget() marks, not physically removes).
 * This ensures CRDT consistency across all peers.
 */

import type { EventEmitter } from 'node:events'
import type { MemoryChunk, MemoryQuery } from './schema.js'

/**
 * Events emitted by IMemoryStore implementations.
 *
 * 'replicated' — fired when remote peer data merges into the local store
 *                (OrbitDB 'update' event from a remote peer)
 * 'error'      — fired on unrecoverable store errors
 */
export interface MemoryStoreEvents {
  replicated: []
  changed: []
  error: [error: Error]
}

/**
 * Core memory store interface.
 * All implementations must honour the append-only and tombstone contracts.
 */
export interface IMemoryStore extends EventEmitter {
  /**
   * Write a memory chunk to the store.
   * The chunk id must be unique — never reuse an existing id.
   * For updates, create a new chunk with supersedes: previousId.
   */
  put(chunk: MemoryChunk): Promise<void>

  /**
   * Retrieve a single chunk by id.
   * Returns null if the chunk does not exist or has been tombstoned.
   * Returns the raw chunk (including tombstones) when called internally by list().
   */
  get(id: string): Promise<MemoryChunk | null>

  /**
   * Query the local store with filters.
   * Returns HEADs only (superseded chunks excluded).
   * Tombstoned and TTL-expired chunks are excluded.
   * Results are sorted by source.timestamp descending.
   */
  query(q: MemoryQuery): Promise<MemoryChunk[]>

  /**
   * Return ALL documents including tombstones — used by GC and network query handler.
   * Callers must handle tombstone filtering themselves.
   */
  list(): Promise<MemoryChunk[]>

  /**
   * Tombstone a chunk by id.
   * The chunk is NOT physically deleted — a tombstone document is stored so that
   * the deletion propagates to all peers via CRDT replication.
   */
  forget(id: string): Promise<void>

  /** Close the store and release all resources. */
  close(): Promise<void>
}

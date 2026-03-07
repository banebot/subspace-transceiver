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
import { EventEmitter } from 'node:events';
import { type OrbitDB } from '@orbitdb/core';
import type { Helia } from 'helia';
import type { Libp2p } from 'libp2p';
import type { MemoryChunk, MemoryQuery, MemoryNamespace } from './schema.js';
import type { IMemoryStore, MemoryStoreEvents } from './store.js';
import type { NetworkKeys } from './crypto.js';
export declare class OrbitDBMemoryStore extends EventEmitter implements IMemoryStore {
    private db;
    /** AES-256-GCM key for encrypting content fields. Null = no encryption (tests/legacy). */
    private envelopeKey;
    private constructor();
    /**
     * Create a store backed by an already-initialised OrbitDB instance.
     * Helia and the libp2p node are owned by the caller (NetworkSession);
     * this store only manages the OrbitDB database handle.
     *
     * @param envelopeKey When provided, content fields are encrypted at rest using
     *                    AES-256-GCM. Pass null to disable encryption (test/legacy mode).
     */
    static create(orbitdb: OrbitDB, networkKeys: NetworkKeys, namespace: MemoryNamespace, envelopeKey?: Buffer | null): Promise<OrbitDBMemoryStore>;
    put(chunk: MemoryChunk): Promise<void>;
    get(id: string): Promise<MemoryChunk | null>;
    query(q: MemoryQuery): Promise<MemoryChunk[]>;
    list(): Promise<MemoryChunk[]>;
    forget(id: string): Promise<void>;
    close(): Promise<void>;
    on<K extends keyof MemoryStoreEvents>(event: K, listener: (...args: MemoryStoreEvents[K]) => void): this;
    emit<K extends keyof MemoryStoreEvents>(event: K, ...args: MemoryStoreEvents[K]): boolean;
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
    helia: Helia;
    orbitdb: OrbitDB;
    /**
     * Close raw Level databases that Helia.stop() does not reach.
     * Call AFTER helia.stop() to release file locks.
     */
    closeLevelStores: () => Promise<void>;
}
/**
 * Create a shared Helia + OrbitDB context for a network.
 * Returns both so the caller can stop Helia when leaving the network.
 */
export declare function createOrbitDBContext(node: Libp2p, dataDir: string, 
/** Deterministic network identifier — passed as OrbitDB identity `id` so the
 *  same network always gets the same signing identity across restarts. */
networkId: string): Promise<OrbitDBContext>;
/**
 * Factory function — creates and returns an IMemoryStore backed by OrbitDB v2.
 * Requires a pre-initialised OrbitDB instance (use createOrbitDBContext).
 *
 * Content fields (`content` and `contentEnvelope.body`) are encrypted at rest
 * using AES-256-GCM with `networkKeys.envelopeKey`. Pass `envelopeKey: null`
 * to disable encryption (test/legacy mode).
 */
export declare function createOrbitDBStore(orbitdb: OrbitDB, networkKeys: NetworkKeys, namespace: MemoryNamespace, envelopeKey?: Buffer | null): Promise<IMemoryStore>;
//# sourceMappingURL=orbitdb-store.d.ts.map
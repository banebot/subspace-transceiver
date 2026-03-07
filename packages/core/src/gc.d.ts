/**
 * TTL garbage collection for Subspace Transceiver memory stores.
 *
 * runGC() is stateless and idempotent — safe to call repeatedly.
 * It tombstones (not physically deletes) expired chunks so that
 * the expiry propagates to all peers via CRDT replication.
 */
import type { IMemoryStore } from './store.js';
export interface GCResult {
    pruned: number;
}
/**
 * Scan the store for TTL-expired chunks and tombstone them.
 *
 * A chunk is expired when: `chunk.ttl !== undefined && chunk.ttl < Date.now()`
 *
 * Tombstoning (rather than physical delete) ensures consistency across peers.
 * Already-tombstoned chunks are skipped to avoid double-writes.
 *
 * @returns { pruned } — count of chunks that were tombstoned in this run
 */
export declare function runGC(store: IMemoryStore): Promise<GCResult>;
//# sourceMappingURL=gc.d.ts.map
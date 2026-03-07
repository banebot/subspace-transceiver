/**
 * TTL garbage collection for Subspace Transceiver memory stores.
 *
 * runGC() is stateless and idempotent — safe to call repeatedly.
 * It tombstones (not physically deletes) expired chunks so that
 * the expiry propagates to all peers via CRDT replication.
 */
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
export async function runGC(store) {
    const now = Date.now();
    const all = await store.list();
    let pruned = 0;
    const tasks = [];
    for (const chunk of all) {
        // Skip already-tombstoned chunks
        if (chunk._tombstone)
            continue;
        // Only prune chunks with an explicit TTL that has expired
        if (chunk.ttl !== undefined && chunk.ttl < now) {
            tasks.push(store.forget(chunk.id));
            pruned++;
        }
    }
    // Run all tombstone operations concurrently
    await Promise.all(tasks);
    return { pruned };
}
//# sourceMappingURL=gc.js.map
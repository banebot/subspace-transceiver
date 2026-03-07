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
export {};
//# sourceMappingURL=store.js.map
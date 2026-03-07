/**
 * Query filtering and HEAD-of-chain resolution for Subspace Transceiver memory.
 *
 * Write model: APPEND-ONLY with supersedes chains.
 * A chain looks like: [ChunkA] <- [ChunkB (supersedes: A)] <- [ChunkC (supersedes: B)]
 * The HEAD is ChunkC — the most recent version in the chain.
 *
 * Fork tie-breaking rule: if resolveHeads encounters multiple chunks with no
 * superseder (concurrent forks — e.g. two agents updated same chunk offline),
 * the chunk with the highest source.timestamp is chosen as HEAD.
 * This rule is deterministic and converges on all peers.
 */
import type { MemoryChunk, MemoryQuery } from './schema.js';
/**
 * Build a filter predicate from a MemoryQuery.
 * The predicate returns true for chunks that match ALL specified query fields.
 * Tombstoned and TTL-expired chunks are always filtered out.
 */
export declare function buildOrbitFilter(q: MemoryQuery): (doc: MemoryChunk) => boolean;
/**
 * Given a flat list of chunks, return only the HEADs — chunks that are NOT
 * superseded by any other chunk in the list.
 *
 * A chunk C is a HEAD if no other chunk D exists where D.supersedes === C.id.
 *
 * Fork tie-breaking: if multiple chunks share no superseder (concurrent fork),
 * the one with the highest source.timestamp wins. This is deterministic and
 * converges on all peers.
 */
export declare function resolveHeads(chunks: MemoryChunk[]): MemoryChunk[];
/**
 * Apply a MemoryQuery to a flat list of chunks:
 * 1. Filter by query predicates (type, namespace, topics, etc.)
 * 2. Resolve HEADs (remove superseded chunks)
 * 3. Sort by source.timestamp descending (newest first)
 * 4. Apply limit
 */
export declare function applyQuery(chunks: MemoryChunk[], q: MemoryQuery): MemoryChunk[];
//# sourceMappingURL=query.d.ts.map
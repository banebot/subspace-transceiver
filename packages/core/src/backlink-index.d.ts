/**
 * In-memory backlink index for the subspace content graph.
 *
 * Maintains a reverse index: targetId → Set<sourceChunkId>.
 * This allows "what chunks link TO this chunk?" queries in O(1) without
 * scanning the entire store.
 *
 * LIFECYCLE
 * ─────────
 * - Built on startup by scanning the local store.
 * - Updated incrementally when chunks are put (local or replicated).
 * - Not persisted — rebuilt from OrbitDB on restart (fast, local-only).
 *
 * INDEX COVERAGE
 * ──────────────
 * Indexes two sources of links:
 *   1. `chunk.links[].target` — explicit ContentLink entries
 *   2. `chunk.supersedes`     — implicit supersedes relationship
 *
 * For `agent://` URIs in link targets, the index stores the URI string
 * directly. Resolution of URIs to chunk IDs happens at query time.
 *
 * THREAD SAFETY
 * ─────────────
 * Single-threaded Node.js — no locking needed. All operations are synchronous
 * on the in-memory Map.
 */
import type { MemoryChunk, ContentLink } from './schema.js';
import type { IMemoryStore } from './store.js';
export declare class BacklinkIndex {
    /**
     * Maps target (chunk ID or agent:// URI) → set of source chunk IDs
     * that contain a link pointing at it.
     */
    private readonly index;
    /**
     * Build the index from an existing store.
     * Should be called once on daemon startup after stores are initialized.
     */
    build(store: IMemoryStore): Promise<void>;
    /**
     * Add a chunk's outgoing links to the index.
     * Idempotent — safe to call multiple times for the same chunk.
     */
    indexChunk(chunk: MemoryChunk): void;
    /**
     * Remove a chunk's outgoing links from the index.
     * Called when a chunk is tombstoned.
     */
    removeChunk(chunk: MemoryChunk): void;
    /**
     * Get the IDs of all chunks that link TO the given target.
     * Target may be a chunk UUID or an agent:// URI.
     */
    getBacklinks(target: string): string[];
    /**
     * Get all outgoing link targets for a given source chunk.
     * Returns an array of { target, rel } pairs.
     *
     * Derived from the chunk itself, not the index
     * (the index is a reverse map, not forward map).
     */
    static getLinks(chunk: MemoryChunk): ContentLink[];
    /** Total number of distinct targets tracked in the index. */
    get size(): number;
    private addEdge;
}
//# sourceMappingURL=backlink-index.d.ts.map
/**
 * agent:// URI scheme for addressing content on the subspace network.
 *
 * FORMAT
 * ──────
 *   agent://<peerId>[/<collection>[/<slug>]]
 *
 * COMPONENTS
 * ──────────
 *   peerId      — libp2p PeerId string (base58btc multi-hash)
 *                 This IS the agent's public key — it is the namespace root.
 *   collection  — Named collection within the agent's namespace
 *                 (e.g. 'patterns', 'guides', 'project-notes')
 *   slug        — Human-readable content identifier within the collection
 *                 (e.g. 'typescript-async', 'error-handling')
 *
 * EXAMPLES
 * ────────
 *   agent://12D3KooWExAmple                              → agent profile root
 *   agent://12D3KooWExAmple/patterns                    → collection listing
 *   agent://12D3KooWExAmple/patterns/typescript-async   → specific chunk
 *
 * BLOB ADDRESSES (special sub-scheme)
 * ────────────────────────────────────
 *   agent://<peerId>/blobs/<sha256hex>   → binary blob addressed by content hash
 *
 * RESOLUTION SEMANTICS
 * ────────────────────
 * URIs are resolved local-first (OrbitDB) then via network query to the
 * specific peer. The peerId serves as both the author identity and the
 * routing key to find the peer.
 */
export interface AgentURI {
    peerId: string;
    collection?: string;
    slug?: string;
    /** Full original URI string */
    raw: string;
}
/**
 * Parse an agent:// URI into its components.
 * Throws AgentNetError with URI_PARSE_ERROR on malformed input.
 */
export declare function parseAgentURI(uri: string): AgentURI;
/**
 * Build an agent:// URI from its components.
 */
export declare function buildAgentURI(peerId: string, collection?: string, slug?: string): string;
/**
 * Build a blob URI for content-addressed binary storage.
 */
export declare function buildBlobURI(peerId: string, sha256hex: string): string;
/**
 * Type guard: returns true if the string looks like a valid agent:// URI.
 */
export declare function isAgentURI(str: string): boolean;
/**
 * Returns true if the URI points to a blob (agent://<peerId>/blobs/<hash>).
 */
export declare function isBlobURI(uri: string): boolean;
//# sourceMappingURL=uri.d.ts.map
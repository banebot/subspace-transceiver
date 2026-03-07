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
import { AgentNetError, ErrorCode } from './errors.js';
const AGENT_SCHEME = 'agent://';
/**
 * Parse an agent:// URI into its components.
 * Throws AgentNetError with URI_PARSE_ERROR on malformed input.
 */
export function parseAgentURI(uri) {
    if (!uri.startsWith(AGENT_SCHEME)) {
        throw new AgentNetError(`Invalid agent URI — must start with "${AGENT_SCHEME}": ${uri}`, ErrorCode.URI_PARSE_ERROR);
    }
    const withoutScheme = uri.slice(AGENT_SCHEME.length);
    const parts = withoutScheme.split('/').filter(Boolean);
    if (parts.length === 0) {
        throw new AgentNetError(`Invalid agent URI — missing peerId: ${uri}`, ErrorCode.URI_PARSE_ERROR);
    }
    const [peerId, collection, slug] = parts;
    if (!peerId || peerId.length < 10) {
        throw new AgentNetError(`Invalid agent URI — peerId is too short to be a valid libp2p PeerId: ${uri}`, ErrorCode.URI_PARSE_ERROR);
    }
    return { peerId, collection, slug, raw: uri };
}
/**
 * Build an agent:// URI from its components.
 */
export function buildAgentURI(peerId, collection, slug) {
    let uri = `${AGENT_SCHEME}${peerId}`;
    if (collection) {
        uri += `/${collection}`;
        if (slug)
            uri += `/${slug}`;
    }
    return uri;
}
/**
 * Build a blob URI for content-addressed binary storage.
 */
export function buildBlobURI(peerId, sha256hex) {
    return `${AGENT_SCHEME}${peerId}/blobs/${sha256hex}`;
}
/**
 * Type guard: returns true if the string looks like a valid agent:// URI.
 */
export function isAgentURI(str) {
    if (!str.startsWith(AGENT_SCHEME))
        return false;
    try {
        parseAgentURI(str);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Returns true if the URI points to a blob (agent://<peerId>/blobs/<hash>).
 */
export function isBlobURI(uri) {
    try {
        const parsed = parseAgentURI(uri);
        return parsed.collection === 'blobs' && !!parsed.slug;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=uri.js.map
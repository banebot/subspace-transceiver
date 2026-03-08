/**
 * Subspace ALPN protocol identifiers and message encoding.
 *
 * In Iroh, protocols are negotiated via ALPN rather than libp2p protocol IDs.
 * These constants are shared between the Rust engine (protocols.rs) and
 * the TypeScript layer.
 *
 * ## Message encoding
 * Messages are JSON-encoded (UTF-8). The framing is handled by the Iroh
 * QUIC stream: each direction uses length-prefixed framing (see sync.rs).
 */

// ---------------------------------------------------------------------------
// ALPN identifiers (must match packages/engine/src/protocols.rs)
// ---------------------------------------------------------------------------

/** Browse protocol — page through an agent's public content. */
export const BROWSE_PROTOCOL = '/subspace/browse/1.0.0'

/** Query protocol — lookup a specific chunk by NSID + key. */
export const QUERY_PROTOCOL = '/subspace/query/1.0.0'

/** Manifest protocol — direct peer-to-peer manifest exchange. */
export const MANIFEST_PROTOCOL = '/subspace/manifest/1.0.0'

/** Mailbox protocol — store-and-forward encrypted mail. */
export const MAILBOX_PROTOCOL = '/subspace/mailbox/1.0.0'

/** Capability negotiation protocol (ANP). */
export const NEGOTIATE_PROTOCOL = '/subspace/negotiate/1.0.0'

// ---------------------------------------------------------------------------
// Message encoding (JSON for simplicity; Loro uses its own binary encoding)
// ---------------------------------------------------------------------------

/**
 * Encode a message object to a Uint8Array (UTF-8 JSON).
 */
export function encodeMessage(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg))
}

/**
 * Decode a Uint8Array (UTF-8 JSON) to a typed message object.
 */
export function decodeMessage<T = unknown>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

// ---------------------------------------------------------------------------
// Query protocol (stub — Phase 3.6 will implement Iroh ALPN version)
// ---------------------------------------------------------------------------

export interface QueryRequest {
  requestId: string
  query: unknown
  networkId?: string
  pow?: unknown
}

export interface QueryResponse {
  requestId: string
  peerId: string
  chunks: unknown[]
}

/**
 * Send a query to a remote peer via the query protocol.
 * @deprecated Phase 3.6 will implement this via Iroh ALPN streams.
 * @returns null (stub — no peer-to-peer query in Phase 3.5)
 */
export async function sendQuery(
  _node: unknown,
  _targetPeerId: unknown,
  _query: unknown,
  _pow?: unknown,
  _networkId?: string
): Promise<QueryResponse | null> {
  // Phase 3.6: implement via Iroh ALPN stream
  return null
}

// ---------------------------------------------------------------------------
// Gossip topics
// ---------------------------------------------------------------------------

/** Global discovery gossip topic — all agents participate. */
export const DISCOVERY_TOPIC = '_subspace/discovery'

/**
 * Derive a PSK-specific gossip topic ID.
 * This ensures PSK network gossip is isolated from the global discovery topic.
 * Returns a 32-byte hex string (matching Iroh's TopicId format).
 */
export function deriveGossipTopic(topicNameOrPsk: string): string {
  // Simple derivation using SHA-256 of the topic name.
  // In production this matches the PSK-derived key from crypto.ts.
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(topicNameOrPsk, 'utf8').digest('hex')
}

/**
 * agent:// URI scheme for addressing content on the subspace network.
 *
 * FORMAT
 * ──────
 *   agent://<peerId|did:key:z...>[/<collection>[/<slug>]]
 *
 * COMPONENTS
 * ──────────
 *   peerId      — libp2p PeerId string (base58btc multi-hash) OR
 *                 DID:Key string (did:key:z6Mk...) — both are accepted.
 *                 The peerId in AgentURI always contains the raw identifier
 *                 as provided (either PeerId or DID:Key).
 *   collection  — Named collection within the agent's namespace
 *                 (e.g. 'patterns', 'guides', 'project-notes')
 *   slug        — Human-readable content identifier within the collection
 *                 (e.g. 'typescript-async', 'error-handling')
 *
 * EXAMPLES
 * ────────
 *   agent://12D3KooWExAmple                              → agent profile root (PeerId)
 *   agent://did:key:z6Mk...                              → agent profile root (DID:Key)
 *   agent://12D3KooWExAmple/patterns                    → collection listing
 *   agent://12D3KooWExAmple/patterns/typescript-async   → specific chunk
 *
 * BLOB ADDRESSES (special sub-scheme)
 * ────────────────────────────────────
 *   agent://<peerId>/blobs/<sha256hex>   → binary blob addressed by content hash
 *
 * BACKWARD COMPATIBILITY
 * ──────────────────────
 * PeerId-based URIs continue to work unchanged. DID:Key support is additive.
 */

import { AgentNetError, ErrorCode } from './errors.js'

export interface AgentURI {
  /** PeerId string OR DID:Key string — whichever was provided in the URI */
  peerId: string
  collection?: string
  slug?: string
  /** Full original URI string */
  raw: string
  /** True when the authority component is a DID:Key (did:key:z...) */
  isDIDKey?: boolean
}

const AGENT_SCHEME = 'agent://'

/**
 * Parse an agent:// URI into its components.
 * Accepts both PeerId and DID:Key as the authority.
 * Throws AgentNetError with URI_PARSE_ERROR on malformed input.
 *
 * DID:Key special handling:
 * DID:Key contains colons (did:key:z6Mk...) which would be split by the
 * naive '/' split. We handle this by detecting the 'did:' prefix and
 * treating the entire DID:Key as the authority before the first path segment.
 */
export function parseAgentURI(uri: string): AgentURI {
  if (!uri.startsWith(AGENT_SCHEME)) {
    throw new AgentNetError(
      `Invalid agent URI — must start with "${AGENT_SCHEME}": ${uri}`,
      ErrorCode.URI_PARSE_ERROR
    )
  }

  const withoutScheme = uri.slice(AGENT_SCHEME.length)

  // Handle DID:Key authority: did:key:z6Mk...
  // The DID is the part before the first '/' that isn't part of the DID itself.
  // DID:Key format: did:key:z<base58btc>  — no '/' in the identifier itself.
  let peerId: string
  let rest: string
  let isDIDKey = false

  if (withoutScheme.startsWith('did:')) {
    // Find the first '/' after the DID identifier
    const didEnd = withoutScheme.indexOf('/')
    if (didEnd === -1) {
      peerId = withoutScheme
      rest = ''
    } else {
      peerId = withoutScheme.slice(0, didEnd)
      rest = withoutScheme.slice(didEnd + 1)
    }
    isDIDKey = true
  } else {
    // Standard PeerId authority
    const parts = withoutScheme.split('/')
    peerId = parts[0]
    rest = parts.slice(1).join('/')
  }

  if (!peerId || peerId.length < 10) {
    throw new AgentNetError(
      `Invalid agent URI — authority is too short: ${uri}`,
      ErrorCode.URI_PARSE_ERROR
    )
  }

  const pathParts = rest.split('/').filter(Boolean)
  const [collection, slug] = pathParts

  return { peerId, collection, slug, raw: uri, isDIDKey: isDIDKey || undefined }
}

/**
 * Build an agent:// URI from its components.
 */
export function buildAgentURI(peerId: string, collection?: string, slug?: string): string {
  let uri = `${AGENT_SCHEME}${peerId}`
  if (collection) {
    uri += `/${collection}`
    if (slug) uri += `/${slug}`
  }
  return uri
}

/**
 * Build a blob URI for content-addressed binary storage.
 */
export function buildBlobURI(peerId: string, sha256hex: string): string {
  return `${AGENT_SCHEME}${peerId}/blobs/${sha256hex}`
}

/**
 * Type guard: returns true if the string looks like a valid agent:// URI.
 */
export function isAgentURI(str: string): boolean {
  if (!str.startsWith(AGENT_SCHEME)) return false
  try {
    parseAgentURI(str)
    return true
  } catch {
    return false
  }
}

/**
 * Returns true if the URI points to a blob (agent://<peerId>/blobs/<hash>).
 */
export function isBlobURI(uri: string): boolean {
  try {
    const parsed = parseAgentURI(uri)
    return parsed.collection === 'blobs' && !!parsed.slug
  } catch {
    return false
  }
}

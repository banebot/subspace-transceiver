/**
 * ANP-compatible meta-protocol capability negotiation.
 *
 * ## Overview
 * The negotiate module adds a `/subspace/negotiate/1.0.0` protocol that
 * lets agents query each other's supported capabilities before initiating
 * interaction. This maps to ANP's (Agent Network Protocol) meta-protocol
 * negotiation layer and enables interop with external agent networks.
 *
 * ## Capability Format
 * Capabilities are declared using Subspace NSIDs:
 *   - `net.subspace.memory.*`    — memory storage protocols
 *   - `net.subspace.protocol.*` — transport/communication protocols
 *   - `net.subspace.schema.*`   — schema/lexicon declarations
 *
 * Each capability declaration includes:
 *   - `nsid`     — the NSID identifying the capability
 *   - `version`  — semantic version string (e.g. '1.0.0')
 *   - `role`     — 'provider' | 'consumer' | 'both'
 *   - `metadata` — optional key-value hints (transport, auth requirements, etc.)
 *
 * ## Protocol
 * The `/subspace/negotiate/1.0.0` libp2p protocol sends a NegotiateRequest
 * and receives a NegotiateResponse (both length-prefixed JSON).
 *
 * ## ANP Mapping
 * Subspace capabilities map to ANP capability objects:
 *   { type: "capability", id: nsid, version, role, metadata }
 * This enables Subspace agents to participate in ANP-based capability queries
 * without a full ANP implementation.
 */

import type { Libp2p } from 'libp2p'
import * as lp from 'it-length-prefixed'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NEGOTIATE_PROTOCOL = '/subspace/negotiate/1.0.0'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilityRole = 'provider' | 'consumer' | 'both'

/**
 * A single capability declaration.
 * Agents advertise what they can do (provider), what they need (consumer),
 * or both.
 */
export interface CapabilityDeclaration {
  /** NSID identifying this capability (e.g. 'net.subspace.memory.skill') */
  nsid: string
  /** Semantic version of the capability implementation */
  version: string
  /** Role: provider, consumer, or both */
  role: CapabilityRole
  /** Optional key-value metadata (transport hints, auth requirements, etc.) */
  metadata?: Record<string, string>
}

/**
 * Request sent over the negotiate protocol.
 * Currently a simple "list all capabilities" query.
 * Future versions may include filtering by NSID prefix.
 */
export interface NegotiateRequest {
  /** Protocol version of this request format */
  protocolVersion: '1.0.0'
  /** Optional NSID prefix filter — if provided, only matching caps are returned */
  filter?: string
  /** Optional requester's DID:Key for authenticated requests */
  requesterDID?: string
}

/**
 * Response returned by the negotiate protocol.
 */
export interface NegotiateResponse {
  /** Protocol version of this response format */
  protocolVersion: '1.0.0'
  /** The responding agent's DID:Key */
  agentDID: string
  /** The responding agent's PeerId */
  peerId: string
  /** List of capabilities this agent supports */
  capabilities: CapabilityDeclaration[]
  /** Unix timestamp of this response */
  timestamp: number
}

// ---------------------------------------------------------------------------
// Built-in Subspace capabilities
// ---------------------------------------------------------------------------

/**
 * The standard set of capabilities that every Subspace agent provides.
 * These are registered at startup and can be extended by the host application.
 */
export const BUILT_IN_CAPABILITIES: CapabilityDeclaration[] = [
  {
    nsid: 'net.subspace.memory.skill',
    version: '2.0.0',
    role: 'both',
    metadata: { store: 'loro-crdt', transport: 'libp2p' },
  },
  {
    nsid: 'net.subspace.memory.project',
    version: '2.0.0',
    role: 'both',
    metadata: { store: 'loro-crdt', transport: 'libp2p' },
  },
  {
    nsid: 'net.subspace.protocol.query',
    version: '1.0.0',
    role: 'both',
    metadata: { protocol: '/subspace/query/1.0.0' },
  },
  {
    nsid: 'net.subspace.protocol.browse',
    version: '1.0.0',
    role: 'both',
    metadata: { protocol: '/subspace/browse/1.0.0' },
  },
  {
    nsid: 'net.subspace.protocol.negotiate',
    version: '1.0.0',
    role: 'both',
    metadata: { protocol: '/subspace/negotiate/1.0.0' },
  },
  {
    nsid: 'net.subspace.protocol.mailbox',
    version: '1.0.0',
    role: 'both',
    metadata: { protocol: '/subspace/mailbox/1.0.0' },
  },
  {
    nsid: 'net.subspace.identity.did-key',
    version: '1.0.0',
    role: 'provider',
    metadata: { keyType: 'Ed25519', codec: 'ed25519-pub' },
  },
  {
    nsid: 'net.subspace.schema.lexicon',
    version: '1.0.0',
    role: 'both',
    metadata: { format: 'AT Protocol Lexicon v1' },
  },
]

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

/**
 * In-process capability registry for a single agent instance.
 * Built-in capabilities are pre-loaded; additional capabilities can be
 * registered by the host application (e.g. for custom NSIDs).
 */
export class CapabilityRegistry {
  private capabilities: Map<string, CapabilityDeclaration>

  constructor(initial: CapabilityDeclaration[] = BUILT_IN_CAPABILITIES) {
    this.capabilities = new Map()
    for (const cap of initial) {
      this.capabilities.set(cap.nsid, cap)
    }
  }

  /**
   * Register or update a capability.
   */
  register(cap: CapabilityDeclaration): void {
    this.capabilities.set(cap.nsid, cap)
  }

  /**
   * Unregister a capability by NSID.
   */
  unregister(nsid: string): void {
    this.capabilities.delete(nsid)
  }

  /**
   * List all registered capabilities, optionally filtered by NSID prefix.
   */
  list(filter?: string): CapabilityDeclaration[] {
    const all = [...this.capabilities.values()]
    if (!filter) return all
    return all.filter(c => c.nsid.startsWith(filter))
  }

  /**
   * Get a single capability by exact NSID.
   */
  get(nsid: string): CapabilityDeclaration | undefined {
    return this.capabilities.get(nsid)
  }

  /**
   * Check if a capability is registered (exact NSID match).
   */
  has(nsid: string): boolean {
    return this.capabilities.has(nsid)
  }

  /**
   * Return all NSIDs as an array (for bloom filter encoding).
   */
  nsids(): string[] {
    return [...this.capabilities.keys()]
  }
}

// ---------------------------------------------------------------------------
// Protocol handler registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal stream helpers (libp2p v3 API)
// ---------------------------------------------------------------------------

interface Libp2pV3Stream extends AsyncIterable<Uint8Array | { subarray(): Uint8Array }> {
  send(data: Uint8Array | Uint8Array[]): boolean
  close(opts?: { signal?: AbortSignal }): Promise<void>
  abort(err: Error): void
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function encodeJSON(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value))
}

function decodeJSON<T>(data: Uint8Array): T {
  return JSON.parse(textDecoder.decode(data)) as T
}

async function streamSend(stream: Libp2pV3Stream, source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of source) {
    const drained = stream.send(chunk)
    if (!drained) {
      await new Promise<void>((resolve) => {
        ;(stream as unknown as { addEventListener(e: string, h: () => void, o?: { once?: boolean }): void })
          .addEventListener('drain', resolve, { once: true })
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Protocol handler registration
// ---------------------------------------------------------------------------

/**
 * Register the `/subspace/negotiate/1.0.0` protocol handler on a libp2p node.
 *
 * When a peer dials this protocol, this handler responds with the full
 * capability list (or filtered by the request's `filter` field).
 *
 * @param node      libp2p node to register the protocol on
 * @param registry  Capability registry to query
 * @param peerId    This agent's PeerId string
 * @param did       This agent's DID:Key string
 */
export function registerNegotiateProtocol(
  node: Libp2p,
  registry: CapabilityRegistry,
  peerId: string,
  did: string,
): void {
  ;(node as unknown as { handle(p: string, h: (stream: unknown, conn: unknown) => Promise<void>): void })
    .handle(NEGOTIATE_PROTOCOL, async (rawStream: unknown) => {
    const stream = rawStream as unknown as Libp2pV3Stream
    try {
      // Read the request (length-prefixed JSON)
      let request: NegotiateRequest | null = null
      for await (const chunk of lp.decode(stream as AsyncIterable<Uint8Array>)) {
        try {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
          request = decodeJSON<NegotiateRequest>(bytes)
        } catch {
          // Malformed request — respond with full capability list
        }
        break
      }

      const capabilities = registry.list(request?.filter)
      const response: NegotiateResponse = {
        protocolVersion: '1.0.0',
        agentDID: did,
        peerId,
        capabilities,
        timestamp: Date.now(),
      }

      async function* responseSource() { yield encodeJSON(response) }
      await streamSend(stream, lp.encode(responseSource()))
    } catch {
      // Ignore errors on individual connections
    } finally {
      await stream.close().catch(() => {})
    }
  })
}

/**
 * Query a peer's capabilities by dialing the negotiate protocol.
 *
 * @param node          libp2p node to use for the connection
 * @param targetPeerId  Peer ID to query
 * @param filter        Optional NSID prefix filter
 * @returns             NegotiateResponse from the peer, or null on failure
 */
export async function queryCapabilities(
  node: Libp2p,
  targetPeerId: string,
  filter?: string,
): Promise<NegotiateResponse | null> {
  try {
    const { peerIdFromString } = await import('@libp2p/peer-id')
    const peerId = peerIdFromString(targetPeerId)
    const rawStream = await node.dialProtocol(peerId, NEGOTIATE_PROTOCOL, {
      signal: AbortSignal.timeout(5000),
    })
    const stream = rawStream as unknown as Libp2pV3Stream

    const request: NegotiateRequest = { protocolVersion: '1.0.0', filter }

    try {
      // Write request
      async function* requestSource() { yield encodeJSON(request) }
      await streamSend(stream, lp.encode(requestSource()))

      // Read response
      let response: NegotiateResponse | null = null
      for await (const chunk of lp.decode(stream as AsyncIterable<Uint8Array>)) {
        try {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
          response = decodeJSON<NegotiateResponse>(bytes)
        } catch {
          // Malformed response
        }
        break
      }

      return response
    } finally {
      await stream.close().catch(() => {})
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// ANP interop helpers
// ---------------------------------------------------------------------------

/**
 * Convert a CapabilityDeclaration to ANP-compatible format.
 * ANP uses { type: "capability", id, version, role, metadata }.
 */
export function toANPCapability(cap: CapabilityDeclaration): Record<string, unknown> {
  return {
    type: 'capability',
    id: cap.nsid,
    version: cap.version,
    role: cap.role,
    metadata: cap.metadata ?? {},
  }
}

/**
 * Convert a NegotiateResponse to ANP-compatible capability advertisement.
 * This is the format that ANP-based systems expect when querying an agent's
 * capabilities.
 */
export function toANPAdvertisement(response: NegotiateResponse): Record<string, unknown> {
  return {
    type: 'capability_advertisement',
    agentId: response.agentDID,
    peerId: response.peerId,
    capabilities: response.capabilities.map(toANPCapability),
    timestamp: response.timestamp,
  }
}

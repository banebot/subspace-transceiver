/**
 * Content discovery layer for agent-net.
 *
 * ARCHITECTURE
 * ────────────
 * Discovery works in two layers:
 *
 * 1. PASSIVE — Topic manifests broadcast via GossipSub every 60s.
 *    Each agent publishes a DiscoveryManifest containing:
 *      - A topic Bloom filter (what topics it holds content for)
 *      - A content Bloom filter (what chunk IDs it holds)
 *      - Collection list and chunk count
 *    Peers receive manifests, update their local PeerIndex, and can answer
 *    "does agent X probably have content about topic Y?" with zero round-trips.
 *
 * 2. ACTIVE — Browse queries via the /agent-net/browse/1.0.0 libp2p protocol.
 *    Browse requests return paginated chunk metadata (not full content) from
 *    a specific peer. Used for displaying "what's on this agent's site."
 *
 * SUBSCRIPTION MODEL
 * ──────────────────
 * Agents can subscribe to topics or specific peers. When a manifest arrives
 * with matching content (bloom check), the subscription triggers an active
 * fetch of any chunks not already held locally.
 *
 * NETWORK WEIGHT BUDGET
 * ─────────────────────
 * Manifest size: ~512 bytes (2× 256-byte blooms + metadata)
 * Frequency: 1/60s per peer
 * 100 peers → ~51KB/min gossip overhead (well within budget)
 */

import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'
import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'
import { BloomFilter } from './bloom.js'
import type { IMemoryStore } from './store.js'
import { encodeMessage, decodeMessage } from './protocol.js'

// ---------------------------------------------------------------------------
// Protocol identifiers
// ---------------------------------------------------------------------------

export const DISCOVERY_TOPIC = '_agent-net/discovery'
export const BROWSE_PROTOCOL = '/agent-net/browse/1.0.0'

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Manifest broadcast by each agent every MANIFEST_INTERVAL_MS.
 * Serialized as JSON and published to DISCOVERY_TOPIC via GossipSub.
 */
export interface DiscoveryManifest {
  /** Publisher's libp2p PeerId string */
  peerId: string
  /** Display name (from agent profile, if set) */
  displayName?: string
  /** Named collections this agent has content in */
  collections: string[]
  /** Bloom filter of all topic strings this agent holds (base64) */
  topicBloom: string
  /** Bloom filter of all chunk IDs this agent holds (base64) */
  contentBloom: string
  /** Total non-tombstoned chunk count */
  chunkCount: number
  /** Unix ms when this manifest was generated */
  updatedAt: number
}

/**
 * A browse request sent via BROWSE_PROTOCOL.
 */
export interface BrowseRequest {
  requestId: string
  /** Omit to browse all collections */
  collection?: string
  /** Pagination cursor — send the last seen chunk's timestamp */
  since?: number
  limit?: number
}

/**
 * Metadata stub for a chunk — enough to display a listing without full content.
 */
export interface ChunkStub {
  id: string
  type: string
  collection?: string
  slug?: string
  topic: string[]
  /** First 200 chars of content (summary) */
  summary: string
  timestamp: number
  hasEnvelope: boolean
  linkCount: number
}

export interface BrowseResponse {
  requestId: string
  peerId: string
  stubs: ChunkStub[]
  hasMore: boolean
}

// ---------------------------------------------------------------------------
// Local peer index — populated from received manifests
// ---------------------------------------------------------------------------

export interface PeerIndexEntry {
  peerId: string
  displayName?: string
  collections: string[]
  topicBloom: BloomFilter
  contentBloom: BloomFilter
  chunkCount: number
  updatedAt: number
  /** When we last received a manifest from this peer */
  lastSeen: number
}

// ---------------------------------------------------------------------------
// DiscoveryManager
// ---------------------------------------------------------------------------

const MANIFEST_INTERVAL_MS = 60_000   // Re-broadcast every 60 seconds
const PEER_STALE_MS = 5 * 60_000      // Consider peer stale after 5 minutes
const PAGE_SIZE = 50                   // Default browse page size

export interface DiscoveryManagerOptions {
  /** Local agent PeerId */
  localPeerId: string
  /** Display name to include in manifests (optional) */
  displayName?: string
  /** Subscribed topics — trigger active fetch when matching manifests arrive */
  subscribedTopics?: string[]
  /** Subscribed peers — trigger active fetch when manifests arrive from these peers */
  subscribedPeers?: string[]
}

export class DiscoveryManager {
  private node: Libp2p
  private stores: IMemoryStore[]
  private opts: DiscoveryManagerOptions
  private peerIndex = new Map<string, PeerIndexEntry>()
  private manifestTimer?: ReturnType<typeof setInterval>
  private registered = false

  constructor(node: Libp2p, stores: IMemoryStore[], opts: DiscoveryManagerOptions) {
    this.node = node
    this.stores = stores
    this.opts = opts
  }

  /**
   * Start the discovery manager:
   * - Subscribe to DISCOVERY_TOPIC to receive peer manifests
   * - Register the BROWSE_PROTOCOL handler
   * - Start the periodic manifest broadcast timer
   * - Broadcast an initial manifest immediately
   */
  async start(): Promise<void> {
    if (this.registered) return
    this.registered = true

    // Subscribe to discovery topic
    try {
      // @ts-expect-error — libp2p pubsub type varies across helia versions
      this.node.services.pubsub.subscribe(DISCOVERY_TOPIC)
      // @ts-expect-error
      this.node.services.pubsub.addEventListener('message', this.handleGossipMessage.bind(this))
    } catch (err) {
      console.warn('[agent-net] Discovery: could not subscribe to GossipSub topic:', err)
    }

    // Register browse protocol handler
    try {
      // @ts-expect-error — libp2p stream handler type mismatch across versions
      await this.node.handle(BROWSE_PROTOCOL, async ({ stream }: { stream: unknown }) => {
        await this.handleBrowseRequest(stream as BrowseDuplexStream)
      })
    } catch (err) {
      console.warn('[agent-net] Discovery: could not register browse protocol:', err)
    }

    // Broadcast initial manifest, then on interval
    await this.broadcastManifest()
    this.manifestTimer = setInterval(() => {
      void this.broadcastManifest()
    }, MANIFEST_INTERVAL_MS)
  }

  /**
   * Stop the discovery manager and clean up resources.
   */
  async stop(): Promise<void> {
    if (this.manifestTimer) {
      clearInterval(this.manifestTimer)
      this.manifestTimer = undefined
    }
    try {
      await this.node.unhandle(BROWSE_PROTOCOL)
    } catch { /* ignore */ }
    this.registered = false
  }

  // ---------------------------------------------------------------------------
  // Peer index queries (local, zero network cost)
  // ---------------------------------------------------------------------------

  /**
   * Get all recently-seen peers (not stale).
   */
  getKnownPeers(): PeerIndexEntry[] {
    const cutoff = Date.now() - PEER_STALE_MS
    return [...this.peerIndex.values()].filter(p => p.lastSeen > cutoff)
  }

  /**
   * Get the index entry for a specific peer, or null if unknown/stale.
   */
  getPeer(peerId: string): PeerIndexEntry | null {
    const entry = this.peerIndex.get(peerId)
    if (!entry) return null
    if (entry.lastSeen < Date.now() - PEER_STALE_MS) return null
    return entry
  }

  /**
   * Test whether a specific peer probably holds content about a given topic.
   * Uses the peer's topic Bloom filter — O(1), zero network cost.
   * Returns null if the peer is unknown.
   */
  peerHasTopic(peerId: string, topic: string): boolean | null {
    const entry = this.getPeer(peerId)
    if (!entry) return null
    return entry.topicBloom.has(topic.toLowerCase())
  }

  /**
   * Test whether a specific peer probably holds a specific chunk ID.
   * Uses the peer's content Bloom filter — O(1), zero network cost.
   */
  peerHasChunk(peerId: string, chunkId: string): boolean | null {
    const entry = this.getPeer(peerId)
    if (!entry) return null
    return entry.contentBloom.has(chunkId)
  }

  /**
   * Returns a deduplicated, sorted list of all topics seen across known peers.
   */
  getNetworkTopics(): Array<{ topic: string; peers: string[] }> {
    // We can't enumerate topics from a bloom filter, so we aggregate
    // from actual peers — this requires a more detailed approach.
    // For now return a structured summary from the peer index.
    const topicPeers = new Map<string, string[]>()
    for (const entry of this.getKnownPeers()) {
      for (const coll of entry.collections) {
        if (!topicPeers.has(coll)) topicPeers.set(coll, [])
        topicPeers.get(coll)!.push(entry.peerId)
      }
    }
    return [...topicPeers.entries()]
      .map(([topic, peers]) => ({ topic, peers }))
      .sort((a, b) => b.peers.length - a.peers.length)
  }

  // ---------------------------------------------------------------------------
  // Active browse — fetches metadata from a specific remote peer
  // ---------------------------------------------------------------------------

  /**
   * Browse a remote peer's content via the BROWSE_PROTOCOL.
   * Returns chunk stubs (metadata without full content).
   * Throws on dial failure — callers should handle and surface as "peer offline."
   */
  async browse(
    peerId: string | PeerId,
    collection?: string,
    since?: number,
    limit: number = PAGE_SIZE
  ): Promise<BrowseResponse> {
    const peerIdStr = typeof peerId === 'string' ? peerId : peerId.toString()
    const requestId = crypto.randomUUID()
    const request: BrowseRequest = { requestId, collection, since, limit }
    const signal = AbortSignal.timeout(10_000)

    // Find the PeerId object from connected peers
    const connectedPeers = this.node.getPeers()
    const targetPeerId = connectedPeers.find(p => p.toString() === peerIdStr)

    if (!targetPeerId) {
      throw new Error(`Peer ${peerIdStr} is not currently connected`)
    }

    const rawStream = await this.node.dialProtocol(targetPeerId, BROWSE_PROTOCOL, { signal })
    const stream = rawStream as unknown as BrowseDuplexStream

    try {
      const responseChunks: Uint8Array[] = []
      async function* req() { yield encodeMessage(request) }
      await pipe(req(), (s) => lp.encode(s), stream.sink)
      await pipe(stream.source, (s) => lp.decode(s), async (source) => {
        for await (const chunk of source) {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
          responseChunks.push(bytes)
          break
        }
      })
      if (!responseChunks.length) throw new Error('No response from peer')
      return decodeMessage<BrowseResponse>(responseChunks[0])
    } finally {
      await (stream as { close(): Promise<void> }).close().catch(() => {})
    }
  }

  // ---------------------------------------------------------------------------
  // Manifest building and broadcasting
  // ---------------------------------------------------------------------------

  private async broadcastManifest(): Promise<void> {
    try {
      const manifest = await this.buildManifest()
      const encoded = encodeMessage(manifest)
      // @ts-expect-error — libp2p pubsub type varies
      await this.node.services.pubsub.publish(DISCOVERY_TOPIC, encoded)
    } catch (err) {
      // Swallow — no peers connected is normal early in startup
      if (!(String(err).includes('not subscribed') || String(err).includes('no peers'))) {
        console.warn('[agent-net] Discovery: manifest broadcast error:', err)
      }
    }
  }

  private async buildManifest(): Promise<DiscoveryManifest> {
    const topicBloom = new BloomFilter()
    const contentBloom = new BloomFilter()
    const collectionsSet = new Set<string>()
    let chunkCount = 0

    for (const store of this.stores) {
      const chunks = await store.list().catch(() => [])
      for (const chunk of chunks) {
        if (chunk._tombstone) continue
        chunkCount++
        contentBloom.add(chunk.id)
        for (const t of chunk.topic) topicBloom.add(t)
        if (chunk.collection) collectionsSet.add(chunk.collection)
      }
    }

    return {
      peerId: this.opts.localPeerId,
      displayName: this.opts.displayName,
      collections: [...collectionsSet].sort(),
      topicBloom: topicBloom.toBase64(),
      contentBloom: contentBloom.toBase64(),
      chunkCount,
      updatedAt: Date.now(),
    }
  }

  // ---------------------------------------------------------------------------
  // GossipSub message handler
  // ---------------------------------------------------------------------------

  private handleGossipMessage(event: CustomEvent<{ topic: string; data: Uint8Array }>): void {
    if (event.detail.topic !== DISCOVERY_TOPIC) return
    try {
      const manifest = decodeMessage<DiscoveryManifest>(event.detail.data)
      if (!manifest.peerId || manifest.peerId === this.opts.localPeerId) return
      this.updatePeerIndex(manifest)
    } catch { /* malformed manifest — ignore */ }
  }

  private updatePeerIndex(manifest: DiscoveryManifest): void {
    const entry: PeerIndexEntry = {
      peerId: manifest.peerId,
      displayName: manifest.displayName,
      collections: manifest.collections,
      topicBloom: BloomFilter.fromBase64(manifest.topicBloom),
      contentBloom: BloomFilter.fromBase64(manifest.contentBloom),
      chunkCount: manifest.chunkCount,
      updatedAt: manifest.updatedAt,
      lastSeen: Date.now(),
    }
    this.peerIndex.set(manifest.peerId, entry)

    // Check subscriptions
    void this.checkSubscriptions(entry)
  }

  private async checkSubscriptions(entry: PeerIndexEntry): Promise<void> {
    const { subscribedTopics = [], subscribedPeers = [] } = this.opts

    const peerMatch = subscribedPeers.includes(entry.peerId)
    const topicMatch = subscribedTopics.some(t => entry.topicBloom.has(t.toLowerCase()))

    if (!peerMatch && !topicMatch) return

    // Emit a subscription hit — the daemon can act on this (e.g. trigger a network query)
    // For now, log it. The daemon will subscribe to these events via the 'subscription-hit' event.
    this.onSubscriptionHit?.(entry)
  }

  /** Callback invoked when a subscription match is detected. Set by the daemon. */
  onSubscriptionHit?: (entry: PeerIndexEntry) => void

  // ---------------------------------------------------------------------------
  // Browse protocol handler (inbound)
  // ---------------------------------------------------------------------------

  private async handleBrowseRequest(stream: BrowseDuplexStream): Promise<void> {
    try {
      const requestChunks: Uint8Array[] = []
      await pipe(stream.source, (s) => lp.decode(s), async (source) => {
        for await (const chunk of source) {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
          requestChunks.push(bytes)
          break
        }
      })
      if (!requestChunks.length) return

      const req = decodeMessage<BrowseRequest>(requestChunks[0])
      const stubs = await this.buildBrowseStubs(req)

      const response: BrowseResponse = {
        requestId: req.requestId,
        peerId: this.opts.localPeerId,
        stubs: stubs.slice(0, req.limit ?? PAGE_SIZE),
        hasMore: stubs.length > (req.limit ?? PAGE_SIZE),
      }

      async function* res() { yield encodeMessage(response) }
      await pipe(res(), (s) => lp.encode(s), stream.sink)
    } catch (err) {
      console.warn('[agent-net] Browse handler error:', err)
    }
  }

  private async buildBrowseStubs(req: BrowseRequest): Promise<ChunkStub[]> {
    const allStubs: ChunkStub[] = []
    const limit = req.limit ?? PAGE_SIZE

    for (const store of this.stores) {
      const chunks = await store.list().catch(() => [])
      for (const chunk of chunks) {
        if (chunk._tombstone) continue
        if (req.collection && chunk.collection !== req.collection) continue
        if (req.since && chunk.source.timestamp <= req.since) continue

        allStubs.push({
          id: chunk.id,
          type: chunk.type,
          collection: chunk.collection,
          slug: chunk.slug,
          topic: chunk.topic,
          summary: chunk.content.slice(0, 200),
          timestamp: chunk.source.timestamp,
          hasEnvelope: !!chunk.contentEnvelope,
          linkCount: (chunk.links?.length ?? 0) + (chunk.supersedes ? 1 : 0),
        })
      }
    }

    return allStubs
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit + 1)  // +1 to detect hasMore
  }
}

// Internal type for stream handling
interface BrowseDuplexStream {
  source: AsyncIterable<Uint8Array>
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>
  close(): Promise<void>
}

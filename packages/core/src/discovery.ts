/**
 * Content discovery layer for Subspace Transceiver — Iroh transport.
 *
 * ARCHITECTURE
 * ────────────
 * Discovery works in two layers:
 *
 * 1. PASSIVE — Topic manifests broadcast via iroh-gossip every 60s.
 *    Each agent publishes a DiscoveryManifest containing:
 *      - A topic Bloom filter (what topics it holds content for)
 *      - A content Bloom filter (what chunk IDs it holds)
 *      - Collection list and chunk count
 *    Peers receive manifests, update their local PeerIndex, and can answer
 *    "does agent X probably have content about topic Y?" with zero round-trips.
 *
 * 2. ACTIVE — Browse queries via /subspace/browse/1.0.0 Iroh ALPN protocol.
 *    Browse requests return paginated chunk metadata from a specific peer.
 *
 * TRANSPORT
 * ─────────
 * Replaces libp2p GossipSub with iroh-gossip (HyParView/Plumtree).
 * The EngineBridge exposes `gossipJoin`, `gossipBroadcast`, `onGossipMessage`.
 */

import { EventEmitter } from 'node:events'
import type { EngineBridge, GossipMessage } from './engine-bridge.js'
import { BloomFilter } from './bloom.js'
import { encodeMessage, decodeMessage, DISCOVERY_TOPIC } from './protocol.js'
import { type HashcashStamp, type StampCache, verifyStamp } from './pow.js'
import type { IMemoryStore } from './store.js'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Protocol identifiers
// ---------------------------------------------------------------------------

export { DISCOVERY_TOPIC }
export const BROWSE_PROTOCOL = '/subspace/browse/1.0.0'
export const MANIFEST_PROTOCOL = '/subspace/manifest/1.0.0'

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Manifest broadcast by each agent via iroh-gossip.
 * Serialized as JSON and published to DISCOVERY_TOPIC.
 */
export interface DiscoveryManifest {
  /** Publisher's Iroh EndpointId (or DID:Key) */
  peerId: string
  /** Agent's global identity (canonical agent:// ID) */
  agentPeerId?: string
  displayName?: string
  collections: string[]
  /** Bloom filter of all topic strings this agent holds (base64) */
  topicBloom: string
  /** Bloom filter of all chunk IDs this agent holds (base64) */
  contentBloom: string
  chunkCount: number
  updatedAt: number
  /** Proof-of-work stamp (optional) */
  pow?: HashcashStamp
}

export interface BrowseRequest {
  requestId: string
  collection?: string
  since?: number
  limit?: number
}

export interface ChunkStub {
  id: string
  type: string
  collection?: string
  slug?: string
  topic: string[]
  summary: string
  timestamp: number
  hasEnvelope: boolean
  linkCount: number
}

export interface BrowseResponse {
  requestId: string
  peerId: string
  agentPeerId?: string
  stubs: ChunkStub[]
  hasMore: boolean
}

// ---------------------------------------------------------------------------
// Local peer index
// ---------------------------------------------------------------------------

export interface PeerIndexEntry {
  peerId: string
  agentPeerId?: string
  displayName?: string
  collections: string[]
  topicBloom: BloomFilter
  contentBloom: BloomFilter
  chunkCount: number
  updatedAt: number
  lastSeen: number
}

// ---------------------------------------------------------------------------
// DiscoveryManager
// ---------------------------------------------------------------------------

const MANIFEST_INTERVAL_MS = parseInt(process.env.SUBSPACE_MANIFEST_INTERVAL_MS ?? '60000', 10)
const PEER_STALE_MS = 5 * 60_000
const PAGE_SIZE = 50

export interface DiscoveryManagerOptions {
  localPeerId: string
  agentPeerId?: string
  displayName?: string
  subscribedTopics?: string[]
  subscribedPeers?: string[]
  stampCache?: StampCache
  powBitsForRequests?: number
  powWindowMs?: number
  requirePoW?: boolean
}

/**
 * Manages peer discovery, manifest broadcasting, and browse protocol.
 * Uses iroh-gossip (via EngineBridge) instead of libp2p GossipSub.
 */
export class DiscoveryManager extends EventEmitter {
  private bridge: EngineBridge
  private stores: IMemoryStore[]
  private opts: DiscoveryManagerOptions
  private peerIndex = new Map<string, PeerIndexEntry>()
  private manifestTimer?: ReturnType<typeof setInterval>
  private rebroadcastTimer?: ReturnType<typeof setTimeout>
  private gossipUnsub?: () => void
  private started = false
  /** Cached discovery topic hex (set during start()) */
  private discoveryTopicHex: string | null = null

  /**
   * @param bridge  The EngineBridge managing the Iroh engine.
   * @param stores  Memory stores whose content drives manifest generation.
   * @param opts    Discovery configuration.
   */
  constructor(
    bridge: EngineBridge,
    stores: IMemoryStore[],
    opts: DiscoveryManagerOptions
  ) {
    super()
    this.bridge = bridge
    this.stores = stores
    this.opts = opts
  }

  /**
   * Start discovery:
   * - Join the gossip discovery topic
   * - Start the periodic manifest broadcast
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Derive gossip topic hex from the discovery topic name
    const topicHex = crypto
      .createHash('sha256')
      .update(DISCOVERY_TOPIC, 'utf8')
      .digest('hex')
    this.discoveryTopicHex = topicHex

    // Subscribe to incoming gossip messages
    this.gossipUnsub = this.bridge.onGossipMessage((msg: GossipMessage) => {
      if (msg.topicHex === topicHex) {
        this.handleGossipMessage(msg)
      }
    })

    // Join the gossip topic (Iroh gossip)
    try {
      await this.bridge.gossipJoin({ topicHex, bootstrapPeers: [] })
    } catch (err) {
      console.warn('[subspace] Discovery: could not join gossip topic:', err)
    }

    // Delayed first broadcast + interval broadcasts
    setTimeout(() => { void this.broadcastManifest() }, 3000)
    this.manifestTimer = setInterval(() => {
      void this.broadcastManifest()
    }, MANIFEST_INTERVAL_MS)
  }

  /**
   * Trigger an immediate manifest re-broadcast (after new content is written).
   * Debounced to at most once per second.
   */
  triggerRebroadcast(): void {
    if (this.rebroadcastTimer) return
    this.rebroadcastTimer = setTimeout(() => {
      this.rebroadcastTimer = undefined
      void this.broadcastManifest()
    }, 1000)
  }

  /**
   * Stop the discovery manager and release resources.
   */
  async stop(): Promise<void> {
    if (this.manifestTimer) {
      clearInterval(this.manifestTimer)
      this.manifestTimer = undefined
    }
    if (this.rebroadcastTimer) {
      clearTimeout(this.rebroadcastTimer)
      this.rebroadcastTimer = undefined
    }
    if (this.gossipUnsub) {
      this.gossipUnsub()
      this.gossipUnsub = undefined
    }
    this.started = false
  }

  /**
   * Introduce a remote peer to the gossip discovery mesh.
   *
   * Calls gossipJoin with the peer's NodeId as a bootstrap peer. This prompts
   * iroh-gossip to establish a connection to the peer and exchange manifests.
   * Once connected, both peers will receive each other's periodic broadcasts.
   *
   * @param nodeId Iroh EndpointId (hex string) of the peer to introduce
   */
  async addDiscoveryPeer(nodeId: string): Promise<void> {
    if (!this.discoveryTopicHex) {
      throw new Error('Discovery not started — call start() first')
    }
    try {
      await this.bridge.gossipJoin({
        topicHex: this.discoveryTopicHex,
        bootstrapPeers: [nodeId],
      })
      // Immediately broadcast our manifest so the peer sees us right away
      void this.broadcastManifest()
    } catch (err) {
      console.warn('[subspace] Discovery: could not introduce peer:', err)
      throw err
    }
  }

  /**
   * Get all currently known peers from the peer index.
   */
  getKnownPeers(): PeerIndexEntry[] {
    const now = Date.now()
    return Array.from(this.peerIndex.values()).filter(
      (entry) => now - entry.lastSeen < PEER_STALE_MS
    )
  }

  /**
   * Check whether a specific peer probably has content for a given topic.
   * Uses the Bloom filter for a fast probabilistic check.
   * Returns true (probably), false (definitely not), or null (unknown peer).
   */
  peerProbablyHasTopic(peerId: string, topic: string): boolean {
    const entry = this.peerIndex.get(peerId)
    if (!entry) return false
    return entry.topicBloom.has(topic)
  }

  /**
   * Alias for peerProbablyHasTopic (backward compat with daemon API).
   */
  peerHasTopic(peerId: string, topic: string): boolean | null {
    const entry = this.peerIndex.get(peerId)
    if (!entry) return null
    return entry.topicBloom.has(topic)
  }

  /**
   * Check whether a specific peer probably has a specific chunk.
   */
  peerProbablyHasChunk(peerId: string, chunkId: string): boolean {
    const entry = this.peerIndex.get(peerId)
    if (!entry) return false
    return entry.contentBloom.has(chunkId)
  }

  /**
   * Trigger an active manifest sync with connected peers.
   * Phase 3.6: implement via Iroh ALPN stream.
   */
  async syncManifestsWithPeers(): Promise<void> {
    // Stub: Phase 3.6 implements direct manifest exchange via Iroh ALPN
  }

  // ---------------------------------------------------------------------------
  // Private — manifest broadcasting
  // ---------------------------------------------------------------------------

  private async broadcastManifest(): Promise<void> {
    const manifest = await this.buildManifest()
    const encoded = encodeMessage(manifest)

    const topicHex = crypto
      .createHash('sha256')
      .update(DISCOVERY_TOPIC, 'utf8')
      .digest('hex')

    // Self-index: store our own manifest so we appear in getKnownPeers()
    // (gossip does not echo messages back to the sender, so we do it ourselves)
    this.processManifestLocal(manifest)

    try {
      await this.bridge.gossipBroadcast(topicHex, encoded)
    } catch (err) {
      // Non-fatal — no peers connected yet is normal during startup
    }
  }

  private async buildManifest(): Promise<DiscoveryManifest> {
    const topicBloom = new BloomFilter()
    const contentBloom = new BloomFilter()
    let chunkCount = 0
    const collections = new Set<string>()

    for (const store of this.stores) {
      const chunks = await store.list().catch(() => [])
      for (const chunk of chunks) {
        if (chunk._tombstone) continue
        chunkCount++
        contentBloom.add(chunk.id)
        for (const topic of chunk.topic) {
          topicBloom.add(topic)
        }
        if (chunk.collection) {
          collections.add(chunk.collection)
        }
      }
    }

    const manifest: DiscoveryManifest = {
      peerId: this.opts.localPeerId,
      agentPeerId: this.opts.agentPeerId,
      displayName: this.opts.displayName,
      collections: Array.from(collections),
      topicBloom: topicBloom.toBase64(),
      contentBloom: contentBloom.toBase64(),
      chunkCount,
      updatedAt: Date.now(),
    }

    // Optionally attach a PoW stamp
    if (this.opts.stampCache) {
      const bits = this.opts.powBitsForRequests ?? 16
      const windowMs = this.opts.powWindowMs ?? 3_600_000
      manifest.pow = await this.opts.stampCache.getOrMine(
        this.opts.localPeerId,
        this.opts.localPeerId,
        bits,
        windowMs
      )
    }

    return manifest
  }

  // ---------------------------------------------------------------------------
  // Private — incoming gossip message handler
  // ---------------------------------------------------------------------------

  private handleGossipMessage(msg: GossipMessage): void {
    try {
      // Decode base64 payload → JSON manifest
      const bytes = Buffer.from(msg.payload, 'base64')
      const manifest = decodeMessage<DiscoveryManifest>(bytes)
      this.processManifest(manifest)
    } catch (err) {
      // Ignore malformed manifests
    }
  }

  /**
   * Process a manifest received from a REMOTE peer via gossip.
   * Drops own manifests (gossip relays shouldn't loop) and applies PoW checks.
   */
  private processManifest(manifest: DiscoveryManifest): void {
    // Drop our own manifests received via gossip (we self-index in broadcastManifest)
    if (manifest.peerId === this.opts.localPeerId) return
    this.processManifestLocal(manifest)
  }

  /**
   * Index a manifest into the peer index unconditionally (used for self-indexing
   * and any path that has already validated the manifest source).
   */
  private processManifestLocal(manifest: DiscoveryManifest): void {
    // Optional PoW verification (skip for self)
    const isSelf = manifest.peerId === this.opts.localPeerId
    if (!isSelf && this.opts.requirePoW && manifest.pow) {
      if (!verifyStamp(manifest.pow, manifest.peerId, manifest.peerId, 16, 3_600_000)) {
        return
      }
    } else if (!isSelf && this.opts.requirePoW && !manifest.pow) {
      return // PoW required but not present
    }

    // Update peer index
    const entry: PeerIndexEntry = {
      peerId: manifest.peerId,
      agentPeerId: manifest.agentPeerId,
      displayName: manifest.displayName,
      collections: manifest.collections,
      topicBloom: BloomFilter.fromBase64(manifest.topicBloom),
      contentBloom: BloomFilter.fromBase64(manifest.contentBloom),
      chunkCount: manifest.chunkCount,
      updatedAt: manifest.updatedAt,
      lastSeen: Date.now(),
    }
    this.peerIndex.set(manifest.peerId, entry)

    this.emit('manifest', entry)

    if (isSelf) return // No subscription triggers for self

    // Trigger subscribed topic fetches
    if (this.opts.subscribedTopics) {
      for (const topic of this.opts.subscribedTopics) {
        if (entry.topicBloom.has(topic)) {
          this.emit('subscribedTopicAvailable', { peerId: manifest.peerId, topic })
        }
      }
    }

    // Trigger subscribed peer fetches
    if (this.opts.subscribedPeers?.includes(manifest.peerId)) {
      this.emit('subscribedPeerManifest', entry)
    }
  }
}

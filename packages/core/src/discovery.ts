/**
 * Content discovery layer for Subspace Transceiver.
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
 * 2. ACTIVE — Browse queries via the /subspace/browse/1.0.0 libp2p protocol.
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
import { peerIdFromString } from '@libp2p/peer-id'
import { BloomFilter } from './bloom.js'
import type { IMemoryStore } from './store.js'
import { encodeMessage, decodeMessage } from './protocol.js'
import { type HashcashStamp, type StampCache, verifyStamp } from './pow.js'

// ---------------------------------------------------------------------------
// Protocol identifiers
// ---------------------------------------------------------------------------

export const DISCOVERY_TOPIC = '_subspace/discovery'
export const BROWSE_PROTOCOL = '/subspace/browse/1.0.0'
/** Direct peer-to-peer manifest exchange (fallback when GossipSub mesh is slow to form) */
export const MANIFEST_PROTOCOL = '/subspace/manifest/1.0.0'

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Manifest broadcast by each agent every MANIFEST_INTERVAL_MS.
 * Serialized as JSON and published to DISCOVERY_TOPIC via GossipSub.
 */
export interface DiscoveryManifest {
  /** Publisher's libp2p PeerId string (PSK node peer ID) */
  peerId: string
  /**
   * Agent's global identity peer ID (the canonical agent:// URI peer ID).
   * This may differ from peerId when the agent uses per-PSK derived keys.
   * Included so peers can map GLOBAL peer IDs → PSK peer IDs for browse.
   */
  agentPeerId?: string
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
  /** Proof-of-work stamp (optional, required when peers enforce requirePoW) */
  pow?: HashcashStamp
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
  /** Optional: the agent's global identity peer ID (may differ from PSK peerId) */
  agentPeerId?: string
  stubs: ChunkStub[]
  hasMore: boolean
}

// ---------------------------------------------------------------------------
// Local peer index — populated from received manifests
// ---------------------------------------------------------------------------

export interface PeerIndexEntry {
  peerId: string
  /** Agent's global identity peer ID (canonical agent:// ID), may differ from peerId */
  agentPeerId?: string
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

// SUBSPACE_MANIFEST_INTERVAL_MS env var allows fast manifest cycles in tests (default: 60s)
const MANIFEST_INTERVAL_MS = parseInt(process.env.SUBSPACE_MANIFEST_INTERVAL_MS ?? '60000', 10)
const PEER_STALE_MS = 5 * 60_000      // Consider peer stale after 5 minutes
const PAGE_SIZE = 50                   // Default browse page size

export interface DiscoveryManagerOptions {
  /** Local agent PeerId (PSK node peer ID for PSK sessions, global for global session) */
  localPeerId: string
  /**
   * Agent's global identity peer ID (may differ from localPeerId when using derived PSK keys).
   * Included in manifests so peers can map GLOBAL peer IDs → PSK peer IDs.
   */
  agentPeerId?: string
  /** Display name to include in manifests (optional) */
  displayName?: string
  /** Subscribed topics — trigger active fetch when matching manifests arrive */
  subscribedTopics?: string[]
  /** Subscribed peers — trigger active fetch when manifests arrive from these peers */
  subscribedPeers?: string[]
  // ── Proof-of-work (TODO-4e34c409) ────────────────────────────────────────
  /** Stamp cache shared with the daemon (optional — manifests skipped if absent) */
  stampCache?: StampCache
  /** Bits of difficulty for manifest stamps (default: 16) */
  powBitsForRequests?: number
  /** PoW time window in ms (default: 3_600_000) */
  powWindowMs?: number
  /** When true, drop incoming manifests that lack a valid PoW stamp */
  requirePoW?: boolean
}

export class DiscoveryManager {
  private node: Libp2p
  private stores: IMemoryStore[]
  private opts: DiscoveryManagerOptions
  private peerIndex = new Map<string, PeerIndexEntry>()
  private manifestTimer?: ReturnType<typeof setInterval>
  private registered = false
  private onPeerConnect?: (event: CustomEvent<PeerId>) => void

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
      console.warn('[subspace] Discovery: could not subscribe to GossipSub topic:', err)
    }

    // Register browse protocol handler
    try {
      // libp2p v3: handler receives (stream, connection) as separate args, not {stream}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.node as any).handle(BROWSE_PROTOCOL, async (stream: unknown, _connection: unknown) => {
        await this.handleBrowseRequest(stream)
      })
    } catch (err) {
      console.warn('[subspace] Discovery: could not register browse protocol:', err)
    }

    // Register direct manifest exchange protocol — a fallback that lets peers
    // pull our manifest via a point-to-point request when GossipSub mesh
    // formation is slow (e.g., under heavy parallel test load).
    try {
      await (this.node as any).handle(MANIFEST_PROTOCOL, async (stream: unknown, _connection: unknown) => {
        await this.handleManifestRequest(stream)
      })
    } catch (err) {
      console.warn('[subspace] Discovery: could not register manifest protocol:', err)
    }

    // On peer:connect, push our manifest to the newly-connected peer directly.
    // This ensures fast discovery even when GossipSub mesh isn't formed yet.
    const onPeerConnect = (event: CustomEvent<PeerId>) => {
      const remotePeerId = event.detail
      void this.pushManifestToPeer(remotePeerId).catch(() => {})
    }
    ;(this.node as unknown as { addEventListener(e: string, h: (evt: CustomEvent<PeerId>) => void): void })
      .addEventListener('peer:connect', onPeerConnect)
    this.onPeerConnect = onPeerConnect

    // Delay the first manifest broadcast to give peers time to connect and
    // for the GossipSub mesh to form.  Subsequent broadcasts are on the
    // interval timer.  triggerRebroadcast() from putMemory forces an early
    // re-broadcast once the store has data.
    const firstBroadcastDelay = 3000 // ms
    setTimeout(() => {
      void this.broadcastManifest()
    }, firstBroadcastDelay)
    this.manifestTimer = setInterval(() => {
      void this.broadcastManifest()
    }, MANIFEST_INTERVAL_MS)
  }

  /**
   * Trigger an immediate manifest re-broadcast (e.g. after new data is written).
   * Debounced to at most once per second to avoid flooding on burst writes.
   */
  private rebroadcastTimer?: ReturnType<typeof setTimeout>
  triggerRebroadcast(): void {
    if (this.rebroadcastTimer) return
    this.rebroadcastTimer = setTimeout(() => {
      this.rebroadcastTimer = undefined
      void this.broadcastManifest()
    }, 1000)
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
    try {
      await this.node.unhandle(MANIFEST_PROTOCOL)
    } catch { /* ignore */ }
    if (this.onPeerConnect) {
      ;(this.node as unknown as { removeEventListener(e: string, h: unknown): void })
        .removeEventListener('peer:connect', this.onPeerConnect)
      this.onPeerConnect = undefined
    }
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
    // Deduplicate: the index may store an entry under both PSK and GLOBAL peer IDs.
    const seen = new Set<string>()
    const result: PeerIndexEntry[] = []
    for (const entry of this.peerIndex.values()) {
      if (entry.lastSeen <= cutoff) continue
      const key = entry.peerId
      if (seen.has(key)) continue
      seen.add(key)
      result.push(entry)
    }
    return result
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

    // Resolve the target peer: look up directly-connected peers first.
    // If the caller used a GLOBAL peer ID (agentPeerId), check the peer index
    // for a PSK peer with that agentPeerId mapping — then dial the PSK peer.
    const connectedPeers = this.node.getPeers()
    let targetPeerId: PeerId

    // Resolve the target peer. Priority order:
    //
    // 1. peerIndex has a mapping where the STORED peerId differs from the lookup key
    //    (i.e., we know "GLOBAL_ID" → "PSK_ID"). Always prefer this — the PSK peer
    //    has actual content stores.
    //
    // 2. Try ALL connected peers that have peerIndex entries with agentPeerId == peerIdStr.
    //    This catches PSK peers whose manifest we received but whose PSK peerId we're
    //    not looking up directly.
    //
    // 3. Direct match: only if the peer is the exact peer ID (e.g., already a PSK peer ID).
    //    Skip this if the peer's peerIndex entry shows it's a "pure global" node (peerId
    //    == peerIdStr, no agentPeerId), which means it has no PSK stores.
    //
    // 4. Candidate scan: iterate all connected peers and try to browse each one.
    //    Return the first peer that reports itself as the target or has content.
    //
    // 5. Last resort: dial the peer ID directly.

    const indexEntry = this.peerIndex.get(peerIdStr)
    if (indexEntry && indexEntry.peerId !== peerIdStr) {
      // peerIndex maps peerIdStr (global) → indexEntry.peerId (PSK) — use PSK peer
      const pskMatch = connectedPeers.find(p => p.toString() === indexEntry.peerId)
      targetPeerId = pskMatch ?? peerIdFromString(indexEntry.peerId)
    } else {
      // Search connected peers for any that identify as the target's PSK node
      // (connected peer with peerIndex entry that has agentPeerId === peerIdStr)
      let foundViaPeerIndex: PeerId | undefined
      for (const cp of connectedPeers) {
        const cpStr = cp.toString()
        if (cpStr === peerIdStr) continue // skip the global peer itself
        const cpEntry = this.peerIndex.get(cpStr)
        if (cpEntry?.agentPeerId === peerIdStr) {
          foundViaPeerIndex = cp
          break
        }
      }

      if (foundViaPeerIndex) {
        targetPeerId = foundViaPeerIndex
      } else {
        // Direct match: only use if this peer has content (not a global-only node)
        const directMatch = connectedPeers.find(p => p.toString() === peerIdStr)
        const directEntry = directMatch ? this.peerIndex.get(peerIdStr) : undefined
        const isGlobalOnlyPeer = directEntry && directEntry.peerId === peerIdStr && !directEntry.agentPeerId

        if (directMatch && !isGlobalOnlyPeer) {
          targetPeerId = directMatch
        } else if (connectedPeers.length > 0) {
          // No mapping found (manifest exchange may not have happened yet).
          // Try ALL connected peers — any peer in this PSK session may serve the content.
          // Skip the global peer (peerIdStr) to avoid dialling global nodes with no stores.
          for (const candidate of connectedPeers) {
            if (candidate.toString() === peerIdStr) continue // skip global peer
            try {
              const candidateSignal = AbortSignal.timeout(5_000)
              const candidateStream = await this.node.dialProtocol(candidate, BROWSE_PROTOCOL, { signal: candidateSignal })
              const cs = candidateStream as unknown as {
                send(data: Uint8Array): boolean
                close(opts?: { signal?: AbortSignal }): Promise<void>
                [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
              }
              async function* candidateReq() { yield encodeMessage(request) }
              for await (const chunk of lp.encode(candidateReq())) { cs.send(chunk) }
              const candidateChunks: Uint8Array[] = []
              for await (const chunk of lp.decode(cs as AsyncIterable<Uint8Array>)) {
                const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
                candidateChunks.push(bytes)
                break
              }
              await cs.close().catch(() => {})
              if (candidateChunks.length > 0) {
                const candidateResp = decodeMessage<BrowseResponse>(candidateChunks[0])
                // Accept if this peer identifies as the target OR has any content
                if (candidateResp.agentPeerId === peerIdStr || candidateResp.peerId === peerIdStr || candidateResp.stubs.length > 0) {
                  return candidateResp
                }
              }
            } catch {
              // This peer doesn't support browse or is unreachable — skip
            }
          }
          // All candidates tried — fall back to dialing the target directly
          targetPeerId = peerIdFromString(peerIdStr)
        } else {
          // No connected peers at all — try dialing directly
          targetPeerId = peerIdFromString(peerIdStr)
        }
      }
    }

    const rawStream = await this.node.dialProtocol(targetPeerId, BROWSE_PROTOCOL, { signal })
    // libp2p v3 stream: read via `for await (const chunk of stream)`, write via stream.send(chunk)
    const stream = rawStream as unknown as {
      send(data: Uint8Array): boolean
      close(opts?: { signal?: AbortSignal }): Promise<void>
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
    }

    try {
      // Write the browse request (length-prefixed)
      async function* req() { yield encodeMessage(request) }
      for await (const chunk of lp.encode(req())) {
        stream.send(chunk)
      }

      // Read the browse response (length-prefixed)
      const responseChunks: Uint8Array[] = []
      for await (const chunk of lp.decode(stream as AsyncIterable<Uint8Array>)) {
        const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
        responseChunks.push(bytes)
        break
      }
      if (!responseChunks.length) throw new Error('No response from peer')
      return decodeMessage<BrowseResponse>(responseChunks[0])
    } finally {
      await stream.close().catch(() => {})
    }
  }

  // ---------------------------------------------------------------------------
  // Manifest building and broadcasting
  // ---------------------------------------------------------------------------

  private async broadcastManifest(): Promise<void> {
    try {
      const manifest = await this.buildManifest()
      const encoded = encodeMessage(manifest)
      // @ts-expect-error — libp2p pubsub type varies across helia versions
      await this.node.services.pubsub.publish(DISCOVERY_TOPIC, encoded)
    } catch (err) {
      // Swallow — no peers connected is normal early in startup
      if (!(String(err).includes('not subscribed') || String(err).includes('no peers'))) {
        console.warn('[subspace] Discovery: manifest broadcast error:', err)
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

    // Mine a PoW stamp if a stamp cache is configured
    let pow: HashcashStamp | undefined
    if (this.opts.stampCache) {
      const bits = this.opts.powBitsForRequests ?? 16
      const windowMs = this.opts.powWindowMs ?? 3_600_000
      try {
        pow = await this.opts.stampCache.getOrMine(this.opts.localPeerId, 'manifest', bits, windowMs)
      } catch (err) {
        console.warn('[subspace] Discovery: failed to mine manifest stamp:', err)
      }
    }

    return {
      peerId: this.opts.localPeerId,
      ...(this.opts.agentPeerId ? { agentPeerId: this.opts.agentPeerId } : {}),
      displayName: this.opts.displayName,
      collections: [...collectionsSet].sort(),
      topicBloom: topicBloom.toBase64(),
      contentBloom: contentBloom.toBase64(),
      chunkCount,
      updatedAt: Date.now(),
      ...(pow ? { pow } : {}),
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

      // PoW verification on incoming manifests
      if (this.opts.requirePoW || manifest.pow) {
        const bits = this.opts.powBitsForRequests ?? 16
        const windowMs = this.opts.powWindowMs ?? 3_600_000

        if (!manifest.pow) {
          if (this.opts.requirePoW) {
            console.warn(`[subspace] Discovery: dropped manifest from ${manifest.peerId} — missing PoW stamp`)
            return
          }
          // No stamp but not required — log warning and allow
          console.warn(`[subspace] Discovery: manifest from ${manifest.peerId} has no PoW stamp (requirePoW=false, allowing)`)
        } else {
          const valid = verifyStamp(manifest.pow, manifest.peerId, 'manifest', bits, windowMs)
          if (!valid) {
            console.warn(`[subspace] Discovery: dropped manifest from ${manifest.peerId} — invalid PoW stamp`)
            return
          }
        }
      }

      this.updatePeerIndex(manifest)
    } catch { /* malformed manifest — ignore */ }
  }

  private updatePeerIndex(manifest: DiscoveryManifest): void {
    const entry: PeerIndexEntry = {
      peerId: manifest.peerId,
      ...(manifest.agentPeerId ? { agentPeerId: manifest.agentPeerId } : {}),
      displayName: manifest.displayName,
      collections: manifest.collections,
      topicBloom: BloomFilter.fromBase64(manifest.topicBloom),
      contentBloom: BloomFilter.fromBase64(manifest.contentBloom),
      chunkCount: manifest.chunkCount,
      updatedAt: manifest.updatedAt,
      lastSeen: Date.now(),
    }
    this.peerIndex.set(manifest.peerId, entry)
    // Also index by agentPeerId so browse-by-global-peer-id works.
    // IMPORTANT: only overwrite an existing agentPeerId entry if the new entry
    // has a higher chunkCount OR the existing entry is a "global-only" mapping
    // (peerId === agentPeerId, meaning no PSK content). This prevents a global
    // manifest (chunkCount=0) from clobbering a richer PSK manifest (chunkCount>0)
    // when both are received concurrently via syncManifestsWithPeers().
    if (manifest.agentPeerId && manifest.agentPeerId !== manifest.peerId) {
      const existingByAgent = this.peerIndex.get(manifest.agentPeerId)
      // Overwrite if: no existing entry, OR existing is global-only, OR new has more content
      if (!existingByAgent ||
          existingByAgent.peerId === manifest.agentPeerId ||
          manifest.chunkCount >= existingByAgent.chunkCount) {
        this.peerIndex.set(manifest.agentPeerId, entry)
      }
    }

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

  private async handleBrowseRequest(rawStream: unknown): Promise<void> {
    // libp2p v3 stream: read via `for await (const chunk of stream)`, write via stream.send(chunk)
    const stream = rawStream as {
      send(data: Uint8Array): boolean
      close(opts?: { signal?: AbortSignal }): Promise<void>
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
    }
    try {
      // Read the browse request (length-prefixed)
      const requestChunks: Uint8Array[] = []
      for await (const chunk of lp.decode(stream as AsyncIterable<Uint8Array>)) {
        const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
        requestChunks.push(bytes)
        break
      }
      if (!requestChunks.length) return

      const req = decodeMessage<BrowseRequest>(requestChunks[0])
      const stubs = await this.buildBrowseStubs(req)

      const response: BrowseResponse = {
        requestId: req.requestId,
        peerId: this.opts.localPeerId,
        ...(this.opts.agentPeerId ? { agentPeerId: this.opts.agentPeerId } : {}),
        stubs: stubs.slice(0, req.limit ?? PAGE_SIZE),
        hasMore: stubs.length > (req.limit ?? PAGE_SIZE),
      }

      // Write the browse response (length-prefixed)
      async function* res() { yield encodeMessage(response) }
      for await (const chunk of lp.encode(res())) {
        stream.send(chunk)
      }
    } catch (err) {
      console.warn('[subspace] Browse handler error:', err)
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

  // ---------------------------------------------------------------------------
  // Direct manifest exchange protocol (fallback when GossipSub is slow)
  // ---------------------------------------------------------------------------

  /** Handle an inbound manifest-request: respond with our current manifest. */
  private async handleManifestRequest(rawStream: unknown): Promise<void> {
    const stream = rawStream as {
      send(data: Uint8Array): boolean
      close(opts?: { signal?: AbortSignal }): Promise<void>
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
    }
    try {
      const manifest = await this.buildManifest()
      const encoded = encodeMessage(manifest)
      async function* res() { yield encoded }
      for await (const chunk of lp.encode(res())) {
        stream.send(chunk)
      }
    } catch (err) {
      console.warn('[subspace] Manifest request handler error:', err)
    } finally {
      await stream.close().catch(() => {})
    }
  }

  /**
   * Actively exchange manifests with all currently connected peers.
   * Dials each connected peer via MANIFEST_PROTOCOL and reads their manifest.
   * This is a reliable synchronisation trigger that doesn't rely on GossipSub.
   */
  async syncManifestsWithPeers(): Promise<void> {
    const peers = this.node.getPeers()
    await Promise.all(peers.map(p => this.pushManifestToPeer(p).catch(() => {})))
  }

  /**
   * Push our manifest to a newly-connected peer via MANIFEST_PROTOCOL.
   * This is a reliable fallback that works even when GossipSub mesh hasn't formed.
   * Fire-and-forget — errors are silently ignored.
   */
  private async pushManifestToPeer(remotePeerId: PeerId): Promise<void> {
    const signal = AbortSignal.timeout(5_000)
    try {
      const rawStream = await this.node.dialProtocol(remotePeerId, MANIFEST_PROTOCOL, { signal })
      const stream = rawStream as unknown as {
        send(data: Uint8Array): boolean
        close(opts?: { signal?: AbortSignal }): Promise<void>
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
      }
      try {
        // Read their manifest back (they respond with theirs on the same stream)
        const responseChunks: Uint8Array[] = []
        for await (const chunk of lp.decode(stream as AsyncIterable<Uint8Array>)) {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
          responseChunks.push(bytes)
          break
        }
        if (responseChunks.length > 0) {
          const manifest = decodeMessage<DiscoveryManifest>(responseChunks[0])
          if (manifest.peerId && manifest.peerId !== this.opts.localPeerId) {
            this.updatePeerIndex(manifest)
          }
        }
      } finally {
        await stream.close().catch(() => {})
      }
    } catch {
      // Peer may not support this protocol yet or dial failed — silently ignore
    }
  }
}

// Internal type for stream handling
interface BrowseDuplexStream {
  source: AsyncIterable<Uint8Array>
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>
  close(): Promise<void>
}

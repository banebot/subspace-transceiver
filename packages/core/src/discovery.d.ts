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
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import { BloomFilter } from './bloom.js';
import type { IMemoryStore } from './store.js';
import { type HashcashStamp, type StampCache } from './pow.js';
export declare const DISCOVERY_TOPIC = "_subspace/discovery";
export declare const BROWSE_PROTOCOL = "/subspace/browse/1.0.0";
/** Direct peer-to-peer manifest exchange (fallback when GossipSub mesh is slow to form) */
export declare const MANIFEST_PROTOCOL = "/subspace/manifest/1.0.0";
/**
 * Manifest broadcast by each agent every MANIFEST_INTERVAL_MS.
 * Serialized as JSON and published to DISCOVERY_TOPIC via GossipSub.
 */
export interface DiscoveryManifest {
    /** Publisher's libp2p PeerId string (PSK node peer ID) */
    peerId: string;
    /**
     * Agent's global identity peer ID (the canonical agent:// URI peer ID).
     * This may differ from peerId when the agent uses per-PSK derived keys.
     * Included so peers can map GLOBAL peer IDs → PSK peer IDs for browse.
     */
    agentPeerId?: string;
    /** Display name (from agent profile, if set) */
    displayName?: string;
    /** Named collections this agent has content in */
    collections: string[];
    /** Bloom filter of all topic strings this agent holds (base64) */
    topicBloom: string;
    /** Bloom filter of all chunk IDs this agent holds (base64) */
    contentBloom: string;
    /** Total non-tombstoned chunk count */
    chunkCount: number;
    /** Unix ms when this manifest was generated */
    updatedAt: number;
    /** Proof-of-work stamp (optional, required when peers enforce requirePoW) */
    pow?: HashcashStamp;
}
/**
 * A browse request sent via BROWSE_PROTOCOL.
 */
export interface BrowseRequest {
    requestId: string;
    /** Omit to browse all collections */
    collection?: string;
    /** Pagination cursor — send the last seen chunk's timestamp */
    since?: number;
    limit?: number;
}
/**
 * Metadata stub for a chunk — enough to display a listing without full content.
 */
export interface ChunkStub {
    id: string;
    type: string;
    collection?: string;
    slug?: string;
    topic: string[];
    /** First 200 chars of content (summary) */
    summary: string;
    timestamp: number;
    hasEnvelope: boolean;
    linkCount: number;
}
export interface BrowseResponse {
    requestId: string;
    peerId: string;
    /** Optional: the agent's global identity peer ID (may differ from PSK peerId) */
    agentPeerId?: string;
    stubs: ChunkStub[];
    hasMore: boolean;
}
export interface PeerIndexEntry {
    peerId: string;
    /** Agent's global identity peer ID (canonical agent:// ID), may differ from peerId */
    agentPeerId?: string;
    displayName?: string;
    collections: string[];
    topicBloom: BloomFilter;
    contentBloom: BloomFilter;
    chunkCount: number;
    updatedAt: number;
    /** When we last received a manifest from this peer */
    lastSeen: number;
}
export interface DiscoveryManagerOptions {
    /** Local agent PeerId (PSK node peer ID for PSK sessions, global for global session) */
    localPeerId: string;
    /**
     * Agent's global identity peer ID (may differ from localPeerId when using derived PSK keys).
     * Included in manifests so peers can map GLOBAL peer IDs → PSK peer IDs.
     */
    agentPeerId?: string;
    /** Display name to include in manifests (optional) */
    displayName?: string;
    /** Subscribed topics — trigger active fetch when matching manifests arrive */
    subscribedTopics?: string[];
    /** Subscribed peers — trigger active fetch when manifests arrive from these peers */
    subscribedPeers?: string[];
    /** Stamp cache shared with the daemon (optional — manifests skipped if absent) */
    stampCache?: StampCache;
    /** Bits of difficulty for manifest stamps (default: 16) */
    powBitsForRequests?: number;
    /** PoW time window in ms (default: 3_600_000) */
    powWindowMs?: number;
    /** When true, drop incoming manifests that lack a valid PoW stamp */
    requirePoW?: boolean;
}
export declare class DiscoveryManager {
    private node;
    private stores;
    private opts;
    private peerIndex;
    private manifestTimer?;
    private registered;
    private onPeerConnect?;
    constructor(node: Libp2p, stores: IMemoryStore[], opts: DiscoveryManagerOptions);
    /**
     * Start the discovery manager:
     * - Subscribe to DISCOVERY_TOPIC to receive peer manifests
     * - Register the BROWSE_PROTOCOL handler
     * - Start the periodic manifest broadcast timer
     * - Broadcast an initial manifest immediately
     */
    start(): Promise<void>;
    /**
     * Trigger an immediate manifest re-broadcast (e.g. after new data is written).
     * Debounced to at most once per second to avoid flooding on burst writes.
     */
    private rebroadcastTimer?;
    triggerRebroadcast(): void;
    /**
     * Stop the discovery manager and clean up resources.
     */
    stop(): Promise<void>;
    /**
     * Get all recently-seen peers (not stale).
     */
    getKnownPeers(): PeerIndexEntry[];
    /**
     * Get the index entry for a specific peer, or null if unknown/stale.
     */
    getPeer(peerId: string): PeerIndexEntry | null;
    /**
     * Test whether a specific peer probably holds content about a given topic.
     * Uses the peer's topic Bloom filter — O(1), zero network cost.
     * Returns null if the peer is unknown.
     */
    peerHasTopic(peerId: string, topic: string): boolean | null;
    /**
     * Test whether a specific peer probably holds a specific chunk ID.
     * Uses the peer's content Bloom filter — O(1), zero network cost.
     */
    peerHasChunk(peerId: string, chunkId: string): boolean | null;
    /**
     * Returns a deduplicated, sorted list of all topics seen across known peers.
     */
    getNetworkTopics(): Array<{
        topic: string;
        peers: string[];
    }>;
    /**
     * Browse a remote peer's content via the BROWSE_PROTOCOL.
     * Returns chunk stubs (metadata without full content).
     * Throws on dial failure — callers should handle and surface as "peer offline."
     */
    browse(peerId: string | PeerId, collection?: string, since?: number, limit?: number): Promise<BrowseResponse>;
    private broadcastManifest;
    private buildManifest;
    private handleGossipMessage;
    private updatePeerIndex;
    private checkSubscriptions;
    /** Callback invoked when a subscription match is detected. Set by the daemon. */
    onSubscriptionHit?: (entry: PeerIndexEntry) => void;
    private handleBrowseRequest;
    private buildBrowseStubs;
    /** Handle an inbound manifest-request: respond with our current manifest. */
    private handleManifestRequest;
    /**
     * Actively exchange manifests with all currently connected peers.
     * Dials each connected peer via MANIFEST_PROTOCOL and reads their manifest.
     * This is a reliable synchronisation trigger that doesn't rely on GossipSub.
     */
    syncManifestsWithPeers(): Promise<void>;
    /**
     * Push our manifest to a newly-connected peer via MANIFEST_PROTOCOL.
     * This is a reliable fallback that works even when GossipSub mesh hasn't formed.
     * Fire-and-forget — errors are silently ignored.
     */
    private pushManifestToPeer;
}
//# sourceMappingURL=discovery.d.ts.map
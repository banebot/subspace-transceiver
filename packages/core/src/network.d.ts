/**
 * Network join/leave orchestration for Subspace Transceiver.
 *
 * A "network" is defined by a PSK. All peers with the same PSK share:
 * - The same DHT announcement key (peer discovery)
 * - The same GossipSub topic (OrbitDB CRDT replication channel)
 * - The same envelope encryption key (message privacy)
 * - The same libp2p private network PSK (connection filter)
 *
 * Each node has a UNIQUE identity keypair (from identity.ts) that is
 * separate from the PSK. The PSK governs network access; the identity
 * governs content authorship and PeerId uniqueness.
 *
 * Each network has TWO namespaces:
 * - 'skill'  — portable across projects (global agent knowledge)
 * - 'project' — scoped to a specific project/repo
 *
 * Internal NetworkSession holds live references (Libp2p node, stores, discovery).
 * External NetworkInfoDTO is serialisable and safe for API responses.
 */
import type { Libp2p } from 'libp2p';
import type { OrbitDB } from '@orbitdb/core';
import type { Helia } from 'helia';
import type { PrivateKey } from '@libp2p/interface';
import { type NetworkKeys } from './crypto.js';
import type { SubspaceConnectionPruner } from './connection-pruner.js';
import { EpochManager, type EpochConfig } from './epoch-manager.js';
import type { IMemoryStore } from './store.js';
import { BacklinkIndex } from './backlink-index.js';
import { DiscoveryManager } from './discovery.js';
import type { StampCache } from './pow.js';
/**
 * Internal live session — holds all runtime resources for an active network.
 * NOT serialisable — do not expose directly in API responses.
 */
export interface NetworkSession {
    /** Unique network identifier — SHA-256(PSK) as hex string */
    id: string;
    /** Human-readable label (optional, from config) */
    name?: string;
    /** Live libp2p node for this network */
    node: Libp2p;
    /** Connection pruner — stops pending prune timers on leave. Null when disabled. */
    pruner: SubspaceConnectionPruner | null;
    /** Shared Helia IPFS node (must be stopped when leaving the network) */
    helia: Helia;
    /** Shared OrbitDB instance */
    orbitdb: OrbitDB;
    /** Memory stores, keyed by namespace (backed by EpochManager for disk reclamation) */
    stores: {
        skill: IMemoryStore;
        project: IMemoryStore;
    };
    /** Epoch managers (same objects as stores, cast — for epoch lifecycle operations) */
    epochManagers: {
        skill: EpochManager;
        project: EpochManager;
    };
    /** In-memory backlink index for content graph traversal */
    backlinkIndex: BacklinkIndex;
    /** Discovery/browse manager — manifests + peer index */
    discovery: DiscoveryManager;
    /** Derived keys for this network */
    networkKeys: NetworkKeys;
    /** Agent identity private key (signing + libp2p identity) */
    agentPrivateKey: PrivateKey;
    /** Close Level databases that Helia.stop() does not reach */
    closeLevelStores: () => Promise<void>;
}
/**
 * Serialisable network info DTO — safe for HTTP API responses and config.
 */
export interface NetworkInfoDTO {
    id: string;
    name?: string;
    peerId: string;
    peers: number;
    namespaces: ['skill', 'project'];
    /** Known peers from the discovery layer */
    knownPeers: number;
    /** Listening multiaddrs of this PSK node (for explicit peer dialing in test harnesses) */
    multiaddrs: string[];
}
/**
 * Derive a stable network ID from a PSK.
 * Uses SHA-256(PSK) as a fingerprint — does not expose the PSK itself.
 */
export declare function deriveNetworkId(psk: string): string;
/**
 * Join (or create) a network identified by the given PSK.
 * Starting a node, initialising OrbitDB stores, and connecting to peers
 * all happen here. Returns a live NetworkSession.
 *
 * @param psk             The pre-shared key for this network.
 * @param agentPrivateKey Persistent agent identity key (from loadOrCreateIdentity).
 * @param options         Network join options.
 */
export declare function joinNetwork(psk: string, agentPrivateKey: PrivateKey, options: {
    name?: string;
    dataDir: string;
    port?: number;
    displayName?: string;
    minConnections?: number;
    maxConnections?: number;
    trustedBootstrapPeers?: string[];
    /** Circuit relay v2 multiaddrs. Overrides built-in RELAY_ADDRESSES when provided. */
    relayAddresses?: string[];
    subscribedTopics?: string[];
    subscribedPeers?: string[];
    stampCache?: StampCache;
    powBitsForRequests?: number;
    powWindowMs?: number;
    requirePoW?: boolean;
    epochConfig?: EpochConfig;
}): Promise<NetworkSession>;
/**
 * Leave a network — stop discovery, close all stores and stop the libp2p node.
 * After this call, the session should be discarded.
 */
export declare function leaveNetwork(session: NetworkSession): Promise<void>;
/**
 * Convert a live NetworkSession to a serialisable NetworkInfoDTO.
 */
export declare function sessionToDTO(session: NetworkSession): NetworkInfoDTO;
/**
 * A GlobalSession is a lightweight always-on connection to the global Subspace
 * network. It gives the agent:
 *
 *   - A stable, globally routable identity (Ed25519 PeerId via circuit relay)
 *   - Participation in the public GossipSub discovery topic
 *   - The ability to discover and browse other agents anywhere on the internet
 *   - No PSK required — global presence is the default
 *
 * PSK networks (NetworkSession) are overlays on top of the global network.
 * They add encrypted memory storage and private content sharing, but the
 * agent exists on the internet from the moment the daemon starts.
 *
 * The GlobalSession has NO OrbitDB stores — content storage requires joining
 * a PSK network. The discovery layer will publish empty bloom filters until
 * PSK sessions are joined and content is written, which is correct: the agent
 * is present and addressable on the network before it has published anything.
 */
export interface GlobalSession {
    /** The underlying libp2p node — gives this agent its global PeerId and routing */
    node: Libp2p;
    /** Connection pruner — stops pending prune timers on leave. Null when disabled. */
    pruner: SubspaceConnectionPruner | null;
    /**
     * Discovery manager — publishes public manifests on the well-known
     * _subspace/discovery GossipSub topic, maintains the public peer index,
     * and serves the /subspace/browse/1.0.0 protocol to any incoming peer.
     */
    discovery: DiscoveryManager;
    /** The agent's libp2p PeerId string — stable across restarts */
    localPeerId: string;
    /** TCP port this node listens on (for constructing dial-able multiaddrs) */
    port: number;
}
/**
 * Join the global Subspace network — connect to bootstrap/relay infrastructure,
 * start broadcasting public discovery manifests, and register the browse protocol
 * handler so any peer can browse this agent's public content.
 *
 * This is called once at daemon startup, before any PSK networks are joined.
 * It gives the agent global presence and addressability from first start.
 *
 * @param agentPrivateKey  Persistent Ed25519 identity key from identity.ts.
 * @param options          Connection and discovery configuration.
 */
export declare function joinGlobalNetwork(agentPrivateKey: PrivateKey, options?: {
    port?: number;
    displayName?: string;
    minConnections?: number;
    maxConnections?: number;
    trustedBootstrapPeers?: string[];
    /** Circuit relay v2 multiaddrs. Overrides built-in RELAY_ADDRESSES when provided. */
    relayAddresses?: string[];
    subscribedTopics?: string[];
    subscribedPeers?: string[];
    stampCache?: StampCache;
    powBitsForRequests?: number;
    powWindowMs?: number;
    requirePoW?: boolean;
}): Promise<GlobalSession>;
/**
 * Leave the global network — stop discovery and shut down the libp2p node.
 * Called during daemon shutdown, after all PSK sessions have been left.
 */
export declare function leaveGlobalNetwork(session: GlobalSession): Promise<void>;
//# sourceMappingURL=network.d.ts.map
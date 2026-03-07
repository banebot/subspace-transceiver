/**
 * libp2p node factory for Subspace Transceiver.
 *
 * KEY CHANGES FROM ORIGINAL
 * ─────────────────────────
 * 1. Node identity now uses the AGENT IDENTITY KEY (persistent per-agent Ed25519
 *    keypair from identity.ts), NOT a PSK-derived key.
 *    Rationale: the original code derived the private key from the PSK, giving
 *    every node on the same network the same PeerId. This breaks DHT routing and
 *    makes chunk signing meaningless. The agent identity key is stable, unique,
 *    and independent of which network(s) the agent participates in.
 *
 * 2. GossipSub hardened (TODO-ebb16396):
 *    - floodPublish: true  — critical messages propagate even through malicious peers
 *    - doPX: true          — peer exchange reduces eclipse attack surface
 *    - scoreThresholds     — peers with bad gossip scores are mesh-excluded
 *
 * 3. Connection manager tuned for eclipse resistance:
 *    - minConnections: 5  — ensures topology diversity
 *    - maxConnections: 50 — prevents connection exhaustion
 *
 * Creates a fully configured libp2p node with:
 * - TCP + Circuit Relay v2 transports
 * - Noise protocol encryption
 * - Yamux stream multiplexing
 * - KAD-DHT peer routing (v16 requires ping service)
 * - GossipSub pub/sub (used by OrbitDB for CRDT replication + discovery)
 * - mDNS local network discovery
 * - AutoNAT + DCUtR for NAT traversal
 * - Ping (required by KAD-DHT v16)
 *
 * NOTE: @libp2p/pnet (PSK connection filter) has been intentionally removed.
 * pnet blocks public relay/bootstrap nodes that lack the PSK, preventing
 * DCUtR hole punching and circuit relay across NATs. Network isolation is
 * enforced at the application layer:
 *   - GossipSub topic is derived from the PSK — outsiders see a different hash
 *   - All content is AES-256-GCM encrypted with a PSK-derived key
 *
 * CONNECTION PRUNER: inbound peers that never subscribe to any `_subspace/`
 * GossipSub topic within graceMs (default 30 s) are disconnected, reclaiming
 * the slot. Peers we dialled ourselves (bootstrap / relay) are exempt.
 * See SubspaceConnectionPruner in connection-pruner.ts.
 *
 * CRITICAL SERVICE ORDER: `identify` MUST be listed first in the services object.
 * circuitRelayTransport() depends on the identify protocol being registered
 * before it can negotiate relay connections. Wrong order = silent relay failure.
 */
import { type Libp2p } from 'libp2p';
import { SubspaceConnectionPruner, type ConnectionPrunerOptions } from './connection-pruner.js';
import type { PrivateKey } from '@libp2p/interface';
export interface CreateNodeOptions {
    /** TCP listen port. 0 = OS-assigned (default). */
    port?: number;
    /** Local data directory (unused by node itself, passed for logging context). */
    dataDir?: string;
    /**
     * Minimum peer connections to maintain for eclipse attack resistance.
     * Default: 5. Increase for higher-security deployments.
     */
    minConnections?: number;
    /**
     * Maximum peer connections (prevents resource exhaustion).
     * Default: 50.
     */
    maxConnections?: number;
    /**
     * Trusted bootstrap peer multiaddrs that are always connected.
     * Pinned peers are harder to eclipse away from.
     */
    trustedBootstrapPeers?: string[];
    /**
     * Circuit relay v2 multiaddrs for NAT traversal.
     * When not provided (or empty), falls back to the built-in RELAY_ADDRESSES.
     * Override from ~/.subspace/config.yaml to point at your own relay server.
     */
    relayAddresses?: string[];
    /**
     * Connection pruner options. Inbound peers that never subscribe to a
     * `_subspace/` GossipSub topic within graceMs are disconnected.
     * Pass `false` to disable pruning (useful in tests).
     */
    connectionPruner?: ConnectionPrunerOptions | false;
}
/**
 * A started libp2p node bundled with its connection pruner.
 * Call pruner.stop() before node.stop() to clear pending timers.
 */
export interface LibP2pNodeWithPruner {
    node: Libp2p;
    pruner: SubspaceConnectionPruner | null;
}
/**
 * Create and start a libp2p node for the given agent.
 *
 * The node is PSK-agnostic — it connects to the global bootstrap/relay
 * infrastructure regardless of whether a PSK network is active. PSK isolation
 * is enforced at the application layer (GossipSub topic derivation + AES-256-GCM
 * content encryption) not at the transport layer.
 *
 * This function is used for both:
 *   - The always-on global session (no PSK, just identity + connectivity)
 *   - Per-PSK network sessions (OrbitDB + encrypted content sharing on top)
 *
 * @param agentPrivateKey Persistent per-agent Ed25519 key from identity.ts.
 *                        Determines the node's PeerId (unique per agent, stable across restarts).
 * @param options         Optional node configuration.
 */
export declare function createLibp2pNode(agentPrivateKey: PrivateKey, options?: CreateNodeOptions): Promise<LibP2pNodeWithPruner>;
/**
 * Derive the PeerId string from an agent private key.
 * Useful for logging / config without starting a full node.
 */
export declare function derivePeerId(agentPrivateKey: PrivateKey): string;
//# sourceMappingURL=node.d.ts.map
/**
 * Hardcoded bootstrap and relay multiaddrs for the Subspace P2P layer.
 *
 * BOOTSTRAP_ADDRESSES: IPFS default bootstrap nodes (Protocol Labs).
 * RELAY_ADDRESSES: Circuit relay v2 nodes for NAT traversal.
 *
 * Last verified: 2026-03-05
 *
 * To update these addresses:
 *   1. Check https://github.com/ipfs/kubo/blob/master/config/bootstrap_peers.go
 *      for the latest IPFS bootstrap peers.
 *   2. Check https://github.com/libp2p/js-libp2p/blob/main/packages/libp2p/src/config/defaults.ts
 *      for relay addresses used by js-libp2p.
 *   3. Update both lists below and update the "Last verified" date.
 *   4. Run the integration tests (store.test.ts) to confirm replication still works.
 *
 * RELAY INFRASTRUCTURE NOTE (2026-03-05):
 *   relay.libp2p.io DNS no longer resolves (ENOTFOUND). Protocol Labs shut down
 *   the dedicated public relay infrastructure. RELAY_ADDRESSES now points at the
 *   same Protocol Labs peers via the still-working bootstrap.libp2p.io DNS. Those
 *   nodes MAY support circuit-relay-v2 server (Kubo >= 0.19 enables it by default).
 *
 *   For reliable NAT traversal in production, operators SHOULD run their own relay
 *   node (see https://github.com/libp2p/js-libp2p/tree/main/packages/relay-server)
 *   and configure it via the `relayAddresses` field in ~/.subspace/config.yaml.
 *   The daemon will warn on startup if no relay addresses resolve.
 */
/**
 * IPFS default bootstrap nodes. Peers dial these on startup to enter the DHT.
 * At least 4 nodes for resilience.
 */
export declare const BOOTSTRAP_ADDRESSES: string[];
/**
 * Circuit relay v2 candidate nodes for NAT traversal.
 *
 * These are the Protocol Labs bootstrap peers accessed via bootstrap.libp2p.io
 * (which resolves) rather than the defunct relay.libp2p.io DNS.  Kubo nodes
 * running >= 0.19 enable circuit-relay-v2 server by default, so these are
 * reasonable best-effort candidates.
 *
 * Override via `relayAddresses` in ~/.subspace/config.yaml for deterministic
 * NAT traversal — especially important for beta deployments.
 *
 * Direct IP fallbacks are included so the daemon can still attempt relay
 * connections even when DNS resolution is degraded.
 */
export declare const RELAY_ADDRESSES: string[];
//# sourceMappingURL=bootstrap.d.ts.map
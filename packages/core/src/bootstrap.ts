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
export const BOOTSTRAP_ADDRESSES: string[] = [
  // Protocol Labs bootstrap nodes — verified 2026-03-05 (bootstrap.libp2p.io resolves)
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  // Protocol Labs sv15 — direct IP fallback (same peer as QmNnooDu7… above)
  '/ip4/147.135.44.132/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  // DigitalOcean NYC — long-running community bootstrap node
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
]

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
export const RELAY_ADDRESSES: string[] = [
  // sv15.bootstrap.libp2p.io — resolves, direct IP included as fallback
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/ip4/147.135.44.132/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  // ny5.bootstrap.libp2p.io — New York City
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/ip4/51.81.93.51/tcp/4001/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  // am6.bootstrap.libp2p.io — Amsterdam
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/ip4/54.38.47.166/tcp/4001/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
]

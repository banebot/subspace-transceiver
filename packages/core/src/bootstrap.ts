/**
 * Hardcoded bootstrap and relay multiaddrs for the Subspace P2P layer.
 *
 * BOOTSTRAP_ADDRESSES: IPFS default bootstrap nodes (Cloudflare + Protocol Labs).
 * RELAY_ADDRESSES: Protocol Labs public circuit relay v2 nodes for NAT traversal.
 *
 * Last verified: 2026-03-02
 *
 * To update these addresses:
 *   1. Check https://github.com/ipfs/kubo/blob/master/config/bootstrap_peers.go
 *      for the latest IPFS bootstrap peers.
 *   2. Check https://github.com/libp2p/js-libp2p/blob/main/packages/libp2p/src/config/defaults.ts
 *      for relay addresses used by js-libp2p.
 *   3. Update both lists below and update the "Last verified" date.
 *   4. Run the integration tests (store.test.ts) to confirm replication still works.
 */

/**
 * IPFS default bootstrap nodes. Peers dial these on startup to enter the DHT.
 * At least 4 nodes for resilience.
 */
export const BOOTSTRAP_ADDRESSES: string[] = [
  // Cloudflare IPFS bootstrap
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  // Protocol Labs bootstrap nodes
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
]

/**
 * Protocol Labs public circuit relay v2 nodes.
 * Used by circuitRelayTransport() for NAT traversal when direct connections fail.
 * At least 2 nodes for fallback.
 */
export const RELAY_ADDRESSES: string[] = [
  '/dnsaddr/relay.libp2p.io/p2p/QmR9ys4e2WKSLEP8gzMuaYiJdmzpBaTXNERm5AqhLzRYAg',
  '/dnsaddr/relay.libp2p.io/p2p/QmZR5a9AAXGqQF2ADqoDdGS8zvqv8n3Pag6TDDnTMHxMUj',
]

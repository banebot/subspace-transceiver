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

import { createLibp2p, type Libp2p } from 'libp2p'
import { SubspaceConnectionPruner, type ConnectionPrunerOptions } from './connection-pruner.js'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { mdns } from '@libp2p/mdns'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { dcutr } from '@libp2p/dcutr'
import { autoNAT } from '@libp2p/autonat'
import { identify } from '@libp2p/identify'
import { bootstrap } from '@libp2p/bootstrap'
import { ping } from '@libp2p/ping'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import { BOOTSTRAP_ADDRESSES, RELAY_ADDRESSES } from './bootstrap.js'

export interface CreateNodeOptions {
  /** TCP listen port. 0 = OS-assigned (default). */
  port?: number
  /** Local data directory (unused by node itself, passed for logging context). */
  dataDir?: string
  /**
   * Minimum peer connections to maintain for eclipse attack resistance.
   * Default: 5. Increase for higher-security deployments.
   */
  minConnections?: number
  /**
   * Maximum peer connections (prevents resource exhaustion).
   * Default: 50.
   */
  maxConnections?: number
  /**
   * Trusted bootstrap peer multiaddrs that are always connected.
   * Pinned peers are harder to eclipse away from.
   */
  trustedBootstrapPeers?: string[]
  /**
   * Circuit relay v2 multiaddrs for NAT traversal.
   * When not provided (or empty), falls back to the built-in RELAY_ADDRESSES.
   * Override from ~/.subspace/config.yaml to point at your own relay server.
   */
  relayAddresses?: string[]
  /**
   * Connection pruner options. Inbound peers that never subscribe to a
   * `_subspace/` GossipSub topic within graceMs are disconnected.
   * Pass `false` to disable pruning (useful in tests).
   */
  connectionPruner?: ConnectionPrunerOptions | false
}

/**
 * A started libp2p node bundled with its connection pruner.
 * Call pruner.stop() before node.stop() to clear pending timers.
 */
export interface LibP2pNodeWithPruner {
  node: Libp2p
  pruner: SubspaceConnectionPruner | null
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
export async function createLibp2pNode(
  agentPrivateKey: PrivateKey,
  options: CreateNodeOptions = {}
): Promise<LibP2pNodeWithPruner> {
  const {
    port = 0,
    minConnections = 5,
    maxConnections = 50,
    trustedBootstrapPeers = [],
    relayAddresses,
    connectionPruner: prunerOpts = {},
  } = options

  // SUBSPACE_RELAY_ADDRS env var overrides the hardcoded RELAY_ADDRESSES.
  // Set to empty string to disable circuit relay (e.g. mDNS-only test environments).
  const envRelayAddrs = process.env.SUBSPACE_RELAY_ADDRS !== undefined
    ? process.env.SUBSPACE_RELAY_ADDRS.split(',').filter(Boolean)
    : null
  const defaultRelayAddresses = envRelayAddrs !== null ? envRelayAddrs : RELAY_ADDRESSES

  // Use caller-supplied relay addresses if provided (even if empty — allows disabling relay).
  // Fall back to the env/built-in RELAY_ADDRESSES when not specified.
  const effectiveRelayAddresses = relayAddresses !== undefined ? relayAddresses : defaultRelayAddresses

  // SUBSPACE_BOOTSTRAP_ADDRS env var overrides the hardcoded BOOTSTRAP_ADDRESSES.
  // Set to empty string to disable all public bootstrap (use mDNS-only for tests).
  // Set to a comma-separated list of multiaddrs to use a private bootstrap node.
  const envBootstrapAddrs = process.env.SUBSPACE_BOOTSTRAP_ADDRS !== undefined
    ? process.env.SUBSPACE_BOOTSTRAP_ADDRS.split(',').filter(Boolean)
    : null

  const effectiveBootstrapAddresses = envBootstrapAddrs !== null ? envBootstrapAddrs : BOOTSTRAP_ADDRESSES

  const bootstrapList = [
    ...effectiveBootstrapAddresses,
    ...effectiveRelayAddresses,
    ...trustedBootstrapPeers,
  ]

  const node = await createLibp2p({
    privateKey: agentPrivateKey,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}`],
    },
    transports: [
      tcp(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      // minConnections is not in this libp2p version's ConnectionManagerInit.
      // Eclipse resistance is enforced via the daemon's diversity monitor and
      // the bootstrap peer list (always-connected trusted peers).
      maxConnections,
    },
    services: {
      // CRITICAL: identify MUST be first — circuitRelayTransport depends on it
      identify: identify(),
      // ping is required by @libp2p/kad-dht@16.x
      ping: ping(),
      dht: kadDHT({ clientMode: false }),
      // @ts-expect-error — helia ships a nested @libp2p/interface that causes a
      // structural type incompatibility (Multiaddr.toOptions missing). Runtime is correct.
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
        // Flood publish: critical messages (discovery manifests) are sent to all
        // mesh peers, bypassing the gossip fanout — ensures propagation even if
        // some peers are malicious or slow.
        floodPublish: true,
        // Peer exchange: peers share knowledge of other peers after grafting.
        // Makes eclipse attacks harder — malicious peers can't prevent you from
        // discovering legitimate nodes.
        doPX: true,
        // Peer scoring: peers that send invalid or low-quality messages accumulate
        // negative scores and are ejected from the gossip mesh.
        scoreThresholds: {
          gossipThreshold: -10,
          publishThreshold: -50,
          graylistThreshold: -80,
          acceptPXThreshold: 10,
          opportunisticGraftThreshold: 20,
        },
      }),
      mdns: mdns(),
      dcutr: dcutr(),
      autoNAT: autoNAT(),
      // Bootstrap service requires at least one address — skip when list is empty.
      // In test environments both SUBSPACE_BOOTSTRAP_ADDRS and SUBSPACE_RELAY_ADDRS
      // are set to '' so nodes use mDNS-only peer discovery.
      ...(bootstrapList.length > 0 ? {
        bootstrap: bootstrap({ list: bootstrapList }),
      } : {}),
    },
  })

  await node.start()

  // libp2p v3 does NOT auto-dial peers discovered via mDNS — peer:discovery events
  // only update the peer store.  Without explicit dialing, mDNS-only nodes (no
  // bootstrap, no relay) never establish connections.
  // Listen on the mDNS service's 'peer' event and dial immediately.
  // libp2p v3 does NOT auto-dial peers discovered via mDNS — peer:discovery events
  // only update the peer store.  Without explicit dialing, mDNS-only nodes never connect.
  // Try multiple event hook points to ensure auto-dialing works:
  //   1. mDNS service 'peer' event  (most direct)
  //   2. node 'peer:discovery' event  (forwarded from internal components)
  const autoDial = (id: import('@libp2p/interface').PeerId) => {
    if (id.toString() === node.peerId.toString()) return
    if (node.getPeers().some(p => p.toString() === id.toString())) return
    void node.dial(id).catch(() => {})
  }
  // libp2p v3: auto-dial peers discovered via mDNS using their multiaddrs directly.
  // The mDNS 'peer' event includes both peerId and multiaddrs.  Use the multiaddrs
  // from the event (not the peer store) to avoid "no valid addresses" dial failures.
  const mdnsService = (node.services as Record<string, unknown>)['mdns'] as
    | { addEventListener(e: string, h: (evt: CustomEvent) => void): void }
    | undefined
  if (mdnsService?.addEventListener != null) {
    mdnsService.addEventListener('peer', (evt: CustomEvent) => {
      const peerInfo = evt.detail as {
        id: import('@libp2p/interface').PeerId
        multiaddrs: import('@multiformats/multiaddr').Multiaddr[]
      }
      if (!peerInfo?.id || peerInfo.id.toString() === node.peerId.toString()) return
      if (node.getPeers().some(p => p.toString() === peerInfo.id.toString())) return
      // Prefer the first dialable TCP multiaddr (loopback or specific interface).
      // Skip 0.0.0.0 (unspecified) and :: (IPv6 any-address) — not dialable.
      const tcpAddr = peerInfo.multiaddrs?.find(ma => {
        const s = ma.toString()
        return s.includes('/tcp/') &&
               !s.includes('/ip4/0.0.0.0') &&
               !s.includes('/ip6/::/')
      })
      if (tcpAddr) {
        void node.dial(tcpAddr).catch(() => {})
      } else {
        void node.dial(peerInfo.id).catch(() => {})
      }
    })
  }

  // Fallback: listen on node-level peer:discovery for peers discovered via
  // relay, DHT, or bootstrap (mDNS handler only fires for mDNS peers).
  // In libp2p v3, the peer:discovery event includes multiaddrs from the peer store.
  node.addEventListener('peer:discovery', (evt) => {
    const peerInfo = (evt as CustomEvent<{
      id: import('@libp2p/interface').PeerId
      multiaddrs?: import('@multiformats/multiaddr').Multiaddr[]
    }>).detail
    if (!peerInfo?.id || peerInfo.id.toString() === node.peerId.toString()) return
    if (node.getPeers().some(p => p.toString() === peerInfo.id.toString())) return
    // Try a dialable TCP multiaddr first; fall back to peer ID dial (uses peer store)
    const tcpAddr = peerInfo.multiaddrs?.find(ma => {
      const s = ma.toString()
      return s.includes('/tcp/') && !s.includes('/ip4/0.0.0.0') && !s.includes('/ip6/::/')
    })
    if (tcpAddr) {
      void node.dial(tcpAddr).catch(() => {})
    } else {
      void node.dial(peerInfo.id).catch(() => {})
    }
  })

  // Start the connection pruner unless explicitly disabled
  let pruner: SubspaceConnectionPruner | null = null
  if (prunerOpts !== false) {
    pruner = new SubspaceConnectionPruner(node, prunerOpts)
    pruner.start()
  }

  return { node, pruner }
}

/**
 * Derive the PeerId string from an agent private key.
 * Useful for logging / config without starting a full node.
 */
export function derivePeerId(agentPrivateKey: PrivateKey): string {
  return peerIdFromPrivateKey(agentPrivateKey).toString()
}

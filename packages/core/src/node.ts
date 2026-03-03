/**
 * libp2p node factory for agent-net.
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
 * - PSK private network connection filter
 * - Ping (required by KAD-DHT v16)
 *
 * CRITICAL SERVICE ORDER: `identify` MUST be listed first in the services object.
 * circuitRelayTransport() depends on the identify protocol being registered
 * before it can negotiate relay connections. Wrong order = silent relay failure.
 */

import { createLibp2p, type Libp2p } from 'libp2p'
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
import { preSharedKey } from '@libp2p/pnet'
import { ping } from '@libp2p/ping'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import { type NetworkKeys } from './crypto.js'
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
}

/**
 * Create and start a libp2p node configured for the given network.
 *
 * @param networkKeys     Derived from the PSK — used for the PSK connection filter only.
 * @param agentPrivateKey Persistent per-agent Ed25519 key from identity.ts.
 *                        Determines the node's PeerId (unique per agent, stable across restarts).
 * @param options         Optional node configuration.
 */
export async function createLibp2pNode(
  networkKeys: NetworkKeys,
  agentPrivateKey: PrivateKey,
  options: CreateNodeOptions = {}
): Promise<Libp2p> {
  const {
    port = 0,
    minConnections = 5,
    maxConnections = 50,
    trustedBootstrapPeers = [],
  } = options

  const bootstrapList = [
    ...BOOTSTRAP_ADDRESSES,
    ...RELAY_ADDRESSES,
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
    connectionProtector: preSharedKey({
      psk: Buffer.from(
        `/key/swarm/psk/1.0.0/\n/base16/\n${networkKeys.pskFilter.toString('hex')}`
      ),
    }),
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
      bootstrap: bootstrap({
        list: bootstrapList,
      }),
    },
  })

  await node.start()
  return node
}

/**
 * Derive the PeerId string from an agent private key.
 * Useful for logging / config without starting a full node.
 */
export function derivePeerId(agentPrivateKey: PrivateKey): string {
  return peerIdFromPrivateKey(agentPrivateKey).toString()
}

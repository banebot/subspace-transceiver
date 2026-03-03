/**
 * libp2p node factory for agent-net.
 *
 * Creates a fully configured libp2p node with:
 * - TCP + Circuit Relay v2 transports
 * - Noise protocol encryption
 * - Yamux stream multiplexing
 * - KAD-DHT peer routing (v16 requires ping service)
 * - GossipSub pub/sub (used by OrbitDB for CRDT replication)
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
import { keys } from '@libp2p/crypto'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { type NetworkKeys } from './crypto.js'
import { BOOTSTRAP_ADDRESSES, RELAY_ADDRESSES } from './bootstrap.js'

export interface CreateNodeOptions {
  /** TCP listen port. 0 = OS-assigned (default). */
  port?: number
  /** Local data directory (unused by node itself, passed for logging context). */
  dataDir?: string
}

/**
 * Create and start a libp2p node configured for the given network keys.
 *
 * The node's peer identity is deterministically derived from `networkKeys.peerId`,
 * ensuring the same PSK always produces the same peer ID across restarts.
 *
 * Returns a started libp2p node. Caller is responsible for calling node.stop().
 */
export async function createLibp2pNode(
  networkKeys: NetworkKeys,
  options: CreateNodeOptions = {}
): Promise<Libp2p> {
  const { port = 0 } = options

  // Derive deterministic Ed25519 keypair from peer identity seed.
  // This makes the peer ID stable across daemon restarts for the same PSK.
  const privateKey = await keys.generateKeyPairFromSeed('Ed25519', networkKeys.peerId)

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}`],
    },
    transports: [
      tcp(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
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
      }),
      mdns: mdns(),
      dcutr: dcutr(),
      autoNAT: autoNAT(),
      bootstrap: bootstrap({
        list: [...BOOTSTRAP_ADDRESSES, ...RELAY_ADDRESSES],
      }),
    },
  })

  await node.start()
  return node
}

/**
 * Derive the peer ID string that will be used for a given PSK.
 * Useful for logging / config without starting a full node.
 */
export async function derivePeerId(networkKeys: NetworkKeys): Promise<string> {
  const privateKey = await keys.generateKeyPairFromSeed('Ed25519', networkKeys.peerId)
  const peerId = peerIdFromPrivateKey(privateKey)
  return peerId.toString()
}

/**
 * Iroh-based node factory for Subspace Transceiver.
 *
 * Replaces the libp2p node factory. Uses the EngineBridge to manage
 * the Rust Iroh engine as the underlying P2P transport.
 *
 * ## Migration from libp2p
 * - `createLibp2pNode(key, opts)` → `createIrohNode(identity, opts)` 
 * - `Libp2p` (complex stateful object) → `IrohNode` (thin wrapper over EngineBridge)
 * - `node.peerId` → `node.id` (Iroh EndpointId as string)
 * - `node.getMultiaddrs()` → `node.addrs()` (IP:port strings)
 * - `node.getPeers()` → `node.getPeers()` (EndpointId strings)
 *
 * ## Key identity mapping
 * The 32-byte Ed25519 seed from `Buffer.from(identity.privateKey.raw.slice(0, 32)).toString('hex')` maps directly to an
 * Iroh EndpointId (Ed25519 public key). This is the same seed used for
 * DID:Key derivation — all three identifiers are cryptographically linked:
 *   - Iroh EndpointId = Ed25519 pubkey
 *   - DID:Key = did:key:z6Mk<base58btc(0xed01 || pubkey)>
 */

import type { AgentIdentity } from './identity.js'
import { EngineBridge } from './engine-bridge.js'

// ---------------------------------------------------------------------------
// IrohNode — public interface (replaces Libp2p for networking)
// ---------------------------------------------------------------------------

export interface IrohNode {
  /** The engine bridge managing the Rust subprocess. */
  readonly bridge: EngineBridge
  /** Iroh EndpointId (Ed25519 public key, hex string). */
  readonly id: string
  /** IP:port listening addresses. */
  addrs(): Promise<string[]>
  /** List of currently connected peer EndpointIds. */
  getPeers(): Promise<string[]>
  /** Stop the node and clean up resources. */
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// IrohNodeOptions
// ---------------------------------------------------------------------------

export interface IrohNodeOptions {
  /** Path to the `subspace-engine` binary. */
  enginePath?: string
  /** Custom relay URL (overrides Iroh's default public relays). */
  relayUrl?: string
  /** Log engine stderr output (default: true in dev). */
  logStderr?: boolean
}

// ---------------------------------------------------------------------------
// Factory — createIrohNode
// ---------------------------------------------------------------------------

/**
 * Create and start an Iroh QUIC endpoint from the agent's identity.
 *
 * This spawns the `subspace-engine` Rust subprocess (if not already running)
 * and starts the Iroh endpoint using the agent's Ed25519 seed.
 *
 * @param identity The agent's identity (from loadOrCreateIdentity).
 * @param options  Node configuration options.
 * @returns A running IrohNode.
 */
export async function createIrohNode(
  identity: AgentIdentity,
  options: IrohNodeOptions = {}
): Promise<IrohNode> {
  const bridge = new EngineBridge({
    enginePath: options.enginePath,
    logStderr: options.logStderr,
  })

  await bridge.start()

  const result = await bridge.engineStart({
    seedHex: Buffer.from(identity.privateKey.raw.slice(0, 32)).toString('hex'),
    relayUrl: options.relayUrl,
  })

  const nodeId = result.nodeId

  return {
    bridge,
    id: nodeId,

    async addrs(): Promise<string[]> {
      return bridge.engineAddrs()
    },

    async getPeers(): Promise<string[]> {
      return bridge.peerList()
    },

    async stop(): Promise<void> {
      await bridge.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// Compatibility shim — derivePeerId
// ---------------------------------------------------------------------------

/**
 * Derive a PeerId string from an identity.
 *
 * In the Iroh world, the "PeerId" is the Iroh EndpointId (Ed25519 public key).
 * This is still a cryptographic identity derived from the same seed —
 * just represented differently than the libp2p multihash PeerId.
 *
 * For backward compatibility, this returns the DID:Key string.
 */
export function derivePeerId(identity: AgentIdentity): string {
  return identity.did ?? identity.peerId
}

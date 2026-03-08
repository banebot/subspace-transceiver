/**
 * Network join/leave orchestration for Subspace Transceiver — Iroh transport.
 *
 * A "network" is defined by a PSK. All peers with the same PSK share:
 * - The same gossip topic (iroh-gossip CRDT replication channel)
 * - The same envelope encryption key (message privacy)
 * - The same content derivation keys
 *
 * Each node has a UNIQUE identity keypair (from identity.ts) that is separate
 * from the PSK. The PSK governs network access; the identity governs content
 * authorship and EndpointId uniqueness.
 *
 * TRANSPORT MIGRATION:
 * - Replaced: libp2p node, GossipSub, KAD-DHT, mDNS, circuit relay
 * - Now uses: Iroh QUIC endpoint via EngineBridge (Rust stdio subprocess)
 *
 * Each network has TWO namespaces:
 * - 'skill'   — portable across projects (global agent knowledge)
 * - 'project' — scoped to a specific project/repo
 */

import { deriveNetworkKeys, validatePSK, type NetworkKeys } from './crypto.js'
import type { AgentIdentity } from './identity.js'
import { getDefaultBridge, EngineBridge } from './engine-bridge.js'
import { DiscoveryManager } from './discovery.js'
import { ReplicationManager } from './replication.js'
import { LoroEpochManager } from './loro-epoch-manager.js'
import { DEFAULT_EPOCH_CONFIG, type EpochConfig } from './epoch-manager.js'
import type { IMemoryStore } from './store.js'
import { BacklinkIndex } from './backlink-index.js'
import { NetworkError, ErrorCode } from './errors.js'
import type { StampCache } from './pow.js'
import path from 'node:path'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal live session — holds all runtime resources for an active network.
 * NOT serialisable — do not expose directly in API responses.
 */
export interface NetworkSession {
  /** Unique network identifier — SHA-256(PSK) as hex string */
  id: string
  /** Human-readable label (optional, from config) */
  name?: string
  /** The Iroh engine bridge (shared across sessions). */
  bridge: EngineBridge
  /** Gossip topic hex for this network's CRDT replication */
  gossipTopicHex: string
  /** Connection pruning is handled natively by Iroh */
  pruner: null
  /** Memory stores, keyed by namespace */
  stores: {
    skill: IMemoryStore
    project: IMemoryStore
  }
  /** Epoch managers */
  epochManagers: {
    skill: LoroEpochManager
    project: LoroEpochManager
  }
  /** In-memory backlink index */
  backlinkIndex: BacklinkIndex
  /** Loro delta sync replication manager */
  replication?: ReplicationManager
  /** Discovery/browse manager */
  discovery: DiscoveryManager
  /** Derived keys for this network */
  networkKeys: NetworkKeys
  /** Agent identity info */
  identity: AgentIdentity
  /**
   * Compatibility shim — acts like the old libp2p node interface for the daemon API layer.
   * Full migration to Iroh ALPN stream-based peer queries is in Phase 3.6.
   */
  node: {
    peerId: { toString(): string }
    getPeers(): string[]
    dial(addr: unknown): Promise<void>
    handle(protocol: string, handler: (stream: unknown, conn: unknown) => Promise<void>): Promise<void>
  }
}

/**
 * Serialisable network info DTO — safe for HTTP API responses.
 */
export interface NetworkInfoDTO {
  id: string
  name?: string
  peerId: string
  peers: number
  namespaces: ['skill', 'project']
  knownPeers: number
  /** Iroh endpoint addresses */
  multiaddrs: string[]
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Derive a stable network ID from a PSK.
 */
export function deriveNetworkId(psk: string): string {
  return crypto.createHash('sha256').update(psk, 'utf8').digest('hex')
}

/**
 * Join (or create) a network identified by the given PSK.
 * Uses the shared EngineBridge for Iroh transport.
 */
export async function joinNetwork(
  psk: string,
  identity: AgentIdentity,
  options: {
    name?: string
    dataDir: string
    port?: number
    displayName?: string
    minConnections?: number
    maxConnections?: number
    trustedBootstrapPeers?: string[]
    relayAddresses?: string[]
    subscribedTopics?: string[]
    subscribedPeers?: string[]
    stampCache?: StampCache
    powBitsForRequests?: number
    powWindowMs?: number
    requirePoW?: boolean
    epochConfig?: EpochConfig
    /** Existing EngineBridge (uses shared bridge if not provided). */
    bridge?: EngineBridge
  }
): Promise<NetworkSession> {
  validatePSK(psk)

  const networkKeys = deriveNetworkKeys(psk)
  const networkId = deriveNetworkId(psk)
  const networkDataDir = path.join(options.dataDir, 'networks', networkId)

  // Derive gossip topic from PSK network key (topic = hex string from crypto.ts)
  const gossipTopicHex = crypto
    .createHash('sha256')
    .update(networkKeys.topic, 'utf8')
    .digest('hex')

  // Use provided bridge or the shared default bridge
  const bridge = options.bridge ?? getDefaultBridge()

  // Ensure the bridge/engine is running
  if (!bridge.isRunning) {
    await bridge.start()
    await bridge.engineStart({ seedHex: Buffer.from(identity.privateKey.raw.slice(0, 32)).toString('hex') })
  }

  try {
    // Create Loro epoch managers for both namespaces
    const epochConfig = options.epochConfig ?? DEFAULT_EPOCH_CONFIG
    const [skillManager, projectManager] = await Promise.all([
      LoroEpochManager.create('skill', epochConfig, networkDataDir),
      LoroEpochManager.create('project', epochConfig, networkDataDir),
    ])

    // Build backlink index
    const backlinkIndex = new BacklinkIndex()
    await Promise.all([
      backlinkIndex.build(skillManager),
      backlinkIndex.build(projectManager),
    ])

    // Wire up backlink index updates on replication
    const updateBacklinks = async (store: IMemoryStore) => {
      const all = await store.list().catch(() => [])
      for (const chunk of all) {
        backlinkIndex.indexChunk(chunk)
      }
    }
    skillManager.on('replicated', () => { void updateBacklinks(skillManager) })
    projectManager.on('replicated', () => { void updateBacklinks(projectManager) })

    // Create the discovery manager (Iroh gossip-based)
    // Use identity.peerId as the canonical identifier so it matches health.peerId.
    // agentPeerId carries the DID for agent:// URI resolution.
    const discovery = new DiscoveryManager(bridge, [skillManager, projectManager], {
      localPeerId: identity.peerId,
      agentPeerId: identity.did,
      displayName: options.displayName,
      subscribedTopics: options.subscribedTopics,
      subscribedPeers: options.subscribedPeers,
      stampCache: options.stampCache,
      powBitsForRequests: options.powBitsForRequests,
      powWindowMs: options.powWindowMs,
      requirePoW: options.requirePoW,
    })

    // Join the network-specific gossip topic
    await bridge.gossipJoin({
      topicHex: gossipTopicHex,
      bootstrapPeers: options.trustedBootstrapPeers,
    }).catch(err => {
      console.warn('[subspace] Could not join gossip topic:', err)
    })

    void discovery.start()

    // PeerId compat shim (Phase 3.6 migrates this to Iroh EndpointId)
    const localPeerIdStr = identity.did ?? identity.peerId

    // Start Loro delta sync replication via gossip
    // Use the bridge's nodeId if available, otherwise fall back to peerId
    const replicationNodeId = bridge.nodeId ?? localPeerIdStr
    const replication = new ReplicationManager(
      bridge,
      { skill: skillManager, project: projectManager },
      gossipTopicHex,
      replicationNodeId,
    )
    replication.start()

    const session: NetworkSession = {
      id: networkId,
      name: options.name,
      bridge,
      gossipTopicHex,
      pruner: null,
      stores: { skill: skillManager, project: projectManager },
      epochManagers: { skill: skillManager, project: projectManager },
      backlinkIndex,
      discovery,
      replication,
      networkKeys,
      identity,
      // Compatibility shim for daemon API layer (Phase 3.6 removes this)
      node: {
        peerId: { toString: () => localPeerIdStr },
        getPeers: () => [],
        dial: async (_addr: unknown) => { /* Phase 3.6: dial via Iroh */ },
        handle: async (_protocol: string, _handler: (stream: unknown, conn: unknown) => Promise<void>) => {
          /* Phase 3.6: register ALPN handler via bridge */
        },
      },
    }

    return session
  } catch (err) {
    throw new NetworkError(
      `Failed to join network: ${String(err)}`,
      ErrorCode.JOIN_FAILED,
      err
    )
  }
}

/**
 * Leave a network — stop discovery and close all stores.
 */
export async function leaveNetwork(session: NetworkSession): Promise<void> {
  const errors: unknown[] = []

  // Connection pruning handled natively by Iroh
  session.replication?.stop()

  await session.discovery.stop().catch((e: unknown) => errors.push(e))

  await session.stores.skill.close().catch((e: unknown) => errors.push(e))
  await session.stores.project.close().catch((e: unknown) => errors.push(e))

  // Leave gossip topic
  await session.bridge.gossipLeave(session.gossipTopicHex).catch((e: unknown) => errors.push(e))

  if (errors.length > 0) {
    console.warn('[subspace] Errors during network leave:', errors)
  }
}

/**
 * Convert a live NetworkSession to a serialisable NetworkInfoDTO.
 */
export async function sessionToDTO(session: NetworkSession): Promise<NetworkInfoDTO> {
  const peerId = session.identity.did ?? session.identity.peerId
  const addrs = await session.bridge.engineAddrs().catch(() => [])
  const knownPeers = session.discovery.getKnownPeers().length

  return {
    id: session.id,
    name: session.name,
    peerId,
    peers: 0, // Peer count from Iroh is available via bridge.peerList()
    namespaces: ['skill', 'project'],
    knownPeers,
    multiaddrs: addrs,
  }
}

// ---------------------------------------------------------------------------
// Global network session
// ---------------------------------------------------------------------------

/**
 * A GlobalSession is the always-on connectivity layer.
 * It gives the agent global presence and addressability.
 */
export interface GlobalSession {
  bridge: EngineBridge
  discovery: DiscoveryManager
  pruner: null
  localPeerId: string
  port: number
  /**
   * Compatibility shim for the daemon API layer.
   * Phase 3.6 removes this in favor of direct bridge calls.
   */
  node: {
    peerId: { toString(): string }
    getPeers(): string[]
    getMultiaddrs(): Array<{ toString(): string }>
    dial(addr: unknown): Promise<void>
    handle(protocol: string, handler: (stream: unknown, conn: unknown) => Promise<void>): Promise<void>
  }
}

/**
 * Join the global Subspace network.
 * Starts the Iroh engine and broadcasts public discovery manifests.
 */
export async function joinGlobalNetwork(
  identity: AgentIdentity,
  options: {
    port?: number
    displayName?: string
    minConnections?: number
    maxConnections?: number
    trustedBootstrapPeers?: string[]
    relayAddresses?: string[]
    subscribedTopics?: string[]
    subscribedPeers?: string[]
    stampCache?: StampCache
    powBitsForRequests?: number
    powWindowMs?: number
    requirePoW?: boolean
    enginePath?: string
  } = {}
): Promise<GlobalSession> {
  const bridge = getDefaultBridge({ enginePath: options.enginePath })

  if (!bridge.isRunning) {
    await bridge.start()
    await bridge.engineStart({ seedHex: Buffer.from(identity.privateKey.raw.slice(0, 32)).toString('hex') })
  }

  // Use identity.peerId as the canonical identifier to match health.peerId
  const localPeerId = identity.peerId

  const discovery = new DiscoveryManager(bridge, [], {
    localPeerId,
    displayName: options.displayName,
    subscribedTopics: options.subscribedTopics,
    subscribedPeers: options.subscribedPeers,
    stampCache: options.stampCache,
    powBitsForRequests: options.powBitsForRequests,
    powWindowMs: options.powWindowMs,
    requirePoW: options.requirePoW,
  })

  setTimeout(() => { void discovery.start() }, 2000)

  return {
    bridge,
    discovery,
    pruner: null,
    localPeerId,
    port: options.port ?? 7432,
    // Compatibility shim
    node: {
      peerId: { toString: () => localPeerId },
      getPeers: () => [],
      getMultiaddrs: () => [],
      dial: async (_addr: unknown) => { /* Phase 3.6 */ },
      handle: async (_protocol: string, _handler: (stream: unknown, conn: unknown) => Promise<void>) => { /* Phase 3.6 */ },
    },
  }
}

/**
 * Leave the global network — stop discovery and shut down the engine.
 */
export async function leaveGlobalNetwork(session: GlobalSession): Promise<void> {
  const errors: unknown[] = []
  await session.discovery.stop().catch((e: unknown) => errors.push(e))
  await session.bridge.stop().catch((e: unknown) => errors.push(e))
  if (errors.length > 0) {
    console.warn('[subspace] Errors during global network leave:', errors)
  }
}

/**
 * Network join/leave orchestration for agent-net.
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

import type { Libp2p } from 'libp2p'
import type { OrbitDB } from '@orbitdb/core'
import type { Helia } from 'helia'
import type { PrivateKey } from '@libp2p/interface'
import { deriveNetworkKeys, validatePSK, type NetworkKeys } from './crypto.js'
import { createLibp2pNode, derivePeerId } from './node.js'
import { createOrbitDBContext, createOrbitDBStore, type OrbitDBContext } from './orbitdb-store.js'
import type { IMemoryStore } from './store.js'
import { BacklinkIndex } from './backlink-index.js'
import { DiscoveryManager } from './discovery.js'
import { NetworkError, ErrorCode } from './errors.js'
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
  /** Live libp2p node for this network */
  node: Libp2p
  /** Shared Helia IPFS node (must be stopped when leaving the network) */
  helia: Helia
  /** Shared OrbitDB instance */
  orbitdb: OrbitDB
  /** Memory stores, keyed by namespace */
  stores: {
    skill: IMemoryStore
    project: IMemoryStore
  }
  /** In-memory backlink index for content graph traversal */
  backlinkIndex: BacklinkIndex
  /** Discovery/browse manager — manifests + peer index */
  discovery: DiscoveryManager
  /** Derived keys for this network */
  networkKeys: NetworkKeys
  /** Agent identity private key (signing + libp2p identity) */
  agentPrivateKey: PrivateKey
  /** Close Level databases that Helia.stop() does not reach */
  closeLevelStores: () => Promise<void>
}

/**
 * Serialisable network info DTO — safe for HTTP API responses and config.
 */
export interface NetworkInfoDTO {
  id: string
  name?: string
  peerId: string
  peers: number
  namespaces: ['skill', 'project']
  /** Known peers from the discovery layer */
  knownPeers: number
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Derive a stable network ID from a PSK.
 * Uses SHA-256(PSK) as a fingerprint — does not expose the PSK itself.
 */
export function deriveNetworkId(psk: string): string {
  return crypto.createHash('sha256').update(psk, 'utf8').digest('hex')
}

/**
 * Join (or create) a network identified by the given PSK.
 * Starting a node, initialising OrbitDB stores, and connecting to peers
 * all happen here. Returns a live NetworkSession.
 *
 * @param psk             The pre-shared key for this network.
 * @param agentPrivateKey Persistent agent identity key (from loadOrCreateIdentity).
 * @param options         Network join options.
 */
export async function joinNetwork(
  psk: string,
  agentPrivateKey: PrivateKey,
  options: {
    name?: string
    dataDir: string
    port?: number
    displayName?: string
    minConnections?: number
    maxConnections?: number
    trustedBootstrapPeers?: string[]
    subscribedTopics?: string[]
    subscribedPeers?: string[]
  }
): Promise<NetworkSession> {
  validatePSK(psk)

  const networkKeys = deriveNetworkKeys(psk)
  const networkId = deriveNetworkId(psk)
  const networkDataDir = path.join(options.dataDir, 'networks', networkId)
  const localPeerId = derivePeerId(agentPrivateKey)

  let node: Libp2p | undefined
  let ctx: OrbitDBContext | undefined
  try {
    node = await createLibp2pNode(networkKeys, agentPrivateKey, {
      port: options.port,
      minConnections: options.minConnections,
      maxConnections: options.maxConnections,
      trustedBootstrapPeers: options.trustedBootstrapPeers,
    })

    // Create a single Helia + OrbitDB context shared by both namespaces.
    // Pass networkId so OrbitDB always uses the same signing identity across restarts.
    ctx = await createOrbitDBContext(node, networkDataDir, networkId)

    const [skillStore, projectStore] = await Promise.all([
      createOrbitDBStore(ctx.orbitdb, networkKeys, 'skill'),
      createOrbitDBStore(ctx.orbitdb, networkKeys, 'project'),
    ])

    // Build backlink index from existing store contents
    const backlinkIndex = new BacklinkIndex()
    await Promise.all([
      backlinkIndex.build(skillStore),
      backlinkIndex.build(projectStore),
    ])

    // Wire up backlink index to update on replication events
    const updateBacklinks = async (store: IMemoryStore) => {
      const all = await store.list().catch(() => [])
      // Rebuild index slice for this store on every replication
      // (incremental updates are complex with OrbitDB's merge semantics)
      for (const chunk of all) {
        backlinkIndex.indexChunk(chunk)
      }
    }

    skillStore.on('replicated', () => { void updateBacklinks(skillStore) })
    projectStore.on('replicated', () => { void updateBacklinks(projectStore) })

    // Create and start the discovery manager
    const discovery = new DiscoveryManager(node, [skillStore, projectStore], {
      localPeerId,
      displayName: options.displayName,
      subscribedTopics: options.subscribedTopics,
      subscribedPeers: options.subscribedPeers,
    })

    // Start discovery after a short delay to let the node connect to some peers
    setTimeout(() => { void discovery.start() }, 2000)

    const session: NetworkSession = {
      id: networkId,
      name: options.name,
      node,
      helia: ctx.helia,
      orbitdb: ctx.orbitdb,
      stores: { skill: skillStore, project: projectStore },
      backlinkIndex,
      discovery,
      networkKeys,
      agentPrivateKey,
      closeLevelStores: ctx.closeLevelStores,
    }

    return session
  } catch (err) {
    // Clean up in reverse order if init failed
    if (ctx) {
      await ctx.helia.stop().catch(() => {})
      await ctx.closeLevelStores().catch(() => {})
    }
    if (node) {
      await Promise.resolve(node.stop()).catch(() => {})
    }
    throw new NetworkError(
      `Failed to join network: ${String(err)}`,
      ErrorCode.JOIN_FAILED,
      err
    )
  }
}

/**
 * Leave a network — stop discovery, close all stores and stop the libp2p node.
 * After this call, the session should be discarded.
 */
export async function leaveNetwork(session: NetworkSession): Promise<void> {
  const errors: unknown[] = []

  // Stop discovery manager first (unregisters protocols)
  await session.discovery.stop().catch((e: unknown) => errors.push(e))

  // Close stores first (they hold DB handles on top of OrbitDB)
  await session.stores.skill.close().catch((e: unknown) => errors.push(e))
  await session.stores.project.close().catch((e: unknown) => errors.push(e))
  // Then close OrbitDB, Helia, and the libp2p node in order
  await Promise.resolve(session.orbitdb.stop()).catch((e: unknown) => errors.push(e))
  await session.helia.stop().catch((e: unknown) => errors.push(e))
  // Close raw Level databases — Helia.stop() does NOT close these
  await session.closeLevelStores().catch((e: unknown) => errors.push(e))
  await Promise.resolve(session.node.stop()).catch((e: unknown) => errors.push(e))

  if (errors.length > 0) {
    console.warn('[agent-net] Errors during network leave:', errors)
  }
}

/**
 * Convert a live NetworkSession to a serialisable NetworkInfoDTO.
 */
export function sessionToDTO(session: NetworkSession): NetworkInfoDTO {
  const peerId = session.node.peerId.toString()
  const peers = session.node.getPeers().length
  const knownPeers = session.discovery.getKnownPeers().length

  return {
    id: session.id,
    name: session.name,
    peerId,
    peers,
    namespaces: ['skill', 'project'],
    knownPeers,
  }
}

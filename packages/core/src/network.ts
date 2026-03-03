/**
 * Network join/leave orchestration for agent-net.
 *
 * A "network" is defined by a PSK. All peers with the same PSK share:
 * - The same DHT announcement key (peer discovery)
 * - The same GossipSub topic (OrbitDB CRDT replication channel)
 * - The same envelope encryption key (message privacy)
 * - The same libp2p private network PSK (connection filter)
 * - The same deterministic peer identity seed
 *
 * Each network has TWO namespaces:
 * - 'skill'  — portable across projects (global agent knowledge)
 * - 'project' — scoped to a specific project/repo
 *
 * Internal NetworkSession holds live references (Libp2p node, stores).
 * External NetworkInfoDTO is serialisable and safe for API responses.
 */

import type { Libp2p } from 'libp2p'
import type { OrbitDB } from '@orbitdb/core'
import type { Helia } from 'helia'
import { deriveNetworkKeys, validatePSK, type NetworkKeys } from './crypto.js'
import { createLibp2pNode, derivePeerId } from './node.js'
import { createOrbitDBContext, createOrbitDBStore, type OrbitDBContext } from './orbitdb-store.js'
import type { IMemoryStore } from './store.js'
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
  /** Derived keys for this network */
  networkKeys: NetworkKeys
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
 */
export async function joinNetwork(
  psk: string,
  options: {
    name?: string
    dataDir: string
    port?: number
  }
): Promise<NetworkSession> {
  validatePSK(psk)

  const networkKeys = deriveNetworkKeys(psk)
  const networkId = deriveNetworkId(psk)
  const networkDataDir = path.join(options.dataDir, 'networks', networkId)

  let node: Libp2p | undefined
  let ctx: OrbitDBContext | undefined
  try {
    node = await createLibp2pNode(networkKeys, { port: options.port })

    // Create a single Helia + OrbitDB context shared by both namespaces.
    // Pass networkId so OrbitDB always uses the same signing identity across restarts.
    // This avoids duplicate protocol handler errors from registering bitswap twice.
    ctx = await createOrbitDBContext(node, networkDataDir, networkId)

    const [skillStore, projectStore] = await Promise.all([
      createOrbitDBStore(ctx.orbitdb, networkKeys, 'skill'),
      createOrbitDBStore(ctx.orbitdb, networkKeys, 'project'),
    ])

    const session: NetworkSession = {
      id: networkId,
      name: options.name,
      node,
      helia: ctx.helia,
      orbitdb: ctx.orbitdb,
      stores: {
        skill: skillStore,
        project: projectStore,
      },
      networkKeys,
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
 * Leave a network — close all stores and stop the libp2p node.
 * After this call, the session should be discarded.
 */
export async function leaveNetwork(session: NetworkSession): Promise<void> {
  const errors: unknown[] = []

  // Close stores first (they hold DB handles on top of OrbitDB)
  await session.stores.skill.close().catch((e: unknown) => errors.push(e))
  await session.stores.project.close().catch((e: unknown) => errors.push(e))
  // Then close OrbitDB, Helia, and the libp2p node in order
  await Promise.resolve(session.orbitdb.stop()).catch((e: unknown) => errors.push(e))
  await session.helia.stop().catch((e: unknown) => errors.push(e))
  // Close raw Level databases — Helia.stop() does NOT close these because
  // LevelBlockstore/LevelDatastore lack start()/stop() methods (they only
  // have open()/close()), so @libp2p/interface's stop() silently skips them.
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

  return {
    id: session.id,
    name: session.name,
    peerId,
    peers,
    namespaces: ['skill', 'project'],
  }
}

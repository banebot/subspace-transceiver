/**
 * Persistence test — verifies that data survives OrbitDB restart.
 *
 * Reproduces two bugs that caused memory query to return [] after restart:
 *
 * BUG 1 — Level DBs never closed:
 *   Helia.stop() uses @libp2p/interface's stop() which requires start()/stop()
 *   methods, but LevelBlockstore/LevelDatastore only have open()/close().
 *   Result: Level file locks are never released → "Database failed to open"
 *   on restart.
 *
 * BUG 2 — Blockstore get() API mismatch:
 *   Helia v6 / blockstore-level v3 changed Blockstore.get() to return
 *   AsyncIterable<Uint8Array>. OrbitDB v3's IPFSBlockStorage does
 *   `await ipfs.blockstore.get(cid)` expecting Promise<Uint8Array>.
 *   Result: after restart the LRU cache is empty, IPFSBlockStorage returns
 *   a generator object instead of bytes → entries can't be decoded.
 */

import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { deriveNetworkKeys } from '../src/crypto.js'
import { createOrbitDBContext, createOrbitDBStore, type OrbitDBContext } from '../src/orbitdb-store.js'
import { createLibp2pNode } from '../src/node.js'
import { createChunk } from '../src/schema.js'
import { deriveNetworkId } from '../src/network.js'
import { keys } from '@libp2p/crypto'
import { randomBytes } from 'node:crypto'

const TEST_PSK = 'persistence-test-psk-do-not-use-in-prod-32chars!'

describe('OrbitDB persistence across restart', { timeout: 120_000 }, () => {
  it('data written before close is readable after reopen', async () => {
    const networkKeys = deriveNetworkKeys(TEST_PSK)
    const networkId = deriveNetworkId(TEST_PSK)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-net-persist-'))

    // ── Phase 1: write data ──
    const agentKey = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    let node = await createLibp2pNode(networkKeys, agentKey, { port: 0 })
    let ctx: OrbitDBContext = await createOrbitDBContext(node, tmpDir, networkId)
    let store = await createOrbitDBStore(ctx.orbitdb, networkKeys, 'project')

    const chunk = createChunk({
      type: 'project',
      namespace: 'project',
      topic: ['persistence', 'test'],
      content: 'This data must survive a restart',
      source: {
        agentId: 'test-agent',
        peerId: node.peerId.toString(),
        timestamp: Date.now(),
      },
      confidence: 0.9,
      network: 'test-network',
    })

    await store.put(chunk)

    // Verify it's readable before close
    const beforeClose = await store.query({ topics: ['persistence'] })
    expect(beforeClose).toHaveLength(1)
    expect(beforeClose[0].content).toBe('This data must survive a restart')

    // Close everything — including raw Level databases
    await store.close()
    await ctx.orbitdb.stop()
    await ctx.helia.stop()
    await ctx.closeLevelStores()
    await node.stop()

    // ── Phase 2: reopen with same data directory ──
    const agentKey2 = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    node = await createLibp2pNode(networkKeys, agentKey2, { port: 0 })
    ctx = await createOrbitDBContext(node, tmpDir, networkId)
    store = await createOrbitDBStore(ctx.orbitdb, networkKeys, 'project')

    // Query should return the previously stored data
    const afterReopen = await store.query({ topics: ['persistence'] })
    expect(afterReopen).toHaveLength(1)
    expect(afterReopen[0].id).toBe(chunk.id)
    expect(afterReopen[0].content).toBe('This data must survive a restart')

    // Also test direct get
    const direct = await store.get(chunk.id)
    expect(direct).not.toBeNull()
    expect(direct?.content).toBe('This data must survive a restart')

    // Cleanup
    await store.close()
    await ctx.orbitdb.stop()
    await ctx.helia.stop()
    await ctx.closeLevelStores()
    await node.stop()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
})

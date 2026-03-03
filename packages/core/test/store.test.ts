/**
 * Integration tests for OrbitDB memory store replication.
 *
 * These tests spin up two in-process libp2p nodes on loopback,
 * join the same PSK network, and verify that memory chunks
 * replicate between peers.
 *
 * These tests are intentionally slow (libp2p + OrbitDB init + P2P handshake).
 * Timeout: 60s per test.
 *
 * NOTE: These tests require network access (loopback only) and may be
 * skipped in CI environments without network support.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createLibp2pNode } from '../src/node.js'
import { deriveNetworkKeys } from '../src/crypto.js'
import { createOrbitDBContext, createOrbitDBStore, type OrbitDBContext } from '../src/orbitdb-store.js'
import { createChunk } from '../src/schema.js'
import type { IMemoryStore } from '../src/store.js'
import type { Libp2p } from 'libp2p'

const TEST_PSK = 'integration-test-psk-do-not-use-in-production-32c'

// Helper: wait for an event on an EventEmitter with a timeout
function waitForEvent(emitter: IMemoryStore, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for '${event}' event after ${timeoutMs}ms`))
    }, timeoutMs)
    emitter.once(event, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('OrbitDB replication integration', { timeout: 60_000 }, () => {
  let nodeA: Libp2p
  let nodeB: Libp2p
  let ctxA: OrbitDBContext
  let ctxB: OrbitDBContext
  let storeA: IMemoryStore
  let storeB: IMemoryStore
  let tmpDirA: string
  let tmpDirB: string

  beforeAll(async () => {
    const networkKeys = deriveNetworkKeys(TEST_PSK)

    // Create temp data directories
    tmpDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-net-test-a-'))
    tmpDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-net-test-b-'))

    // Spin up two nodes on different loopback ports
    ;[nodeA, nodeB] = await Promise.all([
      createLibp2pNode(networkKeys, { port: 0 }),
      createLibp2pNode(networkKeys, { port: 0 }),
    ])

    // Create OrbitDB contexts (Helia + OrbitDB) backed by each libp2p node
    ;[ctxA, ctxB] = await Promise.all([
      createOrbitDBContext(nodeA, tmpDirA, networkKeys.topic),
      createOrbitDBContext(nodeB, tmpDirB, networkKeys.topic),
    ])

    // Create stores using the OrbitDB instances (not the raw libp2p nodes)
    ;[storeA, storeB] = await Promise.all([
      createOrbitDBStore(ctxA.orbitdb, networkKeys, 'skill'),
      createOrbitDBStore(ctxB.orbitdb, networkKeys, 'skill'),
    ])

    // Connect nodes to each other directly (bypass DHT bootstrap for test speed)
    const nodeAAddrs = nodeA.getMultiaddrs()
    if (nodeAAddrs.length > 0) {
      await nodeB.dial(nodeAAddrs[0]).catch(() => {})
    }
  })

  afterAll(async () => {
    await storeA?.close().catch(() => {})
    await storeB?.close().catch(() => {})
    await ctxA?.orbitdb?.stop().catch(() => {})
    await ctxB?.orbitdb?.stop().catch(() => {})
    await ctxA?.helia?.stop().catch(() => {})
    await ctxB?.helia?.stop().catch(() => {})
    await ctxA?.closeLevelStores().catch(() => {})
    await ctxB?.closeLevelStores().catch(() => {})
    await nodeA?.stop().catch(() => {})
    await nodeB?.stop().catch(() => {})
    await fs.rm(tmpDirA, { recursive: true, force: true }).catch(() => {})
    await fs.rm(tmpDirB, { recursive: true, force: true }).catch(() => {})
  })

  it('replicates a chunk from node A to node B', async () => {
    const chunk = createChunk({
      type: 'skill',
      namespace: 'skill',
      topic: ['typescript', 'async'],
      content: 'Always await promises in async functions',
      source: {
        agentId: 'test-agent',
        peerId: nodeA.peerId.toString(),
        timestamp: Date.now(),
      },
      confidence: 0.95,
      network: 'test-network',
    })

    // Put chunk on node A, wait for replication event on node B
    const replicatedPromise = waitForEvent(storeB, 'replicated', 30_000)
    await storeA.put(chunk)
    await replicatedPromise

    // Query node B — should find the chunk
    const results = await storeB.query({ topics: ['typescript'] })
    const found = results.find(r => r.id === chunk.id)
    expect(found).toBeDefined()
    expect(found?.content).toBe(chunk.content)
  })

  it('replicates a tombstone from node A to node B', async () => {
    const chunk = createChunk({
      type: 'context',
      namespace: 'project',
      topic: ['node', 'test'],
      content: 'Temporary context for deletion test',
      source: {
        agentId: 'test-agent',
        peerId: nodeA.peerId.toString(),
        timestamp: Date.now(),
      },
      confidence: 0.5,
      network: 'test-network',
    })

    // Put then forget
    const rep1 = waitForEvent(storeB, 'replicated', 30_000)
    await storeA.put(chunk)
    await rep1

    const rep2 = waitForEvent(storeB, 'replicated', 30_000)
    await storeA.forget(chunk.id)
    await rep2

    // Should not appear in query results
    const results = await storeB.query({ topics: ['test'] })
    const found = results.find(r => r.id === chunk.id)
    expect(found).toBeUndefined()
  })
})

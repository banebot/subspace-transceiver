/**
 * E2E: P2P Browse Protocol
 *
 * Tests that Agent A can browse Agent B's public content via the
 * /subspace/browse/1.0.0 QUIC ALPN protocol.
 *
 * Flow:
 *  1. Start two daemons (alpha + beta)
 *  2. Beta joins a PSK network and writes content
 *  3. Alpha browses Beta using Beta's Iroh NodeId
 *  4. Alpha receives Beta's content stubs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { sleep } from './helpers/wait.js'

describe('P2P browse: alpha fetches beta content', () => {
  const harness = new TestHarness()
  const psk = randomPsk()

  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'], {
      SUBSPACE_MANIFEST_INTERVAL_MS: '2000',
    })

    // Both agents join the same PSK network so beta has a store to write to
    await harness.client('alpha').joinNetwork(psk)
    await harness.client('beta').joinNetwork(psk)

    // Wait for networks to form
    await sleep(1000)

    // Beta writes some content to its store
    await harness.client('beta').putMemory({
      type: 'skill',
      topic: ['typescript', 'async'],
      content: 'TypeScript async/await patterns for AI agents',
      confidence: 0.9,
    })
    await harness.client('beta').putMemory({
      type: 'skill',
      topic: ['rust', 'networking'],
      content: 'Rust QUIC networking with Iroh',
      confidence: 0.95,
    })

    await sleep(500)
  }, 60_000)

  afterAll(() => harness.teardown())

  it('alpha can browse beta and receive content stubs', async () => {
    const betaHealth = await harness.client('beta').getHealth()
    const betaNodeId = betaHealth.nodeId

    expect(betaNodeId).toBeTruthy()
    expect(betaNodeId).toMatch(/^[0-9a-f]{64}$/i)

    // Alpha browses Beta using Beta's Iroh NodeId
    const result = await harness.client('alpha').browse(betaHealth.peerId, {
      nodeId: betaNodeId,
    })

    expect(result).toBeDefined()
    expect(result.stubs).toBeDefined()
    expect(Array.isArray(result.stubs)).toBe(true)
    // Beta wrote 2 items, alpha should see at least them
    expect(result.stubs.length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('browse returns correct topic metadata', async () => {
    const betaHealth = await harness.client('beta').getHealth()
    const betaNodeId = betaHealth.nodeId

    const result = await harness.client('alpha').browse(betaHealth.peerId, {
      nodeId: betaNodeId,
    })

    // Check that the returned stubs have the correct topic information
    const topics = result.stubs.flatMap(s => s.topic)
    expect(topics).toContain('typescript')
    expect(topics).toContain('rust')
  }, 30_000)

  it('browse with collection filter returns only matching stubs', async () => {
    // Beta has no collection set on the stubs (no collection was written)
    // so filtering by a non-existent collection should return 0 stubs
    const betaHealth = await harness.client('beta').getHealth()
    const betaNodeId = betaHealth.nodeId

    const result = await harness.client('alpha').browse(betaHealth.peerId, {
      nodeId: betaNodeId,
      collection: 'nonexistent-collection-xyz',
    })

    expect(result.stubs).toBeDefined()
    expect(result.stubs.length).toBe(0)
  }, 30_000)

  it('browse with limit returns at most N stubs', async () => {
    const betaHealth = await harness.client('beta').getHealth()
    const betaNodeId = betaHealth.nodeId

    const result = await harness.client('alpha').browse(betaHealth.peerId, {
      nodeId: betaNodeId,
      limit: 1,
    })

    expect(result.stubs.length).toBeLessThanOrEqual(1)
    // If beta has > 1 stub, hasMore should be true
    expect(result.hasMore).toBe(true)
  }, 30_000)

  it('browse fails gracefully for invalid nodeId', async () => {
    try {
      await harness.client('alpha').browse('notapeerId', {
        nodeId: 'not-a-valid-node-id',
      })
      expect(false).toBe(true) // Should not reach
    } catch (err) {
      const e = err as { status?: number; message?: string }
      // Should return 400 (bad request) or 503 (connection failed)
      expect([400, 503]).toContain(e.status)
    }
  }, 15_000)
})

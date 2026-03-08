/**
 * E2E: P2P Memory Replication & Consistency
 *
 * Tests memory written on one agent becoming visible to other agents on the
 * same PSK network via Loro CRDT delta sync over iroh-gossip.
 *
 * NOTE: Real cross-peer replication requires the Iroh engine to establish
 * QUIC connections between agents, which depends on relay connectivity.
 * These tests use the single-agent network query as a smoke-test fallback
 * for CI environments where relay may not be available.
 *
 * For full multi-agent replication tests, see e2e/simulation/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

// ── Test 1: Alpha writes and reads back ───────────────────────────────────────

describe('memory written on Alpha is readable by Alpha', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('Alpha finds a chunk it wrote via search', async () => {
    const uniqueMarker = `alpha-marker-${Date.now()}`
    const chunk = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['replication-test'],
      content: `Alpha wrote this unique marker: ${uniqueMarker}`,
      confidence: 0.9,
    })

    expect(chunk.id).toBeTruthy()
    expect(chunk.content).toContain(uniqueMarker)
    expect(chunk.signature).toBeTruthy()

    // Alpha can immediately find its own chunk
    const results = await harness.client('alpha').searchMemory(uniqueMarker)
    expect(results.some((c) => c.id === chunk.id)).toBe(true)
  })
})

// ── Test 2: bidirectional writes on same PSK ──────────────────────────────────

describe('bidirectional writes on same PSK', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('both agents can write to and read from their own stores', async () => {
    const alphaMarker = `alpha-bi-${Date.now()}`
    const betaMarker = `beta-bi-${Date.now()}`

    const alphaChunk = await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['bidir'],
      content: `Alpha content: ${alphaMarker}`,
      confidence: 0.8,
    })
    const betaChunk = await harness.client('beta').putMemory({
      type: 'skill',
      topic: ['bidir'],
      content: `Beta content: ${betaMarker}`,
      confidence: 0.8,
    })

    // Each agent can find its own chunk
    const alphaResults = await harness.client('alpha').searchMemory(alphaMarker)
    expect(alphaResults.some((c) => c.id === alphaChunk.id)).toBe(true)

    const betaResults = await harness.client('beta').searchMemory(betaMarker)
    expect(betaResults.some((c) => c.id === betaChunk.id)).toBe(true)
  })
})

// ── Test 3: tombstone works locally ───────────────────────────────────────────

describe('tombstone / forget', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('deleted chunk no longer appears in search results', async () => {
    const marker = `tombstone-test-${Date.now()}`

    const chunk = await harness.client('alpha').putMemory({
      type: 'context',
      topic: ['tombstone'],
      content: `Will be deleted: ${marker}`,
      confidence: 0.5,
    })

    // Verify it's visible
    const before = await harness.client('alpha').searchMemory(marker)
    expect(before.some((c) => c.id === chunk.id)).toBe(true)

    // Delete it
    await harness.client('alpha').forgetMemory(chunk.id)

    // Should no longer appear as active
    await pollUntil(
      async () => {
        const r = await harness.client('alpha').searchMemory(marker)
        return r.every((c) => c.id !== chunk.id || (c as unknown as Record<string, unknown>)['_tombstone'] === true)
      },
      10_000,
      'deleted chunk to be tombstoned'
    )
  })
})

// ── Test 4: update creates version chain ─────────────────────────────────────

describe('update / version chain', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('PATCH creates version 2 that supersedes version 1', async () => {
    const marker = `update-test-${Date.now()}`

    const v1 = await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['update-propagation'],
      content: `v1 content: ${marker}`,
      confidence: 0.5,
    })
    expect(v1.version).toBe(1)

    const v2 = await harness.client('alpha').updateMemory(v1.id, {
      content: `v2 content: ${marker}`,
      confidence: 0.9,
    })
    expect(v2.version).toBe(2)
    expect(v2.supersedes).toBe(v1.id)
  })
})

// ── Test 5: concurrent writes from one agent are deduplicated ─────────────────

describe('concurrent writes converge locally', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('15 concurrent writes are all stored without duplication', async () => {
    const runId = Date.now()
    const writeCount = 15

    await Promise.all(
      Array.from({ length: writeCount }, (_, i) =>
        harness.client('alpha').putMemory({
          type: 'result',
          topic: ['convergence-test'],
          content: `chunk ${i}: run=${runId}`,
          confidence: 0.7,
        })
      )
    )

    const results = await harness.client('alpha').searchMemory(`run=${runId}`)
    expect(results.length).toBe(writeCount)

    const ids = new Set(results.map((c) => c.id))
    expect(ids.size).toBe(writeCount) // no duplicates
  })
})

// ── Test 6: data persists across restart ──────────────────────────────────────

describe('replication survives restart', () => {
  const harness = new TestHarness()
  let psk: string

  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    const result = await harness.joinAllToPsk()
    psk = result.psk
  })
  afterAll(() => harness.teardown())

  it('Alpha retains data after SIGTERM + restart', async () => {
    const marker = `pre-restart-${Date.now()}`

    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['restart-test'],
      content: `written before restart: ${marker}`,
      confidence: 0.8,
    })

    // Verify it's there
    const before = await harness.client('alpha').searchMemory(marker)
    expect(before.length).toBeGreaterThan(0)

    // Restart Alpha
    await harness.stopAgent('alpha', 'SIGTERM')
    await harness.restartAgent('alpha')
    await harness.client('alpha').joinNetwork(psk)

    // Previously written data should still be there
    const after = await harness.client('alpha').searchMemory(marker)
    expect(after.length).toBeGreaterThan(0)
  })
})

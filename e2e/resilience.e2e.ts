/**
 * E2E: Network Resilience — Restart, GC & Local Durability
 *
 * Tests durability of the local Loro CRDT store across crashes and restarts.
 * Multi-agent partition/reconnect scenarios are in e2e/simulation/partition-reconnect.e2e.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

// ── Test 1: data survives SIGKILL ─────────────────────────────────────────────

describe('data persists through SIGKILL', () => {
  const harness = new TestHarness()
  let psk: string

  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    const result = await harness.joinAllToPsk()
    psk = result.psk
  })
  afterAll(() => harness.teardown())

  it('retains all chunks written before a hard crash', async () => {
    const marker = `pre-kill-${Date.now()}`

    // Write 10 chunks
    const chunks = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        harness.client('alpha').putMemory({
          type: 'skill',
          topic: ['resilience'],
          content: `Chunk ${i}: marker=${marker}`,
          confidence: 0.8,
        })
      )
    )
    expect(chunks).toHaveLength(10)

    // Force-kill (SIGKILL — no graceful shutdown)
    await harness.stopAgent('alpha', 'SIGKILL')
    await sleep(500)

    // Restart
    await harness.restartAgent('alpha')
    await harness.client('alpha').joinNetwork(psk)

    // All chunks should still be there
    const results = await harness.client('alpha').searchMemory(marker)
    expect(results.length).toBe(10)
  })
})

// ── Test 2: rapid restart loop ────────────────────────────────────────────────

describe('rapid restart loop', () => {
  const harness = new TestHarness()
  let psk: string

  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    const result = await harness.joinAllToPsk()
    psk = result.psk
  })
  afterAll(() => harness.teardown())

  it('survives 3 quick restart cycles without data loss', async () => {
    const markers: string[] = []

    // Write before each restart cycle
    for (let cycle = 0; cycle < 3; cycle++) {
      const marker = `cycle-${cycle}-${Date.now()}`
      markers.push(marker)

      await harness.client('alpha').putMemory({
        type: 'skill',
        topic: ['restart-cycle'],
        content: `Cycle ${cycle} data: ${marker}`,
        confidence: 0.7,
      })

      await harness.stopAgent('alpha', 'SIGTERM')
      await harness.restartAgent('alpha')
      await harness.client('alpha').joinNetwork(psk)
    }

    // All markers should be present
    for (const marker of markers) {
      const results = await harness.client('alpha').searchMemory(marker)
      expect(results.length).toBeGreaterThan(0)
    }
  })
})

// ── Test 3: large write batch durability ─────────────────────────────────────

describe('large write batch durability', () => {
  const harness = new TestHarness()
  let psk: string

  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    const result = await harness.joinAllToPsk()
    psk = result.psk
  })
  afterAll(() => harness.teardown())

  it('500 sequential writes all persist after graceful restart', async () => {
    const runId = `batch-${Date.now()}`

    for (let i = 0; i < 500; i++) {
      await harness.client('alpha').putMemory({
        type: 'result',
        topic: ['bulk-write'],
        content: `Bulk item ${i}: runId=${runId}`,
        confidence: 0.6,
      })
    }

    await harness.stopAgent('alpha', 'SIGTERM')
    await harness.restartAgent('alpha')
    await harness.client('alpha').joinNetwork(psk)

    // All 500 should survive
    const results = await harness.client('alpha').queryMemory({
      topics: ['bulk-write'],
      limit: 500,
    })
    expect(results.length).toBe(500)
  })
})

// ── Test 4: store isolation after leave ──────────────────────────────────────

describe('store isolation after PSK leave', () => {
  const harness = new TestHarness()

  beforeAll(async () => {
    await harness.startAgents(['alpha'])
  })
  afterAll(() => harness.teardown())

  it('chunks written to PSK-A are not visible after switching to PSK-B', async () => {
    const pskA = randomPsk()
    const pskB = randomPsk()

    const netA = await harness.client('alpha').joinNetwork(pskA)
    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['psk-a-data'],
      content: 'data only in PSK-A',
      confidence: 0.9,
    })

    await harness.client('alpha').leaveNetwork(netA.id)
    await harness.client('alpha').joinNetwork(pskB)

    const results = await harness.client('alpha').searchMemory('data only in PSK-A')
    // After leaving PSK-A and joining PSK-B, PSK-A data should not be visible
    expect(results.length).toBe(0)
  })
})

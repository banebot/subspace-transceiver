/**
 * C.1: Concurrent write storm — 2 agents × 100 chunks.
 *
 * Both agents fire 100 writes in parallel to the same PSK network.
 * After convergence, both should have all 200 chunks (CRDT guarantee).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { pollUntil } from '../helpers/wait.js'

describe('C.1: Concurrent write storm', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('2 agents × 100 chunks converge to 200 identical chunks', async () => {
    // Note: 200 concurrent HTTP writes can take 60-80s on a loaded system.
    // This test is intentionally heavy — it validates that 100-chunk write storms
    // don't lose data, not that they converge fast.
    await harness.joinAllToPsk()

    const CHUNKS_PER_AGENT = 100

    // Fire 100 writes from each agent in parallel
    const writePromises: Promise<string>[] = []
    for (let i = 0; i < CHUNKS_PER_AGENT; i++) {
      writePromises.push(
        harness.client('alpha').putMemory({
          content: `alpha-storm-${i}`,
          topic: ['write-storm'],
        }).then(c => c.id)
      )
      writePromises.push(
        harness.client('beta').putMemory({
          content: `beta-storm-${i}`,
          topic: ['write-storm'],
        }).then(c => c.id)
      )
    }

    const allIds = await Promise.all(writePromises)
    expect(allIds.length).toBe(CHUNKS_PER_AGENT * 2)

    const startMs = Date.now()

    // Wait for convergence on both agents
    for (const agent of ['alpha', 'beta']) {
      await pollUntil(
        async () => {
          const chunks = await harness.client(agent).queryMemory({ topics: ['write-storm'] })
          return chunks.length >= CHUNKS_PER_AGENT * 2
        },
        90_000,
        `${agent} to have ${CHUNKS_PER_AGENT * 2} chunks`
      )
    }

    const convergenceMs = Date.now() - startMs
    console.log(`[write-storm] Convergence time: ${convergenceMs}ms`)

    // Verify both have the same chunks
    const alphaChunks = await harness.client('alpha').queryMemory({ topics: ['write-storm'] })
    const betaChunks = await harness.client('beta').queryMemory({ topics: ['write-storm'] })

    const alphaIds = alphaChunks.map(c => c.id).sort()
    const betaIds = betaChunks.map(c => c.id).sort()

    expect(alphaIds).toEqual(betaIds)
    expect(alphaIds.length).toBe(CHUNKS_PER_AGENT * 2)
  }, 120_000)
})

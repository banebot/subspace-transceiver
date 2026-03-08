/**
 * C.3: 8-agent swarm — each writes 10 chunks, verify all 80 replicate.
 *
 * Spawns 8 daemon instances (~800MB RAM total).
 * Each agent writes 10 chunks sequentially. All 80 should replicate everywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { pollUntil } from '../helpers/wait.js'

const AGENT_NAMES = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
const CHUNKS_PER_AGENT = 10
const TOTAL_CHUNKS = AGENT_NAMES.length * CHUNKS_PER_AGENT

describe('C.3: 8-agent swarm', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(AGENT_NAMES)
  }, 120_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it(`${TOTAL_CHUNKS} chunks replicate across all ${AGENT_NAMES.length} agents`, async () => {
    await harness.joinAllToPsk()

    // Each agent writes 10 chunks
    const allIds: string[] = []
    for (const name of AGENT_NAMES) {
      for (let i = 0; i < CHUNKS_PER_AGENT; i++) {
        const chunk = await harness.client(name).putMemory({
          content: `${name}-swarm-${i}`,
          topic: ['swarm-test'],
        })
        allIds.push(chunk.id)
      }
    }

    expect(allIds.length).toBe(TOTAL_CHUNKS)

    const startMs = Date.now()

    // Wait for convergence on all agents
    for (const name of AGENT_NAMES) {
      await pollUntil(
        async () => {
          const chunks = await harness.client(name).queryMemory({ topics: ['swarm-test'] })
          return chunks.length >= TOTAL_CHUNKS
        },
        60_000,
        `${name} to have all ${TOTAL_CHUNKS} chunks`
      )
    }

    const convergenceMs = Date.now() - startMs
    console.log(`[swarm] Full convergence time: ${convergenceMs}ms for ${TOTAL_CHUNKS} chunks across ${AGENT_NAMES.length} agents`)

    // Verify all agents have identical chunk sets
    const firstAgentChunks = await harness.client(AGENT_NAMES[0]).queryMemory({ topics: ['swarm-test'] })
    const referenceIds = firstAgentChunks.map(c => c.id).sort()

    for (const name of AGENT_NAMES.slice(1)) {
      const chunks = await harness.client(name).queryMemory({ topics: ['swarm-test'] })
      const ids = chunks.map(c => c.id).sort()
      expect(ids).toEqual(referenceIds)
    }
  }, 120_000)
})

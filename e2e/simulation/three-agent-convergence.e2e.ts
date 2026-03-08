/**
 * B.2: Three-agent gossip convergence test.
 *
 * Spawns 3 daemons on same PSK.
 * Agent A writes 3 chunks → gossip fanout → B and C both receive all 3.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { pollUntil } from '../helpers/wait.js'

describe('B.2: Three-agent gossip convergence', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta', 'gamma'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('3 chunks written by alpha replicate to both beta and gamma', async () => {
    await harness.joinAllToPsk()

    // Alpha writes 3 chunks
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const chunk = await harness.client('alpha').putMemory({
        content: `convergence chunk ${i}`,
        topic: ['convergence-test'],
      })
      ids.push(chunk.id)
    }

    // Poll beta and gamma until all 3 appear
    for (const agent of ['beta', 'gamma']) {
      await pollUntil(
        async () => {
          const chunks = await harness.client(agent).queryMemory({ topics: ['convergence-test'] })
          const foundIds = chunks.map(c => c.id)
          return ids.every(id => foundIds.includes(id))
        },
        30_000,
        `all 3 chunks to replicate to ${agent}`
      )
    }

    // Verify content on beta
    for (let i = 0; i < 3; i++) {
      const chunk = await harness.client('beta').getMemory(ids[i])
      expect(chunk.content).toBe(`convergence chunk ${i}`)
    }

    // Verify content on gamma
    for (let i = 0; i < 3; i++) {
      const chunk = await harness.client('gamma').getMemory(ids[i])
      expect(chunk.content).toBe(`convergence chunk ${i}`)
    }
  }, 45_000)

  it('each agent writes a chunk, all 3 converge to same state', async () => {
    const alphaChunk = await harness.client('alpha').putMemory({
      content: 'from alpha',
      topic: ['multi-writer'],
    })
    const betaChunk = await harness.client('beta').putMemory({
      content: 'from beta',
      topic: ['multi-writer'],
    })
    const gammaChunk = await harness.client('gamma').putMemory({
      content: 'from gamma',
      topic: ['multi-writer'],
    })

    const allIds = [alphaChunk.id, betaChunk.id, gammaChunk.id]

    // All 3 agents should have all 3 chunks
    for (const agent of ['alpha', 'beta', 'gamma']) {
      await pollUntil(
        async () => {
          const chunks = await harness.client(agent).queryMemory({ topics: ['multi-writer'] })
          const foundIds = chunks.map(c => c.id)
          return allIds.every(id => foundIds.includes(id))
        },
        30_000,
        `all chunks to converge on ${agent}`
      )
    }
  }, 45_000)
})

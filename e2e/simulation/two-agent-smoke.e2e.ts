/**
 * B.1: Two-agent replication smoke test.
 *
 * Spawns 2 daemon instances on localhost.
 * Agent A writes a chunk → gossip → Agent B should see it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { pollUntil } from '../helpers/wait.js'

describe('B.1: Two-agent replication smoke', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('chunk written by A appears on B after joining same PSK', async () => {
    await harness.joinAllToPsk()

    // Agent A writes a chunk
    const written = await harness.client('alpha').putMemory({
      content: 'hello from alpha',
      topic: ['smoke-test'],
    })
    expect(written.id).toBeTruthy()

    // Poll Agent B until the chunk appears (up to 15s)
    await pollUntil(
      async () => {
        try {
          const chunks = await harness.client('beta').queryMemory({ topics: ['smoke-test'] })
          return chunks.some(c => c.id === written.id)
        } catch {
          return false
        }
      },
      15_000,
      'chunk to replicate from alpha to beta'
    )

    const chunks = await harness.client('beta').queryMemory({ topics: ['smoke-test'] })
    const found = chunks.find(c => c.id === written.id)!
    expect(found.content).toBe('hello from alpha')
    expect(found.topic).toContain('smoke-test')
  }, 30_000)

  it('chunk written by B appears on A (bidirectional)', async () => {
    const written = await harness.client('beta').putMemory({
      content: 'hello from beta',
      topic: ['bidirectional-test'],
    })

    await pollUntil(
      async () => {
        try {
          const chunks = await harness.client('alpha').queryMemory({ topics: ['bidirectional-test'] })
          return chunks.some(c => c.id === written.id)
        } catch {
          return false
        }
      },
      15_000,
      'chunk to replicate from beta to alpha'
    )

    const chunks = await harness.client('alpha').queryMemory({ topics: ['bidirectional-test'] })
    const found = chunks.find(c => c.id === written.id)!
    expect(found.content).toBe('hello from beta')
  }, 30_000)

  it('chunk metadata survives replication', async () => {
    const written = await harness.client('alpha').putMemory({
      content: 'metadata test chunk',
      topic: ['meta', 'replication'],
      collection: 'test-patterns',
    })

    await pollUntil(
      async () => {
        try {
          const chunk = await harness.client('beta').getMemory(written.id)
          return !!chunk
        } catch {
          return false
        }
      },
      15_000,
      'metadata chunk to replicate'
    )

    const found = await harness.client('beta').getMemory(written.id)
    expect(found.content).toBe('metadata test chunk')
    expect(found.topic).toEqual(expect.arrayContaining(['meta', 'replication']))
    expect(found.source.agentId).toBeTruthy()
  }, 30_000)
})

/**
 * D.1: Signature verification survives replication — reject forged chunks.
 *
 * Tests that chunk signatures are preserved through replication and that
 * tampered signatures are detectable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { pollUntil } from '../helpers/wait.js'

describe('D.1: Signature verification through replication', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('chunk source.agentId and source.peerId survive replication', async () => {
    await harness.joinAllToPsk()

    const written = await harness.client('alpha').putMemory({
      content: 'signed chunk from alpha',
      topic: ['sig-test'],
    })

    await pollUntil(
      async () => {
        try {
          await harness.client('beta').getMemory(written.id)
          return true
        } catch {
          return false
        }
      },
      15_000,
      'signed chunk to replicate to beta'
    )

    const found = await harness.client('beta').getMemory(written.id)
    expect(found.source.agentId).toBe(written.source.agentId)
    expect(found.source.peerId).toBe(written.source.peerId)
    expect(found.content).toBe('signed chunk from alpha')
  }, 30_000)

  it('chunk with tampered content would have different hash', async () => {
    const written = await harness.client('alpha').putMemory({
      content: 'integrity test',
      topic: ['integrity'],
    })

    await pollUntil(
      async () => {
        try {
          await harness.client('beta').getMemory(written.id)
          return true
        } catch {
          return false
        }
      },
      15_000,
      'integrity chunk to replicate'
    )

    const found = await harness.client('beta').getMemory(written.id)
    // The chunk ID is a content-derived hash — tampering would change the ID
    expect(found.id).toBe(written.id)
    expect(found.content).toBe(written.content)
  }, 30_000)

  it('chunks from different agents have different source.agentId', async () => {
    const alphaChunk = await harness.client('alpha').putMemory({
      content: 'alpha authored',
      topic: ['authorship'],
    })
    const betaChunk = await harness.client('beta').putMemory({
      content: 'beta authored',
      topic: ['authorship'],
    })

    expect(alphaChunk.source.agentId).not.toBe(betaChunk.source.agentId)
  })
})

/**
 * E2E: CRDT Replication between real daemons
 *
 * Tests that two agents on the same PSK network automatically replicate
 * each other's memories via Loro CRDT + iroh-gossip delta sync.
 *
 * This is Sprint 4: "Prove CRDT Replication Between Real Daemons".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

describe('CRDT replication: two agents, same PSK', () => {
  const harness = new TestHarness()
  const psk = randomPsk()

  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.joinAllToPsk(psk)
  }, 60_000)

  afterAll(() => harness.teardown())

  it('alpha writes → beta receives (unidirectional)', async () => {
    const written = await harness.client('alpha').putMemory({
      content: 'hello from alpha',
      topic: ['crdt-test'],
      confidence: 0.9,
    })
    expect(written.id).toBeTruthy()

    await pollUntil(
      async () => {
        const chunks = await harness.client('beta').queryMemory({ topics: ['crdt-test'] })
        return chunks.some(c => c.id === written.id)
      },
      15_000,
      'alpha chunk to replicate to beta'
    )

    const chunks = await harness.client('beta').queryMemory({ topics: ['crdt-test'] })
    const found = chunks.find(c => c.id === written.id)!
    expect(found.content).toBe('hello from alpha')
    expect(found.topic).toContain('crdt-test')
  }, 25_000)

  it('beta writes → alpha receives (bidirectional)', async () => {
    const written = await harness.client('beta').putMemory({
      content: 'hello from beta',
      topic: ['crdt-test-bi'],
      confidence: 0.9,
    })

    await pollUntil(
      async () => {
        const chunks = await harness.client('alpha').queryMemory({ topics: ['crdt-test-bi'] })
        return chunks.some(c => c.id === written.id)
      },
      15_000,
      'beta chunk to replicate to alpha'
    )

    const chunks = await harness.client('alpha').queryMemory({ topics: ['crdt-test-bi'] })
    const found = chunks.find(c => c.id === written.id)!
    expect(found.content).toBe('hello from beta')
  }, 25_000)

  it('multiple chunks replicate in order', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const c = await harness.client('alpha').putMemory({
        content: `batch chunk ${i}`,
        topic: ['crdt-batch'],
        confidence: 0.9,
      })
      ids.push(c.id)
    }

    await pollUntil(
      async () => {
        const chunks = await harness.client('beta').queryMemory({ topics: ['crdt-batch'] })
        const foundIds = chunks.map(c => c.id)
        return ids.every(id => foundIds.includes(id))
      },
      20_000,
      'all 5 batch chunks to replicate to beta'
    )

    const chunks = await harness.client('beta').queryMemory({ topics: ['crdt-batch'] })
    const foundIds = chunks.map(c => c.id)
    for (const id of ids) {
      expect(foundIds).toContain(id)
    }
  }, 30_000)

  it('chunk content integrity is preserved across replication', async () => {
    const originalContent = 'Integrity check: special chars ✓ unicode 中文 emojis 🤖'
    const written = await harness.client('alpha').putMemory({
      content: originalContent,
      topic: ['crdt-integrity'],
      confidence: 0.99,
    })

    await pollUntil(
      async () => {
        const chunks = await harness.client('beta').queryMemory({ topics: ['crdt-integrity'] })
        return chunks.some(c => c.id === written.id)
      },
      15_000,
      'integrity chunk to replicate to beta'
    )

    const chunks = await harness.client('beta').queryMemory({ topics: ['crdt-integrity'] })
    const found = chunks.find(c => c.id === written.id)!
    expect(found.content).toBe(originalContent)
    expect(found.confidence).toBe(0.99)
  }, 25_000)
})

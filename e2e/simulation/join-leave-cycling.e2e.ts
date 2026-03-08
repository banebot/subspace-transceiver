/**
 * C.4: Rapid PSK join/leave cycling — verify no state corruption.
 *
 * Agent joins PSK, writes chunks, leaves, rejoins, writes more.
 * Verifies persistent Loro snapshots survive the cycle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from '../harness.js'
import { pollUntil, sleep } from '../helpers/wait.js'

describe('C.4: Join/leave cycling', () => {
  let harness: TestHarness
  let psk: string

  beforeAll(async () => {
    harness = new TestHarness()
    psk = randomPsk()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('chunks survive join → write → leave → rejoin cycle', async () => {
    const net1 = await harness.client('alpha').joinNetwork(psk)

    // Write 3 chunks
    const phase1Ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const chunk = await harness.client('alpha').putMemory({
        content: `cycle-p1-${i}`,
        topic: ['cycle-test'],
      })
      phase1Ids.push(chunk.id)
    }

    // Verify 3 chunks exist
    let chunks = await harness.client('alpha').queryMemory({ topics: ['cycle-test'] })
    expect(chunks.length).toBe(3)

    // Leave the network
    await harness.client('alpha').leaveNetwork(net1.id)
    await sleep(1000)

    // Rejoin the same PSK
    await harness.client('alpha').joinNetwork(psk)

    // Verify original 3 chunks survived (persistent Loro snapshot)
    chunks = await harness.client('alpha').queryMemory({ topics: ['cycle-test'] })
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const id of phase1Ids) {
      const c = chunks.find(ch => ch.id === id)
      expect(c).toBeTruthy()
    }

    // Write 3 more chunks
    for (let i = 0; i < 3; i++) {
      await harness.client('alpha').putMemory({
        content: `cycle-p2-${i}`,
        topic: ['cycle-test'],
      })
    }

    // Verify all 6 chunks
    chunks = await harness.client('alpha').queryMemory({ topics: ['cycle-test'] })
    expect(chunks.length).toBe(6)
  }, 60_000)

  it('second agent joining same PSK sees all chunks after cycling', async () => {
    // Join beta to the SAME psk alpha is on, and introduce them to each other.
    // We list both agents so the harness can exchange NodeIds for gossip bootstrap.
    await harness.joinAllToPsk(psk, ['alpha', 'beta'])

    await pollUntil(
      async () => {
        const chunks = await harness.client('beta').queryMemory({ topics: ['cycle-test'] })
        return chunks.length >= 6
      },
      20_000,
      'beta to see all 6 chunks from alpha after cycling'
    )
  }, 30_000)
})

/**
 * C.2: Network partition + reconnect.
 *
 * Start 2 agents. Write chunks. Kill one agent. Write more on the survivor.
 * Restart killed agent. Verify Loro CRDT merge recovers all data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { pollUntil } from '../helpers/wait.js'

describe('C.2: Partition + reconnect', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('data survives partition and merges on reconnect', async () => {
    const { networkId, psk } = await harness.joinAllToPsk()

    // Phase 1: both agents write 5 chunks each
    for (let i = 0; i < 5; i++) {
      await harness.client('alpha').putMemory({
        content: `alpha-p1-${i}`,
        topic: ['partition-test'],
      })
      await harness.client('beta').putMemory({
        content: `beta-p1-${i}`,
        topic: ['partition-test'],
      })
    }

    // Wait for phase1 convergence
    for (const agent of ['alpha', 'beta']) {
      await pollUntil(
        async () => {
          const chunks = await harness.client(agent).queryMemory({ topics: ['partition-test'] })
          return chunks.length >= 10
        },
        20_000,
        `phase1 convergence on ${agent}`
      )
    }

    // Phase 2: kill beta (simulate partition)
    await harness.stopAgent('beta', 'SIGKILL')

    // Phase 3: alpha writes 5 more chunks while beta is down
    for (let i = 0; i < 5; i++) {
      await harness.client('alpha').putMemory({
        content: `alpha-during-partition-${i}`,
        topic: ['partition-test'],
      })
    }

    // Verify alpha has 15 chunks
    const alphaChunks = await harness.client('alpha').queryMemory({ topics: ['partition-test'] })
    expect(alphaChunks.length).toBe(15)

    // Phase 4: restart beta
    await harness.restartAgent('beta')

    // Beta needs to rejoin the PSK and re-establish connectivity
    await harness.client('beta').joinNetwork(psk)
    await harness.connectPskPeers(networkId, ['alpha', 'beta'])

    // Phase 5: wait for all 15 chunks to appear on beta
    await pollUntil(
      async () => {
        const chunks = await harness.client('beta').queryMemory({ topics: ['partition-test'] })
        return chunks.length >= 15
      },
      30_000,
      'beta to recover all 15 chunks after reconnect'
    )

    // Phase 6: beta writes 5 more → alpha should get them
    for (let i = 0; i < 5; i++) {
      await harness.client('beta').putMemory({
        content: `beta-after-reconnect-${i}`,
        topic: ['partition-test'],
      })
    }

    // Wait for full convergence (20 chunks total)
    for (const agent of ['alpha', 'beta']) {
      await pollUntil(
        async () => {
          const chunks = await harness.client(agent).queryMemory({ topics: ['partition-test'] })
          return chunks.length >= 20
        },
        20_000,
        `final convergence on ${agent} (20 chunks)`
      )
    }
  }, 120_000)
})

/**
 * D.2: Cross-PSK isolation — agents on different PSKs NEVER see each other's data.
 *
 * Agent A on PSK-1 writes data. Agent B on PSK-2 writes data.
 * Neither should ever see the other's chunks, even on the same machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from '../harness.js'
import { pollUntil, sleep } from '../helpers/wait.js'

describe('D.2: Cross-PSK isolation', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta', 'gamma'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('agents on different PSKs never see each other\'s data', async () => {
    const psk1 = randomPsk()
    const psk2 = randomPsk()

    // Alpha joins PSK-1
    await harness.client('alpha').joinNetwork(psk1)
    // Beta joins PSK-2 (different network!)
    await harness.client('beta').joinNetwork(psk2)

    // Alpha writes to PSK-1
    await harness.client('alpha').putMemory({
      content: 'secret-alpha',
      topic: ['isolation-test'],
    })

    // Beta writes to PSK-2
    await harness.client('beta').putMemory({
      content: 'secret-beta',
      topic: ['isolation-test'],
    })

    // Wait 10 seconds to ensure no delayed cross-leak
    await sleep(10_000)

    // Alpha should only see its own chunk
    const alphaChunks = await harness.client('alpha').queryMemory({ topics: ['isolation-test'] })
    expect(alphaChunks.length).toBe(1)
    expect(alphaChunks[0].content).toBe('secret-alpha')

    // Beta should only see its own chunk
    const betaChunks = await harness.client('beta').queryMemory({ topics: ['isolation-test'] })
    expect(betaChunks.length).toBe(1)
    expect(betaChunks[0].content).toBe('secret-beta')
  }, 30_000)

  it('third agent joining PSK-1 sees alpha\'s data but not beta\'s', async () => {
    const psk1 = randomPsk()

    const { networkId } = await harness.joinAllToPsk(psk1, ['alpha', 'gamma'])

    await harness.client('alpha').putMemory({
      content: 'alpha-for-gamma',
      topic: ['gamma-isolation-test'],
    })

    await pollUntil(
      async () => {
        const chunks = await harness.client('gamma').queryMemory({ topics: ['gamma-isolation-test'] })
        return chunks.some(c => c.content === 'alpha-for-gamma')
      },
      15_000,
      'gamma to see alpha\'s chunk'
    )

    // Gamma should NOT see beta's original data (different PSK)
    const gammaAll = await harness.client('gamma').queryMemory({ topics: ['isolation-test'] })
    expect(gammaAll.some(c => c.content === 'secret-beta')).toBe(false)
  }, 30_000)
})

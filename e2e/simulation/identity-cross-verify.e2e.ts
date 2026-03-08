/**
 * B.3: DID + ZKP cross-verification between daemons.
 *
 * Agent A generates proofs/credentials.
 * Agent B verifies them via its own /identity/verify endpoints.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { sleep } from '../helpers/wait.js'

describe('B.3: DID + ZKP cross-verification', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('Agent B accepts Agent A\'s proof of key ownership', async () => {
    // A generates a proof
    const proofRes = await harness.client('alpha').post('/identity/proof', {
      domain: 'test.subspace.local',
    })
    expect(proofRes.proof).toBeTruthy()

    // B verifies it
    const verifyRes = await harness.client('beta').post('/identity/verify', {
      proof: proofRes.proof,
    })
    expect(verifyRes.valid).toBe(true)
  })

  it('Agent B accepts Agent A\'s verifiable credential', async () => {
    const credRes = await harness.client('alpha').post('/identity/credential', {
      claims: [
        { type: 'agentRole', value: 'coordinator' },
        { type: 'trustLevel', value: '3' },
      ],
    })
    expect(credRes.credential).toBeTruthy()

    const verifyRes = await harness.client('beta').post('/identity/credential/verify', {
      credential: credRes.credential,
    })
    expect(verifyRes.valid).toBe(true)
  })

  it('Agent B rejects a tampered proof signature', async () => {
    const proofRes = await harness.client('alpha').post('/identity/proof', {
      domain: 'test.subspace.local',
    })

    // Tamper with the signature — flip a character
    const proof = JSON.parse(JSON.stringify(proofRes.proof)) as Record<string, unknown>
    if (proof.signature) {
      const sig = proof.signature as string
      proof.signature = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a')
    }

    const verifyRes = await harness.client('beta').post('/identity/verify', {
      proof,
    })
    expect(verifyRes.valid).toBe(false)
  })

  it('Agent B rejects an expired proof', async () => {
    // Generate a proof with very short TTL
    const proofRes = await harness.client('alpha').post('/identity/proof', {
      domain: 'test.subspace.local',
      ttlMs: 1000,
    })

    // Wait for it to expire
    await sleep(2000)

    const verifyRes = await harness.client('beta').post('/identity/verify', {
      proof: proofRes.proof,
    })
    expect(verifyRes.valid).toBe(false)
  })

  it('both agents have unique DID:Key identities', async () => {
    const healthA = await harness.client('alpha').getHealth()
    const healthB = await harness.client('beta').getHealth()

    expect(healthA.did).toBeTruthy()
    expect(healthB.did).toBeTruthy()
    expect(healthA.did).not.toBe(healthB.did)
    expect(healthA.did).toMatch(/^did:key:z/)
    expect(healthB.did).toMatch(/^did:key:z/)
  })
})

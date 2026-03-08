/**
 * D.3: ZKP edge cases — expired proofs, tampered proofs, cross-DID attacks.
 *
 * Tests ZKP proof rejection across two real daemon instances.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from '../harness.js'
import { sleep } from '../helpers/wait.js'

describe('D.3: ZKP adversarial edge cases', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = new TestHarness()
    await harness.startAgents(['alpha', 'beta'])
  }, 60_000)

  afterAll(async () => {
    await harness.teardown()
  })

  it('rejects expired proof (1s TTL)', async () => {
    const proofRes = await harness.client('alpha').post<{ proof: Record<string, unknown> }>('/identity/proof', {
      domain: 'test.subspace.local',
      ttlMs: 1000,
    })

    // Wait for expiration
    await sleep(2000)

    const verifyRes = await harness.client('beta').post<{ valid: boolean }>('/identity/verify', {
      proof: proofRes.proof,
    })
    expect(verifyRes.valid).toBe(false)
  }, 15_000)

  it('rejects proof with tampered signature', async () => {
    const proofRes = await harness.client('alpha').post<{ proof: Record<string, unknown> }>('/identity/proof', {
      domain: 'test.subspace.local',
    })

    // Tamper with signature
    const proof = { ...proofRes.proof }
    const sig = proof.signature as string
    proof.signature = sig.slice(0, -2) + (sig.endsWith('aa') ? 'bb' : 'aa')

    const verifyRes = await harness.client('beta').post<{ valid: boolean }>('/identity/verify', {
      proof,
    })
    expect(verifyRes.valid).toBe(false)
  })

  it('rejects proof with cross-DID attack (A\'s proof, B\'s DID)', async () => {
    const proofRes = await harness.client('alpha').post<{ proof: Record<string, unknown> }>('/identity/proof', {
      domain: 'test.subspace.local',
    })

    const healthB = await harness.client('beta').getHealth()

    // Replace the DID in the proof with beta's DID
    const proof = { ...proofRes.proof, did: healthB.did }

    const verifyRes = await harness.client('beta').post<{ valid: boolean }>('/identity/verify', {
      proof,
    })
    expect(verifyRes.valid).toBe(false)
  })

  it('rejects proof with tampered issuedAt', async () => {
    const proofRes = await harness.client('alpha').post<{ proof: Record<string, unknown> }>('/identity/proof', {
      domain: 'test.subspace.local',
    })

    // Change the timestamp (breaks the challenge hash)
    const proof = { ...proofRes.proof }
    proof.issuedAt = new Date(Date.now() - 60000).toISOString()

    const verifyRes = await harness.client('beta').post<{ valid: boolean }>('/identity/verify', {
      proof,
    })
    expect(verifyRes.valid).toBe(false)
  })

  it('rejects credential with tampered claim value', async () => {
    const credRes = await harness.client('alpha').post<{ credential: Record<string, unknown> }>('/identity/credential', {
      claims: [
        { type: 'agentRole', value: 'coordinator' },
      ],
    })

    // Tamper with the credential's claim
    const cred = JSON.parse(JSON.stringify(credRes.credential))
    if (cred.credentialSubject?.claims) {
      cred.credentialSubject.claims[0].value = 'admin' // forged!
    }

    const verifyRes = await harness.client('beta').post<{ valid: boolean }>('/identity/credential/verify', {
      credential: cred,
    })
    expect(verifyRes.valid).toBe(false)
  })
})

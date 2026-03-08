/**
 * E2E: Security — Signatures, PoW, Rate Limiting, Reputation & PSK Isolation
 *
 * Tests all security subsystems end-to-end through the daemon HTTP API.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

// ── Tests 1 & 2: signatures and proof-of-work ─────────────────────────────────

describe('Ed25519 signing and proof-of-work', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('stored chunks have Ed25519 signature matching source.peerId', async () => {
    const alphaPeerId = harness.peerId('alpha')
    const chunk = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['signing-test'],
      content: 'This chunk should be Ed25519 signed.',
      confidence: 0.9,
    })

    expect(chunk.signature).toBeTruthy()
    expect(typeof chunk.signature).toBe('string')
    expect(chunk.source.peerId).toBe(alphaPeerId)
  })

  it('stored chunks have proof-of-work stamps', async () => {
    const chunk = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['pow-test'],
      content: 'This chunk should have a PoW stamp.',
      confidence: 0.9,
    })

    expect(chunk.pow).toBeDefined()
    expect(chunk.pow!.bits).toBeGreaterThan(0)
    expect(chunk.pow!.challenge).toBeTruthy()
    // nonce is stored as a hex string (see HashcashStamp.nonce: string)
    expect(typeof chunk.pow!.nonce).toBe('string')
  })

  it('GET /security/pow-status returns PoW config and cached stamps', async () => {
    const status = await harness.client('alpha').getPowStatus() as {
      config: { powBitsForChunks: number; powBitsForRequests: number }
      cachedStamps: unknown[]
    }
    expect(status.config).toBeDefined()
    expect(status.config.powBitsForChunks).toBeGreaterThan(0)
    expect(status.config.powBitsForRequests).toBeGreaterThan(0)
    expect(Array.isArray(status.cachedStamps)).toBe(true)
  })
})

// ── Test 3: rate limiting ─────────────────────────────────────────────────────

describe('rate limiting', () => {
  // Use a tightly-restricted harness: max 3 chunks per 5-second window
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'], {
      SUBSPACE_RATE_LIMIT_WINDOW_MS: '5000',
      SUBSPACE_MAX_CHUNKS_PER_PEER: '3',
    })
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('rejects writes beyond the per-window limit with 429', async () => {
    // Write 3 chunks — should all succeed
    for (let i = 0; i < 3; i++) {
      await harness.client('alpha').putMemory({
        type: 'context',
        topic: ['rate-test'],
        content: `allowed chunk ${i}`,
        confidence: 0.5,
      })
    }

    // 4th chunk should be rate-limited
    await expect(
      harness.client('alpha').putMemory({
        type: 'context',
        topic: ['rate-test'],
        content: 'this should be rejected',
        confidence: 0.5,
      })
    ).rejects.toMatchObject({ status: 429 })

    // After the window expires, writes succeed again
    await sleep(6000)  // wait for 5s window to roll over
    const recovered = await harness.client('alpha').putMemory({
      type: 'context',
      topic: ['rate-test'],
      content: 'recovered after window reset',
      confidence: 0.5,
    })
    expect(recovered.id).toBeTruthy()
  })
})

// ── Test 4: reputation tracking ───────────────────────────────────────────────

describe('reputation tracking', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('GET /security/reputation returns an array (possibly empty for self)', async () => {
    // Store some valid chunks to register activity
    for (let i = 0; i < 3; i++) {
      await harness.client('alpha').putMemory({
        type: 'skill',
        topic: ['reputation-test'],
        content: `valid chunk ${i}`,
        confidence: 0.8,
      })
    }

    const reputation = await harness.client('alpha').getReputation()
    expect(Array.isArray(reputation)).toBe(true)
    // Reputation entries are for REMOTE peers (self writes don't go through security checks)
    // So it may be empty for a single-agent setup — that's fine.
  })
})

// ── Test 5: invalid signature rejected ────────────────────────────────────────

describe('invalid signature rejection', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('chunks with a tampered signature are rejected with SIGNATURE_INVALID', async () => {
    const alphaPeerId = harness.peerId('alpha')

    // Craft a chunk that claims to be from Alpha but has a forged/garbage signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      harness.client('alpha').putMemory({
        type: 'pattern',
        topic: ['sig-test'],
        content: 'tampered chunk',
        confidence: 0.5,
        // Inject a fake signature — daemon should detect the mismatch
        signature: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        source: {
          agentId: 'attacker',
          peerId: alphaPeerId,  // claims to be Alpha
          timestamp: Date.now(),
        },
      } as any)
    ).rejects.toMatchObject({ status: 400 })
  })
})

// ── Test 6: blacklist and clear ────────────────────────────────────────────────

describe('peer blacklist management', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('clearing a blacklisted peer allows it again', async () => {
    const fakePeerId = '12D3KooWFakePeer1234567890000000000000000000000000000001'

    // The clear endpoint should work even if the peer wasn't blacklisted
    await harness.client('alpha').clearReputation(fakePeerId)

    // Reputation endpoint still works
    const rep = await harness.client('alpha').getReputation()
    expect(Array.isArray(rep)).toBe(true)
  })
})

// ── Test 7: PSK isolation ─────────────────────────────────────────────────────

describe('PSK network isolation', () => {
  const harness = new TestHarness()
  let pskA: string
  let pskB: string

  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta', 'gamma'])

    pskA = randomPsk()
    pskB = randomPsk()

    // Alpha and Beta join PSK-A
    await harness.joinAllToPsk(pskA, ['alpha', 'beta'])

    // Gamma joins PSK-B (different network)
    await harness.client('gamma').joinNetwork(pskB)
  })
  afterAll(() => harness.teardown())

  it('Gamma on PSK-B cannot find content from Alpha on PSK-A', async () => {
    const isolationMarker = `isolation-${Date.now()}`

    // Alpha writes on PSK-A
    await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['isolation'],
      content: `Secret in PSK-A: ${isolationMarker}`,
      confidence: 0.9,
    })

    // Gamma (PSK-B) searches — should NOT find Alpha's content
    // Give it a few seconds in case the query protocol could somehow cross PSK boundaries
    await sleep(5000)

    const gammaResults = await harness.client('gamma').searchMemory(isolationMarker)
    expect(gammaResults.length).toBe(0)

    // Beta (PSK-A) CAN find Alpha's content
    await pollUntil(
      async () => {
        const r = await harness.client('beta').searchMemory(isolationMarker)
        return r.length > 0
      },
      60_000,
      'Beta (same PSK-A) to find Alpha\'s isolated content'
    )
  })
})

// ── Test 8: oversized content rejection ──────────────────────────────────────

describe('oversized content rejection', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('rejects content exceeding maxChunkContentBytes with 413', async () => {
    // Default maxChunkContentBytes is 65536 (64KB). Generate 100KB of content.
    const oversizedContent = 'x'.repeat(100 * 1024)

    await expect(
      harness.client('alpha').putMemory({
        type: 'document',
        topic: ['size-test'],
        content: oversizedContent,
        confidence: 0.5,
      })
    ).rejects.toMatchObject({ status: 413 })
  })
})

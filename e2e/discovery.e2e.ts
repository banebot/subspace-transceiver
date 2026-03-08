/**
 * E2E: Discovery, Bloom Filter & agent:// URI Resolution
 *
 * Tests passive Bloom-filter manifest discovery, topic aggregation,
 * and agent:// URI resolution via the local store and query protocol.
 *
 * Multi-agent gossip propagation tests are in e2e/simulation/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil } from './helpers/wait.js'

// ── Test 1: Local manifest and discovery ─────────────────────────────────────

describe('local discovery manifest', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'], { SUBSPACE_MANIFEST_INTERVAL_MS: '2000' })
    await harness.joinAllToPsk()

    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['typescript', 'auth'],
      content: 'Alpha auth knowledge',
      confidence: 0.9,
    })
    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['jwt'],
      content: 'Alpha JWT knowledge',
      confidence: 0.9,
    })
  })
  afterAll(() => harness.teardown())

  it('Alpha appears in its own discovery peer list after writing chunks', async () => {
    const alphaPeerId = harness.peerId('alpha')

    await pollUntil(
      async () => {
        await harness.client('alpha').rebroadcastManifests().catch(() => {})
        const peers = await harness.client('alpha').getDiscoveryPeers()
        const self = peers.find((p) => p.peerId === alphaPeerId)
        return self !== undefined && self.chunkCount > 0
      },
      30_000,
      'Alpha to appear in its own discovery peers with chunkCount > 0'
    )

    const peers = await harness.client('alpha').getDiscoveryPeers()
    const self = peers.find((p) => p.peerId === alphaPeerId)
    expect(self).toBeDefined()
    expect(self!.agentUri).toBe(`agent://${alphaPeerId}`)
    expect(self!.chunkCount).toBeGreaterThan(0)
  })

  it('topic aggregation reflects written chunks', async () => {
    await pollUntil(
      async () => {
        await harness.client('alpha').rebroadcastManifests().catch(() => {})
        const topics = await harness.client('alpha').getDiscoveryTopics()
        return topics.some((t) => t.topic === 'auth') && topics.some((t) => t.topic === 'jwt')
      },
      30_000,
      'auth and jwt topics to appear in topic aggregation'
    )

    const topics = await harness.client('alpha').getDiscoveryTopics()
    expect(topics.some((t) => t.topic === 'auth')).toBe(true)
    expect(topics.some((t) => t.topic === 'jwt')).toBe(true)
  })
})

// ── Test 2: Bloom filter ──────────────────────────────────────────────────────

describe('Bloom filter topic check', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'], { SUBSPACE_MANIFEST_INTERVAL_MS: '2000' })
    await harness.joinAllToPsk()

    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['rare-topic-xyz-bloom-test'],
      content: 'unique rare topic for bloom filter test',
      confidence: 0.9,
    })
  })
  afterAll(() => harness.teardown())

  it('Bloom filter says probably:true for a topic Alpha holds', async () => {
    const alphaPeerId = harness.peerId('alpha')

    await pollUntil(
      async () => {
        await harness.client('alpha').rebroadcastManifests().catch(() => {})
        const result = await harness.client('alpha').checkTopic(alphaPeerId, 'rare-topic-xyz-bloom-test')
        return result.probably === true
      },
      30_000,
      'Bloom filter to report true for a held topic'
    )

    const result = await harness.client('alpha').checkTopic(alphaPeerId, 'rare-topic-xyz-bloom-test')
    expect(result.probably).toBe(true)
  })

  it('Bloom filter says probably:false for a topic Alpha does not hold', async () => {
    const alphaPeerId = harness.peerId('alpha')

    await pollUntil(
      async () => {
        await harness.client('alpha').rebroadcastManifests().catch(() => {})
        const peers = await harness.client('alpha').getDiscoveryPeers()
        return peers.some((p) => p.peerId === alphaPeerId)
      },
      30_000,
      'Alpha to appear in its own peer list'
    )

    const result = await harness.client('alpha').checkTopic(alphaPeerId, 'definitely-not-a-real-topic-abc123')
    expect(result.probably).toBe(false)
  })
})

// ── Test 3: agent:// URI resolution ──────────────────────────────────────────

describe('agent:// URI resolution', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()

    await harness.client('alpha').putMemory({
      type: 'pattern',
      collection: 'patterns',
      slug: 'jwt-best-practices',
      topic: ['jwt', 'security'],
      content: 'Use RS256 for JWTs in multi-service architectures.',
      confidence: 0.95,
    })
  })
  afterAll(() => harness.teardown())

  it('resolves agent:// URI locally on the originating agent', async () => {
    const alphaPeerId = harness.peerId('alpha')
    const uri = `agent://${alphaPeerId}/patterns/jwt-best-practices`

    const chunk = await harness.client('alpha').resolveUri(uri)
    expect(chunk.slug).toBe('jwt-best-practices')
    expect(chunk.collection).toBe('patterns')
    expect(chunk.content).toContain('RS256')
  })
})

// ── Test 4: site endpoint ─────────────────────────────────────────────────────

describe('site endpoint', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()

    await harness.client('alpha').putMemory({
      type: 'profile',
      topic: ['profile'],
      content: 'Agent Alpha — specialises in authentication and security patterns.',
      confidence: 1.0,
    })
    for (const collection of ['patterns', 'results', 'projects']) {
      await harness.client('alpha').putMemory({
        type: collection === 'patterns' ? 'pattern' : 'result',
        collection,
        slug: `${collection}-item`,
        topic: ['site-test'],
        content: `Content in ${collection} collection`,
        confidence: 0.8,
      })
    }
  })
  afterAll(() => harness.teardown())

  it('site endpoint returns profile and collection list', async () => {
    const alphaPeerId = harness.peerId('alpha')

    const site = await harness.client('alpha').getSite(alphaPeerId)
    expect(site.peerId).toBe(alphaPeerId)
    expect(site.profile).not.toBeNull()
    expect(site.profile!.type).toBe('profile')
    expect(site.collections).toContain('patterns')
    expect(site.collections).toContain('results')
    expect(site.collections).toContain('projects')
    expect(site.chunkCount).toBeGreaterThanOrEqual(4)
    expect(site.agentUri).toBe(`agent://${alphaPeerId}`)
  })
})

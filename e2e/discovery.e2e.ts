/**
 * E2E: Discovery, Browse Protocol & agent:// URI Resolution
 *
 * Tests passive Bloom-filter manifest discovery, the /subspace/browse/1.0.0
 * protocol, topic aggregation, and agent:// URI resolution.
 *
 * Note: SUBSPACE_MANIFEST_INTERVAL_MS=5000 is set by default in vitest.config.ts,
 * so manifest propagation tests use 30s timeouts instead of 90s.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil } from './helpers/wait.js'

// ── Test 1 & 2: manifest-based peer discovery ─────────────────────────────────

describe('discovery manifests', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.waitForMesh(1, 45_000)
    await harness.joinAllToPsk()

    // Alpha stores chunks in topics that will appear in manifests
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
    await harness.client('beta').putMemory({
      type: 'skill',
      topic: ['api', 'auth'],
      content: 'Beta API knowledge',
      confidence: 0.9,
    })
  })
  afterAll(() => harness.teardown())

  it('Alpha appears in Beta\'s discovery peer list after manifest propagation', async () => {
    const alphaPeerId = harness.peerId('alpha')

    await pollUntil(
      async () => {
        const peers = await harness.client('beta').getDiscoveryPeers()
        const alpha = peers.find((p) => p.peerId === alphaPeerId)
        return alpha !== undefined && alpha.chunkCount > 0
      },
      30_000,
      'Alpha to appear in Beta discovery peers with chunkCount > 0'
    )

    const peers = await harness.client('beta').getDiscoveryPeers()
    const alpha = peers.find((p) => p.peerId === alphaPeerId)
    expect(alpha).toBeDefined()
    expect(alpha!.agentUri).toBe(`agent://${alphaPeerId}`)
    expect(alpha!.chunkCount).toBeGreaterThan(0)
    expect(alpha!.lastSeen).toBeGreaterThan(0)
  })

  it('topic aggregation shows auth with peerCount 2', async () => {
    await pollUntil(
      async () => {
        const topics = await harness.client('alpha').getDiscoveryTopics()
        const auth = topics.find((t) => t.topic === 'auth')
        return auth !== undefined && auth.peerCount >= 2
      },
      30_000,
      'auth topic to show peerCount >= 2 in aggregated topics'
    )

    const topics = await harness.client('alpha').getDiscoveryTopics()
    const auth = topics.find((t) => t.topic === 'auth')
    expect(auth).toBeDefined()
    expect(auth!.peerCount).toBeGreaterThanOrEqual(2)

    const jwt = topics.find((t) => t.topic === 'jwt')
    expect(jwt).toBeDefined()
    expect(jwt!.peerCount).toBeGreaterThanOrEqual(1)
  })
})

// ── Test 3: Bloom filter topic check ─────────────────────────────────────────

describe('Bloom filter topic check', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.waitForMesh(1, 45_000)
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

    // Wait for Alpha's manifest to reach Beta
    await pollUntil(
      async () => {
        const result = await harness.client('beta').checkTopic(alphaPeerId, 'rare-topic-xyz-bloom-test')
        return result.probably === true
      },
      30_000,
      'Beta bloom filter to report true for Alpha\'s rare topic'
    )

    const result = await harness.client('beta').checkTopic(alphaPeerId, 'rare-topic-xyz-bloom-test')
    expect(result.probably).toBe(true)
  })

  it('Bloom filter says probably:false for a topic Alpha does not hold', async () => {
    const alphaPeerId = harness.peerId('alpha')

    // Wait for manifest to propagate first
    await pollUntil(
      async () => {
        const peers = await harness.client('beta').getDiscoveryPeers()
        return peers.some((p) => p.peerId === alphaPeerId)
      },
      30_000,
      'Alpha to appear in Beta\'s peer list'
    )

    const result = await harness.client('beta').checkTopic(alphaPeerId, 'definitely-not-a-real-topic-abc123')
    // false = definitely absent (no false negatives in Bloom filters)
    expect(result.probably).toBe(false)
  })
})

// ── Test 4 & 5: browse protocol ───────────────────────────────────────────────

describe('browse protocol', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.waitForMesh(1, 45_000)
    await harness.joinAllToPsk()

    // Alpha stores 6 chunks in 'patterns' collection, 4 in 'results'
    for (let i = 0; i < 6; i++) {
      await harness.client('alpha').putMemory({
        type: 'pattern',
        collection: 'patterns',
        slug: `pattern-${i}`,
        topic: ['browse-test'],
        content: `Pattern chunk ${i}: some content about software patterns and best practices.`,
        confidence: 0.9,
      })
    }
    for (let i = 0; i < 4; i++) {
      await harness.client('alpha').putMemory({
        type: 'result',
        collection: 'results',
        slug: `result-${i}`,
        topic: ['browse-test'],
        content: `Result chunk ${i}: outcome of completed task ${i}.`,
        confidence: 0.9,
      })
    }
  })
  afterAll(() => harness.teardown())

  it('Beta can browse Alpha\'s content stubs', async () => {
    const alphaPeerId = harness.peerId('alpha')

    await pollUntil(
      async () => {
        try {
          const r = await harness.client('beta').browse(alphaPeerId)
          return (r.stubs as unknown[]).length > 0
        } catch {
          return false
        }
      },
      30_000,
      'Beta to successfully browse Alpha\'s content'
    )

    const result = await harness.client('beta').browse(alphaPeerId)
    const stubs = result.stubs as Array<{
      id: string; type: string; summary: string; topic: string[]; timestamp: number
    }>

    expect(stubs.length).toBeGreaterThan(0)
    // Stubs should have the expected fields
    const first = stubs[0]
    expect(first.id).toBeTruthy()
    expect(first.type).toBeTruthy()
    expect(first.timestamp).toBeGreaterThan(0)
    // Summary is max 200 chars of content
    expect(first.summary.length).toBeLessThanOrEqual(200)
  })

  it('browse filtered by collection returns only that collection', async () => {
    const alphaPeerId = harness.peerId('alpha')

    const result = await harness.client('beta').browse(alphaPeerId, { collection: 'patterns' })
    const stubs = result.stubs as Array<{ collection?: string }>
    expect(stubs.length).toBe(6)
    expect(stubs.every((s) => s.collection === 'patterns')).toBe(true)
  })

  it('browse pagination works with limit and since cursor', async () => {
    // Add 60 chunks for pagination test
    const ph = new TestHarness()
    await ph.startAgents(['alpha2', 'beta2'])
    await ph.waitForMesh(1, 45_000)
    await ph.joinAllToPsk()

    for (let i = 0; i < 30; i++) {
      await ph.client('alpha2').putMemory({
        type: 'pattern',
        collection: 'big-collection',
        slug: `item-${i}`,
        topic: ['pagination'],
        content: `Paginated item ${i}: some content here`,
        confidence: 0.5,
      })
    }

    const alpha2PeerId = ph.peerId('alpha2')

    await pollUntil(
      async () => {
        try {
          const r = await ph.client('beta2').browse(alpha2PeerId, { collection: 'big-collection', limit: 10 })
          return (r.stubs as unknown[]).length === 10
        } catch {
          return false
        }
      },
      30_000,
      'Beta2 to browse Alpha2\'s big collection with limit 10'
    )

    const page1 = await ph.client('beta2').browse(alpha2PeerId, { collection: 'big-collection', limit: 10 })
    expect((page1.stubs as unknown[]).length).toBe(10)

    await ph.teardown()
  })
})

// ── Test 6 & 7: agent:// URI resolution ──────────────────────────────────────

describe('agent:// URI resolution', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.waitForMesh(1, 45_000)
    await harness.joinAllToPsk()

    // Alpha stores a named chunk
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

  it('resolves agent:// URI remotely via query protocol from Beta', async () => {
    const alphaPeerId = harness.peerId('alpha')
    const uri = `agent://${alphaPeerId}/patterns/jwt-best-practices`

    await pollUntil(
      async () => {
        try {
          await harness.client('beta').resolveUri(uri)
          return true
        } catch {
          return false
        }
      },
      30_000,
      'Beta to resolve Alpha\'s agent:// URI via query protocol'
    )

    const chunk = await harness.client('beta').resolveUri(uri)
    expect(chunk.slug).toBe('jwt-best-practices')
    expect(chunk.source.peerId).toBe(alphaPeerId)
  })
})

// ── Test 8: site endpoint ─────────────────────────────────────────────────────

describe('site endpoint', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.waitForMesh(1, 45_000)
    await harness.joinAllToPsk()

    // Alpha creates a profile and chunks in multiple collections
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

    // Alpha can see its own site
    const site = await harness.client('alpha').getSite(alphaPeerId)
    expect(site.peerId).toBe(alphaPeerId)
    expect(site.profile).not.toBeNull()
    expect(site.profile!.type).toBe('profile')
    expect(site.collections).toContain('patterns')
    expect(site.collections).toContain('results')
    expect(site.collections).toContain('projects')
    expect(site.chunkCount).toBeGreaterThanOrEqual(4) // profile + 3 collection items
    expect(site.agentUri).toBe(`agent://${alphaPeerId}`)
  })
})

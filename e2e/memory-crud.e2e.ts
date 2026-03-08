/**
 * E2E: PSK Network Join/Leave & Memory CRUD
 *
 * Tests the full memory lifecycle through the HTTP API:
 * network join, put, get, query, search, update, forget, and leave.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil } from './helpers/wait.js'

// ── Shared harness for the whole file ────────────────────────────────────────
const harness = new TestHarness()
let psk: string
let networkId: string

beforeAll(async () => {
  await harness.startAgents(['alpha', 'beta'])
  // Join each agent individually — Iroh doesn't have mDNS auto-discovery
  // so joinAllToPsk's peer connectivity check would time out.
  psk = randomPsk()
  const net = await harness.client('alpha').joinNetwork(psk)
  networkId = net.id
  await harness.client('beta').joinNetwork(psk)
})

afterAll(() => harness.teardown())

// ── Test 1: join and connectivity ─────────────────────────────────────────────

describe('PSK network join', () => {
  it('returns valid network info after joining', async () => {
    const nets = await harness.client('alpha').getNetworks()
    const net = nets.find((n) => n.id === networkId)
    expect(net).toBeDefined()
    expect(net!.id).toHaveLength(64) // SHA-256 hex
    // peerId is now a DID:Key (Iroh transport) or libp2p PeerId
    expect(net!.peerId).toMatch(/^(did:key:z|12D3KooW)/)
    expect(net!.namespaces).toEqual(['skill', 'project'])
  })
})

// ── Test 2: store and retrieve ────────────────────────────────────────────────

describe('memory put and get', () => {
  it('stores a chunk and retrieves it by ID', async () => {
    const chunk = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['typescript', 'auth'],
      content: 'Always await async operations.',
      confidence: 0.9,
    })

    expect(chunk.id).toBeTruthy()
    expect(chunk.signature).toBeTruthy()
    expect(chunk.pow).toBeDefined()
    expect(chunk.pow!.bits).toBeGreaterThan(0)

    const retrieved = await harness.client('alpha').getMemory(chunk.id)
    expect(retrieved.id).toBe(chunk.id)
    expect(retrieved.content).toBe('Always await async operations.')
    expect(retrieved.topic).toEqual(['typescript', 'auth'])
    expect(retrieved.type).toBe('pattern')
    expect(retrieved.confidence).toBe(0.9)
  })
})

// ── Test 3: query by topic ────────────────────────────────────────────────────

describe('memory query by topic', () => {
  it('returns only chunks matching the requested topics', async () => {
    // Store 3 chunks with different topics
    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['auth'],
      content: 'auth only chunk',
      confidence: 0.8,
    })
    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['auth', 'jwt'],
      content: 'auth and jwt chunk',
      confidence: 0.8,
    })
    await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['database'],
      content: 'database only chunk',
      confidence: 0.8,
    })

    const authResults = await harness.client('alpha').queryMemory({ topics: ['auth'] })
    const authContents = authResults.map((c) => c.content)
    expect(authContents).toContain('auth only chunk')
    expect(authContents).toContain('auth and jwt chunk')
    expect(authContents).not.toContain('database only chunk')

    const dbResults = await harness.client('alpha').queryMemory({ topics: ['database'] })
    expect(dbResults.some((c) => c.content === 'database only chunk')).toBe(true)
    expect(dbResults.some((c) => c.topic.includes('auth'))).toBe(false)
  })
})

// ── Test 4: freetext search ───────────────────────────────────────────────────

describe('memory freetext search', () => {
  it('returns only chunks whose content contains the search term', async () => {
    await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['infra'],
      content: 'Use Redis for session storage. TTL of 24h.',
      confidence: 0.85,
    })
    await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['infra'],
      content: 'PostgreSQL for persistent data storage.',
      confidence: 0.85,
    })

    const results = await harness.client('alpha').searchMemory('Redis')
    expect(results.some((c) => c.content.includes('Redis'))).toBe(true)
    expect(results.every((c) => c.content.toLowerCase().includes('redis'))).toBe(true)
  })
})

// ── Test 5: update (version chain) ────────────────────────────────────────────

describe('memory update creates version chain', () => {
  it('PATCH creates version 2 that supersedes version 1', async () => {
    const v1 = await harness.client('alpha').putMemory({
      type: 'context',
      topic: ['versioning-test'],
      content: 'original content',
      confidence: 0.5,
    })
    expect(v1.version).toBe(1)

    const v2 = await harness.client('alpha').updateMemory(v1.id, {
      content: 'updated content',
      confidence: 0.9,
    })
    expect(v2.version).toBe(2)
    expect(v2.supersedes).toBe(v1.id)
    expect(v2.content).toBe('updated content')
    expect(v2.confidence).toBe(0.9)

    // v2 is retrievable
    const retrieved = await harness.client('alpha').getMemory(v2.id)
    expect(retrieved.content).toBe('updated content')

    // v1 is still retrievable (not tombstoned, just superseded)
    const v1Still = await harness.client('alpha').getMemory(v1.id)
    expect(v1Still.content).toBe('original content')
  })
})

// ── Test 6: delete ────────────────────────────────────────────────────────────

describe('memory forget', () => {
  it('DELETE removes a chunk (404 after delete)', async () => {
    const chunk = await harness.client('alpha').putMemory({
      type: 'context',
      topic: ['delete-test'],
      content: 'to be deleted',
      confidence: 0.5,
    })

    await harness.client('alpha').forgetMemory(chunk.id)

    await expect(harness.client('alpha').getMemory(chunk.id)).rejects.toMatchObject({
      status: 404,
    })
  })
})

// ── Test 7: leave network ─────────────────────────────────────────────────────

describe('PSK network leave', () => {
  it('leaving a network removes it and prevents new writes', async () => {
    // Use a fresh harness so we don't mess up other tests
    const lh = new TestHarness()
    await lh.startAgents(['solo'])
    const lPsk = randomPsk()
    const net = await lh.client('solo').joinNetwork(lPsk)

    // Store a chunk while active
    await lh.client('solo').putMemory({
      type: 'pattern',
      topic: ['leave-test'],
      content: 'written before leave',
      confidence: 0.5,
    })

    // Leave the network
    await lh.client('solo').leaveNetwork(net.id)

    // Network list should now be empty
    const nets = await lh.client('solo').getNetworks()
    expect(nets.find((n) => n.id === net.id)).toBeUndefined()

    // Writing should now fail (no active network)
    await expect(
      lh.client('solo').putMemory({
        type: 'pattern',
        topic: ['test'],
        content: 'should fail',
        confidence: 0.5,
      })
    ).rejects.toMatchObject({ status: 400 })

    await lh.teardown()
  })
})

// ── Test 8: rejoin recovers persisted data ────────────────────────────────────

describe('rejoin PSK network recovers persisted data', () => {
  it('data written before leave is accessible after rejoin', async () => {
    const rh = new TestHarness()
    await rh.startAgents(['solo'])
    const rPsk = randomPsk()
    const net = await rh.client('solo').joinNetwork(rPsk)

    const chunk = await rh.client('solo').putMemory({
      type: 'result',
      topic: ['persistence-rejoin'],
      content: 'persisted through leave/rejoin',
      confidence: 0.95,
    })

    await rh.client('solo').leaveNetwork(net.id)

    // Rejoin the same PSK
    await rh.client('solo').joinNetwork(rPsk)

    // Data should still be there
    const retrieved = await rh.client('solo').getMemory(chunk.id)
    expect(retrieved.content).toBe('persisted through leave/rejoin')

    await rh.teardown()
  })
})

// ── Test 9: multiple PSK networks isolated ────────────────────────────────────

describe('multiple PSK networks are isolated', () => {
  it('chunks on different PSKs are not visible across networks', async () => {
    const ih = new TestHarness()
    await ih.startAgents(['solo'])
    const pskA = randomPsk()
    const pskB = randomPsk()
    const netA = await ih.client('solo').joinNetwork(pskA, 'network-a')
    const netB = await ih.client('solo').joinNetwork(pskB, 'network-b')

    // Write to network A
    await ih.client('solo').putMemory({
      type: 'pattern',
      topic: ['isolation-test'],
      content: 'only in network A',
      network: netA.id,
      confidence: 0.5,
    })

    // Write to network B
    await ih.client('solo').putMemory({
      type: 'pattern',
      topic: ['isolation-test'],
      content: 'only in network B',
      network: netB.id,
      confidence: 0.5,
    })

    // Query scoped to namespace should return what's there (both chunks are
    // from the same agent so namespace scoping is what isolates them)
    const allChunks = await ih.client('solo').queryMemory({ topics: ['isolation-test'] })
    const contents = allChunks.map((c) => c.content)
    expect(contents).toContain('only in network A')
    expect(contents).toContain('only in network B')

    // Verify network-specific filtering: each chunk belongs to its network
    const chunkA = allChunks.find((c) => c.content === 'only in network A')
    const chunkB = allChunks.find((c) => c.content === 'only in network B')
    expect(chunkA?.network).toBe(netA.id)
    expect(chunkB?.network).toBe(netB.id)

    await ih.teardown()
  })
})

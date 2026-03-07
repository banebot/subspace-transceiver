/**
 * Unit tests for LoroMemoryStore — the Loro CRDT-backed IMemoryStore.
 *
 * These tests replace the old OrbitDB-based integration tests with fast,
 * in-process unit tests that run without any network connections.
 *
 * Test coverage:
 *  - CRUD: put / get / query / list / forget
 *  - Delta-state export/import round-trip (replication simulation)
 *  - Tombstone propagation via delta sync
 *  - Concurrent write merge semantics (CRDT convergence)
 *  - Large document performance (1k+ chunks)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { LoroMemoryStore, createLoroStore } from '../src/loro-store.js'
import { createChunk } from '../src/schema.js'
import type { IMemoryStore } from '../src/store.js'

const NET = 'test-net'

function makeChunk(overrides: { topic?: string[]; content?: string; type?: string } = {}) {
  return createChunk({
    type: (overrides.type as any) ?? 'skill',
    namespace: 'skill',
    topic: overrides.topic ?? ['test'],
    content: overrides.content ?? 'hello',
    source: { agentId: 'agent-1', peerId: 'peer-1', timestamp: Date.now() },
    confidence: 0.9,
    network: NET,
  })
}

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

describe('LoroMemoryStore — CRUD', () => {
  let store: LoroMemoryStore

  beforeEach(() => {
    store = createLoroStore()
  })

  it('put and get a chunk', async () => {
    const chunk = makeChunk({ content: 'test content' })
    await store.put(chunk)
    const retrieved = await store.get(chunk.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe(chunk.id)
    expect(retrieved!.content).toBe('test content')
  })

  it('returns null for missing chunk id', async () => {
    const result = await store.get('nonexistent-uuid')
    expect(result).toBeNull()
  })

  it('query returns matching chunks', async () => {
    const a = makeChunk({ topic: ['alpha', 'beta'] })
    const b = makeChunk({ topic: ['gamma'] })
    await store.put(a)
    await store.put(b)

    const results = await store.query({ topics: ['alpha'] })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(a.id)
  })

  it('list returns all live chunks', async () => {
    const a = makeChunk()
    const b = makeChunk()
    await store.put(a)
    await store.put(b)

    const all = await store.list()
    expect(all).toHaveLength(2)
    const ids = all.map(c => c.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
  })

  it('forget marks a chunk as tombstoned — get returns null', async () => {
    const chunk = makeChunk()
    await store.put(chunk)
    await store.forget(chunk.id)

    const result = await store.get(chunk.id)
    expect(result).toBeNull()
  })

  it('forgot chunks are excluded from list()', async () => {
    const a = makeChunk()
    const b = makeChunk()
    await store.put(a)
    await store.put(b)
    await store.forget(a.id)

    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(b.id)
  })

  it('forgot chunks are excluded from query()', async () => {
    const chunk = makeChunk({ topic: ['deletable'] })
    await store.put(chunk)
    await store.forget(chunk.id)

    const results = await store.query({ topics: ['deletable'] })
    expect(results).toHaveLength(0)
  })

  it('close resolves without error', async () => {
    await expect(store.close()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Delta-state sync (replication)
// ---------------------------------------------------------------------------

describe('LoroMemoryStore — delta-state sync', () => {
  it('full snapshot export/import replicates all chunks', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    const chunk = makeChunk({ content: 'replicated-content' })
    await storeA.put(chunk)

    // Export full snapshot from A and import into B
    const delta = storeA.exportDelta()
    storeB.importDelta(delta)

    const retrieved = await storeB.get(chunk.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.content).toBe('replicated-content')

    await storeA.close()
    await storeB.close()
  })

  it('importDelta emits replicated event', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    let fired = false
    storeB.on('replicated', () => { fired = true })

    const chunk = makeChunk()
    await storeA.put(chunk)
    const delta = storeA.exportDelta()
    storeB.importDelta(delta)

    expect(fired).toBe(true)

    await storeA.close()
    await storeB.close()
  })

  it('multiple chunks replicate in one delta', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    const chunks = [
      makeChunk({ content: 'chunk-1' }),
      makeChunk({ content: 'chunk-2' }),
      makeChunk({ content: 'chunk-3' }),
    ]
    for (const c of chunks) await storeA.put(c)

    storeB.importDelta(storeA.exportDelta())

    const all = await storeB.list()
    expect(all).toHaveLength(3)
    const contents = all.map(c => c.content).sort()
    expect(contents).toEqual(['chunk-1', 'chunk-2', 'chunk-3'].sort())

    await storeA.close()
    await storeB.close()
  })

  it('tombstone propagates via delta sync', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    const chunk = makeChunk()
    await storeA.put(chunk)

    // Sync initial state to B
    storeB.importDelta(storeA.exportDelta())

    const before = await storeB.get(chunk.id)
    expect(before).not.toBeNull()

    // Tombstone on A
    await storeA.forget(chunk.id)

    // Sync tombstone to B
    storeB.importDelta(storeA.exportDelta())

    const after = await storeB.get(chunk.id)
    expect(after).toBeNull()

    await storeA.close()
    await storeB.close()
  })

  it('bidirectional sync converges', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    const chunkA = makeChunk({ content: 'from-A' })
    const chunkB = makeChunk({ content: 'from-B' })

    await storeA.put(chunkA)
    await storeB.put(chunkB)

    // Cross-sync
    storeA.importDelta(storeB.exportDelta())
    storeB.importDelta(storeA.exportDelta())

    const allA = await storeA.list()
    const allB = await storeB.list()

    expect(allA).toHaveLength(2)
    expect(allB).toHaveLength(2)

    const idsA = allA.map(c => c.id).sort()
    const idsB = allB.map(c => c.id).sort()
    expect(idsA).toEqual(idsB)

    await storeA.close()
    await storeB.close()
  })
})

// ---------------------------------------------------------------------------
// Concurrent write merge semantics
// ---------------------------------------------------------------------------

describe('LoroMemoryStore — concurrent write merge', () => {
  it('concurrent chunks from two stores merge without conflict', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    // Both stores make independent writes (simulating offline divergence)
    const chunks: ReturnType<typeof makeChunk>[] = []
    for (let i = 0; i < 5; i++) {
      const c = makeChunk({ content: `a-${i}` })
      await storeA.put(c)
      chunks.push(c)
    }
    for (let i = 0; i < 5; i++) {
      await storeB.put(makeChunk({ content: `b-${i}` }))
    }

    // Cross-sync (merge)
    storeA.importDelta(storeB.exportDelta())
    storeB.importDelta(storeA.exportDelta())

    const listA = await storeA.list()
    const listB = await storeB.list()

    // Both should have 10 chunks after merge
    expect(listA).toHaveLength(10)
    expect(listB).toHaveLength(10)

    // Both should have the same set of IDs
    const idsA = listA.map(c => c.id).sort()
    const idsB = listB.map(c => c.id).sort()
    expect(idsA).toEqual(idsB)

    await storeA.close()
    await storeB.close()
  })

  it('idempotent import (applying same delta twice does not duplicate)', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    const chunk = makeChunk()
    await storeA.put(chunk)

    const delta = storeA.exportDelta()
    storeB.importDelta(delta)
    storeB.importDelta(delta) // apply again

    const all = await storeB.list()
    expect(all).toHaveLength(1)

    await storeA.close()
    await storeB.close()
  })
})

// ---------------------------------------------------------------------------
// Performance: large document
// ---------------------------------------------------------------------------

describe('LoroMemoryStore — performance', () => {
  it('handles 1000+ chunks without timeout', async () => {
    const store = createLoroStore()
    const COUNT = 1000

    const start = Date.now()
    for (let i = 0; i < COUNT; i++) {
      await store.put(makeChunk({ content: `chunk-${i}`, topic: [`topic-${i % 10}`] }))
    }
    const writeMs = Date.now() - start

    const queryStart = Date.now()
    const results = await store.list()
    const queryMs = Date.now() - queryStart

    expect(results).toHaveLength(COUNT)
    console.log(`[perf] ${COUNT} writes: ${writeMs}ms, list: ${queryMs}ms`)

    await store.close()
  }, 30_000)

  it('delta export/import of 1000 chunks completes in reasonable time', async () => {
    const storeA = createLoroStore()
    const storeB = createLoroStore()

    for (let i = 0; i < 1000; i++) {
      await storeA.put(makeChunk({ content: `chunk-${i}` }))
    }

    const exportStart = Date.now()
    const delta = storeA.exportDelta()
    const exportMs = Date.now() - exportStart

    const importStart = Date.now()
    storeB.importDelta(delta)
    const importMs = Date.now() - importStart

    console.log(`[perf] 1000-chunk delta: export=${exportMs}ms import=${importMs}ms size=${delta.length}B`)

    const all = await storeB.list()
    expect(all).toHaveLength(1000)

    await storeA.close()
    await storeB.close()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Query tests (Loro backend)
// ---------------------------------------------------------------------------

describe('LoroMemoryStore — query', () => {
  let store: IMemoryStore

  beforeEach(() => {
    store = createLoroStore()
  })

  it('filters by type', async () => {
    const skill = createChunk({ type: 'skill', namespace: 'skill', topic: ['t'], content: 'a', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.5, network: NET })
    const pattern = createChunk({ type: 'pattern', namespace: 'skill', topic: ['t'], content: 'b', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.5, network: NET })
    await store.put(skill)
    await store.put(pattern)

    const results = await store.query({ type: 'skill' })
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('skill')
  })

  it('filters by namespace', async () => {
    const s = createChunk({ type: 'skill', namespace: 'skill', topic: ['t'], content: 'a', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.5, network: NET })
    const p = createChunk({ type: 'project', namespace: 'project', topic: ['t'], content: 'b', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.5, network: NET })
    await store.put(s)
    await store.put(p)

    const results = await store.query({ namespace: 'skill' })
    expect(results).toHaveLength(1)
    expect(results[0].namespace).toBe('skill')
  })

  it('resolves HEAD of supersedes chain', async () => {
    const a = makeChunk({ content: 'v1' })
    await store.put(a)

    const b = createChunk({
      type: 'skill',
      namespace: 'skill',
      topic: ['test'],
      content: 'v2',
      source: { agentId: 'agent-1', peerId: 'peer-1', timestamp: Date.now() + 1 },
      confidence: 0.9,
      network: NET,
      supersedes: a.id,
    })
    await store.put(b)

    const results = await store.query({})
    // Only HEAD should be returned
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(b.id)
    expect(results[0].content).toBe('v2')
  })

  it('respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.put(makeChunk({ content: `item-${i}` }))
    }
    const results = await store.query({ limit: 3 })
    expect(results).toHaveLength(3)
  })

  it('filters by minConfidence', async () => {
    const high = createChunk({ type: 'skill', namespace: 'skill', topic: ['t'], content: 'high', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.9, network: NET })
    const low = createChunk({ type: 'skill', namespace: 'skill', topic: ['t'], content: 'low', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.2, network: NET })
    await store.put(high)
    await store.put(low)

    const results = await store.query({ minConfidence: 0.5 })
    expect(results).toHaveLength(1)
    expect(results[0].confidence).toBe(0.9)
  })
})

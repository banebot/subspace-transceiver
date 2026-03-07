/**
 * E2E (in-process): Loro Delta-State Replication
 *
 * Tests Loro CRDT delta-state sync between two in-process LoroMemoryStore instances,
 * simulating what would happen between two daemon instances over the network.
 *
 * These tests verify:
 *  - Delta-state sync (not full-log replay) between two peers
 *  - ContentLink CRDT replication over Loro deltas
 *  - TTL/GC compatibility with Loro snapshots
 *  - Offline/reconnect merge with Loro delta sync
 *  - Concurrent writes from two agents merge correctly (CRDT convergence)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { LoroMemoryStore, createLoroStore, createPersistentLoroStore } from '../packages/core/src/loro-store.js'
import { createChunk } from '../packages/core/src/schema.js'
import type { IMemoryStore } from '../packages/core/src/store.js'

const NET = 'loro-e2e-test-net'

function chunk(overrides: {
  content?: string
  topic?: string[]
  type?: string
  ttl?: number
  links?: Array<{ target: string; rel: string }>
  supersedes?: string
}) {
  return createChunk({
    type: (overrides.type as any) ?? 'skill',
    namespace: 'skill',
    topic: overrides.topic ?? ['e2e'],
    content: overrides.content ?? 'e2e test content',
    source: { agentId: 'agent-1', peerId: 'peer-1', timestamp: Date.now() },
    confidence: 0.9,
    network: NET,
    ...(overrides.ttl != null ? { ttl: overrides.ttl } : {}),
    ...(overrides.links != null ? { links: overrides.links } : {}),
    ...(overrides.supersedes != null ? { supersedes: overrides.supersedes } : {}),
  })
}

// ---------------------------------------------------------------------------
// Delta-state sync (not full-log replay)
// ---------------------------------------------------------------------------

describe('Loro delta-state sync between two peers', () => {
  it('peer B only needs the delta (not the full snapshot) after first sync', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    // Phase 1: initial sync
    const c1 = chunk({ content: 'initial-chunk' })
    await peerA.put(c1)

    const snapshot = peerA.exportDelta()
    peerB.importDelta(snapshot)

    const beforeDelta = await peerB.list()
    expect(beforeDelta).toHaveLength(1)

    // Phase 2: A writes more — B should only need the new delta
    const c2 = chunk({ content: 'new-chunk-after-sync' })
    await peerA.put(c2)

    // Export delta since the snapshot we already applied
    // (using exportDelta with the old snapshot as the "since" reference)
    const delta = peerA.exportDelta(snapshot)

    // The delta should be smaller than a full snapshot (proves it's incremental)
    const fullSnapshot = peerA.exportDelta()
    expect(delta.length).toBeLessThan(fullSnapshot.length)

    peerB.importDelta(delta)

    const afterDelta = await peerB.list()
    expect(afterDelta).toHaveLength(2)

    await peerA.close()
    await peerB.close()
  })

  it('delta sync confirms all chunk fields are preserved', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    const original = chunk({
      content: 'full-fidelity content',
      topic: ['topic-a', 'topic-b'],
      type: 'pattern',
    })
    await peerA.put(original)

    peerB.importDelta(peerA.exportDelta())

    const retrieved = await peerB.get(original.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.content).toBe(original.content)
    expect(retrieved!.topic).toEqual(original.topic)
    expect(retrieved!.type).toBe(original.type)
    expect(retrieved!.confidence).toBe(original.confidence)
    expect(retrieved!.source.agentId).toBe(original.source.agentId)
    expect(retrieved!.network).toBe(original.network)

    await peerA.close()
    await peerB.close()
  })
})

// ---------------------------------------------------------------------------
// ContentLink CRDT replication
// ---------------------------------------------------------------------------

describe('ContentLink CRDT replication via Loro delta', () => {
  it('chunks with links replicate with all link metadata intact', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    const target = chunk({ content: 'target-chunk' })
    await peerA.put(target)

    const source = chunk({
      content: 'source-with-links',
      links: [
        { target: target.id, rel: 'depends-on' },
        { target: `agent://peer-1/blobs/abc123`, rel: 'references' },
      ],
    })
    await peerA.put(source)

    peerB.importDelta(peerA.exportDelta())

    const replicatedSource = await peerB.get(source.id)
    expect(replicatedSource).not.toBeNull()
    expect(replicatedSource!.links).toHaveLength(2)
    expect(replicatedSource!.links![0].target).toBe(target.id)
    expect(replicatedSource!.links![0].rel).toBe('depends-on')
    expect(replicatedSource!.links![1].rel).toBe('references')

    await peerA.close()
    await peerB.close()
  })

  it('supersedes chains replicate correctly', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    const v1 = chunk({ content: 'version 1' })
    await peerA.put(v1)

    const v2 = createChunk({
      type: 'skill', namespace: 'skill', topic: ['e2e'],
      content: 'version 2 (supersedes v1)',
      source: { agentId: 'agent-1', peerId: 'peer-1', timestamp: Date.now() + 100 },
      confidence: 0.9, network: NET,
      supersedes: v1.id,
    })
    await peerA.put(v2)

    peerB.importDelta(peerA.exportDelta())

    // query() returns HEADs only — should be v2
    const results = await peerB.query({})
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(v2.id)
    expect(results[0].supersedes).toBe(v1.id)

    await peerA.close()
    await peerB.close()
  })
})

// ---------------------------------------------------------------------------
// TTL / GC with Loro snapshots
// ---------------------------------------------------------------------------

describe('TTL and GC compatibility with Loro store', () => {
  it('TTL-expired chunks are excluded from query results', async () => {
    const store = createLoroStore()

    const expired = createChunk({
      type: 'skill', namespace: 'skill', topic: ['ttl-test'],
      content: 'this should expire',
      source: { agentId: 'a', peerId: 'p', timestamp: Date.now() },
      confidence: 0.9, network: NET,
      ttl: Date.now() - 1000, // already expired
    })
    const live = createChunk({
      type: 'skill', namespace: 'skill', topic: ['ttl-test'],
      content: 'this is live',
      source: { agentId: 'a', peerId: 'p', timestamp: Date.now() },
      confidence: 0.9, network: NET,
      ttl: Date.now() + 60_000, // expires in 1 minute
    })

    await store.put(expired)
    await store.put(live)

    const results = await store.query({ topics: ['ttl-test'] })
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(live.id)

    await store.close()
  })

  it('TTL-expired chunks replicate but are excluded on the receiving end', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    const expired = createChunk({
      type: 'skill', namespace: 'skill', topic: ['ttl-e2e'],
      content: 'expired content',
      source: { agentId: 'a', peerId: 'p', timestamp: Date.now() },
      confidence: 0.9, network: NET,
      ttl: Date.now() - 1000, // expired
    })
    await peerA.put(expired)

    peerB.importDelta(peerA.exportDelta())

    // The chunk replicates (it's still in the CRDT state), but query excludes it
    const results = await peerB.query({ topics: ['ttl-e2e'] })
    expect(results).toHaveLength(0)

    await peerA.close()
    await peerB.close()
  })
})

// ---------------------------------------------------------------------------
// Offline / reconnect merge
// ---------------------------------------------------------------------------

describe('Offline/reconnect merge with Loro delta sync', () => {
  it('offline writes from both peers converge after reconnect', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    // Initial shared state
    const shared = chunk({ content: 'shared-initial' })
    await peerA.put(shared)
    peerB.importDelta(peerA.exportDelta())

    // Capture version vectors before going "offline"
    const vvA = peerA.versionVector()
    const vvB = peerB.versionVector()

    // Both peers write independently while "offline"
    const offlineA = [
      chunk({ content: 'a-offline-1' }),
      chunk({ content: 'a-offline-2' }),
    ]
    const offlineB = [
      chunk({ content: 'b-offline-1' }),
      chunk({ content: 'b-offline-2' }),
      chunk({ content: 'b-offline-3' }),
    ]

    for (const c of offlineA) await peerA.put(c)
    for (const c of offlineB) await peerB.put(c)

    // Reconnect: cross-sync with incremental deltas
    peerA.importDelta(peerB.exportDelta(vvA))
    peerB.importDelta(peerA.exportDelta(vvB))

    const allA = await peerA.list()
    const allB = await peerB.list()

    // Both should have: 1 shared + 2 A offline + 3 B offline = 6
    expect(allA).toHaveLength(6)
    expect(allB).toHaveLength(6)

    const idsA = allA.map(c => c.id).sort()
    const idsB = allB.map(c => c.id).sort()
    expect(idsA).toEqual(idsB) // CRDT convergence

    await peerA.close()
    await peerB.close()
  })

  it('tombstone written offline propagates after reconnect', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    const toDelete = chunk({ content: 'will-be-deleted-offline' })
    await peerA.put(toDelete)
    peerB.importDelta(peerA.exportDelta())

    const vvA = peerA.versionVector()

    // A tombstones offline
    await peerA.forget(toDelete.id)

    // Reconnect
    peerB.importDelta(peerA.exportDelta(vvA))

    // Tombstone should now be visible on B
    const result = await peerB.get(toDelete.id)
    expect(result).toBeNull()

    await peerA.close()
    await peerB.close()
  })
})

// ---------------------------------------------------------------------------
// Concurrent writes from two agents merge correctly
// ---------------------------------------------------------------------------

describe('Concurrent write merge — CRDT conflict-free resolution', () => {
  it('50 concurrent writes from two agents produce deterministic convergence', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()

    // Concurrent writes (no sync between them)
    const chunksA: ReturnType<typeof chunk>[] = []
    const chunksB: ReturnType<typeof chunk>[] = []

    for (let i = 0; i < 25; i++) {
      const c = chunk({ content: `a-${i}`, topic: [`batch-a`] })
      await peerA.put(c)
      chunksA.push(c)
    }
    for (let i = 0; i < 25; i++) {
      const c = chunk({ content: `b-${i}`, topic: [`batch-b`] })
      await peerB.put(c)
      chunksB.push(c)
    }

    // Full bidirectional sync
    const deltaA = peerA.exportDelta()
    const deltaB = peerB.exportDelta()
    peerA.importDelta(deltaB)
    peerB.importDelta(deltaA)

    const listA = await peerA.list()
    const listB = await peerB.list()

    expect(listA).toHaveLength(50)
    expect(listB).toHaveLength(50)

    const idsA = listA.map(c => c.id).sort()
    const idsB = listB.map(c => c.id).sort()
    expect(idsA).toEqual(idsB)

    // All A chunks should be present on B
    for (const c of chunksA) {
      expect(idsB).toContain(c.id)
    }
    // All B chunks should be present on A
    for (const c of chunksB) {
      expect(idsA).toContain(c.id)
    }

    await peerA.close()
    await peerB.close()
  })

  it('three-way sync converges to the same state', async () => {
    const peerA = createLoroStore()
    const peerB = createLoroStore()
    const peerC = createLoroStore()

    // Each peer writes independently
    const aChunk = chunk({ content: 'from-A' })
    const bChunk = chunk({ content: 'from-B' })
    const cChunk = chunk({ content: 'from-C' })

    await peerA.put(aChunk)
    await peerB.put(bChunk)
    await peerC.put(cChunk)

    // Broadcast pattern: A→B, B→C, C→A, then cross-check
    peerB.importDelta(peerA.exportDelta())
    peerC.importDelta(peerB.exportDelta())
    peerA.importDelta(peerC.exportDelta())

    // One more round to converge fully
    peerB.importDelta(peerA.exportDelta())
    peerC.importDelta(peerB.exportDelta())

    const allA = (await peerA.list()).map(c => c.id).sort()
    const allB = (await peerB.list()).map(c => c.id).sort()
    const allC = (await peerC.list()).map(c => c.id).sort()

    expect(allA).toHaveLength(3)
    expect(allA).toEqual(allB)
    expect(allB).toEqual(allC)

    await peerA.close()
    await peerB.close()
    await peerC.close()
  })
})

// ---------------------------------------------------------------------------
// Persistent store e2e replication
// ---------------------------------------------------------------------------

describe('Persistent Loro stores replicate and survive restart', () => {
  it('replicated data survives restart on receiving peer', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loro-e2e-persist-'))
    const snapA = path.join(tmpDir, 'peer-a.bin')
    const snapB = path.join(tmpDir, 'peer-b.bin')

    let peerA = await createPersistentLoroStore(snapA)
    let peerB = await createPersistentLoroStore(snapB)

    const c = chunk({ content: 'persistent-replicated-content' })
    await peerA.put(c)
    peerB.importDelta(peerA.exportDelta())

    await peerA.close()
    await peerB.close()

    // Restart both peers from snapshots
    peerA = await createPersistentLoroStore(snapA)
    peerB = await createPersistentLoroStore(snapB)

    // B should have A's data without needing another sync
    const result = await peerB.get(c.id)
    expect(result).not.toBeNull()
    expect(result!.content).toBe('persistent-replicated-content')

    await peerA.close()
    await peerB.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
})

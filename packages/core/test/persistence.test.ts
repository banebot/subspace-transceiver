/**
 * Persistence test — verifies that data survives a LoroMemoryStore restart.
 *
 * Loro stores snapshots as binary files using `doc.export({ mode: 'snapshot' })`.
 * On restart, the snapshot is loaded via `doc.import(bytes)` and all data is restored.
 *
 * This replaces the OrbitDB persistence tests which required LevelDB, Helia, and
 * a full libp2p node. Loro snapshots are self-contained binary blobs — no external
 * dependencies needed.
 */

import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { LoroMemoryStore } from '../src/loro-store.js'
import { createChunk } from '../src/schema.js'

const NET = 'persistence-test-net'

describe('Loro snapshot persistence across restart', () => {
  it('data written before close is readable after reopen', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-loro-persist-'))
    const snapshotPath = path.join(tmpDir, 'store-skill.bin')

    // ── Phase 1: write data ──────────────────────────────────────────────────
    let store = await LoroMemoryStore.createPersistent(snapshotPath)

    const chunk = createChunk({
      type: 'project',
      namespace: 'project',
      topic: ['persistence', 'test'],
      content: 'This data must survive a restart',
      source: { agentId: 'test-agent', peerId: 'peer-1', timestamp: Date.now() },
      confidence: 0.9,
      network: NET,
    })

    await store.put(chunk)

    // Verify it's readable before close
    const beforeClose = await store.query({ topics: ['persistence'] })
    expect(beforeClose).toHaveLength(1)
    expect(beforeClose[0].content).toBe('This data must survive a restart')

    // Close — this flushes the snapshot to disk
    await store.close()

    // ── Phase 2: reopen with same snapshot file ──────────────────────────────
    store = await LoroMemoryStore.createPersistent(snapshotPath)

    const afterReopen = await store.query({ topics: ['persistence'] })
    expect(afterReopen).toHaveLength(1)
    expect(afterReopen[0].id).toBe(chunk.id)
    expect(afterReopen[0].content).toBe('This data must survive a restart')

    // Also test direct get
    const direct = await store.get(chunk.id)
    expect(direct).not.toBeNull()
    expect(direct?.content).toBe('This data must survive a restart')

    await store.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('multiple chunks survive restart', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-loro-persist2-'))
    const snapshotPath = path.join(tmpDir, 'store.bin')

    let store = await LoroMemoryStore.createPersistent(snapshotPath)

    const chunks = [
      createChunk({ type: 'skill', namespace: 'skill', topic: ['alpha'], content: 'alpha', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.8, network: NET }),
      createChunk({ type: 'skill', namespace: 'skill', topic: ['beta'], content: 'beta', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() + 1 }, confidence: 0.7, network: NET }),
      createChunk({ type: 'pattern', namespace: 'skill', topic: ['gamma'], content: 'gamma', source: { agentId: 'a', peerId: 'p', timestamp: Date.now() + 2 }, confidence: 0.6, network: NET }),
    ]

    for (const c of chunks) await store.put(c)
    await store.close()

    store = await LoroMemoryStore.createPersistent(snapshotPath)
    const all = await store.list()
    expect(all).toHaveLength(3)
    const ids = all.map(c => c.id).sort()
    expect(ids).toEqual(chunks.map(c => c.id).sort())

    await store.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('tombstones survive restart', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-loro-persist3-'))
    const snapshotPath = path.join(tmpDir, 'store.bin')

    let store = await LoroMemoryStore.createPersistent(snapshotPath)

    const chunk = createChunk({
      type: 'skill', namespace: 'skill', topic: ['deletable'], content: 'to-be-deleted',
      source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.8, network: NET,
    })

    await store.put(chunk)
    await store.forget(chunk.id)
    await store.close()

    // Reopen — tombstone must be preserved
    store = await LoroMemoryStore.createPersistent(snapshotPath)
    const retrieved = await store.get(chunk.id)
    expect(retrieved).toBeNull() // tombstoned

    const all = await store.list()
    expect(all).toHaveLength(0) // tombstone excluded from list

    await store.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('explicit save() flushes snapshot before close()', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-loro-persist4-'))
    const snapshotPath = path.join(tmpDir, 'store.bin')

    let store = await LoroMemoryStore.createPersistent(snapshotPath)

    const chunk = createChunk({
      type: 'skill', namespace: 'skill', topic: ['saved'], content: 'explicitly-saved',
      source: { agentId: 'a', peerId: 'p', timestamp: Date.now() }, confidence: 0.9, network: NET,
    })
    await store.put(chunk)

    // Explicit save before close
    await store.save()

    // Verify file exists and has data
    const stat = await fs.stat(snapshotPath)
    expect(stat.size).toBeGreaterThan(0)

    // Close without further save
    store.close()

    // Reload and check
    store = await LoroMemoryStore.createPersistent(snapshotPath)
    const result = await store.get(chunk.id)
    expect(result).not.toBeNull()
    expect(result?.content).toBe('explicitly-saved')

    await store.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('fresh store (no snapshot file) starts empty', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-loro-fresh-'))
    const snapshotPath = path.join(tmpDir, 'nonexistent.bin')

    const store = await LoroMemoryStore.createPersistent(snapshotPath)
    const all = await store.list()
    expect(all).toHaveLength(0)

    await store.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
})

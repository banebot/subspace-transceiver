import { describe, it, expect, beforeEach } from 'vitest'
import { resolveHeads, buildOrbitFilter, applyQuery } from '../src/query.js'
import type { MemoryChunk } from '../src/schema.js'

function makeChunk(overrides: Partial<MemoryChunk> & { id: string }): MemoryChunk {
  return {
    type: 'skill',
    namespace: 'skill',
    topic: ['typescript'],
    content: 'test content',
    source: {
      agentId: 'test-agent',
      peerId: '12D3KooWTest',
      timestamp: Date.now(),
    },
    confidence: 0.8,
    network: 'net1',
    version: 1,
    ...overrides,
  }
}

describe('resolveHeads', () => {
  it('returns the single chunk when there is no chain', () => {
    const a = makeChunk({ id: 'a' })
    expect(resolveHeads([a])).toEqual([a])
  })

  it('returns the HEAD of a 2-chunk chain', () => {
    const a = makeChunk({ id: 'a' })
    const b = makeChunk({ id: 'b', supersedes: 'a' })
    const result = resolveHeads([a, b])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b')
  })

  it('returns the HEAD of a 3-chunk chain', () => {
    const a = makeChunk({ id: 'a' })
    const b = makeChunk({ id: 'b', supersedes: 'a' })
    const c = makeChunk({ id: 'c', supersedes: 'b' })
    const result = resolveHeads([a, b, c])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c')
  })

  it('handles multiple independent chains', () => {
    const a = makeChunk({ id: 'a' })
    const b = makeChunk({ id: 'b', supersedes: 'a' })
    const x = makeChunk({ id: 'x' })
    const y = makeChunk({ id: 'y', supersedes: 'x' })
    const result = resolveHeads([a, b, x, y])
    const ids = result.map(c => c.id).sort()
    expect(ids).toEqual(['b', 'y'])
  })

  it('excludes tombstoned chunks from results', () => {
    const a = makeChunk({ id: 'a', _tombstone: true })
    expect(resolveHeads([a])).toHaveLength(0)
  })

  it('returns empty array for empty input', () => {
    expect(resolveHeads([])).toEqual([])
  })
})

describe('buildOrbitFilter', () => {
  it('returns true for a chunk matching all query fields', () => {
    const chunk = makeChunk({ id: 'a', type: 'pattern', namespace: 'project', topic: ['async', 'node'] })
    const filter = buildOrbitFilter({ type: 'pattern', namespace: 'project', topics: ['async'] })
    expect(filter(chunk)).toBe(true)
  })

  it('filters out tombstoned chunks', () => {
    const chunk = makeChunk({ id: 'a', _tombstone: true })
    expect(buildOrbitFilter({})(chunk)).toBe(false)
  })

  it('filters out TTL-expired chunks', () => {
    const chunk = makeChunk({ id: 'a', ttl: Date.now() - 1000 })
    expect(buildOrbitFilter({})(chunk)).toBe(false)
  })

  it('passes chunks with future TTL', () => {
    const chunk = makeChunk({ id: 'a', ttl: Date.now() + 60_000 })
    expect(buildOrbitFilter({})(chunk)).toBe(true)
  })

  it('filters by type', () => {
    const chunk = makeChunk({ id: 'a', type: 'skill' })
    expect(buildOrbitFilter({ type: 'pattern' })(chunk)).toBe(false)
    expect(buildOrbitFilter({ type: 'skill' })(chunk)).toBe(true)
  })

  it('filters by namespace', () => {
    const chunk = makeChunk({ id: 'a', namespace: 'skill' })
    expect(buildOrbitFilter({ namespace: 'project' })(chunk)).toBe(false)
    expect(buildOrbitFilter({ namespace: 'skill' })(chunk)).toBe(true)
  })

  it('filters by minConfidence', () => {
    const chunk = makeChunk({ id: 'a', confidence: 0.5 })
    expect(buildOrbitFilter({ minConfidence: 0.7 })(chunk)).toBe(false)
    expect(buildOrbitFilter({ minConfidence: 0.5 })(chunk)).toBe(true)
  })

  it('requires ALL requested topics to be present', () => {
    const chunk = makeChunk({ id: 'a', topic: ['typescript', 'async'] })
    expect(buildOrbitFilter({ topics: ['typescript', 'async', 'missing'] })(chunk)).toBe(false)
    expect(buildOrbitFilter({ topics: ['typescript', 'async'] })(chunk)).toBe(true)
    expect(buildOrbitFilter({ topics: ['typescript'] })(chunk)).toBe(true)
  })

  it('filters by project', () => {
    const chunk = makeChunk({ id: 'a', source: { agentId: 'ag', peerId: 'p', project: 'myapp', timestamp: Date.now() } })
    expect(buildOrbitFilter({ project: 'other' })(chunk)).toBe(false)
    expect(buildOrbitFilter({ project: 'myapp' })(chunk)).toBe(true)
  })
})

describe('applyQuery', () => {
  it('returns heads only, sorted by timestamp desc', () => {
    const older = makeChunk({ id: 'a', source: { agentId: 'ag', peerId: 'p', timestamp: 1000 } })
    const newer = makeChunk({ id: 'b', supersedes: 'a', source: { agentId: 'ag', peerId: 'p', timestamp: 2000 } })
    const result = applyQuery([older, newer], {})
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b')
  })

  it('applies limit', () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ id: `c${i}`, source: { agentId: 'ag', peerId: 'p', timestamp: i * 1000 } })
    )
    const result = applyQuery(chunks, { limit: 2 })
    expect(result).toHaveLength(2)
  })
})

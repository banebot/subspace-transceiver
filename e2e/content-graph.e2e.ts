/**
 * E2E: Content Graph — Links, Backlinks & Graph Traversal
 *
 * Tests the typed ContentLink system, in-memory backlink index,
 * and BFS graph traversal via POST /memory/graph.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness, randomPsk } from './harness.js'

// ── Shared harness ────────────────────────────────────────────────────────────
const harness = new TestHarness()

beforeAll(async () => {
  await harness.startAgents(['alpha'])
  await harness.joinAllToPsk()
})

afterAll(() => harness.teardown())

// ── Test 1: outgoing links ────────────────────────────────────────────────────

describe('outgoing links', () => {
  it('GET /memory/:id/links returns the chunk\'s outgoing ContentLinks', async () => {
    const chunkA = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['graph-test'],
      content: 'Pattern A — foundational concept',
      confidence: 0.9,
    })

    const chunkB = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['graph-test'],
      content: 'Pattern B — depends on A',
      confidence: 0.8,
      links: [{ target: chunkA.id, rel: 'depends-on', label: 'requires A' }],
    })

    const { links } = await harness.client('alpha').getLinks(chunkB.id)
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe(chunkA.id)
    expect(links[0].rel).toBe('depends-on')
    expect(links[0].label).toBe('requires A')
  })

  it('chunks with no links return an empty links array', async () => {
    const chunk = await harness.client('alpha').putMemory({
      type: 'skill',
      topic: ['graph-test'],
      content: 'Standalone chunk with no links',
      confidence: 0.7,
    })

    const { links } = await harness.client('alpha').getLinks(chunk.id)
    expect(links).toEqual([])
  })
})

// ── Test 2: backlink index ────────────────────────────────────────────────────

describe('backlink index (reverse edges)', () => {
  it('GET /memory/:id/backlinks returns chunks that link TO this chunk', async () => {
    const chunkA = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['backlink-test'],
      content: 'The target of backlinks',
      confidence: 0.9,
    })

    const chunkB = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['backlink-test'],
      content: 'B depends on A',
      confidence: 0.8,
      links: [{ target: chunkA.id, rel: 'depends-on' }],
    })

    const backlinks = await harness.client('alpha').getBacklinks(chunkA.id)
    expect(backlinks.map((c) => c.id)).toContain(chunkB.id)
  })
})

// ── Test 3: multiple link types ───────────────────────────────────────────────

describe('multiple link types', () => {
  it('backlinks from B, C, D all point to A', async () => {
    const A = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['multi-link'],
      content: 'Chunk A — hub node',
      confidence: 0.9,
    })

    const B = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['multi-link'],
      content: 'B depends-on A',
      confidence: 0.8,
      links: [{ target: A.id, rel: 'depends-on' }],
    })

    const C = await harness.client('alpha').putMemory({
      type: 'result',
      topic: ['multi-link'],
      content: 'C references A and is related to B',
      confidence: 0.7,
      links: [
        { target: A.id, rel: 'references' },
        { target: B.id, rel: 'related' },
      ],
    })

    const D = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['multi-link'],
      content: 'D supersedes A',
      confidence: 0.95,
      links: [{ target: A.id, rel: 'supersedes' }],
    })

    // A's backlinks should include B, C, D
    const aBacklinks = await harness.client('alpha').getBacklinks(A.id)
    const aBacklinkIds = aBacklinks.map((c) => c.id)
    expect(aBacklinkIds).toContain(B.id)
    expect(aBacklinkIds).toContain(C.id)
    expect(aBacklinkIds).toContain(D.id)

    // B's backlinks should include C (C references B via 'related')
    const bBacklinks = await harness.client('alpha').getBacklinks(B.id)
    expect(bBacklinks.map((c) => c.id)).toContain(C.id)

    // A has no outgoing links (no links field stored on A itself)
    const { links: aLinks } = await harness.client('alpha').getLinks(A.id)
    expect(aLinks).toEqual([])
  })
})

// ── Test 4: graph traversal with depth limit ──────────────────────────────────

describe('BFS graph traversal', () => {
  it('maxDepth limits BFS traversal correctly', async () => {
    // Build chain: A → B → C → D → E
    const nodes: Array<{ id: string }> = []
    let prev: string | undefined

    for (let i = 0; i < 5; i++) {
      const chunk = await harness.client('alpha').putMemory({
        type: 'pattern',
        topic: ['traversal-chain'],
        content: `Chain node ${i}`,
        confidence: 0.8,
        links: prev ? [{ target: prev, rel: 'related' }] : undefined,
      })
      nodes.push(chunk)
      prev = chunk.id
    }

    // Reverse so nodes[0] is the head of the chain
    nodes.reverse()
    const [A, B, C, D, E] = nodes

    // maxDepth=2 should include A, B, C (0→1→2 hops)
    const depth2 = await harness.client('alpha').traverseGraph(A.id, { maxDepth: 2 })
    const depth2Ids = depth2.nodes.map((n) => n.id)
    expect(depth2Ids).toContain(A.id)
    expect(depth2Ids).toContain(B.id)
    expect(depth2Ids).toContain(C.id)
    expect(depth2Ids.length).toBeLessThanOrEqual(3)

    // maxDepth=5 should include all 5 nodes
    const depth5 = await harness.client('alpha').traverseGraph(A.id, { maxDepth: 5 })
    const depth5Ids = depth5.nodes.map((n) => n.id)
    expect(depth5Ids).toContain(A.id)
    expect(depth5Ids).toContain(E.id)

    // Edges should be present
    expect(depth5.edges.length).toBeGreaterThan(0)
    expect(depth5.traversedFrom).toBe(A.id)
  })
})

// ── Test 5: rel filter in graph traversal ─────────────────────────────────────

describe('graph traversal rel filter', () => {
  it('rels filter restricts which edges are followed', async () => {
    // Build the graph bottom-up so links point to final IDs (no supersedes chains):
    //   A  --(depends-on)-->  B  --(depends-on)-->  D
    //   A  --(references)-->  C
    // Traversal with rels=['depends-on'] should reach A, B, D but NOT C.

    const C = await harness.client('alpha').putMemory({
      type: 'result',
      topic: ['rel-filter'],
      content: 'C — reached via references only',
      confidence: 0.7,
    })

    const D = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['rel-filter'],
      content: 'D — linked from B via depends-on',
      confidence: 0.8,
    })

    // B is created with its final link to D so no supersedes needed
    const B = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['rel-filter'],
      content: 'B — reached via depends-on, links to D',
      confidence: 0.8,
      links: [{ target: D.id, rel: 'depends-on' }],
    })

    // A is created with its final links to B and C
    const A = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['rel-filter'],
      content: 'A — has both depends-on (B) and references (C) links',
      confidence: 0.9,
      links: [
        { target: B.id, rel: 'depends-on' },
        { target: C.id, rel: 'references' },
      ],
    })

    // Traverse only depends-on edges from A
    const result = await harness.client('alpha').traverseGraph(A.id, {
      rels: ['depends-on'],
      maxDepth: 5,
    })

    const nodeIds = result.nodes.map((n) => n.id)
    // Should include A (start), B (depends-on from A), D (depends-on from B)
    expect(nodeIds).toContain(A.id)
    expect(nodeIds).toContain(B.id)
    expect(nodeIds).toContain(D.id)
    // Should NOT include C (linked via 'references', not 'depends-on')
    expect(nodeIds).not.toContain(C.id)
  })
})

// ── Test 6: backlink index survives restart ───────────────────────────────────

describe('backlink index survives restart', () => {
  const rh = new TestHarness()
  let psk: string

  beforeAll(async () => {
    await rh.startAgents(['alpha'])
    psk = (await rh.joinAllToPsk()).psk
  })
  afterAll(() => rh.teardown())

  it('backlinks are correct after daemon restart', async () => {
    const target = await rh.client('alpha').putMemory({
      type: 'pattern',
      topic: ['restart-backlinks'],
      content: 'Target chunk — will be linked to',
      confidence: 0.9,
    })

    const linker = await rh.client('alpha').putMemory({
      type: 'result',
      topic: ['restart-backlinks'],
      content: 'Linker chunk — points at target',
      confidence: 0.8,
      links: [{ target: target.id, rel: 'related' }],
    })

    // Verify backlinks before restart
    const before = await rh.client('alpha').getBacklinks(target.id)
    expect(before.map((c) => c.id)).toContain(linker.id)

    // Restart
    await rh.stopAgent('alpha')
    await rh.restartAgent('alpha')
    await rh.client('alpha').joinNetwork(psk)

    // Backlinks should still work after restart (index rebuilt from store)
    const after = await rh.client('alpha').getBacklinks(target.id)
    expect(after.map((c) => c.id)).toContain(linker.id)
  })
})

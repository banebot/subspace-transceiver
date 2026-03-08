/**
 * ReplicationManager unit/integration tests.
 *
 * Tests the full pipeline:
 *   LoroStore.put() → 'changed' event → exportDelta → gossipBroadcast
 *   onGossipMessage → decode envelope → importDelta → chunk appears
 *
 * Uses mock EngineBridge to avoid needing real Iroh processes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { LoroMemoryStore } from '../src/loro-store.js'
import { ReplicationManager } from '../src/replication.js'
import type { GossipMessage } from '../src/engine-bridge.js'
import type { MemoryChunk } from '../src/schema.js'

// ---------------------------------------------------------------------------
// Mock EngineBridge — captures broadcasts and allows injecting messages
// ---------------------------------------------------------------------------
class MockEngineBridge extends EventEmitter {
  public broadcasts: Array<{ topicHex: string; payload: Buffer }> = []
  public nodeId: string | null = 'mock-node-a'
  public isRunning = true

  private gossipListeners: Array<(msg: GossipMessage) => void> = []

  async gossipBroadcast(topicHex: string, payload: Buffer | Uint8Array): Promise<void> {
    this.broadcasts.push({ topicHex, payload: Buffer.from(payload) })
  }

  onGossipMessage(cb: (msg: GossipMessage) => void): () => void {
    this.gossipListeners.push(cb)
    return () => {
      this.gossipListeners = this.gossipListeners.filter(l => l !== cb)
    }
  }

  onGossipNeighborUp(_cb: (event: { topicHex: string; nodeId: string }) => void): () => void {
    // No-op in tests — neighbor up events are not simulated
    return () => {}
  }

  /** Simulate receiving a gossip message from a peer */
  injectGossipMessage(msg: GossipMessage): void {
    for (const listener of this.gossipListeners) {
      listener(msg)
    }
  }
}

function makeChunk(id: string, content: string, namespace: 'skill' | 'project' = 'project'): MemoryChunk {
  return {
    id,
    type: namespace,
    namespace,
    topic: ['test'],
    content,
    source: { agentId: 'agent-a', peerId: 'peer-a', timestamp: Date.now() },
    confidence: 1,
    network: 'test-net',
    version: 1,
  }
}

const TOPIC_HEX = 'a'.repeat(64)

describe('ReplicationManager', () => {
  let bridgeA: MockEngineBridge
  let storeASkill: LoroMemoryStore
  let storeAProject: LoroMemoryStore
  let replicationA: ReplicationManager

  beforeEach(() => {
    bridgeA = new MockEngineBridge()
    storeASkill = LoroMemoryStore.createInMemory()
    storeAProject = LoroMemoryStore.createInMemory()
    replicationA = new ReplicationManager(
      bridgeA as unknown as import('../src/engine-bridge.js').EngineBridge,
      { skill: storeASkill, project: storeAProject },
      TOPIC_HEX,
      'mock-node-a',
    )
    replicationA.start()
  })

  afterEach(() => {
    replicationA.stop()
  })

  // Helper: wait for debounced broadcast
  async function waitForBroadcast(bridge: MockEngineBridge, count = 1, timeoutMs = 2000): Promise<void> {
    const start = Date.now()
    while (bridge.broadcasts.length < count && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 20))
    }
  }

  // -----------------------------------------------------------------------
  // Outbound: local write → gossip broadcast
  // -----------------------------------------------------------------------

  it('broadcasts a Loro delta when a chunk is written to the project store', async () => {
    await storeAProject.put(makeChunk('chunk-1', 'hello world', 'project'))
    await waitForBroadcast(bridgeA)

    expect(bridgeA.broadcasts.length).toBe(1)
    expect(bridgeA.broadcasts[0].topicHex).toBe(TOPIC_HEX)

    // Verify the payload is a valid envelope
    const payload = JSON.parse(bridgeA.broadcasts[0].payload.toString('utf8'))
    expect(payload.type).toBe('loro-delta')
    expect(payload.namespace).toBe('project')
    expect(payload.fromNodeId).toBe('mock-node-a')
    expect(payload.delta).toBeTruthy() // base64 string
  })

  it('broadcasts a Loro delta when a chunk is written to the skill store', async () => {
    await storeASkill.put(makeChunk('chunk-2', 'skill data', 'skill'))
    await waitForBroadcast(bridgeA)

    expect(bridgeA.broadcasts.length).toBe(1)
    const payload = JSON.parse(bridgeA.broadcasts[0].payload.toString('utf8'))
    expect(payload.namespace).toBe('skill')
  })

  it('debounces rapid writes into fewer broadcasts', async () => {
    // Write 5 chunks rapidly
    for (let i = 0; i < 5; i++) {
      await storeAProject.put(makeChunk(`rapid-${i}`, `data ${i}`, 'project'))
    }
    // Wait for debounce (50ms) plus margin
    await new Promise(r => setTimeout(r, 200))

    // Should be 1 or 2 broadcasts, not 5
    expect(bridgeA.broadcasts.length).toBeLessThanOrEqual(2)
  })

  // -----------------------------------------------------------------------
  // Inbound: gossip message → Loro import
  // -----------------------------------------------------------------------

  it('imports a delta received from a peer into the correct store', async () => {
    // Create a delta from a separate Loro store (simulating a peer)
    const peerStore = LoroMemoryStore.createInMemory()
    await peerStore.put(makeChunk('peer-chunk-1', 'from peer', 'project'))
    const delta = peerStore.exportDelta(undefined)

    // Create the envelope as the peer would send it
    const envelope = {
      type: 'loro-delta',
      namespace: 'project',
      delta: Buffer.from(delta).toString('base64'),
      fromNodeId: 'mock-node-b',
    }

    const gossipPayload = Buffer.from(JSON.stringify(envelope)).toString('base64')

    bridgeA.injectGossipMessage({
      topicHex: TOPIC_HEX,
      payload: gossipPayload,
      fromNodeId: 'mock-node-b',
    })

    // Give it a tick to process
    await new Promise(r => setTimeout(r, 50))

    // The chunk should now be in storeAProject
    const chunk = await storeAProject.get('peer-chunk-1')
    expect(chunk).not.toBeNull()
    expect(chunk!.content).toBe('from peer')
  })

  it('routes skill deltas to the skill store', async () => {
    const peerStore = LoroMemoryStore.createInMemory()
    await peerStore.put(makeChunk('skill-from-peer', 'skill knowledge', 'skill'))
    const delta = peerStore.exportDelta(undefined)

    const envelope = {
      type: 'loro-delta',
      namespace: 'skill',
      delta: Buffer.from(delta).toString('base64'),
      fromNodeId: 'mock-node-b',
    }

    bridgeA.injectGossipMessage({
      topicHex: TOPIC_HEX,
      payload: Buffer.from(JSON.stringify(envelope)).toString('base64'),
      fromNodeId: 'mock-node-b',
    })

    await new Promise(r => setTimeout(r, 50))

    const chunk = await storeASkill.get('skill-from-peer')
    expect(chunk).not.toBeNull()
    expect(chunk!.content).toBe('skill knowledge')

    // Should NOT be in project store
    const notInProject = await storeAProject.get('skill-from-peer')
    expect(notInProject).toBeNull()
  })

  it('ignores messages from self', async () => {
    const peerStore = LoroMemoryStore.createInMemory()
    await peerStore.put(makeChunk('self-chunk', 'should be ignored', 'project'))
    const delta = peerStore.exportDelta(undefined)

    const envelope = {
      type: 'loro-delta',
      namespace: 'project',
      delta: Buffer.from(delta).toString('base64'),
      fromNodeId: 'mock-node-a', // same as local
    }

    bridgeA.injectGossipMessage({
      topicHex: TOPIC_HEX,
      payload: Buffer.from(JSON.stringify(envelope)).toString('base64'),
      fromNodeId: 'mock-node-a',
    })

    await new Promise(r => setTimeout(r, 50))

    const chunk = await storeAProject.get('self-chunk')
    expect(chunk).toBeNull()
  })

  it('ignores messages for a different gossip topic', async () => {
    const peerStore = LoroMemoryStore.createInMemory()
    await peerStore.put(makeChunk('wrong-topic', 'wrong', 'project'))
    const delta = peerStore.exportDelta(undefined)

    const envelope = {
      type: 'loro-delta',
      namespace: 'project',
      delta: Buffer.from(delta).toString('base64'),
      fromNodeId: 'mock-node-b',
    }

    bridgeA.injectGossipMessage({
      topicHex: 'b'.repeat(64), // different topic
      payload: Buffer.from(JSON.stringify(envelope)).toString('base64'),
      fromNodeId: 'mock-node-b',
    })

    await new Promise(r => setTimeout(r, 50))

    const chunk = await storeAProject.get('wrong-topic')
    expect(chunk).toBeNull()
  })

  it('ignores non-replication envelopes (e.g. discovery manifests)', async () => {
    const discoveryPayload = JSON.stringify({ type: 'discovery', version: '1.0' })

    bridgeA.injectGossipMessage({
      topicHex: TOPIC_HEX,
      payload: Buffer.from(discoveryPayload).toString('base64'),
      fromNodeId: 'mock-node-b',
    })

    await new Promise(r => setTimeout(r, 50))
    // Should not crash — just silently ignore
    expect(true).toBe(true)
  })

  it('handles malformed base64 gracefully', async () => {
    bridgeA.injectGossipMessage({
      topicHex: TOPIC_HEX,
      payload: '!!!not-base64!!!',
      fromNodeId: 'mock-node-b',
    })

    await new Promise(r => setTimeout(r, 50))
    // Should not crash
    expect(true).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Full round-trip: write → broadcast → receive → import
  // -----------------------------------------------------------------------

  it('full round-trip: A writes, B receives the delta, both have the chunk', async () => {
    // Set up "Agent B" with its own store and replication
    const bridgeB = new MockEngineBridge()
    bridgeB.nodeId = 'mock-node-b'
    const storeBProject = LoroMemoryStore.createInMemory()
    const storeBSkill = LoroMemoryStore.createInMemory()
    const replicationB = new ReplicationManager(
      bridgeB as unknown as import('../src/engine-bridge.js').EngineBridge,
      { skill: storeBSkill, project: storeBProject },
      TOPIC_HEX,
      'mock-node-b',
    )
    replicationB.start()

    try {
      // Agent A writes a chunk
      await storeAProject.put(makeChunk('roundtrip-1', 'hello from A', 'project'))

      // Wait for A's broadcast
      await waitForBroadcast(bridgeA)
      expect(bridgeA.broadcasts.length).toBeGreaterThanOrEqual(1)

      // Simulate network delivery: take A's broadcast and inject it into B
      const broadcast = bridgeA.broadcasts[bridgeA.broadcasts.length - 1]
      bridgeB.injectGossipMessage({
        topicHex: broadcast.topicHex,
        payload: broadcast.payload.toString('base64'),
        fromNodeId: 'mock-node-a',
      })

      await new Promise(r => setTimeout(r, 100))

      // B should now have the chunk
      const chunkOnB = await storeBProject.get('roundtrip-1')
      expect(chunkOnB).not.toBeNull()
      expect(chunkOnB!.content).toBe('hello from A')

      // A still has it too
      const chunkOnA = await storeAProject.get('roundtrip-1')
      expect(chunkOnA).not.toBeNull()
      expect(chunkOnA!.content).toBe('hello from A')
    } finally {
      replicationB.stop()
    }
  })

  it('bidirectional: both A and B write, both get each other\'s chunks', async () => {
    const bridgeB = new MockEngineBridge()
    bridgeB.nodeId = 'mock-node-b'
    const storeBProject = LoroMemoryStore.createInMemory()
    const storeBSkill = LoroMemoryStore.createInMemory()
    const replicationB = new ReplicationManager(
      bridgeB as unknown as import('../src/engine-bridge.js').EngineBridge,
      { skill: storeBSkill, project: storeBProject },
      TOPIC_HEX,
      'mock-node-b',
    )
    replicationB.start()

    try {
      // A writes
      await storeAProject.put(makeChunk('from-a', 'A wrote this', 'project'))
      await waitForBroadcast(bridgeA)

      // B writes
      await storeBProject.put(makeChunk('from-b', 'B wrote this', 'project'))
      await waitForBroadcast(bridgeB)

      // Deliver A→B
      const aBroadcast = bridgeA.broadcasts[bridgeA.broadcasts.length - 1]
      bridgeB.injectGossipMessage({
        topicHex: aBroadcast.topicHex,
        payload: aBroadcast.payload.toString('base64'),
        fromNodeId: 'mock-node-a',
      })

      // Deliver B→A
      const bBroadcast = bridgeB.broadcasts[bridgeB.broadcasts.length - 1]
      bridgeA.injectGossipMessage({
        topicHex: bBroadcast.topicHex,
        payload: bBroadcast.payload.toString('base64'),
        fromNodeId: 'mock-node-b',
      })

      await new Promise(r => setTimeout(r, 100))

      // Both should have both chunks
      expect(await storeAProject.get('from-a')).not.toBeNull()
      expect(await storeAProject.get('from-b')).not.toBeNull()
      expect(await storeBProject.get('from-a')).not.toBeNull()
      expect(await storeBProject.get('from-b')).not.toBeNull()
    } finally {
      replicationB.stop()
    }
  })

  it('chunk metadata survives replication', async () => {
    const bridgeB = new MockEngineBridge()
    bridgeB.nodeId = 'mock-node-b'
    const storeBProject = LoroMemoryStore.createInMemory()
    const storeBSkill = LoroMemoryStore.createInMemory()
    const replicationB = new ReplicationManager(
      bridgeB as unknown as import('../src/engine-bridge.js').EngineBridge,
      { skill: storeBSkill, project: storeBProject },
      TOPIC_HEX,
      'mock-node-b',
    )
    replicationB.start()

    try {
      const original: MemoryChunk = {
        id: 'meta-test',
        type: 'project',
        namespace: 'project',
        topic: ['testing', 'metadata'],
        content: 'metadata survives replication',
        source: {
          agentId: 'agent-alpha',
          peerId: 'peer-alpha',
          project: 'test-project',
          sessionId: 'sess-123',
          timestamp: 1700000000000,
        },
        confidence: 0.95,
        network: 'test-net',
        version: 3,
        collection: 'patterns',
        slug: 'test-pattern',
      }

      await storeAProject.put(original)
      await waitForBroadcast(bridgeA)

      const broadcast = bridgeA.broadcasts[bridgeA.broadcasts.length - 1]
      bridgeB.injectGossipMessage({
        topicHex: broadcast.topicHex,
        payload: broadcast.payload.toString('base64'),
        fromNodeId: 'mock-node-a',
      })

      await new Promise(r => setTimeout(r, 100))

      const replicated = await storeBProject.get('meta-test')
      expect(replicated).not.toBeNull()
      expect(replicated!.content).toBe(original.content)
      expect(replicated!.topic).toEqual(original.topic)
      expect(replicated!.source.agentId).toBe(original.source.agentId)
      expect(replicated!.confidence).toBe(original.confidence)
      expect(replicated!.version).toBe(original.version)
      expect(replicated!.collection).toBe(original.collection)
      expect(replicated!.slug).toBe(original.slug)
    } finally {
      replicationB.stop()
    }
  })

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  it('stop() prevents further broadcasts', async () => {
    replicationA.stop()

    await storeAProject.put(makeChunk('after-stop', 'should not broadcast', 'project'))
    await new Promise(r => setTimeout(r, 200))

    expect(bridgeA.broadcasts.length).toBe(0)
  })

  it('stop() unsubscribes from gossip messages', async () => {
    replicationA.stop()

    const peerStore = LoroMemoryStore.createInMemory()
    await peerStore.put(makeChunk('after-stop-recv', 'should not import', 'project'))
    const delta = peerStore.exportDelta(undefined)

    bridgeA.injectGossipMessage({
      topicHex: TOPIC_HEX,
      payload: Buffer.from(JSON.stringify({
        type: 'loro-delta',
        namespace: 'project',
        delta: Buffer.from(delta).toString('base64'),
        fromNodeId: 'mock-node-b',
      })).toString('base64'),
      fromNodeId: 'mock-node-b',
    })

    await new Promise(r => setTimeout(r, 50))
    const chunk = await storeAProject.get('after-stop-recv')
    expect(chunk).toBeNull()
  })
})

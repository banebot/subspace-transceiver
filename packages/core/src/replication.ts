/**
 * ReplicationManager — wires Loro CRDT delta sync to Iroh gossip transport.
 *
 * Outbound: Loro store write → exportDelta() → gossipBroadcast()
 * Inbound:  onGossipMessage() → parse envelope → importDelta()
 *
 * Envelope format (JSON, then base64-encoded for gossip payload):
 * {
 *   "type": "loro-delta",
 *   "namespace": "skill" | "project",
 *   "delta": "<base64-encoded Loro delta bytes>",
 *   "fromNodeId": "<sender's nodeId>"
 * }
 */

import type { EngineBridge, GossipMessage } from './engine-bridge.js'

/** Any store that supports Loro delta export/import */
interface DeltaSyncCapable {
  exportDelta(since?: Uint8Array): Uint8Array
  importDelta(bytes: Uint8Array): void
  on(event: 'changed', listener: () => void): unknown
  removeListener(event: 'changed', listener: () => void): unknown
}

const ENVELOPE_TYPE = 'loro-delta'

interface DeltaEnvelope {
  type: typeof ENVELOPE_TYPE
  namespace: 'skill' | 'project'
  delta: string   // base64
  fromNodeId: string
}

export class ReplicationManager {
  private bridge: EngineBridge
  private stores: { skill: DeltaSyncCapable; project: DeltaSyncCapable }
  private gossipTopicHex: string
  private localNodeId: string

  // Debounce state per namespace
  private pendingBroadcast: { skill: ReturnType<typeof setTimeout> | null; project: ReturnType<typeof setTimeout> | null }
  private lastSyncVersion: { skill: Uint8Array | undefined; project: Uint8Array | undefined }

  // Cleanup handles
  private gossipUnsub: (() => void) | null = null
  private storeListeners: Array<() => void> = []
  private stopped = false

  constructor(
    bridge: EngineBridge,
    stores: { skill: DeltaSyncCapable; project: DeltaSyncCapable },
    gossipTopicHex: string,
    localNodeId: string,
  ) {
    this.bridge = bridge
    this.stores = stores
    this.gossipTopicHex = gossipTopicHex
    this.localNodeId = localNodeId
    this.pendingBroadcast = { skill: null, project: null }
    this.lastSyncVersion = { skill: undefined, project: undefined }
  }

  /**
   * Start listening for local changes and incoming gossip messages.
   */
  start(): void {
    // --- Outbound: store changes → gossip broadcast ---
    for (const ns of ['skill', 'project'] as const) {
      const store = this.stores[ns]
      const handler = () => { this.scheduleBroadcast(ns) }
      store.on('changed', handler)
      this.storeListeners.push(() => store.removeListener('changed', handler))
    }

    // --- Inbound: gossip messages → store importDelta ---
    this.gossipUnsub = this.bridge.onGossipMessage((msg: GossipMessage) => {
      if (msg.topicHex !== this.gossipTopicHex) return
      this.handleIncomingMessage(msg)
    })
  }

  /**
   * Stop the replication manager and release resources.
   */
  stop(): void {
    this.stopped = true
    if (this.pendingBroadcast.skill) clearTimeout(this.pendingBroadcast.skill)
    if (this.pendingBroadcast.project) clearTimeout(this.pendingBroadcast.project)
    for (const unsub of this.storeListeners) unsub()
    this.storeListeners = []
    if (this.gossipUnsub) {
      this.gossipUnsub()
      this.gossipUnsub = null
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound: local change → gossip broadcast
  // ---------------------------------------------------------------------------

  private scheduleBroadcast(namespace: 'skill' | 'project'): void {
    if (this.stopped) return
    // Debounce: coalesce writes within 50ms
    if (this.pendingBroadcast[namespace]) return
    this.pendingBroadcast[namespace] = setTimeout(() => {
      this.pendingBroadcast[namespace] = null
      void this.broadcastDelta(namespace)
    }, 50)
  }

  private async broadcastDelta(namespace: 'skill' | 'project'): Promise<void> {
    if (this.stopped) return
    try {
      const store = this.stores[namespace]
      const delta = store.exportDelta(this.lastSyncVersion[namespace])

      // Update our sync version to current state
      this.lastSyncVersion[namespace] = store.exportDelta(undefined) // snapshot as version marker

      const envelope: DeltaEnvelope = {
        type: ENVELOPE_TYPE,
        namespace,
        delta: Buffer.from(delta).toString('base64'),
        fromNodeId: this.localNodeId,
      }

      const payloadBytes = Buffer.from(JSON.stringify(envelope), 'utf8')
      await this.bridge.gossipBroadcast(this.gossipTopicHex, payloadBytes)
    } catch (err) {
      console.warn(`[subspace:replication] Failed to broadcast ${namespace} delta:`, err)
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound: gossip message → Loro importDelta
  // ---------------------------------------------------------------------------

  private handleIncomingMessage(msg: GossipMessage): void {
    try {
      // Decode the gossip payload (base64 → bytes → JSON)
      const payloadBytes = Buffer.from(msg.payload, 'base64')
      const envelopeStr = payloadBytes.toString('utf8')

      let envelope: DeltaEnvelope
      try {
        envelope = JSON.parse(envelopeStr) as DeltaEnvelope
      } catch {
        // Not a replication envelope (could be a discovery manifest)
        return
      }

      // Only handle our envelope type
      if (envelope.type !== ENVELOPE_TYPE) return

      // Ignore messages from self
      if (envelope.fromNodeId === this.localNodeId) return

      // Validate namespace
      if (envelope.namespace !== 'skill' && envelope.namespace !== 'project') {
        console.warn(`[subspace:replication] Unknown namespace: ${envelope.namespace}`)
        return
      }

      // Decode delta bytes
      const deltaBytes = Buffer.from(envelope.delta, 'base64')

      // Import into the correct store
      const store = this.stores[envelope.namespace]
      store.importDelta(new Uint8Array(deltaBytes))
    } catch (err) {
      console.warn('[subspace:replication] Failed to process incoming delta:', err)
    }
  }
}

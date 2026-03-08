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
  /** Return a lightweight snapshot for use as a version marker with exportDelta(since) */
  getVersionSnapshot(): Uint8Array
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
  private resyncTimer: ReturnType<typeof setInterval> | null = null
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

    // --- Gossip NeighborUp: reset sync version so the new peer gets full state ---
    // When a peer joins the gossip mesh, reset lastSyncVersion so the next
    // periodic resync (or debounced broadcast) sends the FULL snapshot.
    // This is the correct fix for "late-joining peer" scenarios: the full
    // snapshot is only sent AFTER the gossip connection is established.
    const neighborUnsub = this.bridge.onGossipNeighborUp((event) => {
      if (event.topicHex !== this.gossipTopicHex) return
      this.resetSyncVersion()
    })
    this.storeListeners.push(neighborUnsub)

    // --- Periodic re-sync: broadcast current state every 5s ---
    // This ensures that if the first broadcast was lost (gossip mesh not yet
    // formed when the chunk was written), the next periodic sync delivers it.
    const RESYNC_INTERVAL = parseInt(process.env.SUBSPACE_REPLICATION_INTERVAL_MS ?? '5000', 10)
    this.resyncTimer = setInterval(() => {
      void this.broadcastDelta('skill')
      void this.broadcastDelta('project')
    }, RESYNC_INTERVAL)
  }

  /**
   * Reset the sync version so the next broadcast sends the full current state.
   * Call this when a new peer joins the gossip mesh to ensure they receive
   * all existing data even if the node has been running for a while.
   */
  resetSyncVersion(): void {
    // Reset lastSyncVersion to undefined so the next periodic resync
    // (or any triggered broadcast) sends the full current state.
    this.lastSyncVersion = { skill: undefined, project: undefined }
  }

  /**
   * Stop the replication manager and release resources.
   */
  stop(): void {
    this.stopped = true
    if (this.pendingBroadcast.skill) clearTimeout(this.pendingBroadcast.skill)
    if (this.pendingBroadcast.project) clearTimeout(this.pendingBroadcast.project)
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer)
      this.resyncTimer = null
    }
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
      const since = this.lastSyncVersion[namespace]
      const delta = store.exportDelta(since)

      // Build envelope BEFORE updating lastSyncVersion so we can retry on failure
      const newVersion = store.getVersionSnapshot()

      const envelope: DeltaEnvelope = {
        type: ENVELOPE_TYPE,
        namespace,
        delta: Buffer.from(delta).toString('base64'),
        fromNodeId: this.localNodeId,
      }

      const payloadBytes = Buffer.from(JSON.stringify(envelope), 'utf8')
      await this.bridge.gossipBroadcast(this.gossipTopicHex, payloadBytes)

      // Only advance lastSyncVersion AFTER successful broadcast.
      // If the broadcast fails, the next periodic resync will retry from the
      // same starting point (no data loss).
      this.lastSyncVersion[namespace] = newVersion
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

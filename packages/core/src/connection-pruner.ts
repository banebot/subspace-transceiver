/**
 * SubspaceConnectionPruner — connection-slot defence against non-Subspace peers.
 *
 * PROBLEM
 * ───────
 * The daemon connects to the open global network so that agents are globally
 * reachable via circuit relay and DHT. Any libp2p node on the internet can
 * therefore establish a TCP connection and occupy one of the 50 connection
 * slots, even though it cannot read PSK-encrypted content or subscribe to
 * Subspace GossipSub topics.
 *
 * APPROACH
 * ────────
 * After a configurable grace period (default 30 s), we check whether a peer
 * that connected to us *inbound* has subscribed to at least one topic whose
 * name starts with `_subspace/`. Peers that never subscribe are quietly
 * disconnected with `node.hangUp()`.
 *
 * Rules:
 *   1. Only inbound connections are pruned — peers we dialled ourselves
 *      (bootstrap nodes, relay servers, trusted peers) are always kept.
 *   2. If a peer has at least one connection that we initiated (outbound),
 *      we skip the prune check for that peer entirely.
 *   3. The pruner is non-blocking: failed hangUp() calls are swallowed.
 *   4. All timers are cleared on stop() so there are no dangling timeouts
 *      after daemon shutdown.
 *
 * INTEGRATION
 * ───────────
 * Instantiate with the libp2p node and call start() after node.start().
 * Call stop() before node.stop() (leaveNetwork / leaveGlobalNetwork do this).
 * The pruner is wired into createLibp2pNode() automatically.
 */

import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'

export interface ConnectionPrunerOptions {
  /**
   * How long (ms) to wait after a peer connects before checking whether it
   * has subscribed to any `_subspace/` GossipSub topic.
   * Default: 30 000 (30 seconds).
   */
  graceMs?: number
  /**
   * GossipSub topic prefix to consider "Subspace". Any peer subscribed to at
   * least one topic starting with this prefix is kept.
   * Default: '_subspace/'
   */
  topicPrefix?: string
}

export class SubspaceConnectionPruner {
  private readonly node: Libp2p
  private readonly graceMs: number
  private readonly topicPrefix: string
  /** peerId.toString() → pending prune timer */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = false

  constructor(node: Libp2p, opts: ConnectionPrunerOptions = {}) {
    this.node = node
    this.graceMs = opts.graceMs ?? 30_000
    this.topicPrefix = opts.topicPrefix ?? '_subspace/'
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.node.addEventListener('peer:connect', this.onConnect)
    this.node.addEventListener('peer:disconnect', this.onDisconnect)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.node.removeEventListener('peer:connect', this.onConnect)
    this.node.removeEventListener('peer:disconnect', this.onDisconnect)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private readonly onConnect = (evt: CustomEvent<PeerId>): void => {
    const peerIdStr = evt.detail.toString()
    // Don't double-schedule if we reconnect quickly
    if (this.timers.has(peerIdStr)) return
    const timer = setTimeout(() => this.checkPeer(peerIdStr), this.graceMs)
    this.timers.set(peerIdStr, timer)
  }

  private readonly onDisconnect = (evt: CustomEvent<PeerId>): void => {
    const peerIdStr = evt.detail.toString()
    const timer = this.timers.get(peerIdStr)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(peerIdStr)
    }
  }

  // ---------------------------------------------------------------------------
  // Prune check
  // ---------------------------------------------------------------------------

  private checkPeer(peerIdStr: string): void {
    this.timers.delete(peerIdStr)

    // Find the PeerId object from currently connected peers
    const peers = this.node.getPeers()
    const targetPeerId = peers.find(p => p.toString() === peerIdStr)
    if (targetPeerId === undefined) return  // already disconnected

    // Rule 2: never prune peers we dialled outbound (bootstrap / relay)
    const conns = this.node.getConnections(targetPeerId)
    if (conns.some(c => c.direction === 'outbound')) return

    // Rule 1 + 3: check GossipSub subscription
    if (this.isSubspacePeer(peerIdStr)) return

    // Peer has consumed a slot without engaging — disconnect quietly
    console.log(`[subspace:pruner] disconnecting non-Subspace peer ${peerIdStr.slice(0, 20)}… (grace=${this.graceMs}ms)`)
    this.node.hangUp(targetPeerId).catch(() => { /* ignore */ })
  }

  /**
   * Returns true if the peer is subscribed to at least one `_subspace/` topic.
   * Returns true (skips prune) if pubsub is unavailable — fail-open is safer
   * than accidentally pruning a legitimate peer.
   *
   * Implementation note: `pubsub.getTopics()` returns only topics the LOCAL
   * node is subscribed to — useless here since the pruner itself never
   * subscribes. Instead we read `pubsub.topics` directly: gossipsub's internal
   * Map<topicString, Set<peerIdString>> that tracks ALL peers' subscriptions
   * regardless of local subscription state.
   */
  private isSubspacePeer(peerIdStr: string): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pubsub = (this.node.services as any)?.pubsub
    if (pubsub == null) return true

    // gossipsub.topics: Map<topic, Set<peerIdStr>> — all known remote subscriptions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topicsMap: Map<string, Set<string>> | undefined = pubsub.topics
    if (topicsMap == null) return true   // fallback: fail-open if API not available

    for (const [topic, peers] of topicsMap) {
      if (topic.startsWith(this.topicPrefix) && peers.has(peerIdStr)) return true
    }
    return false
  }
}

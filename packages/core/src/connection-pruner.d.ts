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
import type { Libp2p } from 'libp2p';
export interface ConnectionPrunerOptions {
    /**
     * How long (ms) to wait after a peer connects before checking whether it
     * has subscribed to any `_subspace/` GossipSub topic.
     * Default: 30 000 (30 seconds).
     */
    graceMs?: number;
    /**
     * GossipSub topic prefix to consider "Subspace". Any peer subscribed to at
     * least one topic starting with this prefix is kept.
     * Default: '_subspace/'
     */
    topicPrefix?: string;
}
export declare class SubspaceConnectionPruner {
    private readonly node;
    private readonly graceMs;
    private readonly topicPrefix;
    /** peerId.toString() → pending prune timer */
    private readonly timers;
    private running;
    constructor(node: Libp2p, opts?: ConnectionPrunerOptions);
    start(): void;
    stop(): void;
    private readonly onConnect;
    private readonly onDisconnect;
    private checkPeer;
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
    private isSubspacePeer;
}
//# sourceMappingURL=connection-pruner.d.ts.map
/**
 * Connection management for Iroh transport.
 *
 * In libp2p, we needed a custom ConnectionPruner to manage peer connections
 * because GossipSub's connection manager was not aggressive enough about
 * evicting idle peers.
 *
 * Iroh handles connection management natively:
 * - QUIC connections are closed when the ALPN stream completes
 * - Gossip uses HyParView which handles peer churn automatically
 * - The router closes connections when protocols finish
 *
 * This module is kept as a stub for backward compatibility.
 * The SubspaceConnectionPruner is now a no-op — Iroh handles it.
 */

/**
 * @deprecated Iroh manages connections natively. This is a no-op stub.
 */
export interface ConnectionPrunerOptions {
  /** Grace period in ms before pruning an idle connection (unused). */
  graceMs?: number
}

/**
 * @deprecated No-op stub — connection pruning is handled by Iroh QUIC.
 */
export class SubspaceConnectionPruner {
  constructor(_node: unknown, _options: ConnectionPrunerOptions = {}) {
    // No-op: Iroh manages connection lifecycle
  }

  /** No-op: Iroh manages connections. */
  stop(): void {}
}

/**
 * Sliding-window rate limiter for per-peer ingest control.
 *
 * Tracks event timestamps for each PeerId in a sliding window.
 * Peers that exceed the window limit can be soft-banned for a configurable
 * duration — they are ignored without disconnection (graceful degradation).
 *
 * All state is in-memory and resets on daemon restart. This is intentional:
 * transient misbehavior does not permanently penalize peers.
 */
export interface RateLimiterOptions {
    /** Maximum number of events allowed within the window */
    maxPerWindow: number;
    /** Window duration in milliseconds */
    windowMs: number;
}
export declare class RateLimiter {
    private readonly maxPerWindow;
    private readonly windowMs;
    private readonly peers;
    constructor(opts: RateLimiterOptions);
    /**
     * Check whether a peer is within rate limits.
     * Returns `true` if the event is allowed, `false` if the peer is over-limit
     * or currently soft-banned.
     *
     * Does NOT record the event — call `record()` separately after this check.
     */
    check(peerId: string): boolean;
    /**
     * Record an event for a peer.
     * Call after `check()` returns true.
     */
    record(peerId: string): void;
    /**
     * Apply a soft ban to a peer for the specified duration (ms).
     * Banned peers fail `check()` without consuming quota.
     */
    softBan(peerId: string, durationMs: number): void;
    /**
     * Returns true if the peer is currently soft-banned.
     */
    isBanned(peerId: string): boolean;
    /**
     * Return the current event count for a peer within the active window.
     */
    getCount(peerId: string): number;
    /**
     * Clear all state for a peer (e.g. after a manual reputation reset).
     */
    reset(peerId: string): void;
    private getOrCreate;
    /** Remove timestamps older than the window from the front of the list. */
    private prune;
}
//# sourceMappingURL=rate-limiter.d.ts.map
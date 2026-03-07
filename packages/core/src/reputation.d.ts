/**
 * Peer reputation scoring for Subspace Transceiver.
 *
 * Each node maintains a LOCAL reputation score for every peer it interacts with.
 * Scores are NOT shared over the network — they are a private, subjective view
 * that each node uses to protect itself.
 *
 * SCORE MODEL
 * ───────────
 * Scores start at 0. Positive events increase the score; negative events
 * decrease it. Scores decay toward 0 over time (half-life: 24 hours) so
 * that misbehaving peers that go quiet eventually recover.
 *
 * THRESHOLDS
 * ──────────
 *   score < -50  → stop replicating content from this peer
 *   score < -100 → disconnect + temp blacklist for 1 hour
 *   score < -200 → permanent blacklist (until manual reset)
 *
 * EVENTS
 * ──────
 *   VALID_CONTENT         +1    Content passed all validation checks
 *   INVALID_CONTENT      -10    Malformed / schema-invalid chunk
 *   RATE_LIMIT_VIOLATION  -5    Peer exceeded ingest rate limit
 *   SIGNATURE_FAILURE    -20    Chunk signature verification failed
 *   OVERSIZED_CONTENT     -8    Chunk or blob exceeds size limits
 */
export type ScoreEvent = 'VALID_CONTENT' | 'INVALID_CONTENT' | 'RATE_LIMIT_VIOLATION' | 'SIGNATURE_FAILURE' | 'OVERSIZED_CONTENT';
export declare class ReputationStore {
    /** Half-life for score decay: 24 hours */
    private static readonly HALF_LIFE_MS;
    static readonly STOP_REPLICATION_THRESHOLD = -50;
    static readonly TEMP_BLACKLIST_THRESHOLD = -100;
    static readonly PERM_BLACKLIST_THRESHOLD = -200;
    private peers;
    /**
     * Record a scored event for a peer.
     * Applies decay first, then applies the delta, then checks thresholds.
     */
    record(peerId: string, event: ScoreEvent): void;
    /**
     * Get the current (decay-adjusted) score for a peer.
     * Unknown peers return 0.
     */
    getScore(peerId: string): number;
    /**
     * Returns true if the peer is blacklisted (temporary or permanent).
     */
    isBlacklisted(peerId: string): boolean;
    /**
     * Returns true if we should stop replicating content from this peer,
     * but not disconnect (score between STOP_REPLICATION and TEMP_BLACKLIST).
     */
    shouldStopReplicating(peerId: string): boolean;
    /**
     * Manually clear blacklist and reset score for a peer.
     * Use for operator-initiated forgiveness.
     */
    clearBlacklist(peerId: string): void;
    /**
     * Return a diagnostic snapshot of all known peers.
     */
    getAll(): Array<{
        peerId: string;
        score: number;
        blacklisted: boolean;
        permanent: boolean;
    }>;
    private getOrCreate;
    /**
     * Apply exponential decay toward 0: score *= 0.5^(elapsed / half_life).
     * Only adjusts scores with magnitude > 0.01 to avoid infinite loops.
     */
    private applyDecay;
}
//# sourceMappingURL=reputation.d.ts.map
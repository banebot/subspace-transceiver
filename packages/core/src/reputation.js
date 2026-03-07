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
const SCORE_DELTA = {
    VALID_CONTENT: 1,
    INVALID_CONTENT: -10,
    RATE_LIMIT_VIOLATION: -5,
    SIGNATURE_FAILURE: -20,
    OVERSIZED_CONTENT: -8,
};
export class ReputationStore {
    /** Half-life for score decay: 24 hours */
    static HALF_LIFE_MS = 24 * 60 * 60 * 1000;
    static STOP_REPLICATION_THRESHOLD = -50;
    static TEMP_BLACKLIST_THRESHOLD = -100;
    static PERM_BLACKLIST_THRESHOLD = -200;
    peers = new Map();
    /**
     * Record a scored event for a peer.
     * Applies decay first, then applies the delta, then checks thresholds.
     */
    record(peerId, event) {
        const rec = this.getOrCreate(peerId);
        this.applyDecay(rec);
        rec.score += SCORE_DELTA[event];
        rec.lastUpdated = Date.now();
        if (!rec.isPermanentlyBlacklisted) {
            if (rec.score < ReputationStore.PERM_BLACKLIST_THRESHOLD) {
                rec.isPermanentlyBlacklisted = true;
                console.warn(`[subspace] Peer ${peerId} permanently blacklisted (score: ${rec.score.toFixed(1)})`);
            }
            else if (rec.score < ReputationStore.TEMP_BLACKLIST_THRESHOLD && rec.blacklistedUntil === 0) {
                rec.blacklistedUntil = Date.now() + 60 * 60 * 1000; // 1 hour
                console.warn(`[subspace] Peer ${peerId} temp-blacklisted for 1 hour (score: ${rec.score.toFixed(1)})`);
            }
        }
    }
    /**
     * Get the current (decay-adjusted) score for a peer.
     * Unknown peers return 0.
     */
    getScore(peerId) {
        const rec = this.peers.get(peerId);
        if (!rec)
            return 0;
        this.applyDecay(rec);
        return rec.score;
    }
    /**
     * Returns true if the peer is blacklisted (temporary or permanent).
     */
    isBlacklisted(peerId) {
        const rec = this.peers.get(peerId);
        if (!rec)
            return false;
        if (rec.isPermanentlyBlacklisted)
            return true;
        if (rec.blacklistedUntil > 0) {
            if (Date.now() < rec.blacklistedUntil)
                return true;
            rec.blacklistedUntil = 0; // Expired
        }
        return false;
    }
    /**
     * Returns true if we should stop replicating content from this peer,
     * but not disconnect (score between STOP_REPLICATION and TEMP_BLACKLIST).
     */
    shouldStopReplicating(peerId) {
        const score = this.getScore(peerId);
        return score < ReputationStore.STOP_REPLICATION_THRESHOLD;
    }
    /**
     * Manually clear blacklist and reset score for a peer.
     * Use for operator-initiated forgiveness.
     */
    clearBlacklist(peerId) {
        const rec = this.peers.get(peerId);
        if (rec) {
            rec.isPermanentlyBlacklisted = false;
            rec.blacklistedUntil = 0;
            rec.score = 0;
            rec.lastUpdated = Date.now();
        }
    }
    /**
     * Return a diagnostic snapshot of all known peers.
     */
    getAll() {
        return [...this.peers.entries()].map(([peerId, rec]) => {
            this.applyDecay(rec);
            return {
                peerId,
                score: Math.round(rec.score * 10) / 10,
                blacklisted: this.isBlacklisted(peerId),
                permanent: rec.isPermanentlyBlacklisted,
            };
        });
    }
    getOrCreate(peerId) {
        if (!this.peers.has(peerId)) {
            this.peers.set(peerId, {
                score: 0,
                lastUpdated: Date.now(),
                blacklistedUntil: 0,
                isPermanentlyBlacklisted: false,
            });
        }
        return this.peers.get(peerId);
    }
    /**
     * Apply exponential decay toward 0: score *= 0.5^(elapsed / half_life).
     * Only adjusts scores with magnitude > 0.01 to avoid infinite loops.
     */
    applyDecay(rec) {
        if (Math.abs(rec.score) < 0.01) {
            rec.score = 0;
            return;
        }
        const elapsed = Date.now() - rec.lastUpdated;
        if (elapsed < 1000)
            return; // No decay for sub-second intervals
        const decay = Math.pow(0.5, elapsed / ReputationStore.HALF_LIFE_MS);
        rec.score *= decay;
        rec.lastUpdated = Date.now();
    }
}
//# sourceMappingURL=reputation.js.map
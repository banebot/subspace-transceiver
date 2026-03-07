/**
 * Hashcash-style Proof-of-Work stamps for Subspace Transceiver.
 *
 * Design:
 * - Stateless time-windowed challenges (no round-trip needed)
 * - SHA-256 based — Node.js crypto only, no external deps
 * - Stamps accepted for current window AND previous window (clock-skew grace)
 * - Mining yields to the event loop every 10,000 iterations (non-blocking)
 *
 * Challenge = SHA-256(peerId + ":" + scope + ":" + windowIndex)
 * Stamp hash = SHA-256(challenge + nonce) with `bits` leading zero bits
 *
 * Scopes:
 *   "chunk"    — content publishing (20 bits default)
 *   "query"    — query/browse requests (16 bits default)
 *   "manifest" — discovery manifest broadcasts (16 bits default)
 */
import { createHash } from 'node:crypto';
export const DEFAULT_POW_WINDOW_MS = 3_600_000; // 1 hour
export const DEFAULT_POW_BITS_CHUNKS = 20;
export const DEFAULT_POW_BITS_REQUESTS = 16;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/** Compute the integer window index for the current time. */
function windowIndex(windowMs) {
    return Math.floor(Date.now() / windowMs);
}
/**
 * Compute a deterministic challenge string.
 * @param windowIdx - explicit window index (for testing / multi-window checks)
 */
export function currentChallenge(peerId, scope, windowMs = DEFAULT_POW_WINDOW_MS, windowIdx) {
    const idx = windowIdx ?? windowIndex(windowMs);
    return createHash('sha256')
        .update(`${peerId}:${scope}:${idx}`)
        .digest('hex');
}
/**
 * Check whether a hex SHA-256 digest has at least `bits` leading zero bits.
 */
function hasLeadingZeroBits(hexHash, bits) {
    // Each hex character covers 4 bits.
    const fullNibbles = Math.floor(bits / 4);
    const remainder = bits % 4;
    for (let i = 0; i < fullNibbles; i++) {
        if (hexHash[i] !== '0')
            return false;
    }
    if (remainder > 0) {
        const nibble = parseInt(hexHash[fullNibbles], 16);
        // Mask selects the top `remainder` bits of the nibble.
        const mask = 0xf & (0xf << (4 - remainder));
        if ((nibble & mask) !== 0)
            return false;
    }
    return true;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Mine a hashcash stamp for the given peerId, scope, and difficulty.
 *
 * - Runs in a tight loop, yielding to the event loop every 10,000 iterations
 *   so it does not block other I/O while mining.
 * - At 20 bits: ~30ms on modern hardware.
 * - At 16 bits: ~2ms.
 */
export async function mineStamp(peerId, scope, bits, windowMs = DEFAULT_POW_WINDOW_MS) {
    const challenge = currentChallenge(peerId, scope, windowMs);
    let nonce = 0;
    while (true) {
        const nonceHex = nonce.toString(16);
        const hash = createHash('sha256')
            .update(challenge + nonceHex)
            .digest('hex');
        if (hasLeadingZeroBits(hash, bits)) {
            return { bits, challenge, nonce: nonceHex, hash };
        }
        nonce++;
        // Yield to the event loop every 10,000 iterations (cooperative multitasking)
        if (nonce % 10_000 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
}
/**
 * Verify a hashcash stamp.
 *
 * - Accepts stamps for the current window AND the previous window (clock-skew grace).
 * - Verifies that stamp.hash is the actual SHA-256 of (challenge + nonce).
 * - Verifies that stamp.hash has at least `bits` leading zero bits.
 * - Verifies that stamp.challenge matches the expected challenge for this peer/scope/window.
 *
 * Returns `false` on any validation failure (does not throw).
 */
export function verifyStamp(stamp, peerId, scope, bits, windowMs = DEFAULT_POW_WINDOW_MS) {
    // 1. Stamp must claim at least the required difficulty.
    if (stamp.bits < bits)
        return false;
    // 2. Recompute the hash to verify the nonce/hash claim.
    const expectedHash = createHash('sha256')
        .update(stamp.challenge + stamp.nonce)
        .digest('hex');
    if (expectedHash !== stamp.hash)
        return false;
    // 3. Hash must actually have the required leading zero bits.
    if (!hasLeadingZeroBits(stamp.hash, bits))
        return false;
    // 4. Challenge must match current OR previous time window.
    const idx = windowIndex(windowMs);
    const challengeCurrent = currentChallenge(peerId, scope, windowMs, idx);
    const challengePrev = currentChallenge(peerId, scope, windowMs, idx - 1);
    return stamp.challenge === challengeCurrent || stamp.challenge === challengePrev;
}
/**
 * A per-daemon stamp cache that avoids re-mining every request.
 * Key: `${scope}:${bits}:${windowMs}`
 *
 * A stamp is reused until the time window rolls over, then re-mined.
 * This means ~30ms spent once per hour for chunks, ~2ms for requests.
 */
export class StampCache {
    cache = new Map();
    cacheKey(scope, bits, windowMs) {
        return `${scope}:${bits}:${windowMs}`;
    }
    currentWindowIndex(windowMs) {
        return Math.floor(Date.now() / windowMs);
    }
    /** Retrieve a cached stamp if still valid for the current window. */
    get(scope, bits, windowMs) {
        const key = this.cacheKey(scope, bits, windowMs);
        const entry = this.cache.get(key);
        if (!entry)
            return null;
        if (entry.windowIndex !== this.currentWindowIndex(windowMs))
            return null;
        return entry;
    }
    /** Store a freshly mined stamp in the cache. */
    set(scope, bits, windowMs, stamp, mineTimeMs) {
        const key = this.cacheKey(scope, bits, windowMs);
        this.cache.set(key, {
            stamp,
            windowIndex: this.currentWindowIndex(windowMs),
            bits,
            windowMs,
            minedAt: Date.now(),
            mineTimeMs,
        });
    }
    /**
     * Get a valid stamp for this scope — from cache if possible, mining otherwise.
     */
    async getOrMine(peerId, scope, bits, windowMs = DEFAULT_POW_WINDOW_MS) {
        const cached = this.get(scope, bits, windowMs);
        if (cached)
            return cached.stamp;
        const start = Date.now();
        const stamp = await mineStamp(peerId, scope, bits, windowMs);
        const mineTimeMs = Date.now() - start;
        this.set(scope, bits, windowMs, stamp, mineTimeMs);
        return stamp;
    }
    /** Return all current cache entries (for diagnostics). */
    getAll() {
        return [...this.cache.values()];
    }
    /** Clear the entire cache (e.g. after config change). */
    clear() {
        this.cache.clear();
    }
}
//# sourceMappingURL=pow.js.map
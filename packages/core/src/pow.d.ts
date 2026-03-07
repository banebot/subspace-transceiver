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
export interface HashcashStamp {
    /** Number of required leading zero bits in the hash output */
    bits: number;
    /** Challenge string (hex SHA-256 of peerId + scope + windowIndex) */
    challenge: string;
    /** Nonce (hex counter string) that produces the winning hash */
    nonce: string;
    /** Winning SHA-256 hash (hex) — cached to avoid recomputation on verify */
    hash: string;
}
export type PowScope = 'chunk' | 'query' | 'manifest';
export declare const DEFAULT_POW_WINDOW_MS = 3600000;
export declare const DEFAULT_POW_BITS_CHUNKS = 20;
export declare const DEFAULT_POW_BITS_REQUESTS = 16;
/**
 * Compute a deterministic challenge string.
 * @param windowIdx - explicit window index (for testing / multi-window checks)
 */
export declare function currentChallenge(peerId: string, scope: string, windowMs?: number, windowIdx?: number): string;
/**
 * Mine a hashcash stamp for the given peerId, scope, and difficulty.
 *
 * - Runs in a tight loop, yielding to the event loop every 10,000 iterations
 *   so it does not block other I/O while mining.
 * - At 20 bits: ~30ms on modern hardware.
 * - At 16 bits: ~2ms.
 */
export declare function mineStamp(peerId: string, scope: string, bits: number, windowMs?: number): Promise<HashcashStamp>;
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
export declare function verifyStamp(stamp: HashcashStamp, peerId: string, scope: string, bits: number, windowMs?: number): boolean;
/**
 * A cache entry holding one solved stamp.
 * The stamp is valid until the time window rolls over.
 */
export interface StampCacheEntry {
    stamp: HashcashStamp;
    /** The window index when this stamp was mined */
    windowIndex: number;
    bits: number;
    windowMs: number;
    /** Epoch ms when this stamp was mined (for diagnostics) */
    minedAt: number;
    /** How long mining took (ms, for diagnostics) */
    mineTimeMs: number;
}
/**
 * A per-daemon stamp cache that avoids re-mining every request.
 * Key: `${scope}:${bits}:${windowMs}`
 *
 * A stamp is reused until the time window rolls over, then re-mined.
 * This means ~30ms spent once per hour for chunks, ~2ms for requests.
 */
export declare class StampCache {
    private cache;
    private cacheKey;
    private currentWindowIndex;
    /** Retrieve a cached stamp if still valid for the current window. */
    get(scope: string, bits: number, windowMs: number): StampCacheEntry | null;
    /** Store a freshly mined stamp in the cache. */
    set(scope: string, bits: number, windowMs: number, stamp: HashcashStamp, mineTimeMs: number): void;
    /**
     * Get a valid stamp for this scope — from cache if possible, mining otherwise.
     */
    getOrMine(peerId: string, scope: string, bits: number, windowMs?: number): Promise<HashcashStamp>;
    /** Return all current cache entries (for diagnostics). */
    getAll(): StampCacheEntry[];
    /** Clear the entire cache (e.g. after config change). */
    clear(): void;
}
//# sourceMappingURL=pow.d.ts.map
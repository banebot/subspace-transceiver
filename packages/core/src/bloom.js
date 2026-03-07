/**
 * Compact Bloom filter for Subspace Transceiver discovery.
 *
 * Used to encode which topics or chunk IDs a peer holds, enabling other
 * peers to test membership with zero network round-trips.
 *
 * PARAMETERS
 * ──────────
 *   m = 2048 bits (256 bytes) — filter bit array size
 *   k = 7 hash functions
 *
 * CAPACITY / FALSE POSITIVE RATE
 *   n=100  items → FPR ≈ 0.008  (0.8%)
 *   n=200  items → FPR ≈ 0.10   (10%)   ← topic bloom (acceptable)
 *   n=50   items → FPR ≈ 0.0004 (0.04%) ← ideal range
 *
 * For networks with >200 topics, the caller should use ScaledBloomFilter
 * which doubles m when the count exceeds the threshold.
 *
 * HASH FUNCTION
 * ─────────────
 * Uses a Fowler-Noll-Vo (FNV-1a) variant with per-hash seed mixing via
 * Knuth multiplicative hashing. Zero external dependencies — pure Node.js.
 *
 * WIRE FORMAT
 * ───────────
 * Bloom filters are serialized as base64 strings for GossipSub transport.
 * A full filter is 256 bytes → 344 base64 chars — well within message limits.
 */
const BLOOM_BITS = 2048;
const BLOOM_BYTES = BLOOM_BITS / 8; // 256 bytes
const BLOOM_HASHES = 7;
/**
 * FNV-1a hash with seed mixing for Bloom filter hash functions.
 * Returns a bit position in [0, BLOOM_BITS).
 */
function bloomHash(item, seed) {
    // FNV-1a basis XOR'd with seed for domain separation between hash functions
    let hash = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < item.length; i++) {
        hash = (hash ^ item.charCodeAt(i)) >>> 0;
        // FNV prime = 16777619 (0x01000193)
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % BLOOM_BITS;
}
// Knuth's multiplicative constant for seed variation across hash functions
const SEED_STEP = 0x9e3779b9;
export class BloomFilter {
    bits;
    constructor(existing) {
        if (existing) {
            this.bits = new Uint8Array(existing);
        }
        else {
            this.bits = new Uint8Array(BLOOM_BYTES);
        }
    }
    /**
     * Add an item to the filter.
     */
    add(item) {
        for (let i = 0; i < BLOOM_HASHES; i++) {
            const bit = bloomHash(item, (i * SEED_STEP) >>> 0);
            this.bits[bit >>> 3] |= 1 << (bit & 7);
        }
    }
    /**
     * Test membership. Returns:
     *   true  — item PROBABLY in the set (false positives possible)
     *   false — item DEFINITELY not in the set
     */
    has(item) {
        for (let i = 0; i < BLOOM_HASHES; i++) {
            const bit = bloomHash(item, (i * SEED_STEP) >>> 0);
            if (!(this.bits[bit >>> 3] & (1 << (bit & 7))))
                return false;
        }
        return true;
    }
    /**
     * Merge another filter into this one (bitwise OR).
     * Enables union of multiple peer filters without re-hashing items.
     */
    merge(other) {
        for (let i = 0; i < BLOOM_BYTES; i++) {
            this.bits[i] |= other.bits[i];
        }
    }
    /**
     * Approximate count of items in the filter using the formula:
     *   n ≈ -(m/k) * ln(1 - X/m)
     * where X = number of set bits.
     */
    approximateCount() {
        let setBits = 0;
        for (let i = 0; i < BLOOM_BYTES; i++) {
            let b = this.bits[i];
            while (b) {
                setBits += b & 1;
                b >>>= 1;
            }
        }
        if (setBits === BLOOM_BITS)
            return Infinity; // Saturated
        return -((BLOOM_BITS / BLOOM_HASHES) * Math.log(1 - setBits / BLOOM_BITS));
    }
    toBuffer() {
        return Buffer.from(this.bits);
    }
    toBase64() {
        return this.toBuffer().toString('base64');
    }
    static fromBuffer(buf) {
        return new BloomFilter(buf);
    }
    static fromBase64(b64) {
        return BloomFilter.fromBuffer(Buffer.from(b64, 'base64'));
    }
    /**
     * Build a BloomFilter from an array of items in one pass.
     */
    static from(items) {
        const f = new BloomFilter();
        for (const item of items)
            f.add(item);
        return f;
    }
    /**
     * Byte size of this filter (always BLOOM_BYTES = 256).
     */
    get byteSize() {
        return BLOOM_BYTES;
    }
}
//# sourceMappingURL=bloom.js.map
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
export declare class BloomFilter {
    private readonly bits;
    constructor(existing?: Uint8Array | Buffer);
    /**
     * Add an item to the filter.
     */
    add(item: string): void;
    /**
     * Test membership. Returns:
     *   true  — item PROBABLY in the set (false positives possible)
     *   false — item DEFINITELY not in the set
     */
    has(item: string): boolean;
    /**
     * Merge another filter into this one (bitwise OR).
     * Enables union of multiple peer filters without re-hashing items.
     */
    merge(other: BloomFilter): void;
    /**
     * Approximate count of items in the filter using the formula:
     *   n ≈ -(m/k) * ln(1 - X/m)
     * where X = number of set bits.
     */
    approximateCount(): number;
    toBuffer(): Buffer;
    toBase64(): string;
    static fromBuffer(buf: Buffer | Uint8Array): BloomFilter;
    static fromBase64(b64: string): BloomFilter;
    /**
     * Build a BloomFilter from an array of items in one pass.
     */
    static from(items: string[]): BloomFilter;
    /**
     * Byte size of this filter (always BLOOM_BYTES = 256).
     */
    get byteSize(): number;
}
//# sourceMappingURL=bloom.d.ts.map
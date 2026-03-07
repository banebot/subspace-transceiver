/**
 * Cryptographic primitives for Subspace Transceiver.
 *
 * ALL key derivation flows through deriveNetworkKeys().
 * ALL symmetric encryption uses encryptEnvelope() / decryptEnvelope().
 * Zero external crypto dependencies — Node.js built-ins only.
 *
 * HKDF salt is intentionally zero-filled (32 bytes of 0x00).
 * Rationale: the PSK is the sole entropy source. Using a zero salt with
 * HKDF-SHA256 is standard practice when the IKM (PSK) is itself a
 * high-entropy secret. The distinct `info` strings for each derived key
 * guarantee domain separation without requiring a non-zero salt.
 */
export interface NetworkKeys {
    /** 32 bytes — DHT announcement key (peers publish presence here) */
    dhtKey: Buffer;
    /** hex string — GossipSub topic name (OrbitDB replication channel) */
    topic: string;
    /** 32 bytes — AES-256-GCM symmetric key for message envelope encryption */
    envelopeKey: Buffer;
    /**
     * @deprecated pskFilter is no longer used for libp2p private-network filtering.
     * Kept for backward-compatibility with callers that reference this field.
     * The pnet connection filter has been removed because it blocks public relay
     * nodes (DCUtR/circuit-relay cannot connect through relays that lack our PSK).
     * Network isolation is now enforced via GossipSub topic (derived from PSK) +
     * AES-256-GCM envelope encryption on content fields.
     */
    pskFilter: Buffer;
    /** 32 bytes — deterministic peer identity seed (stable peer ID across restarts) */
    peerId: Buffer;
}
export interface EncryptedEnvelope {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
}
/**
 * Validate a PSK string before deriving network keys.
 * Throws CryptoError with PSK_TOO_SHORT if psk.length < 16.
 * Logs a warning (does not throw) if psk.length < 32.
 *
 * Recommendation: generate a PSK with `openssl rand -hex 32` (64 hex chars).
 */
export declare function validatePSK(psk: string): void;
/**
 * Derive all five network keys from a single PSK string using HKDF-SHA256.
 *
 * Call validatePSK() before this if you need user-facing validation errors.
 * This function does NOT call validatePSK() to keep derivation pure/fast.
 *
 * The same PSK always produces the same NetworkKeys — deterministic by design.
 */
export declare function deriveNetworkKeys(psk: string): NetworkKeys;
/**
 * Encrypt a plaintext buffer using AES-256-GCM.
 * A fresh 12-byte random IV is generated for each call.
 * Returns ciphertext, IV, and authentication tag — all required for decryption.
 */
export declare function encryptEnvelope(plaintext: Buffer, key: Buffer): EncryptedEnvelope;
/**
 * Decrypt an AES-256-GCM encrypted envelope.
 * Throws CryptoError with DECRYPT_FAILED if authentication fails (tampered data or wrong key).
 */
export declare function decryptEnvelope(ciphertext: Buffer, iv: Buffer, tag: Buffer, key: Buffer): Buffer;
//# sourceMappingURL=crypto.d.ts.map
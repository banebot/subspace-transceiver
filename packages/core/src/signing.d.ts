/**
 * Ed25519 chunk signing and verification for Subspace Transceiver.
 *
 * Every chunk published to the network SHOULD carry a signature. The
 * signature proves that the holder of the private key corresponding to
 * `source.peerId` authored the chunk. This is the primary defense against
 * Sybil attacks — you cannot forge content as another agent without their
 * private key.
 *
 * CANONICAL BYTES
 * ───────────────
 * Signing operates on the canonical JSON representation of the chunk:
 *   - The `signature` field is excluded from the input.
 *   - All top-level keys are sorted lexicographically.
 *   - Encoded as UTF-8.
 *
 * This ensures the signature is deterministic regardless of insertion order.
 *
 * VERIFICATION
 * ────────────
 * Verification requires the signer's public key. Since libp2p PeerIds embed
 * the public key (Ed25519 PeerIds ARE the public key), the verifier can
 * derive the public key from `source.peerId` using peerIdFromString().
 *
 * BACKWARD COMPATIBILITY
 * ──────────────────────
 * `signature` is optional on MemoryChunk. Chunks without a signature are
 * treated as "unverified" — the daemon logs a warning but does not reject
 * them unless `security.requireSignatures: true` is set in config.
 */
import type { PrivateKey, PublicKey } from '@libp2p/interface';
import type { MemoryChunk } from './schema.js';
/**
 * Compute the canonical byte representation of a chunk for signing/verification.
 *
 * Excludes the `signature` field. Top-level keys are sorted to ensure
 * determinism across different serialization orders.
 */
export declare function canonicalChunkBytes(chunk: MemoryChunk): Uint8Array;
/**
 * Sign a chunk with an Ed25519 private key.
 *
 * Returns a new chunk object (does not mutate the original) with the
 * `signature` field set to a base64-encoded Ed25519 signature.
 */
export declare function signChunk(chunk: MemoryChunk, privateKey: PrivateKey): Promise<MemoryChunk>;
/**
 * Verify a chunk's Ed25519 signature against a public key.
 *
 * Returns `true` if the signature is valid, `false` if absent or invalid.
 * Never throws — all errors map to `false`.
 */
export declare function verifyChunkSignature(chunk: MemoryChunk, publicKey: PublicKey): Promise<boolean>;
//# sourceMappingURL=signing.d.ts.map
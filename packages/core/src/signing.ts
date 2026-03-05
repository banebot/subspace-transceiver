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

import type { PrivateKey, PublicKey } from '@libp2p/interface'
import type { MemoryChunk } from './schema.js'

const encoder = new TextEncoder()

/**
 * Compute the canonical byte representation of a chunk for signing/verification.
 *
 * Excludes the `signature` field. Top-level keys are sorted to ensure
 * determinism across different serialization orders.
 */
export function canonicalChunkBytes(chunk: MemoryChunk): Uint8Array {
  // Destructure out signature so it's never included in the signed payload
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _sig, ...rest } = chunk as MemoryChunk & { signature?: string }
  const sorted = sortObjectKeys(rest)
  return encoder.encode(JSON.stringify(sorted))
}

/**
 * Recursively sort object keys for deterministic JSON serialization.
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortObjectKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * Sign a chunk with an Ed25519 private key.
 *
 * Returns a new chunk object (does not mutate the original) with the
 * `signature` field set to a base64-encoded Ed25519 signature.
 */
export async function signChunk(
  chunk: MemoryChunk,
  privateKey: PrivateKey
): Promise<MemoryChunk> {
  const data = canonicalChunkBytes(chunk)
  const sigBytes = await privateKey.sign(data)
  return { ...chunk, signature: Buffer.from(sigBytes).toString('base64') }
}

/**
 * Verify a chunk's Ed25519 signature against a public key.
 *
 * Returns `true` if the signature is valid, `false` if absent or invalid.
 * Never throws — all errors map to `false`.
 */
export async function verifyChunkSignature(
  chunk: MemoryChunk,
  publicKey: PublicKey
): Promise<boolean> {
  if (!chunk.signature) return false
  try {
    const data = canonicalChunkBytes(chunk)
    const sigBytes = Buffer.from(chunk.signature, 'base64')
    return await publicKey.verify(data, sigBytes)
  } catch {
    return false
  }
}

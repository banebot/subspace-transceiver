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

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { CryptoError, ErrorCode } from './errors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NetworkKeys {
  /** 32 bytes — DHT announcement key (peers publish presence here) */
  dhtKey: Buffer
  /** hex string — GossipSub topic name (OrbitDB replication channel) */
  topic: string
  /** 32 bytes — AES-256-GCM symmetric key for message envelope encryption */
  envelopeKey: Buffer
  /** 32 bytes — libp2p private network PSK (direct connection filter) */
  pskFilter: Buffer
  /** 32 bytes — deterministic peer identity seed (stable peer ID across restarts) */
  peerId: Buffer
}

export interface EncryptedEnvelope {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

// ---------------------------------------------------------------------------
// PSK validation
// ---------------------------------------------------------------------------

/**
 * Validate a PSK string before deriving network keys.
 * Throws CryptoError with PSK_TOO_SHORT if psk.length < 16.
 * Logs a warning (does not throw) if psk.length < 32.
 *
 * Recommendation: generate a PSK with `openssl rand -hex 32` (64 hex chars).
 */
export function validatePSK(psk: string): void {
  if (psk.length < 16) {
    throw new CryptoError(
      `PSK too short: ${psk.length} chars. Minimum is 16. ` +
        'Generate a secure PSK with: openssl rand -hex 32',
      ErrorCode.PSK_TOO_SHORT
    )
  }
  if (psk.length < 32) {
    console.warn(
      `[subspace] WARNING: PSK is only ${psk.length} characters. ` +
        'For production networks, use a PSK of at least 32 characters. ' +
        'Generate one with: openssl rand -hex 32'
    )
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive all five network keys from a single PSK string using HKDF-SHA256.
 *
 * Call validatePSK() before this if you need user-facing validation errors.
 * This function does NOT call validatePSK() to keep derivation pure/fast.
 *
 * The same PSK always produces the same NetworkKeys — deterministic by design.
 */
export function deriveNetworkKeys(psk: string): NetworkKeys {
  const keyMaterial = Buffer.from(psk, 'utf8')
  // Zero salt — PSK is the entropy source. See module JSDoc for rationale.
  const salt = Buffer.alloc(32)

  const derive = (info: string, len: number): Buffer =>
    Buffer.from(hkdfSync('sha256', keyMaterial, salt, Buffer.from(info, 'utf8'), len))

  return {
    dhtKey: derive('subspace/dht-key', 32),
    topic: derive('subspace/topic', 32).toString('hex'),
    envelopeKey: derive('subspace/envelope', 32),
    pskFilter: derive('subspace/psk-filter', 32),
    peerId: derive('subspace/peer-id', 32),
  }
}

// ---------------------------------------------------------------------------
// AES-256-GCM envelope encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext buffer using AES-256-GCM.
 * A fresh 12-byte random IV is generated for each call.
 * Returns ciphertext, IV, and authentication tag — all required for decryption.
 */
export function encryptEnvelope(plaintext: Buffer, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { ciphertext, iv, tag }
}

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 * Throws CryptoError with DECRYPT_FAILED if authentication fails (tampered data or wrong key).
 */
export function decryptEnvelope(
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  key: Buffer
): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (err) {
    throw new CryptoError(
      'Decryption failed — data may be tampered or the key is incorrect.',
      ErrorCode.DECRYPT_FAILED,
      err
    )
  }
}

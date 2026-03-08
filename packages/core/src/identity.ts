/**
 * Persistent per-agent Ed25519 identity for Subspace Transceiver.
 *
 * DESIGN INTENT
 * ─────────────
 * The PSK governs NETWORK ACCESS — who may connect to a libp2p swarm.
 * The identity keypair governs CONTENT AUTHORSHIP — who published what,
 * and provides each node with a unique, stable libp2p PeerId.
 *
 * These are intentionally separate:
 *   - One agent identity can participate in many PSK networks.
 *   - Rotating the PSK does NOT change agent identity or authorship history.
 *
 * DID:KEY (v2)
 * ────────────
 * Each agent identity now exposes a W3C DID:Key string in addition to the
 * libp2p PeerId. DID:Key is a deterministic, self-describing encoding of the
 * Ed25519 public key using multicodec + multibase:
 *
 *   did:key:z6Mk<base58btc(0xed01 || pubkey)>
 *
 * The DID:Key is derived from the same 32-byte seed as the PeerId — no new
 * key material is generated. This is an additive, backward-compatible change.
 *
 * STORAGE
 * ───────
 * The 32-byte Ed25519 seed is stored at <identityPath> (default:
 * ~/.subspace/identity.key) with mode 0o600 (owner-read only).
 * The seed is regenerated once on first run and never changed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { keys } from '@libp2p/crypto'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey, PublicKey } from '@libp2p/interface'
import { base58btc } from 'multiformats/bases/base58'

// ---------------------------------------------------------------------------
// DID:Key constants
// ---------------------------------------------------------------------------

/**
 * Multicodec varint prefix for Ed25519 public keys: 0xed01 (two bytes).
 * Reference: https://github.com/multiformats/multicodec/blob/master/table.csv
 * codec: ed25519-pub, code: 0xed (237 decimal), varint: 0xed 0x01
 */
const ED25519_PUB_CODEC = new Uint8Array([0xed, 0x01])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DEFAULT_IDENTITY_PATH = join(homedir(), '.subspace', 'identity.key')

export interface AgentIdentity {
  /** Ed25519 private key — use for signing chunks and as libp2p node identity */
  privateKey: PrivateKey
  /** libp2p PeerId string (base58btc) derived from privateKey */
  peerId: string
  /**
   * W3C DID:Key string — deterministic encoding of the Ed25519 public key.
   * Format: `did:key:z6Mk<base58btc(0xed01 || pubkey)>`
   * Backward-compatible addition; peerId continues to work unchanged.
   */
  did: string
}

/**
 * W3C DID Document (JSON-LD) for an agent identity.
 * Minimal implementation covering public key, agent URI, and service endpoints.
 */
export interface DIDDocument {
  '@context': string[]
  id: string
  verificationMethod: Array<{
    id: string
    type: string
    controller: string
    publicKeyMultibase: string
  }>
  authentication: string[]
  assertionMethod: string[]
  service?: Array<{
    id: string
    type: string
    serviceEndpoint: string
  }>
}

// ---------------------------------------------------------------------------
// DID:Key derivation utilities
// ---------------------------------------------------------------------------

/**
 * Derive a DID:Key string from an Ed25519 public key.
 *
 * Algorithm:
 * 1. Take the 32-byte raw Ed25519 public key bytes
 * 2. Prepend the multicodec prefix 0xed01 (Ed25519 pub key indicator)
 * 3. Base58btc-encode the prefixed bytes
 * 4. Prefix with 'z' (multibase base58btc prefix)
 * 5. Prefix with 'did:key:'
 *
 * @param pubKey  libp2p PublicKey (Ed25519)
 * @returns       DID:Key string (e.g. `did:key:z6Mk...`)
 */
export function deriveDidKey(pubKey: PublicKey): string {
  const rawPubKey = pubKey.raw  // 32 bytes for Ed25519
  const prefixed = new Uint8Array(ED25519_PUB_CODEC.length + rawPubKey.length)
  prefixed.set(ED25519_PUB_CODEC, 0)
  prefixed.set(rawPubKey, ED25519_PUB_CODEC.length)
  // base58btc.encode produces a string without the 'z' prefix; add it explicitly
  const encoded = base58btc.encode(prefixed)
  return `did:key:${encoded}`
}

/**
 * Extract the 32-byte Ed25519 public key from a DID:Key string.
 *
 * @param did  DID:Key string (e.g. `did:key:z6Mk...`)
 * @returns    32-byte Ed25519 public key
 * @throws     Error if the DID is malformed or uses an unsupported multicodec
 */
export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error(`Invalid DID:Key format (expected 'did:key:z...'): ${did}`)
  }

  // Remove 'did:key:' prefix — leave the multibase-encoded value (starts with 'z')
  const multibaseEncoded = did.slice('did:key:'.length)

  // Decode base58btc (the 'z' prefix is the multibase indicator, included in the string)
  const decoded = base58btc.decode(multibaseEncoded)

  // Validate multicodec prefix
  if (decoded.length < 2 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(
      `Unsupported multicodec in DID:Key (expected Ed25519 0xed01): ${did}`
    )
  }

  // Return the 32-byte public key (after the 2-byte multicodec prefix)
  return decoded.slice(2)
}

/**
 * Check if a string is a valid DID:Key for an Ed25519 key.
 */
export function isValidDidKey(did: string): boolean {
  try {
    publicKeyFromDidKey(did)
    return true
  } catch {
    return false
  }
}

/**
 * Generate a W3C DID Document (JSON-LD) for an agent identity.
 *
 * @param did      DID:Key string
 * @param peerId   libp2p PeerId string (for the agent:// service endpoint)
 * @param port     Optional HTTP port for the daemon API service endpoint
 */
export function generateDIDDocument(
  did: string,
  peerId: string,
  port?: number,
): DIDDocument {
  const verificationMethodId = `${did}#${did.slice('did:key:'.length)}`
  const publicKeyMultibase = did.slice('did:key:'.length)

  const doc: DIDDocument = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: verificationMethodId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase,
      },
    ],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
  }

  // Add service endpoints if we have connection info
  doc.service = [
    {
      id: `${did}#subspace-agent`,
      type: 'SubspaceAgent',
      serviceEndpoint: `agent://${peerId}`,
    },
  ]

  if (port != null) {
    doc.service.push({
      id: `${did}#daemon-api`,
      type: 'SubspaceDaemonAPI',
      serviceEndpoint: `http://localhost:${port}`,
    })
  }

  return doc
}

// ---------------------------------------------------------------------------
// Identity loading
// ---------------------------------------------------------------------------

/**
 * Load the agent's persistent Ed25519 identity from disk, or generate and
 * save a new one if none exists.
 *
 * Idempotent — repeated calls with the same path always return the same identity.
 *
 * @param identityPath  Path to the 32-byte seed file (default: ~/.subspace/identity.key)
 */
export async function loadOrCreateIdentity(
  identityPath: string = DEFAULT_IDENTITY_PATH
): Promise<AgentIdentity> {
  await mkdir(dirname(identityPath), { recursive: true })

  let seed: Buffer

  if (existsSync(identityPath)) {
    seed = await readFile(identityPath)
    if (seed.length !== 32) {
      // Corrupted file — regenerate
      console.warn(
        `[subspace] Identity file at ${identityPath} is corrupt (${seed.length} bytes, expected 32). Regenerating.`
      )
      seed = Buffer.from(randomBytes(32))
      await writeFile(identityPath, seed, { mode: 0o600 })
    }
  } else {
    seed = Buffer.from(randomBytes(32))
    await writeFile(identityPath, seed, { mode: 0o600 })
    console.log(`[subspace] Generated new agent identity. Stored at ${identityPath}`)
  }

  const privateKey = await keys.generateKeyPairFromSeed('Ed25519', seed)
  const peerId = peerIdFromPrivateKey(privateKey).toString()
  const did = deriveDidKey(privateKey.publicKey)

  return { privateKey, peerId, did }
}

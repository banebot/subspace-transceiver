/**
 * ZKP Identity Proofs — Phase 4.1
 *
 * Implements lightweight zero-knowledge-style identity proofs using the
 * agent's existing Ed25519 keypair (from DID:Key identity).
 *
 * Two proof types are provided:
 *
 * 1. **ProofOfKeyOwnership** — Proves control of a DID:Key without revealing
 *    the private key. Uses an EdDSA signature on a challenge+commitment nonce.
 *    This is a sound Schnorr-compatible proof scheme.
 *
 * 2. **VerifiableCredential** — W3C VC-compatible structure carrying agent
 *    capabilities with a selective-disclosure commitment. The holder can
 *    present any subset of claims without revealing the others.
 *
 * Design principles:
 * - Purely optional — agents work without any ZKP features enabled
 * - Uses @libp2p/crypto (already a dependency) for Ed25519 signing
 * - Backward compatible — proofs are additive to existing identity
 * - 100% in-memory — no circuit compilation needed
 *
 * Future (Phase 4.x): Noir circuit for range proofs on reputation scores
 * and set-membership proofs for PSK group membership without identity reveal.
 */

import { createHash, randomBytes } from 'node:crypto'
import { keys } from '@libp2p/crypto'
import type { PrivateKey, PublicKey } from '@libp2p/interface'
import { isValidDidKey, publicKeyFromDidKey } from './identity.js'
import { base58btc } from 'multiformats/bases/base58'

// ── Types ────────────────────────────────────────────────────────────────────

/** A commitment binding a value to a random nonce without revealing the value. */
export interface Commitment {
  /** SHA-256(value || nonce) as hex */
  hash: string
  /** Random nonce as hex — revealed only when opening the commitment */
  nonce?: string
}

/**
 * Proof that the holder controls the private key corresponding to a DID:Key.
 *
 * Scheme:
 *   1. Prover generates random nonce R
 *   2. Prover constructs challenge = SHA-256("ownership" || did || timestamp || R)
 *   3. Prover signs challenge with Ed25519 private key
 *   4. Verifier checks signature against the DID's public key
 */
export interface ProofOfKeyOwnership {
  type: 'ProofOfKeyOwnership'
  /** The DID:Key being proven */
  did: string
  /** ISO timestamp of proof creation */
  issuedAt: string
  /** Expiry timestamp (default: issuedAt + 5 minutes) */
  expiresAt: string
  /** Random nonce (hex) used in the challenge */
  nonce: string
  /** Challenge bytes that were signed (hex) */
  challenge: string
  /** Ed25519 signature over challenge (hex) */
  signature: string
  /** Optional: peer ID for agent:// service binding */
  peerId?: string
  /** Optional: additional context claims */
  context?: Record<string, string>
}

/**
 * Claim within a VerifiableCredential.
 */
export interface Claim {
  /** Claim type (e.g. "memory.read", "CapabilityToken", "ReputationScore") */
  type: string
  /** Claim value */
  value: string
  /** Commitment hash for selective disclosure */
  commitment: string
}

/**
 * W3C VC-compatible Verifiable Credential.
 * The holder can selectively disclose any subset of claims.
 */
export interface VerifiableCredential {
  '@context': ['https://www.w3.org/2018/credentials/v1', 'https://subspace.network/v1']
  type: ['VerifiableCredential', 'SubspaceAgentCredential']
  id: string
  issuer: string
  issuanceDate: string
  expirationDate?: string
  credentialSubject: {
    id: string
    claims: Claim[]
  }
  proof: {
    type: 'Ed25519Signature2020'
    created: string
    verificationMethod: string
    proofValue: string
  }
}

/**
 * Selective presentation of a subset of VC claims.
 */
export interface CredentialPresentation {
  type: 'CredentialPresentation'
  credentialId: string
  holderDid: string
  /** Subset of claims being revealed, with their nonces for verification */
  revealedClaims: Array<{ claim: Claim; nonce: string }>
  /** Commitments for unrevealed claims (order-preserving) */
  hiddenCommitments: string[]
  /** Proof of key ownership (proves holder controls the DID) */
  ownershipProof: ProofOfKeyOwnership
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256hex(...parts: (string | Uint8Array)[]): string {
  const hash = createHash('sha256')
  for (const p of parts) {
    if (typeof p === 'string') {
      hash.update(p, 'utf8')
    } else {
      hash.update(p)
    }
  }
  return hash.digest('hex')
}

function sha256bytes(...parts: (string | Uint8Array)[]): Buffer {
  const hash = createHash('sha256')
  for (const p of parts) {
    if (typeof p === 'string') {
      hash.update(p, 'utf8')
    } else {
      hash.update(p)
    }
  }
  return hash.digest()
}

// ── Proof Generation ─────────────────────────────────────────────────────────

const OWNERSHIP_DOMAIN = 'subspace:ownership:v1'
const PROOF_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Generate a ProofOfKeyOwnership for a DID:Key.
 *
 * @param did         DID:Key string (did:key:z...)
 * @param privateKey  Libp2p PrivateKey (Ed25519)
 * @param options     Optional context and TTL overrides
 */
export async function generateOwnershipProof(
  did: string,
  privateKey: PrivateKey,
  options: {
    ttlMs?: number
    peerId?: string
    context?: Record<string, string>
  } = {}
): Promise<ProofOfKeyOwnership> {
  if (!isValidDidKey(did)) {
    throw new Error(`Invalid DID:Key format: ${did}`)
  }

  const now = Date.now()
  const ttl = options.ttlMs ?? PROOF_TTL_MS
  const issuedAt = new Date(now).toISOString()
  const expiresAt = new Date(now + ttl).toISOString()

  // Generate random nonce (32 bytes → 64 hex chars)
  const nonceBytes = randomBytes(32)
  const nonce = nonceBytes.toString('hex')

  // Build challenge: domain || did || timestamp || nonce
  const challengeBytes = sha256bytes(OWNERSHIP_DOMAIN, did, issuedAt, nonce)
  const challengeHex = challengeBytes.toString('hex')

  // Sign with Ed25519 private key
  const signatureBytes = await privateKey.sign(challengeBytes)
  const signatureHex = Buffer.from(signatureBytes).toString('hex')

  return {
    type: 'ProofOfKeyOwnership',
    did,
    issuedAt,
    expiresAt,
    nonce,
    challenge: challengeHex,
    signature: signatureHex,
    ...(options.peerId && { peerId: options.peerId }),
    ...(options.context && { context: options.context }),
  }
}

/**
 * Verify a ProofOfKeyOwnership.
 *
 * @returns `true` if the proof is valid and not expired
 */
export async function verifyOwnershipProof(proof: ProofOfKeyOwnership): Promise<boolean> {
  if (proof.type !== 'ProofOfKeyOwnership') return false

  // Check expiry
  if (Date.now() > new Date(proof.expiresAt).getTime()) return false

  // Extract raw Ed25519 public key from DID
  let rawPubKey: Uint8Array
  try {
    rawPubKey = publicKeyFromDidKey(proof.did)
  } catch {
    return false
  }

  // Reconstruct the challenge
  const expectedChallenge = sha256bytes(
    OWNERSHIP_DOMAIN,
    proof.did,
    proof.issuedAt,
    proof.nonce
  )
  const expectedChallengeHex = expectedChallenge.toString('hex')

  // Verify challenge matches what was signed
  if (expectedChallengeHex !== proof.challenge) return false

  // Verify signature using @libp2p/crypto's Ed25519 verifier
  try {
    const sigBytes = Buffer.from(proof.signature, 'hex')
    // Reconstruct the public key from raw bytes via libp2p/crypto
    const pubKey = keys.publicKeyFromRaw(rawPubKey)
    return pubKey.verify(expectedChallenge, sigBytes)
  } catch {
    return false
  }
}

// ── Verifiable Credentials ────────────────────────────────────────────────────

/** Create a commitment for a claim value with a random nonce. */
function commitClaim(type: string, value: string): { commitmentHash: string; nonce: string } {
  const nonce = randomBytes(32).toString('hex')
  const commitmentHash = sha256hex(`${type}:${value}:${nonce}`)
  return { commitmentHash, nonce }
}

/**
 * Issue a Verifiable Credential for an agent.
 *
 * @param issuerDid    DID:Key of the issuer (may be the agent itself for self-signed VCs)
 * @param issuerKey    Libp2p PrivateKey of the issuer
 * @param subjectDid   DID:Key of the credential subject
 * @param claimsInput  Array of {type, value} claims to include
 * @param options      Optional expiration and ID overrides
 */
export async function issueCredential(
  issuerDid: string,
  issuerKey: PrivateKey,
  subjectDid: string,
  claimsInput: Array<{ type: string; value: string }>,
  options: { expirationDate?: string; id?: string } = {}
): Promise<{ credential: VerifiableCredential; nonces: Record<string, string> }> {
  const now = new Date().toISOString()
  const id =
    options.id ??
    `urn:subspace:vc:${randomBytes(16).toString('hex')}`

  // Build claims with commitments
  const nonces: Record<string, string> = {}
  const claims: Claim[] = claimsInput.map(({ type, value }) => {
    const { commitmentHash, nonce } = commitClaim(type, value)
    nonces[type] = nonce
    return { type, value, commitment: commitmentHash }
  })

  // Build credential body (without proof) to sign
  const credentialBody = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://subspace.network/v1'] as const,
    type: ['VerifiableCredential', 'SubspaceAgentCredential'] as const,
    id,
    issuer: issuerDid,
    issuanceDate: now,
    ...(options.expirationDate && { expirationDate: options.expirationDate }),
    credentialSubject: { id: subjectDid, claims },
  }

  // Sign the credential body
  const bodyBytes = Buffer.from(JSON.stringify(credentialBody), 'utf8')
  const bodyHash = sha256bytes(bodyBytes)
  const signatureBytes = await issuerKey.sign(bodyHash)

  const credential: VerifiableCredential = {
    '@context': [...credentialBody['@context']] as unknown as VerifiableCredential['@context'],
    type: [...credentialBody.type] as unknown as VerifiableCredential['type'],
    id: credentialBody.id,
    issuer: credentialBody.issuer,
    issuanceDate: credentialBody.issuanceDate,
    ...(options.expirationDate && { expirationDate: options.expirationDate }),
    credentialSubject: credentialBody.credentialSubject,
    proof: {
      type: 'Ed25519Signature2020' as const,
      created: now,
      verificationMethod: `${issuerDid}#${issuerDid.slice('did:key:'.length)}`,
      proofValue: Buffer.from(signatureBytes).toString('hex'),
    },
  }

  return { credential, nonces }
}

/**
 * Verify a VerifiableCredential's proof.
 *
 * @returns `true` if the signature is valid
 */
export async function verifyCredential(credential: VerifiableCredential): Promise<boolean> {
  // Extract public key from issuer DID
  let rawPubKey: Uint8Array
  try {
    rawPubKey = publicKeyFromDidKey(credential.issuer)
  } catch {
    return false
  }

  // Reconstruct the body that was signed
  const { proof, ...credentialBody } = credential
  const bodyBytes = Buffer.from(JSON.stringify(credentialBody), 'utf8')
  const bodyHash = sha256bytes(bodyBytes)

  try {
    const sigBytes = Buffer.from(proof.proofValue, 'hex')
    const pubKey = keys.publicKeyFromRaw(rawPubKey)
    return pubKey.verify(bodyHash, sigBytes)
  } catch {
    return false
  }
}

/**
 * Create a selective presentation revealing a subset of VC claims.
 *
 * @param credential      The full VerifiableCredential
 * @param nonces          Map of claim type → nonce (from issueCredential)
 * @param revealTypes     Which claim types to reveal (others are hidden)
 * @param holderDid       DID of the holder
 * @param holderKey       Libp2p PrivateKey of the holder
 */
export async function createPresentation(
  credential: VerifiableCredential,
  nonces: Record<string, string>,
  revealTypes: string[],
  holderDid: string,
  holderKey: PrivateKey
): Promise<CredentialPresentation> {
  const allClaims = credential.credentialSubject.claims
  const revealSet = new Set(revealTypes)

  const revealedClaims: CredentialPresentation['revealedClaims'] = []
  const hiddenCommitments: string[] = []

  for (const claim of allClaims) {
    if (revealSet.has(claim.type)) {
      const nonce = nonces[claim.type]
      if (!nonce) throw new Error(`Missing nonce for claim type: ${claim.type}`)
      revealedClaims.push({ claim, nonce })
    } else {
      hiddenCommitments.push(claim.commitment)
    }
  }

  const ownershipProof = await generateOwnershipProof(holderDid, holderKey, {
    context: { credentialId: credential.id },
  })

  return {
    type: 'CredentialPresentation',
    credentialId: credential.id,
    holderDid,
    revealedClaims,
    hiddenCommitments,
    ownershipProof,
  }
}

/**
 * Verify a selective presentation.
 *
 * Checks:
 * 1. The ownership proof is valid (holder controls the DID)
 * 2. All revealed claims match their commitments
 */
export async function verifyPresentation(
  presentation: CredentialPresentation
): Promise<boolean> {
  // 1. Verify key ownership
  const ownershipValid = await verifyOwnershipProof(presentation.ownershipProof)
  if (!ownershipValid) return false

  // 2. Verify all revealed claims match their commitments
  for (const { claim, nonce } of presentation.revealedClaims) {
    const expectedHash = sha256hex(`${claim.type}:${claim.value}:${nonce}`)
    if (expectedHash !== claim.commitment) return false
  }

  return true
}

// ── Convenience: self-signed credential for capability advertisement ──────────

/**
 * Issue a self-signed capability credential for an agent.
 * Used in ANP capability negotiation to advertise verifiable capabilities.
 *
 * @param did         Agent DID:Key
 * @param privateKey  Agent PrivateKey
 * @param capabilities  List of capability IDs the agent supports
 */
export async function issueCapabilityCredential(
  did: string,
  privateKey: PrivateKey,
  capabilities: string[]
): Promise<{ credential: VerifiableCredential; nonces: Record<string, string> }> {
  return issueCredential(
    did,
    privateKey,
    did,
    capabilities.map(cap => ({ type: 'capability', value: cap })),
    {
      expirationDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }
  )
}

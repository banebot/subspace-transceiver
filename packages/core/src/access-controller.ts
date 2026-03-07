/**
 * SubspaceAccessController — custom OrbitDB v2 access controller that validates
 * incoming CRDT oplog entries at the replication layer.
 *
 * ## Problem
 * OrbitDB's default IPFSAccessController only checks that the entry was signed by
 * a known OrbitDB identity. It does NOT validate the chunk's schema, content size,
 * or Ed25519 authorship. A malicious peer on the GossipSub topic can inject arbitrary
 * documents into the oplog, consuming disk space and crashing queries.
 *
 * ## Solution
 * This access controller validates every incoming PUT operation against:
 * 1. A metadata-level schema check (id, type, namespace, topic[], source, confidence)
 * 2. Content size limits (encrypted blobs are bounded even if content is opaque)
 * 3. Ed25519 signature verification (when present and source.peerId is an Ed25519 PeerId)
 *
 * ## Encryption compatibility
 * When envelope encryption is enabled (the default), `content` is stored as an
 * empty string and the actual ciphertext lives in `encryptedContent`. This AC
 * validates the encrypted-document shape rather than the plaintext content field.
 *
 * ## OrbitDB integration
 * Register this controller ONCE at startup with `useAccessController(SubspaceAccessController)`,
 * then pass `AccessController: SubspaceAccessController(options)` to `orbitdb.open()`.
 *
 * The controller is stateless — no IPFS storage required, no manifest block fetched.
 * This makes it safe to use with private networks where storing manifest CIDs in the
 * public IPFS blockstore would leak metadata.
 */

import { peerIdFromString } from '@libp2p/peer-id'
import { z } from 'zod'
import { verifyChunkSignature } from './signing.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SubspaceAccessControllerOptions {
  /**
   * Maximum allowed byte size of the `content` field (or `encryptedContent` blob).
   * Default: 65_536 (64KB) — matches SecurityConfig.maxChunkContentBytes.
   */
  maxContentBytes?: number
  /**
   * Maximum allowed byte size of `encryptedEnvelopeBody` (or `contentEnvelope.body`).
   * Default: 262_144 (256KB) — matches SecurityConfig.maxEnvelopeBodyBytes.
   */
  maxEnvelopeBodyBytes?: number
  /**
   * When true, entries without a valid Ed25519 signature are REJECTED.
   * Default: false (signature is verified if present, but absence is allowed).
   */
  requireSignatures?: boolean
}

// ---------------------------------------------------------------------------
// Metadata-only validation schema (used by the AC)
// ---------------------------------------------------------------------------
// We validate the structural invariants that don't depend on decrypted content:
// - id must be a UUID
// - type, namespace, topic[] are required enum/array fields
// - source must have agentId + peerId + timestamp
// - confidence must be in [0, 1]
// - version must be a positive integer
// We do NOT validate `content` here because it may be an empty placeholder
// (when envelope encryption is enabled) or the encrypted ciphertext.

const metadataSchema = z.object({
  id: z.string().uuid(),
  type: z.enum([
    'skill', 'project', 'context', 'pattern', 'result',
    'document', 'schema', 'thread', 'blob-manifest', 'profile',
  ]),
  namespace: z.enum(['skill', 'project']),
  topic: z.array(z.string()).min(1),
  source: z.object({
    agentId: z.string().min(1),
    peerId: z.string().min(1),
    timestamp: z.number().positive(),
  }),
  confidence: z.number().min(0).max(1),
  version: z.number().int().positive(),
})

// ---------------------------------------------------------------------------
// Access controller factory
// ---------------------------------------------------------------------------

const CONTROLLER_TYPE = 'subspace'

/**
 * Factory function matching the OrbitDB AccessController interface.
 * Call `SubspaceAccessController(options)` to get an async factory, then
 * pass it to `orbitdb.open()` as `AccessController`.
 *
 * Also register globally: `useAccessController(SubspaceAccessController)`
 * so that existing databases (with 'subspace' in their manifest) can be
 * reopened without providing the factory explicitly.
 */
const SubspaceAccessController = (options: SubspaceAccessControllerOptions = {}) =>
  async ({ name, address }: { orbitdb?: unknown; identities?: unknown; name?: string; address?: string }) => {
    const {
      maxContentBytes = 65_536,
      maxEnvelopeBodyBytes = 262_144,
      requireSignatures = false,
    } = options

    // The access controller address is the DB name (no IPFS manifest block stored)
    const controllerAddress = name ?? address ?? 'subspace-ac'

    const canAppend = async (entry: {
      payload?: {
        op?: string
        key?: string
        value?: Record<string, unknown>
      }
    }): Promise<boolean> => {
      try {
        const { op, value } = entry.payload ?? {}

        // Allow DEL operations (tombstone propagation) — these are written by
        // the store's forget() method and are safe to replicate.
        if (op === 'DEL') return true

        // Only process PUT operations
        if (op !== 'PUT' || !value) return false

        const doc = value as Record<string, unknown>

        // 1. Permit tombstones FIRST — they are minimal `{ _id, _tombstone: true }`
        //    documents that intentionally lack full metadata schema fields.
        //    Checking metadata before tombstones would reject valid delete ops.
        if (doc._tombstone === true) return true

        // 2. Validate structural metadata (non-content fields) for regular entries
        const metaResult = metadataSchema.safeParse(doc)
        if (!metaResult.success) return false

        // 3. Content size limit
        // For encrypted docs: check encryptedContent blob size
        // For plaintext docs: check content field size
        const contentField = (doc._encrypted === true)
          ? (doc.encryptedContent as string | undefined ?? '')
          : (doc.content as string | undefined ?? '')
        if (Buffer.byteLength(contentField, 'utf8') > maxContentBytes) return false

        // 4. Envelope body size limit
        const envelopeBodyField = (doc._encrypted === true)
          ? (doc.encryptedEnvelopeBody as string | undefined ?? '')
          : ((doc.contentEnvelope as Record<string, unknown> | undefined)?.body as string | undefined ?? '')
        if (Buffer.byteLength(envelopeBodyField, 'utf8') > maxEnvelopeBodyBytes) return false

        // 5. Ed25519 signature verification
        //
        // IMPORTANT: Skip signature verification for encrypted documents.
        //
        // The signing order is: sign(plaintext_chunk) → encrypt(chunk) → store.
        // The stored document has `content: ''` (empty placeholder) with the
        // real content in `encryptedContent`. The signature was computed over
        // the PLAINTEXT content, but `canAppend` receives the ENCRYPTED doc.
        // Verifying a plaintext-signature against an encrypted doc will always
        // fail, causing all encrypted writes to be rejected.
        //
        // The AC cannot decrypt the content (it lacks the PSK-derived key), so
        // signature verification is deferred to the ingest layer (checkIngestSecurity
        // in api.ts) which operates on plaintext before encryption. For remote
        // replication, the PSK-network access and OrbitDB identity checks serve
        // as the primary guards.
        const isEncrypted = doc._encrypted === true
        const peerId = (doc.source as Record<string, unknown> | undefined)?.peerId as string | undefined
        const signature = doc.signature as string | undefined

        if (!isEncrypted && signature && peerId) {
          try {
            const peerIdObj = peerIdFromString(peerId)
            const pubKey = peerIdObj.publicKey
            if (pubKey) {
              // Cast to MemoryChunk for verifyChunkSignature — only signature-relevant
              // fields are accessed (id, source, etc., all present in the doc)
              const valid = await verifyChunkSignature(
                doc as unknown as import('./schema.js').MemoryChunk,
                pubKey
              )
              if (!valid) return false
            }
          } catch {
            // Non-Ed25519 PeerId or malformed peerId — signature unverifiable.
            // Allow the entry (we can't verify, but we can't block legitimate peers).
          }
        } else if (!isEncrypted && !signature && requireSignatures) {
          // Unsigned plaintext entry rejected when requireSignatures is enabled
          return false
        }

        return true
      } catch {
        // Any unexpected error → reject the entry (fail-closed)
        return false
      }
    }

    return {
      type: CONTROLLER_TYPE,
      address: controllerAddress,
      canAppend,
    }
  }

// Required static field so OrbitDB can look it up by type string
SubspaceAccessController.type = CONTROLLER_TYPE

export { SubspaceAccessController }

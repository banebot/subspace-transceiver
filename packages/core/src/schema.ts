import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { StoreError, ErrorCode } from './errors.js'

// ---------------------------------------------------------------------------
// Memory types and namespaces
// ---------------------------------------------------------------------------

export type MemoryType =
  | 'skill'
  | 'project'
  | 'context'
  | 'pattern'
  | 'result'
  | 'document'        // Rich structured document (see ContentEnvelope)
  | 'schema'          // JSON Schema definition for structured content validation
  | 'thread'          // Multi-agent conversation thread
  | 'blob-manifest'   // Manifest describing a binary blob stored on-network
  | 'profile'         // Agent profile / namespace root document

export type MemoryNamespace = 'skill' | 'project'

// ---------------------------------------------------------------------------
// Content envelope — rich content types (additive, backward compatible)
// ---------------------------------------------------------------------------

/**
 * Content format for the ContentEnvelope.
 * When absent (legacy chunks), content is treated as 'text'.
 */
export type ContentFormat =
  | 'text'        // Plain text — default, backward compat
  | 'markdown'    // Markdown document
  | 'json'        // Structured JSON data (body is a JSON string)
  | 'code'        // Source code (language hint in metadata.language)
  | 'thread'      // Conversation thread (body is JSON array of messages)
  | 'table'       // Tabular data (body is JSON array of objects)
  | 'composite'   // Multi-section document (body is JSON array of sections)

/**
 * Reference to a binary or external media asset.
 * Media is REFERENCED, not embedded — keeps chunks small.
 *
 * URI schemes:
 *   agent://<peerId>/blobs/<sha256hash>  — content on this network
 *   ipfs://<CID>                         — IPFS-addressed content
 *   https://...                          — public HTTP URL
 *   data:<mimeType>;base64,...           — inline data (max 4KB)
 */
export interface MediaRef {
  uri: string
  mimeType: string
  size?: number       // bytes
  hash?: string       // SHA-256 hex of the blob content
  alt?: string        // alt text / description
}

/**
 * Rich content envelope.
 * When present, `content` on MemoryChunk is a plain-text SUMMARY for search.
 * The actual rich content lives here.
 */
export interface ContentEnvelope {
  format: ContentFormat
  body: string             // The primary content
  media?: MediaRef[]       // Optional media references
  schemaUri?: string       // Optional agent:// URI of a JSON Schema chunk for validation
  metadata?: Record<string, string>  // Format-specific hints (e.g. { language: 'typescript' })
}

// ---------------------------------------------------------------------------
// Content links — typed directed edges between chunks
// ---------------------------------------------------------------------------

/**
 * Standard link relationship types.
 * Agents may use any string for `rel` — these are the canonical values.
 */
export type LinkRel =
  | 'related'       // General association
  | 'depends-on'    // This chunk builds on / requires the target
  | 'supersedes'    // This chunk replaces the target (formal version of the supersedes field)
  | 'references'    // Cites or quotes from the target
  | 'part-of'       // This chunk is a section of a larger document
  | 'reply-to'      // Conversational reply to the target
  | 'see-also'      // Suggested further reading
  | string          // Custom rel types allowed

export interface ContentLink {
  /** Target chunk ID (UUID) or agent:// URI */
  target: string
  /** Relationship type */
  rel: LinkRel
  /** Optional human-readable description of the relationship */
  label?: string
}

// ---------------------------------------------------------------------------
// MemoryChunk — the core unit of content on the network
// ---------------------------------------------------------------------------

export interface MemoryChunk {
  id: string
  type: MemoryType
  namespace: MemoryNamespace
  topic: string[]
  /** Plain-text summary — always required. Used for full-text search. */
  content: string
  source: {
    agentId: string
    peerId: string
    project?: string
    sessionId?: string
    timestamp: number
  }
  ttl?: number
  confidence: number
  network: string
  version: number
  supersedes?: string

  // ── Namespace / site fields (TODO-054945bb) ──────────────────────────────
  /** Named collection within this agent's namespace (e.g. 'patterns', 'guides') */
  collection?: string
  /** Human-readable slug, unique within agent+collection (e.g. 'typescript-async') */
  slug?: string

  // ── Rich content types (TODO-dc561cde) ───────────────────────────────────
  /** Rich content envelope. When present, `content` is a search-index summary. */
  contentEnvelope?: ContentEnvelope

  // ── Content linking (TODO-e07a6eaf) ──────────────────────────────────────
  /** Typed directed links to other chunks or agent:// URIs */
  links?: ContentLink[]

  // ── Security (TODO-ebb16396) ──────────────────────────────────────────────
  /**
   * Ed25519 signature over the canonical chunk bytes (base64-encoded).
   * Canonical = JSON.stringify of the chunk WITHOUT this field, keys sorted.
   * Signed by the agent's identity private key (source.peerId must match signer).
   */
  signature?: string

  /** Origin marker for crawled/cached content — not re-advertised to prevent amplification. */
  origin?: 'local' | 'crawl' | 'replicated'

  /** Internal tombstone marker — set by store.forget(). Not for external use. */
  _tombstone?: boolean
}

export interface MemoryQuery {
  topics?: string[]
  type?: MemoryType
  namespace?: MemoryNamespace
  project?: string
  /** Filter by publishing agent's PeerId (namespace query) */
  peerId?: string
  /** Filter by collection name */
  collection?: string
  /** Filter by content format */
  contentFormat?: ContentFormat
  minConfidence?: number
  since?: number
  until?: number
  limit?: number
}

// ---------------------------------------------------------------------------
// Zod schema for runtime validation on ingest
// ---------------------------------------------------------------------------

const memoryTypeSchema = z.enum([
  'skill', 'project', 'context', 'pattern', 'result',
  'document', 'schema', 'thread', 'blob-manifest', 'profile',
])
const memoryNamespaceSchema = z.enum(['skill', 'project'])
const contentFormatSchema = z.enum([
  'text', 'markdown', 'json', 'code', 'thread', 'table', 'composite',
])

const mediaRefSchema = z.object({
  uri: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().positive().optional(),
  hash: z.string().optional(),
  alt: z.string().optional(),
})

const contentEnvelopeSchema = z.object({
  format: contentFormatSchema,
  body: z.string(),
  media: z.array(mediaRefSchema).optional(),
  schemaUri: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
})

const contentLinkSchema = z.object({
  target: z.string().min(1),
  rel: z.string().min(1),
  label: z.string().optional(),
})

export const memoryChunkSchema = z.object({
  id: z.string().uuid('id must be a valid UUID v4'),
  type: memoryTypeSchema,
  namespace: memoryNamespaceSchema,
  topic: z
    .array(z.string().toLowerCase())
    .min(1, 'topic must be a non-empty array'),
  content: z.string().min(1, 'content must not be empty'),
  source: z.object({
    agentId: z.string().min(1),
    peerId: z.string().min(1),
    project: z.string().optional(),
    sessionId: z.string().optional(),
    timestamp: z.number().int().positive(),
  }),
  ttl: z.number().int().positive().optional(),
  confidence: z.number().min(0, 'confidence must be >= 0').max(1, 'confidence must be <= 1'),
  network: z.string().min(1),
  version: z.number().int().min(1).default(1),
  supersedes: z.string().uuid().optional(),
  // Namespace / site
  collection: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  // Rich content
  contentEnvelope: contentEnvelopeSchema.optional(),
  // Content links
  links: z.array(contentLinkSchema).optional(),
  // Security
  signature: z.string().optional(),
  origin: z.enum(['local', 'crawl', 'replicated']).optional(),
  // Internal
  _tombstone: z.boolean().optional(),
})

export type MemoryChunkInput = z.input<typeof memoryChunkSchema>

/**
 * Validate and parse a raw data object into a typed MemoryChunk.
 * Throws StoreError with INVALID_CHUNK on validation failure.
 */
export function validateChunk(data: unknown): MemoryChunk {
  const result = memoryChunkSchema.safeParse(data)
  if (!result.success) {
    const zodErr = result.error as unknown as { issues?: Array<{ path: unknown[]; message: string }> }
    const issues = zodErr.issues ?? []
    const msg = issues.length > 0
      ? issues.map((e) => `${(e.path ?? []).join('.')}: ${e.message}`).join('; ')
      : String(result.error)
    throw new StoreError(`Invalid memory chunk: ${msg}`, ErrorCode.INVALID_CHUNK)
  }
  return result.data as MemoryChunk
}

/**
 * Create a new MemoryChunk with auto-generated id and default version.
 * Caller provides all other fields; id and version are set here.
 */
export function createChunk(
  input: Omit<MemoryChunk, 'id' | 'version'> & { version?: number }
): MemoryChunk {
  const chunk: MemoryChunk = {
    ...input,
    id: uuidv4(),
    version: input.version ?? 1,
    // Normalise topics to lowercase
    topic: input.topic.map(t => t.toLowerCase()),
  }
  return validateChunk(chunk)
}

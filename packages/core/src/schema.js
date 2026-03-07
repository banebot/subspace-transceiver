import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { StoreError, ErrorCode } from './errors.js';
// ---------------------------------------------------------------------------
// Zod schema for runtime validation on ingest
// ---------------------------------------------------------------------------
const memoryTypeSchema = z.enum([
    'skill', 'project', 'context', 'pattern', 'result',
    'document', 'schema', 'thread', 'blob-manifest', 'profile',
]);
const memoryNamespaceSchema = z.enum(['skill', 'project']);
const contentFormatSchema = z.enum([
    'text', 'markdown', 'json', 'code', 'thread', 'table', 'composite',
]);
const mediaRefSchema = z.object({
    uri: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().positive().optional(),
    hash: z.string().optional(),
    alt: z.string().optional(),
});
const contentEnvelopeSchema = z.object({
    format: contentFormatSchema,
    body: z.string(),
    media: z.array(mediaRefSchema).optional(),
    schemaUri: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
});
const contentLinkSchema = z.object({
    target: z.string().min(1),
    rel: z.string().min(1),
    label: z.string().optional(),
});
const hashcashStampSchema = z.object({
    bits: z.number().int().positive(),
    challenge: z.string().min(1),
    nonce: z.string().min(1),
    hash: z.string().min(1),
});
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
    pow: hashcashStampSchema.optional(),
    origin: z.enum(['local', 'crawl', 'replicated']).optional(),
    // Internal
    _tombstone: z.boolean().optional(),
});
/**
 * Validate and parse a raw data object into a typed MemoryChunk.
 * Throws StoreError with INVALID_CHUNK on validation failure.
 */
export function validateChunk(data) {
    const result = memoryChunkSchema.safeParse(data);
    if (!result.success) {
        const zodErr = result.error;
        const issues = zodErr.issues ?? [];
        const msg = issues.length > 0
            ? issues.map((e) => `${(e.path ?? []).join('.')}: ${e.message}`).join('; ')
            : String(result.error);
        throw new StoreError(`Invalid memory chunk: ${msg}`, ErrorCode.INVALID_CHUNK);
    }
    return result.data;
}
/**
 * Create a new MemoryChunk with auto-generated id and default version.
 * Caller provides all other fields; id and version are set here.
 */
export function createChunk(input) {
    const chunk = {
        ...input,
        id: uuidv4(),
        version: input.version ?? 1,
        // Normalise topics to lowercase
        topic: input.topic.map(t => t.toLowerCase()),
    };
    return validateChunk(chunk);
}
//# sourceMappingURL=schema.js.map
import { z } from 'zod'
import { v4 as uuidv4 } from 'uuid'
import { StoreError, ErrorCode } from './errors.js'

export type MemoryType = 'skill' | 'project' | 'context' | 'pattern' | 'result'
export type MemoryNamespace = 'skill' | 'project'

export interface MemoryChunk {
  id: string
  type: MemoryType
  namespace: MemoryNamespace
  topic: string[]
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
  /** Internal tombstone marker — set by store.forget(). Not for external use. */
  _tombstone?: boolean
}

export interface MemoryQuery {
  topics?: string[]
  type?: MemoryType
  namespace?: MemoryNamespace
  project?: string
  minConfidence?: number
  since?: number
  until?: number
  limit?: number
}

// ---------------------------------------------------------------------------
// Zod schema for runtime validation on ingest
// ---------------------------------------------------------------------------

const memoryTypeSchema = z.enum(['skill', 'project', 'context', 'pattern', 'result'])
const memoryNamespaceSchema = z.enum(['skill', 'project'])

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
    // Zod v4: .issues is a getter (non-enumerable) on ZodError
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

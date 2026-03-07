/**
 * Schema Registry — resolves and caches LexiconSchemas by NSID.
 *
 * Resolution order:
 *   1. Built-in schemas (net.subspace.* types, always available)
 *   2. In-memory registered schemas (user-registered at runtime)
 *   3. File-cached schemas (from ~/.subspace/schemas/ directory)
 *
 * The registry uses the open-world model: if a schema is unknown,
 * records with that $type are stored and forwarded but not validated.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LexiconSchema } from './lexicon.js'
import { BUILT_IN_SCHEMAS, validateLexiconSchema, validateRecordData } from './lexicon.js'
import { isValidNSID, nsidMatches } from './nsid.js'

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean
  errors: string[]
  /** If true, schema was not found — record was accepted under open-world model */
  unknownSchema?: boolean
}

export interface ISchemaRegistry {
  /** Resolve a schema by NSID. Returns null if not found (open-world: still valid). */
  resolve(nsid: string): Promise<LexiconSchema | null>
  /** Register a schema in-memory. */
  register(schema: LexiconSchema): void
  /** List all known schemas. */
  list(): LexiconSchema[]
  /** Validate a record's data against its schema (if known). */
  validateRecord(nsid: string, data: Record<string, unknown>): Promise<ValidationResult>
}

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

export class InMemorySchemaRegistry implements ISchemaRegistry {
  protected schemas = new Map<string, LexiconSchema>()

  constructor(builtIns: LexiconSchema[] = BUILT_IN_SCHEMAS) {
    for (const schema of builtIns) {
      this.schemas.set(schema.id, schema)
    }
  }

  async resolve(nsid: string): Promise<LexiconSchema | null> {
    return this.schemas.get(nsid) ?? null
  }

  register(schema: LexiconSchema): void {
    const result = validateLexiconSchema(schema)
    if (!result.valid) {
      throw new Error(`Invalid schema: ${result.errors.join('; ')}`)
    }
    this.schemas.set(schema.id, schema)
  }

  list(): LexiconSchema[] {
    return [...this.schemas.values()]
  }

  async validateRecord(nsid: string, data: Record<string, unknown>): Promise<ValidationResult> {
    const schema = await this.resolve(nsid)
    if (!schema) {
      // Open-world: unknown schema → accept
      return { valid: true, errors: [], unknownSchema: true }
    }
    const result = validateRecordData(data, schema)
    return result
  }
}

// ---------------------------------------------------------------------------
// File-backed registry (persists schemas to disk)
// ---------------------------------------------------------------------------

export class FileSchemaRegistry extends InMemorySchemaRegistry {
  private readonly cacheDir: string
  private loaded = false

  constructor(cacheDir: string, builtIns: LexiconSchema[] = BUILT_IN_SCHEMAS) {
    super(builtIns)
    this.cacheDir = cacheDir
  }

  /** Load all cached schemas from disk. Call once at startup. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const files = await readdir(this.cacheDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await readFile(join(this.cacheDir, file), 'utf8')
          const schema = JSON.parse(raw) as LexiconSchema
          // Don't re-validate built-ins, only user-registered schemas
          if (!this.schemas.has(schema.id)) {
            this.schemas.set(schema.id, schema)
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[schema-registry] Could not load schema cache:', err)
      }
    }
  }

  override register(schema: LexiconSchema): void {
    super.register(schema)
    // Persist to disk asynchronously
    this.save(schema).catch(e => console.warn('[schema-registry] Could not save schema:', e))
  }

  private async save(schema: LexiconSchema): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true })
    // Filename: NSID with dots replaced by underscores + revision
    const filename = `${schema.id.replace(/\./g, '_')}_r${schema.revision}.json`
    await writeFile(join(this.cacheDir, filename), JSON.stringify(schema, null, 2), 'utf8')
  }
}

// ---------------------------------------------------------------------------
// Global default registry (singleton)
// ---------------------------------------------------------------------------

let _defaultRegistry: InMemorySchemaRegistry | null = null

/**
 * Get the global default schema registry.
 * Pre-loaded with all built-in net.subspace.* schemas.
 */
export function getDefaultRegistry(): InMemorySchemaRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new InMemorySchemaRegistry()
  }
  return _defaultRegistry
}

/**
 * Create a file-backed registry and load cached schemas.
 * Use this at daemon startup to persist user-registered schemas.
 */
export async function createFileRegistry(cacheDir: string): Promise<FileSchemaRegistry> {
  const registry = new FileSchemaRegistry(cacheDir)
  await registry.load()
  return registry
}

/**
 * Parse a JSON string as a LexiconSchema with validation.
 * Throws if the schema is invalid.
 */
export function parseLexiconSchema(json: string): LexiconSchema {
  let schema: unknown
  try {
    schema = JSON.parse(json)
  } catch {
    throw new Error('Invalid JSON: could not parse schema')
  }
  const result = validateLexiconSchema(schema)
  if (!result.valid) {
    throw new Error(`Invalid Lexicon schema: ${result.errors.join('; ')}`)
  }
  return schema as LexiconSchema
}

/**
 * Find all NSIDs matching a pattern (supports '*' wildcard).
 */
export function findSchemasByPattern(registry: ISchemaRegistry, pattern: string): LexiconSchema[] {
  return registry.list().filter(s => nsidMatches(s.id, pattern))
}

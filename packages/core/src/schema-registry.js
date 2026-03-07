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
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILT_IN_SCHEMAS, validateLexiconSchema, validateRecordData } from './lexicon.js';
import { nsidMatches } from './nsid.js';
// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------
export class InMemorySchemaRegistry {
    schemas = new Map();
    constructor(builtIns = BUILT_IN_SCHEMAS) {
        for (const schema of builtIns) {
            this.schemas.set(schema.id, schema);
        }
    }
    async resolve(nsid) {
        return this.schemas.get(nsid) ?? null;
    }
    register(schema) {
        const result = validateLexiconSchema(schema);
        if (!result.valid) {
            throw new Error(`Invalid schema: ${result.errors.join('; ')}`);
        }
        this.schemas.set(schema.id, schema);
    }
    list() {
        return [...this.schemas.values()];
    }
    async validateRecord(nsid, data) {
        const schema = await this.resolve(nsid);
        if (!schema) {
            // Open-world: unknown schema → accept
            return { valid: true, errors: [], unknownSchema: true };
        }
        const result = validateRecordData(data, schema);
        return result;
    }
}
// ---------------------------------------------------------------------------
// File-backed registry (persists schemas to disk)
// ---------------------------------------------------------------------------
export class FileSchemaRegistry extends InMemorySchemaRegistry {
    cacheDir;
    loaded = false;
    constructor(cacheDir, builtIns = BUILT_IN_SCHEMAS) {
        super(builtIns);
        this.cacheDir = cacheDir;
    }
    /** Load all cached schemas from disk. Call once at startup. */
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const files = await readdir(this.cacheDir);
            for (const file of files) {
                if (!file.endsWith('.json'))
                    continue;
                try {
                    const raw = await readFile(join(this.cacheDir, file), 'utf8');
                    const schema = JSON.parse(raw);
                    // Don't re-validate built-ins, only user-registered schemas
                    if (!this.schemas.has(schema.id)) {
                        this.schemas.set(schema.id, schema);
                    }
                }
                catch {
                    // Skip malformed files
                }
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('[schema-registry] Could not load schema cache:', err);
            }
        }
    }
    register(schema) {
        super.register(schema);
        // Persist to disk asynchronously
        this.save(schema).catch(e => console.warn('[schema-registry] Could not save schema:', e));
    }
    async save(schema) {
        await mkdir(this.cacheDir, { recursive: true });
        // Filename: NSID with dots replaced by underscores + revision
        const filename = `${schema.id.replace(/\./g, '_')}_r${schema.revision}.json`;
        await writeFile(join(this.cacheDir, filename), JSON.stringify(schema, null, 2), 'utf8');
    }
}
// ---------------------------------------------------------------------------
// Global default registry (singleton)
// ---------------------------------------------------------------------------
let _defaultRegistry = null;
/**
 * Get the global default schema registry.
 * Pre-loaded with all built-in net.subspace.* schemas.
 */
export function getDefaultRegistry() {
    if (!_defaultRegistry) {
        _defaultRegistry = new InMemorySchemaRegistry();
    }
    return _defaultRegistry;
}
/**
 * Create a file-backed registry and load cached schemas.
 * Use this at daemon startup to persist user-registered schemas.
 */
export async function createFileRegistry(cacheDir) {
    const registry = new FileSchemaRegistry(cacheDir);
    await registry.load();
    return registry;
}
/**
 * Parse a JSON string as a LexiconSchema with validation.
 * Throws if the schema is invalid.
 */
export function parseLexiconSchema(json) {
    let schema;
    try {
        schema = JSON.parse(json);
    }
    catch {
        throw new Error('Invalid JSON: could not parse schema');
    }
    const result = validateLexiconSchema(schema);
    if (!result.valid) {
        throw new Error(`Invalid Lexicon schema: ${result.errors.join('; ')}`);
    }
    return schema;
}
/**
 * Find all NSIDs matching a pattern (supports '*' wildcard).
 */
export function findSchemasByPattern(registry, pattern) {
    return registry.list().filter(s => nsidMatches(s.id, pattern));
}
//# sourceMappingURL=schema-registry.js.map
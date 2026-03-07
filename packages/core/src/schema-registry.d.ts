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
import type { LexiconSchema } from './lexicon.js';
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    /** If true, schema was not found — record was accepted under open-world model */
    unknownSchema?: boolean;
}
export interface ISchemaRegistry {
    /** Resolve a schema by NSID. Returns null if not found (open-world: still valid). */
    resolve(nsid: string): Promise<LexiconSchema | null>;
    /** Register a schema in-memory. */
    register(schema: LexiconSchema): void;
    /** List all known schemas. */
    list(): LexiconSchema[];
    /** Validate a record's data against its schema (if known). */
    validateRecord(nsid: string, data: Record<string, unknown>): Promise<ValidationResult>;
}
export declare class InMemorySchemaRegistry implements ISchemaRegistry {
    protected schemas: Map<string, LexiconSchema>;
    constructor(builtIns?: LexiconSchema[]);
    resolve(nsid: string): Promise<LexiconSchema | null>;
    register(schema: LexiconSchema): void;
    list(): LexiconSchema[];
    validateRecord(nsid: string, data: Record<string, unknown>): Promise<ValidationResult>;
}
export declare class FileSchemaRegistry extends InMemorySchemaRegistry {
    private readonly cacheDir;
    private loaded;
    constructor(cacheDir: string, builtIns?: LexiconSchema[]);
    /** Load all cached schemas from disk. Call once at startup. */
    load(): Promise<void>;
    register(schema: LexiconSchema): void;
    private save;
}
/**
 * Get the global default schema registry.
 * Pre-loaded with all built-in net.subspace.* schemas.
 */
export declare function getDefaultRegistry(): InMemorySchemaRegistry;
/**
 * Create a file-backed registry and load cached schemas.
 * Use this at daemon startup to persist user-registered schemas.
 */
export declare function createFileRegistry(cacheDir: string): Promise<FileSchemaRegistry>;
/**
 * Parse a JSON string as a LexiconSchema with validation.
 * Throws if the schema is invalid.
 */
export declare function parseLexiconSchema(json: string): LexiconSchema;
/**
 * Find all NSIDs matching a pattern (supports '*' wildcard).
 */
export declare function findSchemasByPattern(registry: ISchemaRegistry, pattern: string): LexiconSchema[];
//# sourceMappingURL=schema-registry.d.ts.map
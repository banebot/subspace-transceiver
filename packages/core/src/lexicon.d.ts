/**
 * Lexicon — AT Protocol-inspired schema definition format for Subspace.
 *
 * A LexiconSchema defines the structure of a record type identified by an NSID.
 * Schemas are JSON documents that can be published, fetched, and cached.
 *
 * The schema format is a simplified subset of JSON Schema, covering:
 *   - Type checks: string, integer, boolean, array, object, unknown
 *   - Required fields
 *   - String constraints: maxLength, minLength, enum, format
 *   - Number constraints: minimum, maximum
 *   - Array constraints: items (item schema), maxLength
 *   - Object constraints: properties (nested schemas)
 */
export type FieldType = 'string' | 'integer' | 'boolean' | 'array' | 'object' | 'bytes' | 'ref' | 'union' | 'unknown';
export interface FieldSchema {
    type: FieldType;
    description?: string;
    /** For 'string': max character length */
    maxLength?: number;
    /** For 'string': min character length */
    minLength?: number;
    /** For 'string': allowed values */
    enum?: string[];
    /** For 'string': format hint ('datetime', 'uri', 'at-uri', etc.) */
    format?: string;
    /** For 'integer': minimum value */
    minimum?: number;
    /** For 'integer': maximum value */
    maximum?: number;
    /** For 'array': schema for each item */
    items?: FieldSchema;
    /** For 'array': max number of items */
    maxItems?: number;
    /** For 'object': nested property schemas */
    properties?: Record<string, FieldSchema>;
    /** For 'object': required property names */
    required?: string[];
    /** For 'ref': NSID of the referenced type */
    ref?: string;
    /** For 'union': allowed NSIDs */
    refs?: string[];
}
export interface RecordDefinition {
    type: 'record';
    description?: string;
    record: {
        type: 'object';
        required?: string[];
        properties: Record<string, FieldSchema>;
    };
}
export interface LexiconSchema {
    /** Always 1 (schema language version) */
    lexicon: 1;
    /** The NSID identifying this schema */
    id: string;
    /** Human-readable description */
    description?: string;
    /** Monotonically increasing revision number */
    revision: number;
    defs: {
        main: RecordDefinition;
        [key: string]: RecordDefinition | FieldSchema;
    };
}
export interface ValidationResult {
    valid: boolean;
    errors: string[];
}
/**
 * Validate a LexiconSchema definition itself (meta-validation).
 */
export declare function validateLexiconSchema(schema: unknown): ValidationResult;
/**
 * Validate a data object against a Lexicon schema.
 *
 * Open-world model: if the schema is unknown, return valid=true (store and forward).
 * Only validates fields that are defined in the schema; extra fields are allowed.
 */
export declare function validateRecordData(data: Record<string, unknown>, schema: LexiconSchema): ValidationResult;
/**
 * Built-in schemas for all net.subspace.* types.
 * These provide validation for built-in memory types.
 */
export declare const BUILT_IN_SCHEMAS: LexiconSchema[];
//# sourceMappingURL=lexicon.d.ts.map
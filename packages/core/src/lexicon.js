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
import { isValidNSID } from './nsid.js';
/**
 * Validate a LexiconSchema definition itself (meta-validation).
 */
export function validateLexiconSchema(schema) {
    const errors = [];
    if (typeof schema !== 'object' || schema === null) {
        return { valid: false, errors: ['Schema must be an object'] };
    }
    const s = schema;
    if (s.lexicon !== 1)
        errors.push('lexicon must be 1');
    if (typeof s.id !== 'string' || !isValidNSID(s.id))
        errors.push(`id must be a valid NSID, got: "${s.id}"`);
    if (typeof s.revision !== 'number' || s.revision < 1 || !Number.isInteger(s.revision)) {
        errors.push('revision must be a positive integer');
    }
    if (typeof s.defs !== 'object' || s.defs === null)
        errors.push('defs must be an object');
    else if (!s.defs.main)
        errors.push('defs.main is required');
    return { valid: errors.length === 0, errors };
}
/**
 * Validate a data object against a Lexicon schema.
 *
 * Open-world model: if the schema is unknown, return valid=true (store and forward).
 * Only validates fields that are defined in the schema; extra fields are allowed.
 */
export function validateRecordData(data, schema) {
    const errors = [];
    const { record } = schema.defs.main;
    // Check required fields
    for (const req of record.required ?? []) {
        if (!(req in data)) {
            errors.push(`Missing required field: "${req}"`);
        }
    }
    // Validate declared properties
    for (const [key, fieldSchema] of Object.entries(record.properties)) {
        if (!(key in data))
            continue; // optional field absent — OK
        const value = data[key];
        const fieldErrors = validateField(value, fieldSchema, key);
        errors.push(...fieldErrors);
    }
    return { valid: errors.length === 0, errors };
}
function validateField(value, schema, path) {
    const errors = [];
    if (schema.type === 'unknown')
        return errors; // any value accepted
    if (value === null || value === undefined) {
        return errors; // null/undefined only matters for required check (done above)
    }
    switch (schema.type) {
        case 'string': {
            if (typeof value !== 'string') {
                errors.push(`${path}: expected string, got ${typeof value}`);
                break;
            }
            if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                errors.push(`${path}: string too long (max ${schema.maxLength}, got ${value.length})`);
            }
            if (schema.minLength !== undefined && value.length < schema.minLength) {
                errors.push(`${path}: string too short (min ${schema.minLength}, got ${value.length})`);
            }
            if (schema.enum !== undefined && !schema.enum.includes(value)) {
                errors.push(`${path}: must be one of [${schema.enum.join(', ')}], got "${value}"`);
            }
            break;
        }
        case 'integer': {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                errors.push(`${path}: expected integer, got ${typeof value}`);
                break;
            }
            if (schema.minimum !== undefined && value < schema.minimum) {
                errors.push(`${path}: integer too small (min ${schema.minimum}, got ${value})`);
            }
            if (schema.maximum !== undefined && value > schema.maximum) {
                errors.push(`${path}: integer too large (max ${schema.maximum}, got ${value})`);
            }
            break;
        }
        case 'boolean': {
            if (typeof value !== 'boolean') {
                errors.push(`${path}: expected boolean, got ${typeof value}`);
            }
            break;
        }
        case 'array': {
            if (!Array.isArray(value)) {
                errors.push(`${path}: expected array, got ${typeof value}`);
                break;
            }
            if (schema.maxItems !== undefined && value.length > schema.maxItems) {
                errors.push(`${path}: array too long (max ${schema.maxItems}, got ${value.length})`);
            }
            if (schema.items) {
                value.forEach((item, i) => {
                    errors.push(...validateField(item, schema.items, `${path}[${i}]`));
                });
            }
            break;
        }
        case 'object': {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                errors.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
                break;
            }
            const obj = value;
            for (const req of schema.required ?? []) {
                if (!(req in obj))
                    errors.push(`${path}.${req}: required field missing`);
            }
            if (schema.properties) {
                for (const [k, fs] of Object.entries(schema.properties)) {
                    if (k in obj)
                        errors.push(...validateField(obj[k], fs, `${path}.${k}`));
                }
            }
            break;
        }
        case 'bytes':
            if (typeof value !== 'string') {
                errors.push(`${path}: expected base64 bytes string, got ${typeof value}`);
            }
            break;
        default:
            // ref, union, unknown — skip for now
            break;
    }
    return errors;
}
// ---------------------------------------------------------------------------
// Built-in schemas for backward compatibility
// ---------------------------------------------------------------------------
const MEMORY_RECORD_BASE_PROPERTIES = {
    content: { type: 'string', maxLength: 65536, description: 'Text content' },
    topic: { type: 'array', items: { type: 'string' }, description: 'Semantic tags' },
    confidence: { type: 'integer', minimum: 0, maximum: 1, description: 'Confidence score 0-1' },
};
/**
 * Built-in schemas for all net.subspace.* types.
 * These provide validation for built-in memory types.
 */
export const BUILT_IN_SCHEMAS = [
    {
        lexicon: 1,
        id: 'net.subspace.memory.skill',
        description: 'Portable agent knowledge — reusable across projects',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['content', 'topic'],
                    properties: {
                        ...MEMORY_RECORD_BASE_PROPERTIES,
                        language: { type: 'string', description: 'Programming language (for code skills)' },
                    },
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.memory.context',
        description: 'Conversation or session context',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['content', 'topic'],
                    properties: {
                        ...MEMORY_RECORD_BASE_PROPERTIES,
                        sessionId: { type: 'string', description: 'Session identifier' },
                    },
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.memory.pattern',
        description: 'Recognized behavioral or data pattern',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['content', 'topic'],
                    properties: MEMORY_RECORD_BASE_PROPERTIES,
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.memory.result',
        description: 'Task or computation result',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['content', 'topic'],
                    properties: MEMORY_RECORD_BASE_PROPERTIES,
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.memory.document',
        description: 'Rich document',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['content', 'topic'],
                    properties: {
                        ...MEMORY_RECORD_BASE_PROPERTIES,
                        mimeType: { type: 'string', description: 'MIME type of the content' },
                    },
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.memory.thread',
        description: 'Conversation thread',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['topic'],
                    properties: MEMORY_RECORD_BASE_PROPERTIES,
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.schema.definition',
        description: 'A Lexicon schema definition record',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['lexicon', 'id', 'revision', 'defs'],
                    properties: {
                        lexicon: { type: 'integer', minimum: 1, maximum: 1 },
                        id: { type: 'string', description: 'NSID of the schema' },
                        description: { type: 'string' },
                        revision: { type: 'integer', minimum: 1 },
                        defs: { type: 'object', description: 'Type definitions' },
                    },
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.blob.manifest',
        description: 'Binary blob manifest',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['topic'],
                    properties: {
                        ...MEMORY_RECORD_BASE_PROPERTIES,
                        blobCid: { type: 'string', description: 'IPFS CID of the blob' },
                        mimeType: { type: 'string', description: 'MIME type' },
                        size: { type: 'integer', description: 'Byte size' },
                    },
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.identity.profile',
        description: 'Agent profile and identity',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['topic'],
                    properties: {
                        ...MEMORY_RECORD_BASE_PROPERTIES,
                        displayName: { type: 'string', maxLength: 128 },
                        bio: { type: 'string', maxLength: 512 },
                        website: { type: 'string', format: 'uri' },
                    },
                },
            },
        },
    },
    {
        lexicon: 1,
        id: 'net.subspace.mail.envelope',
        description: 'A mail envelope for store-and-forward messaging',
        revision: 1,
        defs: {
            main: {
                type: 'record',
                record: {
                    type: 'object',
                    required: ['from', 'to', 'payload', 'ephemeralPubKey', 'nonce', 'authTag', 'signature', 'timestamp', 'ttl'],
                    properties: {
                        from: { type: 'string', description: 'Sender PeerId' },
                        to: { type: 'string', description: 'Recipient PeerId' },
                        payload: { type: 'string', description: 'Base64 encrypted payload' },
                        ephemeralPubKey: { type: 'string', description: 'Base64 ephemeral X25519 public key' },
                        nonce: { type: 'string', description: 'Base64 AES-GCM nonce' },
                        authTag: { type: 'string', description: 'Base64 AES-GCM auth tag' },
                        signature: { type: 'string', description: 'Hex Ed25519 signature' },
                        timestamp: { type: 'integer', description: 'Unix ms timestamp' },
                        ttl: { type: 'integer', description: 'TTL in seconds' },
                        contentType: { type: 'string', description: 'Content type hint' },
                    },
                },
            },
        },
    },
];
//# sourceMappingURL=lexicon.js.map
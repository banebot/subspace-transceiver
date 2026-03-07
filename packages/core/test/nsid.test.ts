/**
 * Unit tests for NSID parsing/validation and the Lexicon schema system.
 */

import { describe, it, expect } from 'vitest'
import {
  isValidNSID,
  parseNSID,
  nsidMatches,
  memoryTypeToNSID,
  nsidToMemoryType,
  BUILT_IN_NSIDS,
} from '../src/nsid.js'
import {
  validateLexiconSchema,
  validateRecordData,
  BUILT_IN_SCHEMAS,
  type LexiconSchema,
} from '../src/lexicon.js'
import {
  InMemorySchemaRegistry,
  parseLexiconSchema,
  findSchemasByPattern,
} from '../src/schema-registry.js'

// ---------------------------------------------------------------------------
// NSID validation
// ---------------------------------------------------------------------------

describe('isValidNSID', () => {
  it('accepts valid NSIDs', () => {
    expect(isValidNSID('net.subspace.memory.skill')).toBe(true)
    expect(isValidNSID('com.example.task.item')).toBe(true)
    expect(isValidNSID('io.agent.market.listing')).toBe(true)
    expect(isValidNSID('org.myteam.review.request')).toBe(true)
    expect(isValidNSID('a.b.c')).toBe(true)  // minimum valid
  })

  it('rejects NSIDs with too few segments', () => {
    expect(isValidNSID('net.subspace')).toBe(false)  // only 2 segments
    expect(isValidNSID('foo')).toBe(false)
    expect(isValidNSID('')).toBe(false)
  })

  it('rejects NSIDs with uppercase letters', () => {
    expect(isValidNSID('net.Subspace.memory.skill')).toBe(false)
    expect(isValidNSID('NET.subspace.memory.skill')).toBe(false)
  })

  it('rejects NSIDs with leading digits in segments', () => {
    expect(isValidNSID('net.subspace.1memory.skill')).toBe(false)
    expect(isValidNSID('1net.subspace.memory.skill')).toBe(false)
  })

  it('rejects NSIDs with special characters', () => {
    expect(isValidNSID('net.subspace.memory_skill')).toBe(false)
    expect(isValidNSID('net.subspace.memory/skill')).toBe(false)
  })

  it('rejects NSIDs exceeding max length', () => {
    const long = 'a.b.' + 'c'.repeat(250)
    expect(isValidNSID(long)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// NSID parsing
// ---------------------------------------------------------------------------

describe('parseNSID', () => {
  it('correctly parses segments and authority', () => {
    const parsed = parseNSID('net.subspace.memory.skill')
    expect(parsed.nsid).toBe('net.subspace.memory.skill')
    expect(parsed.segments).toEqual(['net', 'subspace', 'memory', 'skill'])
    expect(parsed.authority).toBe('subspace.net')  // first 2 reversed
    expect(parsed.name).toBe('memory.skill')        // remaining joined
    expect(parsed.toString()).toBe('net.subspace.memory.skill')
  })

  it('throws on invalid NSID', () => {
    expect(() => parseNSID('invalid')).toThrow()
    expect(() => parseNSID('')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// NSID pattern matching
// ---------------------------------------------------------------------------

describe('nsidMatches', () => {
  it('matches exact NSID', () => {
    expect(nsidMatches('net.subspace.memory.skill', 'net.subspace.memory.skill')).toBe(true)
    expect(nsidMatches('net.subspace.memory.skill', 'net.subspace.memory.context')).toBe(false)
  })

  it('matches wildcard patterns', () => {
    expect(nsidMatches('net.subspace.memory.skill', 'net.subspace.*')).toBe(true)
    expect(nsidMatches('net.subspace.memory.skill', 'net.subspace.memory.*')).toBe(true)
    expect(nsidMatches('net.subspace.memory.skill', 'com.example.*')).toBe(false)
  })

  it('matches the global wildcard', () => {
    expect(nsidMatches('any.nsid.here', '*')).toBe(true)
  })

  it('does not partially match without wildcard', () => {
    expect(nsidMatches('net.subspace.memory.skill', 'net.subspace')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Built-in NSID mapping
// ---------------------------------------------------------------------------

describe('memoryTypeToNSID / nsidToMemoryType', () => {
  it('maps all MemoryType values to NSIDs', () => {
    for (const [type, nsid] of Object.entries(BUILT_IN_NSIDS)) {
      expect(memoryTypeToNSID(type)).toBe(nsid)
    }
  })

  it('returns null for unknown types', () => {
    expect(memoryTypeToNSID('unknown-type')).toBeNull()
  })

  it('maps NSIDs back to MemoryType values', () => {
    expect(nsidToMemoryType('net.subspace.memory.skill')).toBe('skill')
    expect(nsidToMemoryType('net.subspace.identity.profile')).toBe('profile')
    expect(nsidToMemoryType('com.unknown.type')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// LexiconSchema validation
// ---------------------------------------------------------------------------

describe('validateLexiconSchema', () => {
  const validSchema: LexiconSchema = {
    lexicon: 1,
    id: 'com.example.task.item',
    revision: 1,
    description: 'A task item',
    defs: {
      main: {
        type: 'record',
        record: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', maxLength: 256 },
            done: { type: 'boolean' },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
          },
        },
      },
    },
  }

  it('accepts a valid schema', () => {
    const result = validateLexiconSchema(validSchema)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects schema with wrong lexicon version', () => {
    const result = validateLexiconSchema({ ...validSchema, lexicon: 2 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('lexicon'))).toBe(true)
  })

  it('rejects schema with invalid NSID', () => {
    const result = validateLexiconSchema({ ...validSchema, id: 'bad' })
    expect(result.valid).toBe(false)
  })

  it('rejects schema with missing defs.main', () => {
    const result = validateLexiconSchema({ ...validSchema, defs: {} })
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Record data validation
// ---------------------------------------------------------------------------

describe('validateRecordData', () => {
  const taskSchema: LexiconSchema = {
    lexicon: 1,
    id: 'com.example.task.item',
    revision: 1,
    defs: {
      main: {
        type: 'record',
        record: {
          type: 'object',
          required: ['title', 'status'],
          properties: {
            title: { type: 'string', maxLength: 100 },
            status: { type: 'string', enum: ['open', 'done'] },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }

  it('accepts valid data', () => {
    const result = validateRecordData(
      { title: 'Fix bug', status: 'open', priority: 3, tags: ['urgent'] },
      taskSchema
    )
    expect(result.valid).toBe(true)
  })

  it('rejects missing required fields', () => {
    const result = validateRecordData({ title: 'Fix bug' }, taskSchema)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('status'))).toBe(true)
  })

  it('rejects wrong type', () => {
    const result = validateRecordData(
      { title: 123, status: 'open' },
      taskSchema
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('title'))).toBe(true)
  })

  it('rejects enum violation', () => {
    const result = validateRecordData(
      { title: 'Test', status: 'invalid-status' },
      taskSchema
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('status'))).toBe(true)
  })

  it('rejects integer out of range', () => {
    const result = validateRecordData(
      { title: 'Test', status: 'open', priority: 10 },
      taskSchema
    )
    expect(result.valid).toBe(false)
  })

  it('rejects string too long', () => {
    const result = validateRecordData(
      { title: 'x'.repeat(101), status: 'open' },
      taskSchema
    )
    expect(result.valid).toBe(false)
  })

  it('allows extra fields (open-world)', () => {
    const result = validateRecordData(
      { title: 'Test', status: 'open', extraField: 'anything' },
      taskSchema
    )
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Schema Registry
// ---------------------------------------------------------------------------

describe('InMemorySchemaRegistry', () => {
  it('includes all built-in schemas', async () => {
    const registry = new InMemorySchemaRegistry()
    const schemas = registry.list()
    expect(schemas.length).toBeGreaterThan(0)
    // Should have all BUILT_IN_SCHEMAS
    for (const s of BUILT_IN_SCHEMAS) {
      const resolved = await registry.resolve(s.id)
      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(s.id)
    }
  })

  it('registers and resolves custom schemas', async () => {
    const registry = new InMemorySchemaRegistry()
    const schema: LexiconSchema = {
      lexicon: 1,
      id: 'com.example.custom.type',
      revision: 1,
      defs: {
        main: {
          type: 'record',
          record: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    }
    registry.register(schema)
    const resolved = await registry.resolve('com.example.custom.type')
    expect(resolved).not.toBeNull()
    expect(resolved!.revision).toBe(1)
  })

  it('returns null for unknown NSID (open-world)', async () => {
    const registry = new InMemorySchemaRegistry()
    const result = await registry.resolve('com.unknown.type')
    expect(result).toBeNull()
  })

  it('validates record data (valid)', async () => {
    const registry = new InMemorySchemaRegistry()
    const result = await registry.validateRecord('net.subspace.memory.skill', {
      content: 'A skill',
      topic: ['coding'],
    })
    expect(result.valid).toBe(true)
  })

  it('accepts unknown schema under open-world model', async () => {
    const registry = new InMemorySchemaRegistry()
    const result = await registry.validateRecord('com.unknown.custom.type', { anything: true })
    expect(result.valid).toBe(true)
    expect(result.unknownSchema).toBe(true)
  })

  it('throws on registering an invalid schema', () => {
    const registry = new InMemorySchemaRegistry()
    expect(() => registry.register({ lexicon: 2 } as unknown as LexiconSchema)).toThrow()
  })
})

describe('parseLexiconSchema', () => {
  it('parses valid JSON schema', () => {
    const schema = parseLexiconSchema(JSON.stringify({
      lexicon: 1,
      id: 'com.test.type',
      revision: 1,
      defs: { main: { type: 'record', record: { type: 'object', properties: {} } } },
    }))
    expect(schema.id).toBe('com.test.type')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseLexiconSchema('not-json')).toThrow()
  })

  it('throws on invalid schema', () => {
    expect(() => parseLexiconSchema(JSON.stringify({ lexicon: 2 }))).toThrow()
  })
})

describe('findSchemasByPattern', () => {
  it('finds all net.subspace.* schemas', () => {
    const registry = new InMemorySchemaRegistry()
    const schemas = findSchemasByPattern(registry, 'net.subspace.*')
    expect(schemas.length).toBeGreaterThan(0)
    for (const s of schemas) {
      expect(s.id.startsWith('net.subspace.')).toBe(true)
    }
  })

  it('finds schemas by exact NSID', () => {
    const registry = new InMemorySchemaRegistry()
    const schemas = findSchemasByPattern(registry, 'net.subspace.memory.skill')
    expect(schemas.length).toBe(1)
    expect(schemas[0].id).toBe('net.subspace.memory.skill')
  })

  it('returns all schemas for * wildcard', () => {
    const registry = new InMemorySchemaRegistry()
    const all = findSchemasByPattern(registry, '*')
    expect(all.length).toBe(registry.list().length)
  })
})

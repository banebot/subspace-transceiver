import { describe, it, expect } from 'vitest'
import { validateChunk, createChunk } from '../src/schema.js'
import { StoreError, ErrorCode } from '../src/errors.js'

const validChunk = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'skill' as const,
  namespace: 'skill' as const,
  topic: ['typescript', 'async'],
  content: 'Always await async operations',
  source: {
    agentId: 'claude-3-7-sonnet',
    peerId: '12D3KooWTest',
    timestamp: Date.now(),
  },
  confidence: 0.9,
  network: 'abc123',
  version: 1,
}

describe('validateChunk', () => {
  it('accepts a valid chunk', () => {
    const result = validateChunk(validChunk)
    expect(result.id).toBe(validChunk.id)
    expect(result.type).toBe('skill')
    expect(result.confidence).toBe(0.9)
  })

  it('rejects a chunk missing the topic field', () => {
    const bad = { ...validChunk }
    // @ts-ignore
    delete bad.topic
    expect(() => validateChunk(bad)).toThrow(StoreError)
    try {
      validateChunk(bad)
    } catch (err) {
      expect((err as StoreError).code).toBe(ErrorCode.INVALID_CHUNK)
    }
  })

  it('rejects an empty topic array', () => {
    const bad = { ...validChunk, topic: [] }
    expect(() => validateChunk(bad)).toThrow(StoreError)
  })

  it('rejects confidence > 1', () => {
    const bad = { ...validChunk, confidence: 1.5 }
    expect(() => validateChunk(bad)).toThrow(StoreError)
  })

  it('rejects confidence < 0', () => {
    const bad = { ...validChunk, confidence: -0.1 }
    expect(() => validateChunk(bad)).toThrow(StoreError)
  })

  it('rejects an invalid UUID as id', () => {
    const bad = { ...validChunk, id: 'not-a-uuid' }
    expect(() => validateChunk(bad)).toThrow(StoreError)
  })

  it('rejects missing required source fields', () => {
    const bad = {
      ...validChunk,
      source: { agentId: 'agent', timestamp: Date.now() }, // missing peerId
    }
    expect(() => validateChunk(bad)).toThrow(StoreError)
  })
})

describe('createChunk', () => {
  it('assigns a UUID id and version 1 by default', () => {
    const { id, version, ...rest } = validChunk
    const chunk = createChunk(rest)
    expect(chunk.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(chunk.version).toBe(1)
  })

  it('normalises topics to lowercase', () => {
    const { id, version, ...rest } = validChunk
    const chunk = createChunk({ ...rest, topic: ['TypeScript', 'ASYNC'] })
    expect(chunk.topic).toEqual(['typescript', 'async'])
  })
})

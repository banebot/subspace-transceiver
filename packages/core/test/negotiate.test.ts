/**
 * Unit tests for ANP-compatible capability negotiation.
 *
 * Tests cover:
 * - CapabilityRegistry CRUD operations
 * - NSID prefix filtering
 * - Built-in capabilities list
 * - ANP conversion helpers
 * - NegotiateResponse → ANP advertisement conversion
 */

import { describe, it, expect } from 'vitest'
import {
  CapabilityRegistry,
  BUILT_IN_CAPABILITIES,
  toANPCapability,
  toANPAdvertisement,
  type CapabilityDeclaration,
  type NegotiateResponse,
} from '../src/negotiate.js'
import { isValidNSID } from '../src/nsid.js'

// ---------------------------------------------------------------------------
// CapabilityRegistry
// ---------------------------------------------------------------------------

describe('CapabilityRegistry', () => {
  it('initializes with built-in capabilities', () => {
    const registry = new CapabilityRegistry()
    const caps = registry.list()
    expect(caps.length).toBeGreaterThanOrEqual(BUILT_IN_CAPABILITIES.length)
  })

  it('starts with a did-key capability', () => {
    const registry = new CapabilityRegistry()
    expect(registry.has('net.subspace.identity.did-key')).toBe(true)
  })

  it('starts with both memory namespaces', () => {
    const registry = new CapabilityRegistry()
    expect(registry.has('net.subspace.memory.skill')).toBe(true)
    expect(registry.has('net.subspace.memory.project')).toBe(true)
  })

  it('starts with protocol capabilities', () => {
    const registry = new CapabilityRegistry()
    expect(registry.has('net.subspace.protocol.query')).toBe(true)
    expect(registry.has('net.subspace.protocol.browse')).toBe(true)
    expect(registry.has('net.subspace.protocol.negotiate')).toBe(true)
  })

  it('register() adds a new capability', () => {
    const registry = new CapabilityRegistry()
    const custom: CapabilityDeclaration = {
      nsid: 'com.example.task.item',
      version: '1.0.0',
      role: 'both',
    }
    registry.register(custom)
    expect(registry.has('com.example.task.item')).toBe(true)
    expect(registry.get('com.example.task.item')).toEqual(custom)
  })

  it('register() updates an existing capability', () => {
    const registry = new CapabilityRegistry()
    const updated: CapabilityDeclaration = {
      nsid: 'net.subspace.memory.skill',
      version: '3.0.0',
      role: 'consumer',
      metadata: { store: 'custom' },
    }
    registry.register(updated)
    const result = registry.get('net.subspace.memory.skill')
    expect(result?.version).toBe('3.0.0')
    expect(result?.role).toBe('consumer')
  })

  it('unregister() removes a capability', () => {
    const registry = new CapabilityRegistry()
    registry.unregister('net.subspace.memory.skill')
    expect(registry.has('net.subspace.memory.skill')).toBe(false)
  })

  it('list() with filter returns matching NSIDs only', () => {
    const registry = new CapabilityRegistry()
    const memCaps = registry.list('net.subspace.memory')
    expect(memCaps.length).toBeGreaterThan(0)
    for (const cap of memCaps) {
      expect(cap.nsid.startsWith('net.subspace.memory')).toBe(true)
    }
  })

  it('list() with empty filter returns all', () => {
    const registry = new CapabilityRegistry()
    const all = registry.list()
    const filtered = registry.list('')
    expect(all).toHaveLength(filtered.length)
  })

  it('nsids() returns all registered NSIDs', () => {
    const registry = new CapabilityRegistry()
    const nsids = registry.nsids()
    expect(nsids).toContain('net.subspace.memory.skill')
    expect(nsids).toContain('net.subspace.identity.did-key')
  })

  it('get() returns undefined for unknown NSID', () => {
    const registry = new CapabilityRegistry()
    expect(registry.get('nonexistent.nsid.here')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ANP conversion
// ---------------------------------------------------------------------------

describe('toANPCapability', () => {
  it('converts a CapabilityDeclaration to ANP format', () => {
    const cap: CapabilityDeclaration = {
      nsid: 'net.subspace.memory.skill',
      version: '2.0.0',
      role: 'both',
      metadata: { store: 'loro-crdt' },
    }
    const anp = toANPCapability(cap)
    expect(anp.type).toBe('capability')
    expect(anp.id).toBe('net.subspace.memory.skill')
    expect(anp.version).toBe('2.0.0')
    expect(anp.role).toBe('both')
    expect((anp.metadata as Record<string, string>).store).toBe('loro-crdt')
  })

  it('handles missing metadata with empty object', () => {
    const cap: CapabilityDeclaration = {
      nsid: 'net.subspace.protocol.query',
      version: '1.0.0',
      role: 'provider',
    }
    const anp = toANPCapability(cap)
    expect(anp.metadata).toEqual({})
  })
})

describe('toANPAdvertisement', () => {
  it('converts a NegotiateResponse to ANP advertisement format', () => {
    const response: NegotiateResponse = {
      protocolVersion: '1.0.0',
      agentDID: 'did:key:z6MkTestKey',
      peerId: '12D3KooWTestPeer',
      capabilities: [
        {
          nsid: 'net.subspace.memory.skill',
          version: '2.0.0',
          role: 'both',
        },
      ],
      timestamp: Date.now(),
    }
    const advert = toANPAdvertisement(response)
    expect(advert.type).toBe('capability_advertisement')
    expect(advert.agentId).toBe('did:key:z6MkTestKey')
    expect(advert.peerId).toBe('12D3KooWTestPeer')
    expect(Array.isArray(advert.capabilities)).toBe(true)
    expect((advert.capabilities as unknown[]).length).toBe(1)
  })

  it('includes timestamp in the advertisement', () => {
    const ts = Date.now()
    const response: NegotiateResponse = {
      protocolVersion: '1.0.0',
      agentDID: 'did:key:z6MkTest',
      peerId: 'testPeer',
      capabilities: [],
      timestamp: ts,
    }
    const advert = toANPAdvertisement(response)
    expect(advert.timestamp).toBe(ts)
  })
})

// ---------------------------------------------------------------------------
// Built-in capabilities completeness check
// ---------------------------------------------------------------------------

describe('BUILT_IN_CAPABILITIES', () => {
  it('contains at least 7 capabilities', () => {
    expect(BUILT_IN_CAPABILITIES.length).toBeGreaterThanOrEqual(7)
  })

  it('all capabilities have valid NSID format', () => {
    for (const cap of BUILT_IN_CAPABILITIES) {
      expect(isValidNSID(cap.nsid)).toBe(true)
    }
  })

  it('loro-crdt is listed as the store for memory capabilities', () => {
    const memCaps = BUILT_IN_CAPABILITIES.filter(c => c.nsid.startsWith('net.subspace.memory'))
    for (const cap of memCaps) {
      expect(cap.metadata?.store).toBe('loro-crdt')
    }
  })

  it('did-key capability references Ed25519', () => {
    const didCap = BUILT_IN_CAPABILITIES.find(c => c.nsid === 'net.subspace.identity.did-key')
    expect(didCap).toBeDefined()
    expect(didCap?.metadata?.keyType).toBe('Ed25519')
  })
})

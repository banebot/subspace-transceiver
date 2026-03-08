/**
 * Unit tests for DID:Key identity layer.
 *
 * Tests cover:
 * - DID:Key derivation from Ed25519 keypair
 * - DID:Key → public key round-trip
 * - DID Document generation and structure
 * - Invalid DID:Key rejection
 * - agent:// URI with DID:Key authority
 * - Backward compatibility: PeerId URIs still work
 */

import { describe, it, expect } from 'vitest'
import { keys } from '@libp2p/crypto'
import { randomBytes } from 'node:crypto'
import {
  deriveDidKey,
  publicKeyFromDidKey,
  isValidDidKey,
  generateDIDDocument,
  loadOrCreateIdentity,
} from '../src/identity.js'
import { parseAgentURI, buildAgentURI, isAgentURI } from '../src/uri.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

// ---------------------------------------------------------------------------
// DID:Key derivation
// ---------------------------------------------------------------------------

describe('deriveDidKey', () => {
  it('produces a string starting with did:key:z6Mk', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    expect(did).toMatch(/^did:key:z6Mk/)
  })

  it('is deterministic for the same key', async () => {
    const seed = Buffer.from(randomBytes(32))
    const key1 = await keys.generateKeyPairFromSeed('Ed25519', seed)
    const key2 = await keys.generateKeyPairFromSeed('Ed25519', seed)
    expect(deriveDidKey(key1.publicKey)).toBe(deriveDidKey(key2.publicKey))
  })

  it('produces different DIDs for different keys', async () => {
    const key1 = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const key2 = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    expect(deriveDidKey(key1.publicKey)).not.toBe(deriveDidKey(key2.publicKey))
  })

  it('DID length is consistent (~57 chars after did:key:)', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    // did:key:z6Mk + base58btc(34 bytes) ~ 53 + prefix = ~57 chars total key portion
    expect(did.length).toBeGreaterThan(50)
    expect(did.startsWith('did:key:')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DID:Key → public key round-trip
// ---------------------------------------------------------------------------

describe('publicKeyFromDidKey', () => {
  it('round-trips: derive DID, extract pubkey bytes, verify match', async () => {
    const seed = Buffer.from(randomBytes(32))
    const key = await keys.generateKeyPairFromSeed('Ed25519', seed)
    const did = deriveDidKey(key.publicKey)
    const extractedPubKey = publicKeyFromDidKey(did)

    expect(extractedPubKey).toBeInstanceOf(Uint8Array)
    expect(extractedPubKey.length).toBe(32) // Ed25519 pubkey is always 32 bytes
    expect(Buffer.from(extractedPubKey).equals(Buffer.from(key.publicKey.raw))).toBe(true)
  })

  it('throws on non-did:key prefix', () => {
    expect(() => publicKeyFromDidKey('did:web:example.com')).toThrow()
    expect(() => publicKeyFromDidKey('12D3KooWPeerIdString')).toThrow()
    expect(() => publicKeyFromDidKey('')).toThrow()
  })

  it('throws on invalid multicodec prefix', async () => {
    // Craft a fake DID:Key with wrong codec
    const { base58btc } = await import('multiformats/bases/base58')
    const fakeBytes = new Uint8Array([0xed, 0x02, ...new Array(32).fill(0)]) // wrong codec byte
    const fakeEncoded = base58btc.encode(fakeBytes)
    expect(() => publicKeyFromDidKey(`did:key:${fakeEncoded}`)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// isValidDidKey
// ---------------------------------------------------------------------------

describe('isValidDidKey', () => {
  it('returns true for a valid DID:Key', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    expect(isValidDidKey(did)).toBe(true)
  })

  it('returns false for non-DID strings', () => {
    expect(isValidDidKey('12D3KooWPeerIdString')).toBe(false)
    expect(isValidDidKey('did:web:example.com')).toBe(false)
    expect(isValidDidKey('')).toBe(false)
    expect(isValidDidKey('did:key:invalid_base58')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DID Document generation
// ---------------------------------------------------------------------------

describe('generateDIDDocument', () => {
  it('returns a valid JSON-LD DID Document structure', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const peerId = '12D3KooWTestPeerId'

    const doc = generateDIDDocument(did, peerId)

    // Required JSON-LD fields
    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1')
    expect(doc.id).toBe(did)

    // Verification method
    expect(doc.verificationMethod).toHaveLength(1)
    const vm = doc.verificationMethod[0]
    expect(vm.id).toContain(did)
    expect(vm.type).toBe('Ed25519VerificationKey2020')
    expect(vm.controller).toBe(did)
    expect(vm.publicKeyMultibase).toBeTruthy()
    expect(vm.publicKeyMultibase.startsWith('z')).toBe(true)

    // Authentication + assertion
    expect(doc.authentication).toContain(vm.id)
    expect(doc.assertionMethod).toContain(vm.id)

    // Service endpoint (agent://)
    expect(doc.service).toBeDefined()
    const agentService = doc.service!.find(s => s.type === 'SubspaceAgent')
    expect(agentService).toBeDefined()
    expect(agentService!.serviceEndpoint).toBe(`agent://${peerId}`)
  })

  it('includes daemon API endpoint when port is provided', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const doc = generateDIDDocument(did, '12D3KooWTest', 7432)

    const apiService = doc.service?.find(s => s.type === 'SubspaceDaemonAPI')
    expect(apiService).toBeDefined()
    expect(apiService!.serviceEndpoint).toBe('http://localhost:7432')
  })

  it('DID Document id matches the input DID', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const doc = generateDIDDocument(did, 'test-peer')
    expect(doc.id).toBe(did)
  })

  it('publicKeyMultibase in DID Document round-trips to correct pubkey', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const doc = generateDIDDocument(did, 'test-peer')

    const multibaseKey = doc.verificationMethod[0].publicKeyMultibase
    // The multibase key is the DID:Key portion without 'did:key:'
    const extractedPubKey = publicKeyFromDidKey(`did:key:${multibaseKey}`)
    expect(Buffer.from(extractedPubKey).equals(Buffer.from(key.publicKey.raw))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// loadOrCreateIdentity — now returns DID
// ---------------------------------------------------------------------------

describe('loadOrCreateIdentity', () => {
  it('returns a did field', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-id-did-'))
    const identity = await loadOrCreateIdentity(path.join(tmpDir, 'identity.key'))

    expect(identity.did).toBeTruthy()
    expect(identity.did).toMatch(/^did:key:z6Mk/)
    expect(identity.peerId).toBeTruthy()

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('DID is consistent across restarts (derived from same seed)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-id-stable-'))
    const keyPath = path.join(tmpDir, 'identity.key')

    const id1 = await loadOrCreateIdentity(keyPath)
    const id2 = await loadOrCreateIdentity(keyPath)

    expect(id1.did).toBe(id2.did)
    expect(id1.peerId).toBe(id2.peerId)

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('DID round-trips to the same Ed25519 public key as the private key', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subspace-id-roundtrip-'))
    const keyPath = path.join(tmpDir, 'identity.key')
    const identity = await loadOrCreateIdentity(keyPath)

    const extractedPubKey = publicKeyFromDidKey(identity.did)
    expect(
      Buffer.from(extractedPubKey).equals(Buffer.from(identity.privateKey.publicKey.raw))
    ).toBe(true)

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
})

// ---------------------------------------------------------------------------
// agent:// URI with DID:Key authority
// ---------------------------------------------------------------------------

describe('agent:// URI — DID:Key authority', () => {
  it('parseAgentURI accepts a DID:Key as authority', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const uri = `agent://${did}`

    const parsed = parseAgentURI(uri)
    expect(parsed.peerId).toBe(did)
    expect(parsed.isDIDKey).toBe(true)
    expect(parsed.collection).toBeUndefined()
  })

  it('parseAgentURI accepts DID:Key with collection and slug', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const uri = `agent://${did}/patterns/typescript-async`

    const parsed = parseAgentURI(uri)
    expect(parsed.peerId).toBe(did)
    expect(parsed.collection).toBe('patterns')
    expect(parsed.slug).toBe('typescript-async')
    expect(parsed.isDIDKey).toBe(true)
  })

  it('backward compat: PeerId URIs still parse correctly', () => {
    const uri = 'agent://12D3KooWExAmplPeerId/patterns/test-slug'
    const parsed = parseAgentURI(uri)
    expect(parsed.peerId).toBe('12D3KooWExAmplPeerId')
    expect(parsed.collection).toBe('patterns')
    expect(parsed.slug).toBe('test-slug')
    expect(parsed.isDIDKey).toBeUndefined()
  })

  it('isAgentURI returns true for DID:Key-based URIs', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    expect(isAgentURI(`agent://${did}`)).toBe(true)
  })

  it('throws on missing authority', () => {
    expect(() => parseAgentURI('agent://')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// W3C DID Document JSON-LD context validation
// ---------------------------------------------------------------------------

describe('DID Document JSON-LD context', () => {
  it('includes the W3C DID v1 context', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const doc = generateDIDDocument(did, 'test-peer')

    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1')
  })

  it('includes the Ed25519 2020 suite context', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const doc = generateDIDDocument(did, 'test-peer')

    expect(doc['@context']).toContain('https://w3id.org/security/suites/ed25519-2020/v1')
  })

  it('serializes to valid JSON', async () => {
    const key = await keys.generateKeyPairFromSeed('Ed25519', Buffer.from(randomBytes(32)))
    const did = deriveDidKey(key.publicKey)
    const doc = generateDIDDocument(did, 'test-peer', 7432)

    const json = JSON.stringify(doc)
    const parsed = JSON.parse(json)
    expect(parsed.id).toBe(did)
    expect(parsed.verificationMethod).toHaveLength(1)
  })
})

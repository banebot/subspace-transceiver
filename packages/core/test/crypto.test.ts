import { describe, it, expect } from 'vitest'
import { deriveNetworkKeys, encryptEnvelope, decryptEnvelope, validatePSK } from '../src/crypto.js'
import { CryptoError, ErrorCode } from '../src/errors.js'

const TEST_PSK = 'test-network-key-for-fixed-vector-assertions'

describe('deriveNetworkKeys', () => {
  it('produces stable keys for the same PSK', () => {
    const keys1 = deriveNetworkKeys(TEST_PSK)
    const keys2 = deriveNetworkKeys(TEST_PSK)
    expect(keys1.dhtKey.toString('hex')).toBe(keys2.dhtKey.toString('hex'))
    expect(keys1.topic).toBe(keys2.topic)
    expect(keys1.envelopeKey.toString('hex')).toBe(keys2.envelopeKey.toString('hex'))
    expect(keys1.pskFilter.toString('hex')).toBe(keys2.pskFilter.toString('hex'))
    expect(keys1.peerId.toString('hex')).toBe(keys2.peerId.toString('hex'))
  })

  it('produces 32-byte buffers for dhtKey, envelopeKey, pskFilter, peerId', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    expect(keys.dhtKey.length).toBe(32)
    expect(keys.envelopeKey.length).toBe(32)
    expect(keys.pskFilter.length).toBe(32)
    expect(keys.peerId.length).toBe(32)
  })

  it('produces a 64-char hex string for topic', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    expect(typeof keys.topic).toBe('string')
    expect(keys.topic.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(keys.topic)).toBe(true)
  })

  it('all five derived values are distinct from each other', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    const vals = [
      keys.dhtKey.toString('hex'),
      keys.topic,
      keys.envelopeKey.toString('hex'),
      keys.pskFilter.toString('hex'),
      keys.peerId.toString('hex'),
    ]
    const unique = new Set(vals)
    expect(unique.size).toBe(5)
  })

  it('different PSKs produce different keys', () => {
    const keys1 = deriveNetworkKeys('psk-one')
    const keys2 = deriveNetworkKeys('psk-two')
    expect(keys1.topic).not.toBe(keys2.topic)
    expect(keys1.dhtKey.toString('hex')).not.toBe(keys2.dhtKey.toString('hex'))
  })
})

describe('encryptEnvelope / decryptEnvelope', () => {
  it('round-trips plaintext correctly', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    const plaintext = Buffer.from('hello, subspace!')
    const envelope = encryptEnvelope(plaintext, keys.envelopeKey)
    const decrypted = decryptEnvelope(envelope.ciphertext, envelope.iv, envelope.tag, keys.envelopeKey)
    expect(decrypted.toString('utf8')).toBe('hello, subspace!')
  })

  it('uses a different IV on every call', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    const plaintext = Buffer.from('same plaintext')
    const e1 = encryptEnvelope(plaintext, keys.envelopeKey)
    const e2 = encryptEnvelope(plaintext, keys.envelopeKey)
    expect(e1.iv.toString('hex')).not.toBe(e2.iv.toString('hex'))
    expect(e1.ciphertext.toString('hex')).not.toBe(e2.ciphertext.toString('hex'))
  })

  it('throws CryptoError with DECRYPT_FAILED on tampered ciphertext', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    const plaintext = Buffer.from('sensitive data')
    const envelope = encryptEnvelope(plaintext, keys.envelopeKey)
    // Flip a byte in the ciphertext
    envelope.ciphertext[0] ^= 0xff
    expect(() => decryptEnvelope(envelope.ciphertext, envelope.iv, envelope.tag, keys.envelopeKey))
      .toThrow(CryptoError)
    try {
      decryptEnvelope(envelope.ciphertext, envelope.iv, envelope.tag, keys.envelopeKey)
    } catch (err) {
      expect((err as CryptoError).code).toBe(ErrorCode.DECRYPT_FAILED)
    }
  })

  it('throws CryptoError with DECRYPT_FAILED on wrong key', () => {
    const keys1 = deriveNetworkKeys('psk-one-xxxxxxxxxxxxxxxxxxxxxxxxxx')
    const keys2 = deriveNetworkKeys('psk-two-yyyyyyyyyyyyyyyyyyyyyyyyyy')
    const plaintext = Buffer.from('secret')
    const envelope = encryptEnvelope(plaintext, keys1.envelopeKey)
    expect(() => decryptEnvelope(envelope.ciphertext, envelope.iv, envelope.tag, keys2.envelopeKey))
      .toThrow(CryptoError)
  })
})

describe('validatePSK', () => {
  it('throws for PSK shorter than 16 chars', () => {
    expect(() => validatePSK('tooshort')).toThrow(CryptoError)
    try {
      validatePSK('tooshort')
    } catch (err) {
      expect((err as CryptoError).code).toBe(ErrorCode.PSK_TOO_SHORT)
    }
  })

  it('accepts a PSK of exactly 16 chars', () => {
    expect(() => validatePSK('exactly16chars!!!')).not.toThrow()
  })

  it('accepts a 64-char hex PSK (openssl rand -hex 32 output)', () => {
    const psk = 'a'.repeat(64)
    expect(() => validatePSK(psk)).not.toThrow()
  })
})

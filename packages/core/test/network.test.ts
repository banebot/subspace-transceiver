import { describe, it, expect } from 'vitest'
import { deriveNetworkKeys } from '../src/crypto.js'
import { deriveNetworkId } from '../src/network.js'

const TEST_PSK = 'test-network-psk-at-least-32-characters-long'

describe('deriveNetworkKeys — determinism', () => {
  it('same PSK always produces same NetworkKeys', () => {
    const k1 = deriveNetworkKeys(TEST_PSK)
    const k2 = deriveNetworkKeys(TEST_PSK)
    expect(k1.dhtKey.toString('hex')).toBe(k2.dhtKey.toString('hex'))
    expect(k1.topic).toBe(k2.topic)
    expect(k1.envelopeKey.toString('hex')).toBe(k2.envelopeKey.toString('hex'))
    expect(k1.pskFilter.toString('hex')).toBe(k2.pskFilter.toString('hex'))
    expect(k1.peerId.toString('hex')).toBe(k2.peerId.toString('hex'))
  })

  it('all five derived keys are distinct', () => {
    const keys = deriveNetworkKeys(TEST_PSK)
    const vals = new Set([
      keys.dhtKey.toString('hex'),
      keys.topic,
      keys.envelopeKey.toString('hex'),
      keys.pskFilter.toString('hex'),
      keys.peerId.toString('hex'),
    ])
    expect(vals.size).toBe(5)
  })
})

describe('deriveNetworkId', () => {
  it('produces a 64-char hex string', () => {
    const id = deriveNetworkId(TEST_PSK)
    expect(typeof id).toBe('string')
    expect(id.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(id)).toBe(true)
  })

  it('is deterministic', () => {
    expect(deriveNetworkId(TEST_PSK)).toBe(deriveNetworkId(TEST_PSK))
  })

  it('different PSKs produce different IDs', () => {
    expect(deriveNetworkId('psk-one')).not.toBe(deriveNetworkId('psk-two'))
  })
})

/**
 * Unit tests for the Hashcash Proof-of-Work module.
 *
 * Tests cover:
 * - mineStamp / verifyStamp roundtrip
 * - Stamp expiry (wrong window)
 * - Invalid stamps (wrong hash, wrong nonce, wrong bits, tampered challenge)
 * - StampCache — reuse within window, re-mine on window rollover
 * - currentChallenge — determinism and domain separation
 * - hasLeadingZeroBits through the public API (indirect)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mineStamp,
  verifyStamp,
  currentChallenge,
  StampCache,
  DEFAULT_POW_WINDOW_MS,
} from '../src/pow.js'

// Use low bits for fast tests
const TEST_BITS = 8

describe('currentChallenge', () => {
  it('is deterministic for the same inputs', () => {
    const c1 = currentChallenge('peer1', 'chunk', 3_600_000, 42)
    const c2 = currentChallenge('peer1', 'chunk', 3_600_000, 42)
    expect(c1).toBe(c2)
  })

  it('differs across peers (domain separation by peerId)', () => {
    const c1 = currentChallenge('peer1', 'chunk', 3_600_000, 42)
    const c2 = currentChallenge('peer2', 'chunk', 3_600_000, 42)
    expect(c1).not.toBe(c2)
  })

  it('differs across scopes (domain separation by scope)', () => {
    const c1 = currentChallenge('peer1', 'chunk', 3_600_000, 42)
    const c2 = currentChallenge('peer1', 'query', 3_600_000, 42)
    expect(c1).not.toBe(c2)
  })

  it('differs across time windows', () => {
    const c1 = currentChallenge('peer1', 'chunk', 3_600_000, 10)
    const c2 = currentChallenge('peer1', 'chunk', 3_600_000, 11)
    expect(c1).not.toBe(c2)
  })

  it('returns a 64-character hex string (SHA-256)', () => {
    const c = currentChallenge('peer1', 'chunk', 3_600_000, 1)
    expect(c).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('mineStamp', () => {
  it('produces a stamp with the correct structure', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    expect(stamp).toHaveProperty('bits', TEST_BITS)
    expect(stamp).toHaveProperty('challenge')
    expect(stamp).toHaveProperty('nonce')
    expect(stamp).toHaveProperty('hash')
    expect(stamp.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('mines a stamp that passes verifyStamp', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    expect(verifyStamp(stamp, 'peer1', 'chunk', TEST_BITS)).toBe(true)
  })

  it('produces stamps for different scopes independently', async () => {
    const s1 = await mineStamp('peer1', 'chunk', TEST_BITS)
    const s2 = await mineStamp('peer1', 'query', TEST_BITS)
    expect(s1.challenge).not.toBe(s2.challenge)
  })

  it('completes in a reasonable time for 16 bits', async () => {
    const start = Date.now()
    await mineStamp('peer1', 'query', 16)
    const elapsed = Date.now() - start
    // Should complete well under 2 seconds on any modern machine
    expect(elapsed).toBeLessThan(2000)
  }, 10_000)
})

describe('verifyStamp', () => {
  it('rejects a stamp with a tampered hash', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    const tampered = { ...stamp, hash: 'a'.repeat(64) }
    expect(verifyStamp(tampered, 'peer1', 'chunk', TEST_BITS)).toBe(false)
  })

  it('rejects a stamp with a tampered nonce', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    const tampered = { ...stamp, nonce: 'deadbeef' }
    expect(verifyStamp(tampered, 'peer1', 'chunk', TEST_BITS)).toBe(false)
  })

  it('rejects a stamp with a tampered challenge', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    const tampered = { ...stamp, challenge: 'b'.repeat(64) }
    expect(verifyStamp(tampered, 'peer1', 'chunk', TEST_BITS)).toBe(false)
  })

  it('rejects a stamp claiming fewer bits than required', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    // Override bits to claim less than required — should fail the bits >= required check
    const low = { ...stamp, bits: TEST_BITS - 4 }
    expect(verifyStamp(low, 'peer1', 'chunk', TEST_BITS)).toBe(false)
  })

  it('rejects a stamp for a different peerId', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    // Verify as if from peer2 — challenge won't match
    expect(verifyStamp(stamp, 'peer2', 'chunk', TEST_BITS)).toBe(false)
  })

  it('rejects a stamp for a different scope', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    expect(verifyStamp(stamp, 'peer1', 'query', TEST_BITS)).toBe(false)
  })

  it('accepts a stamp from the previous time window (clock-skew grace)', async () => {
    // Mine a stamp for the previous window explicitly
    const windowMs = 3_600_000
    const prevWindowIdx = Math.floor(Date.now() / windowMs) - 1
    const challenge = currentChallenge('peer1', 'chunk', windowMs, prevWindowIdx)

    // Mine against that specific challenge
    const { createHash } = await import('node:crypto')
    let nonce = 0
    let hash = ''
    while (true) {
      const nonceHex = nonce.toString(16)
      hash = createHash('sha256').update(challenge + nonceHex).digest('hex')
      if (hash.startsWith('0'.repeat(Math.floor(TEST_BITS / 4)))) break
      nonce++
    }

    const stamp = { bits: TEST_BITS, challenge, nonce: nonce.toString(16), hash }
    expect(verifyStamp(stamp, 'peer1', 'chunk', TEST_BITS, windowMs)).toBe(true)
  })

  it('rejects a stamp from two windows ago (too old)', async () => {
    // Mine a stamp for two windows back
    const windowMs = 3_600_000
    const oldWindowIdx = Math.floor(Date.now() / windowMs) - 2
    const challenge = currentChallenge('peer1', 'chunk', windowMs, oldWindowIdx)

    const { createHash } = await import('node:crypto')
    let nonce = 0
    let hash = ''
    while (true) {
      const nonceHex = nonce.toString(16)
      hash = createHash('sha256').update(challenge + nonceHex).digest('hex')
      if (hash.startsWith('0'.repeat(Math.floor(TEST_BITS / 4)))) break
      nonce++
    }

    const stamp = { bits: TEST_BITS, challenge, nonce: nonce.toString(16), hash }
    expect(verifyStamp(stamp, 'peer1', 'chunk', TEST_BITS, windowMs)).toBe(false)
  })
})

describe('StampCache', () => {
  let cache: StampCache

  beforeEach(() => {
    cache = new StampCache()
  })

  it('returns null when cache is empty', () => {
    expect(cache.get('chunk', TEST_BITS, DEFAULT_POW_WINDOW_MS)).toBeNull()
  })

  it('stores and retrieves a stamp within the same window', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    cache.set('chunk', TEST_BITS, DEFAULT_POW_WINDOW_MS, stamp, 10)
    const entry = cache.get('chunk', TEST_BITS, DEFAULT_POW_WINDOW_MS)
    expect(entry).not.toBeNull()
    expect(entry!.stamp).toEqual(stamp)
    expect(entry!.bits).toBe(TEST_BITS)
    expect(entry!.mineTimeMs).toBe(10)
  })

  it('returns null for a different scope (different cache key)', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    cache.set('chunk', TEST_BITS, DEFAULT_POW_WINDOW_MS, stamp, 10)
    expect(cache.get('query', TEST_BITS, DEFAULT_POW_WINDOW_MS)).toBeNull()
  })

  it('returns null after the window rolls over (simulated via fake time)', async () => {
    const stamp = await mineStamp('peer1', 'chunk', TEST_BITS)
    cache.set('chunk', TEST_BITS, DEFAULT_POW_WINDOW_MS, stamp, 10)

    // Simulate window rollover by using a tiny window and sleeping
    const tinyWindowMs = 100
    const stamp2 = await mineStamp('peer1', 'chunk', TEST_BITS, tinyWindowMs)
    cache.set('chunk', TEST_BITS, tinyWindowMs, stamp2, 5)

    // Wait for the window to expire
    await new Promise(r => setTimeout(r, 150))

    // Cache should now be stale (different window index)
    const entry = cache.get('chunk', TEST_BITS, tinyWindowMs)
    expect(entry).toBeNull()
  })

  it('getOrMine returns a cached stamp on second call', async () => {
    const s1 = await cache.getOrMine('peer1', 'chunk', TEST_BITS)
    const s2 = await cache.getOrMine('peer1', 'chunk', TEST_BITS)
    // Same stamp object (from cache)
    expect(s1).toEqual(s2)
  })

  it('getAll returns all cached entries', async () => {
    await cache.getOrMine('peer1', 'chunk', TEST_BITS)
    await cache.getOrMine('peer1', 'query', TEST_BITS)
    const all = cache.getAll()
    expect(all.length).toBe(2)
  })

  it('clear removes all entries', async () => {
    await cache.getOrMine('peer1', 'chunk', TEST_BITS)
    cache.clear()
    expect(cache.getAll()).toHaveLength(0)
    expect(cache.get('chunk', TEST_BITS, DEFAULT_POW_WINDOW_MS)).toBeNull()
  })
})

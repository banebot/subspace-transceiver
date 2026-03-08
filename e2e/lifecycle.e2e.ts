/**
 * E2E: Daemon Lifecycle & Global Identity
 *
 * Tests daemon startup, shutdown, PeerId persistence, global connectivity,
 * and multi-daemon isolation. All tests use localhost processes (no Docker).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

// ── Test 1: single daemon health ─────────────────────────────────────────────

describe('daemon starts and becomes healthy', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('reports status:ok with valid PeerId and agentUri', async () => {
    await harness.startAgents(['alpha'])
    const health = await harness.client('alpha').getHealth()

    expect(health.status).toBe('ok')
    // Ed25519 PeerIds encoded in libp2p multihash format start with 12D3KooW
    expect(health.peerId).toMatch(/^12D3KooW/)
    expect(health.agentUri).toBe(`agent://${health.peerId}`)
    // DID:Key identity (Phase 2.1+)
    expect(health.did).toMatch(/^did:key:z/)
    expect(health.version).toBeTruthy()
    expect(typeof health.uptime).toBe('number')
  })
})

// ── Test 2: persistent identity ───────────────────────────────────────────────

describe('daemon generates persistent identity', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('returns the same PeerId after restart', async () => {
    await harness.startAgents(['alpha'])
    const firstPeerId = harness.peerId('alpha')
    expect(firstPeerId).toMatch(/^12D3KooW/)

    // Stop and restart with same dataDir
    await harness.stopAgent('alpha')
    await harness.restartAgent('alpha')

    const secondPeerId = harness.peerId('alpha')
    expect(secondPeerId).toBe(firstPeerId)
  })
})

// ── Test 3: global network connectivity (Iroh transport) ─────────────────────
// Note: Iroh does not use mDNS for peer discovery. Peers connect via relay
// servers or direct QUIC connections. The getPeers() shim currently returns []
// so we test that the global session initialises and agents are healthy.

describe('daemon establishes global network presence via Iroh', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('two agents start with Iroh engine and have unique identities', async () => {
    await harness.startAgents(['alpha', 'beta'])

    const alphaHealth = await harness.client('alpha').getHealth()
    const betaHealth = await harness.client('beta').getHealth()

    // Both agents should be healthy
    expect(alphaHealth.status).toBe('ok')
    expect(betaHealth.status).toBe('ok')

    // Both should have DID:key identities
    expect(alphaHealth.did).toMatch(/^did:key:z/)
    expect(betaHealth.did).toMatch(/^did:key:z/)

    // Identities should be unique
    expect(alphaHealth.did).not.toBe(betaHealth.did)
    expect(alphaHealth.peerId).not.toBe(betaHealth.peerId)
  })
})

// ── Test 4: graceful shutdown and data persistence ────────────────────────────

describe('daemon graceful shutdown', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('persists memory across restart after SIGTERM', async () => {
    await harness.startAgents(['alpha'])
    const psk = randomPsk()

    // Join network and store a chunk
    await harness.client('alpha').joinNetwork(psk)
    const chunk = await harness.client('alpha').putMemory({
      type: 'pattern',
      topic: ['persistence-test'],
      content: 'This should survive a restart.',
      confidence: 0.9,
    })
    expect(chunk.id).toBeTruthy()

    // PID file should exist while running (localhost mode)
    const agent = harness.agents.get('alpha')!
    const pidPath = join(agent.dataDir!, 'daemon.pid')
    // Wait for PID file to appear
    await pollUntil(
      async () => existsSync(pidPath),
      10_000,
      'PID file to be created'
    )

    // Graceful shutdown
    await harness.stopAgent('alpha', 'SIGTERM')
    await sleep(500)

    // PID file should be removed
    expect(existsSync(pidPath)).toBe(false)

    // Restart and verify data persists
    await harness.restartAgent('alpha')

    // Rejoin same PSK network (data dir still has the network config)
    await harness.client('alpha').joinNetwork(psk)
    const retrieved = await harness.client('alpha').getMemory(chunk.id)
    expect(retrieved.content).toBe('This should survive a restart.')
  })
})

// ── Test 5: multiple daemons on same host ─────────────────────────────────────

describe('multiple daemons run concurrently with distinct identities', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('three agents have distinct PeerIds and are all healthy', async () => {
    await harness.startAgents(['alpha', 'beta', 'gamma'])

    const peerIds = new Set<string>()
    for (const name of ['alpha', 'beta', 'gamma']) {
      const health = await harness.client(name).getHealth()
      expect(health.status).toBe('ok')
      peerIds.add(health.peerId)
    }

    // All three PeerIds must be distinct
    expect(peerIds.size).toBe(3)
  })
})

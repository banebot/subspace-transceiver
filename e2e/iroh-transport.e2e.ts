/**
 * E2E: Iroh Transport Layer
 *
 * Tests the Iroh-based transport (Phase 3.x) including:
 * - Daemon startup with Iroh engine stub
 * - DID:Key identity in health endpoint
 * - Capability negotiation (ANP /capabilities endpoint)
 * - Network join/leave with AgentIdentity
 * - EngineBridge lifecycle from daemon perspective
 *
 * These tests verify observable HTTP API behaviour backed by the Iroh transport.
 * Connection-level Iroh QUIC tests require the engine binary and live in cargo tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

// ── Test 1: DID:Key identity in health ───────────────────────────────────────

describe('daemon health exposes DID:Key identity', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('health endpoint includes did field in did:key: format', async () => {
    await harness.startAgents(['alpha'])
    const health = await harness.client('alpha').getHealth()

    expect(health.status).toBe('ok')
    // DID:Key format: did:key:z<base58btc>
    expect(health.did).toMatch(/^did:key:z/)
    // PeerId still works for backward compat
    expect(health.peerId).toMatch(/^12D3KooW/)
  })

  it('DID:Key is stable across restarts', async () => {
    await harness.startAgents(['beta'])
    const firstHealth = await harness.client('beta').getHealth()
    const firstDid = firstHealth.did

    await harness.stopAgent('beta')
    await harness.restartAgent('beta')

    const secondHealth = await harness.client('beta').getHealth()
    expect(secondHealth.did).toBe(firstDid)
  })

  it('different agents have different DIDs', async () => {
    await harness.startAgents(['gamma', 'delta'])
    const gammaDid = (await harness.client('gamma').getHealth()).did
    const deltaDid = (await harness.client('delta').getHealth()).did
    expect(gammaDid).not.toBe(deltaDid)
  })
})

// ── Test 2: ANP Capability negotiation ───────────────────────────────────────

describe('ANP capability negotiation endpoint', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('GET /capabilities returns built-in capabilities list', async () => {
    await harness.startAgents(['alpha'])
    const resp = await fetch(`${harness.url('alpha')}/capabilities`)
    expect(resp.ok).toBe(true)
    const data = await resp.json() as { capabilities: Array<{ nsid: string; version: string }> }
    expect(Array.isArray(data.capabilities)).toBe(true)
    // Built-in capabilities registered in negotiate.ts
    const nsids = data.capabilities.map(c => c.nsid)
    expect(nsids).toContain('net.subspace.memory.skill')
    expect(nsids).toContain('net.subspace.memory.project')
    expect(nsids).toContain('net.subspace.protocol.negotiate')
  })

  it('GET /capabilities/anp returns ANP-format negotiate schema', async () => {
    await harness.startAgents(['beta'])
    const resp = await fetch(`${harness.url('beta')}/capabilities/anp`)
    expect(resp.ok).toBe(true)
    const data = await resp.json() as {
      protocolVersion: string
      agentId: string
      capabilities: Array<{ id: string; version: string }>
    }
    expect(data.protocolVersion).toBe('anp/0.1')
    expect(typeof data.agentId).toBe('string')
    expect(Array.isArray(data.capabilities)).toBe(true)
    // Verify memory.skill is in ANP format
    const memSkill = data.capabilities.find(c => c.id === 'net.subspace.memory.skill')
    expect(memSkill).toBeDefined()
    expect(memSkill!.version).toBeTruthy()
  })
})

// ── Test 3: Network join with AgentIdentity ───────────────────────────────────

describe('network join uses AgentIdentity (Iroh-based)', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('joining a PSK network succeeds and lists the network', async () => {
    await harness.startAgents(['alpha'])
    const psk = randomPsk()
    const joinResp = await harness.client('alpha').joinNetwork(psk)
    expect(joinResp.id).toBeTruthy()

    const networks = await harness.client('alpha').listNetworks()
    const found = networks.find(n => n.id === joinResp.id)
    expect(found).toBeDefined()
  })

  it('can write and read memory chunks after joining a PSK network', async () => {
    await harness.startAgents(['alpha'])
    const psk = randomPsk()
    await harness.client('alpha').joinNetwork(psk)

    const chunk = await harness.client('alpha').putMemory({
      content: 'Iroh transport test chunk',
      collection: 'iroh-test',
      topic: ['iroh', 'phase3'],
    })
    expect(chunk.id).toBeTruthy()

    const retrieved = await harness.client('alpha').getMemory(chunk.id)
    expect(retrieved.content).toBe('Iroh transport test chunk')
    expect(retrieved.topic).toContain('iroh')
  })

  it('can leave a PSK network', async () => {
    await harness.startAgents(['beta'])
    const psk = randomPsk()
    const net = await harness.client('beta').joinNetwork(psk)

    await harness.client('beta').leaveNetwork(net.id)
    const networks = await harness.client('beta').listNetworks()
    const found = networks.find(n => n.id === net.id)
    expect(found).toBeUndefined()
  })
})

// ── Test 4: Engine bridge integration indicators ──────────────────────────────

describe('daemon reflects Iroh engine integration', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('health endpoint includes engine-related fields', async () => {
    await harness.startAgents(['alpha'])
    const health = await harness.client('alpha').getHealth()

    // Both classic peerId and DID:Key should be present
    expect(health.peerId).toBeTruthy()
    expect(health.did).toBeTruthy()
    expect(health.uptime).toBeGreaterThanOrEqual(0)
  })

  it('two daemons can both join same PSK and write independent chunks', async () => {
    await harness.startAgents(['alpha', 'beta'])
    const psk = randomPsk()

    const netAlpha = await harness.client('alpha').joinNetwork(psk)
    const netBeta = await harness.client('beta').joinNetwork(psk)

    // Both join same logical network (same PSK → same network ID)
    expect(netAlpha.id).toBe(netBeta.id)

    const chunkA = await harness.client('alpha').putMemory({
      content: 'Written by alpha via Iroh',
      topic: ['iroh-test'],
      collection: 'iroh-test',
    })
    const chunkB = await harness.client('beta').putMemory({
      content: 'Written by beta via Iroh',
      topic: ['iroh-test'],
      collection: 'iroh-test',
    })

    expect(chunkA.id).not.toBe(chunkB.id)
    // Each agent can read its own chunk locally
    const gotA = await harness.client('alpha').getMemory(chunkA.id)
    const gotB = await harness.client('beta').getMemory(chunkB.id)
    expect(gotA.content).toBe('Written by alpha via Iroh')
    expect(gotB.content).toBe('Written by beta via Iroh')
  })
})

// ── Test 5: Iroh relay config in network bootstrap ────────────────────────────

describe('Iroh relay configuration', () => {
  const harness = new TestHarness()
  afterAll(() => harness.teardown())

  it('daemon starts without SUBSPACE_BOOTSTRAP_ADDRS (Iroh uses own relay)', async () => {
    // The harness already sets SUBSPACE_BOOTSTRAP_ADDRS='' per agent
    // With Iroh, we don't need bootstrap addrs for local connectivity
    await harness.startAgents(['alpha'])
    const health = await harness.client('alpha').getHealth()
    expect(health.status).toBe('ok')
    // Daemon should be healthy even without external bootstrap
  })
})

/**
 * E2E: Cross-Agent Discovery
 *
 * Tests that two separate daemon processes can discover each other via
 * Iroh gossip-based manifest broadcasting.
 *
 * Discovery flow:
 *  1. Both daemons start with their own Iroh endpoints
 *  2. One daemon "introduces" the other via POST /discovery/introduce
 *     (this bootstraps the gossip mesh between them)
 *  3. Each daemon broadcasts its discovery manifest via gossip
 *  4. Both eventually see each other in /discovery/peers
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestHarness } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

describe('cross-agent discovery: two agents find each other', () => {
  const harness = new TestHarness()

  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'], {
      // Speed up manifest broadcasts for tests
      SUBSPACE_MANIFEST_INTERVAL_MS: '2000',
    })
    // Give both daemons time to start their Iroh engines and discovery managers
    await sleep(3000)
  }, 60_000)

  afterAll(() => harness.teardown())

  it('alpha discovers beta after introduction', async () => {
    const betaHealth = await harness.client('beta').getHealth()
    const betaNodeId = betaHealth.nodeId ?? betaHealth.peerId
    expect(betaNodeId).toBeTruthy()

    // Introduce Beta to Alpha's gossip mesh
    // Alpha will gossip-connect to Beta and receive Beta's manifest broadcasts
    await harness.client('alpha').introducePeer(betaNodeId)

    // Trigger an immediate manifest rebroadcast on Beta so Alpha sees it quickly
    await harness.client('beta').rebroadcastManifests()

    // Alpha should discover Beta in its peer list
    await pollUntil(
      async () => {
        const peers = await harness.client('alpha').getDiscoveryPeers()
        return peers.some(p => p.peerId === betaNodeId || p.peerId === betaHealth.peerId)
      },
      30_000,
      'Alpha to discover Beta'
    )

    const peers = await harness.client('alpha').getDiscoveryPeers()
    const beta = peers.find(p => p.peerId === betaNodeId || p.peerId === betaHealth.peerId)
    expect(beta).toBeDefined()
    expect(beta!.agentUri).toContain('agent://')
  }, 40_000)

  it('beta discovers alpha after bidirectional introduction', async () => {
    const alphaHealth = await harness.client('alpha').getHealth()
    const alphaNodeId = alphaHealth.nodeId ?? alphaHealth.peerId

    // Introduce Alpha to Beta's gossip mesh
    await harness.client('beta').introducePeer(alphaNodeId)
    await harness.client('alpha').rebroadcastManifests()

    // Beta should discover Alpha in its peer list
    await pollUntil(
      async () => {
        const peers = await harness.client('beta').getDiscoveryPeers()
        return peers.some(p => p.peerId === alphaNodeId || p.peerId === alphaHealth.peerId)
      },
      30_000,
      'Beta to discover Alpha'
    )

    const peers = await harness.client('beta').getDiscoveryPeers()
    const alpha = peers.find(p => p.peerId === alphaNodeId || p.peerId === alphaHealth.peerId)
    expect(alpha).toBeDefined()
  }, 40_000)

  it('both peers remain discoverable across rebroadcasts', async () => {
    const alphaHealth = await harness.client('alpha').getHealth()
    const betaHealth = await harness.client('beta').getHealth()
    const alphaNodeId = alphaHealth.nodeId ?? alphaHealth.peerId
    const betaNodeId = betaHealth.nodeId ?? betaHealth.peerId

    // Ensure mutual introduction (may already be done from prior tests, idempotent)
    await harness.client('alpha').introducePeer(betaNodeId)
    await harness.client('beta').introducePeer(alphaNodeId)

    // Force multiple rebroadcasts and verify peers remain visible
    for (let i = 0; i < 3; i++) {
      await harness.client('alpha').rebroadcastManifests()
      await harness.client('beta').rebroadcastManifests()
      await sleep(500)
    }

    // Both peers should see each other
    const alphaPeers = await harness.client('alpha').getDiscoveryPeers()
    const betaPeers = await harness.client('beta').getDiscoveryPeers()

    const alphaSesBeta = alphaPeers.some(p =>
      p.peerId === betaNodeId || p.peerId === betaHealth.peerId
    )
    const betaSeesAlpha = betaPeers.some(p =>
      p.peerId === alphaNodeId || p.peerId === alphaHealth.peerId
    )

    expect(alphaSesBeta).toBe(true)
    expect(betaSeesAlpha).toBe(true)
  }, 20_000)
})

describe('cross-agent discovery: self-discovery still works', () => {
  const harness = new TestHarness()

  beforeAll(async () => {
    await harness.startAgents(['alpha'], { SUBSPACE_MANIFEST_INTERVAL_MS: '2000' })
    await sleep(2000)
  }, 60_000)

  afterAll(() => harness.teardown())

  it('alpha appears in its own peer list after manifest broadcast', async () => {
    const health = await harness.client('alpha').getHealth()
    const nodeId = health.nodeId ?? health.peerId

    // Force a rebroadcast
    await harness.client('alpha').rebroadcastManifests()

    await pollUntil(
      async () => {
        const peers = await harness.client('alpha').getDiscoveryPeers()
        return peers.some(p => p.peerId === nodeId || p.peerId === health.peerId)
      },
      20_000,
      'Alpha to appear in its own peer list'
    )

    const peers = await harness.client('alpha').getDiscoveryPeers()
    const self = peers.find(p => p.peerId === nodeId || p.peerId === health.peerId)
    expect(self).toBeDefined()
    expect(self!.agentUri).toContain('agent://')
  }, 25_000)
})

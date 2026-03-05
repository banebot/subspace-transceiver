#!/usr/bin/env node
/**
 * @subspace-net/daemon — entrypoint
 *
 * Parse CLI args, load config, load agent identity, start Fastify API,
 * join known networks, start GC scheduler, handle graceful shutdown.
 *
 * Flags:
 *   --port <n>       Override configured port
 *   --foreground     Stay in foreground (no daemonize) — for Docker/CI
 */

import { parseArgs } from 'node:util'
import dns from 'node:dns/promises'
import {
  joinNetwork,
  leaveNetwork,
  type NetworkSession,
  deriveNetworkId,
  loadOrCreateIdentity,
  RateLimiter,
  ReputationStore,
  StampCache,
  type EpochManager,
  RELAY_ADDRESSES,
} from '@subspace-net/core'
import {
  loadConfig,
  saveConfig,
  ensureDirectories,
  IDENTITY_PATH,
  type DaemonConfig,
} from './config.js'
import { writePid, clearPid, isDaemonRunning } from './lifecycle.js'
import { createApi, registerQueryProtocol, type DaemonState } from './api.js'
import { startGCScheduler } from './gc-scheduler.js'
import type { IMemoryStore } from '@subspace-net/core'

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string' },
    foreground: { type: 'boolean', default: false },
  },
  strict: false,
})

// ---------------------------------------------------------------------------
// Relay health check
// ---------------------------------------------------------------------------

/**
 * Probe a relay multiaddr to check if its DNS resolves.
 * Returns true if the relay is likely reachable, false if DNS is dead.
 * IP-based addresses are assumed reachable without a lookup.
 *
 * Format examples:
 *   /dnsaddr/bootstrap.libp2p.io/p2p/<PeerId>  → resolve bootstrap.libp2p.io
 *   /ip4/1.2.3.4/tcp/4001/p2p/<PeerId>         → always considered reachable
 */
async function probeRelayDns(multiaddr: string): Promise<boolean> {
  const dnsaddrMatch = multiaddr.match(/^\/dnsaddr\/([^/]+)/)
  if (!dnsaddrMatch) {
    // IP4 or IP6 address — no DNS needed
    return true
  }
  const hostname = dnsaddrMatch[1]
  try {
    await dns.resolveTxt(`_dnsaddr.${hostname}`)
    return true
  } catch {
    return false
  }
}

/**
 * Check relay addresses at startup and emit prominent warnings for any that
 * don't resolve. Called once after config is loaded, before joining networks.
 */
async function checkRelayHealth(relayAddresses: string[]): Promise<void> {
  if (relayAddresses.length === 0) {
    console.warn(
      '[subspace] WARNING: No relay addresses configured. NAT traversal (circuit relay v2) ' +
      'is disabled. Agents behind NAT will only be reachable via mDNS on the same LAN. ' +
      'Add relay addresses to ~/.subspace/config.yaml under `relayAddresses:` to enable ' +
      'global connectivity. See https://github.com/libp2p/js-libp2p/tree/main/packages/relay-server'
    )
    return
  }

  // Deduplicate by hostname — avoid redundant DNS probes for the same host
  const hostsSeen = new Set<string>()
  const uniqueAddresses = relayAddresses.filter(addr => {
    const m = addr.match(/^\/dnsaddr\/([^/]+)/)
    if (!m) return true          // IP-based — always include
    if (hostsSeen.has(m[1])) return false
    hostsSeen.add(m[1])
    return true
  })

  const results = await Promise.all(
    uniqueAddresses.map(addr => probeRelayDns(addr).then(ok => ({ addr, ok })))
  )

  const dead = results.filter(r => !r.ok)
  const alive = results.filter(r => r.ok)

  if (dead.length > 0) {
    console.warn(
      `[subspace] WARNING: ${dead.length} relay address(es) failed DNS resolution — ` +
      'NAT traversal will be degraded:\n' +
      dead.map(r => `  ${r.addr}`).join('\n')
    )
  }

  if (alive.length === 0) {
    console.warn(
      '[subspace] CRITICAL: ALL relay addresses are unreachable! ' +
      'Circuit relay v2 NAT traversal will not work. ' +
      'Agents behind NAT cannot connect to each other. ' +
      'Configure a reachable relay via `relayAddresses` in ~/.subspace/config.yaml.'
    )
  } else {
    console.log(
      `[subspace] Relay health: ${alive.length}/${uniqueAddresses.length} address(es) reachable.` +
      (dead.length > 0 ? ` (${dead.length} dead — see warnings above)` : '')
    )
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (isDaemonRunning()) {
    console.error('[subspace] Daemon is already running.')
    process.exit(1)
  }

  let config: DaemonConfig
  try {
    config = await loadConfig()
    if (args.port) {
      config.port = parseInt(args.port as string, 10)
    }
    await ensureDirectories(config)
  } catch (err) {
    console.error('[subspace] Failed to load config:', err)
    process.exit(1)
  }

  // ---------------------------------------------------------------------------
  // Relay health check — warn early if relay DNS is dead or unconfigured
  // ---------------------------------------------------------------------------
  const effectiveRelayAddresses =
    config.relayAddresses.length > 0 ? config.relayAddresses : RELAY_ADDRESSES
  await checkRelayHealth(effectiveRelayAddresses)

  // ---------------------------------------------------------------------------
  // Load (or generate) the persistent agent identity
  // ---------------------------------------------------------------------------
  let identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>
  try {
    identity = await loadOrCreateIdentity(IDENTITY_PATH)
    console.log(`[subspace] Agent identity: ${identity.peerId}`)
  } catch (err) {
    console.error('[subspace] Failed to load agent identity:', err)
    process.exit(1)
  }

  const sessions = new Map<string, NetworkSession>()

  // State shared with the API
  const state: DaemonState = {
    config,
    sessions,
    getPeerId: () => identity.peerId,
    startedAt: Date.now(),
    agentPrivateKey: identity.privateKey,
    rateLimiter: new RateLimiter({
      maxPerWindow: config.security.maxChunksPerPeerPerWindow,
      windowMs: config.security.rateLimitWindowMs,
    }),
    reputation: new ReputationStore(),
    stampCache: new StampCache(),
  }

  // ---------------------------------------------------------------------------
  // Start Fastify API (bind to localhost only)
  // ---------------------------------------------------------------------------
  let app: Awaited<ReturnType<typeof createApi>>
  try {
    app = await createApi(state)
    await app.listen({ port: config.port, host: '127.0.0.1' })
    console.log(`[subspace] Daemon listening on 127.0.0.1:${config.port}`)
  } catch (err) {
    console.error('[subspace] Failed to start API server:', err)
    process.exit(1)
  }

  // ---------------------------------------------------------------------------
  // Write PID file
  // ---------------------------------------------------------------------------
  writePid(config.port)

  // ---------------------------------------------------------------------------
  // Re-join all known networks from config (auto-reconnect on restart)
  // ---------------------------------------------------------------------------
  for (const netConfig of config.networks) {
    try {
      const session = await joinNetwork(netConfig.psk, identity.privateKey, {
        name: netConfig.name,
        dataDir: config.dataDir,
        displayName: config.displayName,
        minConnections: config.security.minPeerConnections,
        trustedBootstrapPeers: config.security.trustedBootstrapPeers,
        // Pass effective relay addresses (config override or built-in fallback)
        relayAddresses: effectiveRelayAddresses,
        subscribedTopics: config.subscriptions.topics,
        subscribedPeers: config.subscriptions.peers,
        // Proof-of-work
        stampCache: state.stampCache,
        powBitsForRequests: config.security.powBitsForRequests,
        powWindowMs: config.security.powWindowMs,
        requirePoW: config.security.requirePoW,
        // Epoch-based database rotation
        epochConfig: config.epochs,
      })
      sessions.set(session.id, session)
      registerQueryProtocol(session, state)
      console.log(
        `[subspace] Joined network ${session.id.slice(0, 8)}… (${session.node.peerId.toString()})`
      )
    } catch (err) {
      console.warn(`[subspace] Could not rejoin network ${deriveNetworkId(netConfig.psk).slice(0, 8)}…:`, err)
    }
  }

  // If agentId is null, use peer ID as fallback
  if (!config.agentId) {
    config.agentId = identity.peerId
  }

  // ---------------------------------------------------------------------------
  // Start GC + epoch rotation scheduler
  // ---------------------------------------------------------------------------
  const gcHandle = startGCScheduler(
    () => {
      const stores: IMemoryStore[] = []
      for (const session of sessions.values()) {
        stores.push(session.stores.skill, session.stores.project)
      }
      return stores
    },
    () => {
      const managers: EpochManager[] = []
      for (const session of sessions.values()) {
        managers.push(session.epochManagers.skill, session.epochManagers.project)
      }
      return managers
    },
  )

  // ---------------------------------------------------------------------------
  // Peer diversity monitor — warn when below minPeerConnections threshold
  // ---------------------------------------------------------------------------
  const diversityHandle = setInterval(() => {
    const minRequired = config.security.minPeerConnections
    for (const session of sessions.values()) {
      const connected = session.node.getPeers().length
      if (connected < minRequired) {
        console.warn(
          `[subspace] Eclipse risk: only ${connected}/${minRequired} peers connected ` +
          `(network: ${session.id.slice(0, 8)}…). Check bootstrap/relay configuration.`
        )
      }
    }
  }, 30_000)

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(`\n[subspace] Received ${signal}, shutting down…`)
    clearInterval(gcHandle)
    clearInterval(diversityHandle)

    // Leave all networks
    for (const session of sessions.values()) {
      await leaveNetwork(session).catch(e => console.warn('[subspace] Leave error:', e))
    }
    sessions.clear()

    // Stop Fastify
    await app.close().catch(e => console.warn('[subspace] Fastify close error:', e))

    // Save config
    await saveConfig(config).catch(() => {})

    clearPid()
    console.log('[subspace] Shutdown complete.')
    process.exit(0)
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))

  process.on('uncaughtException', async (err) => {
    console.error('[subspace] Uncaught exception:', err)
    await shutdown('uncaughtException')
    process.exit(1)
  })

  process.on('unhandledRejection', async (reason) => {
    console.error('[subspace] Unhandled rejection:', reason)
    await shutdown('unhandledRejection')
    process.exit(1)
  })

  if (args.foreground) {
    console.log('[subspace] Running in foreground mode (--foreground). Press Ctrl+C to stop.')
  }
}

main().catch(err => {
  console.error('[subspace] Fatal startup error:', err)
  process.exit(1)
})

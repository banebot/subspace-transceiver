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
  joinGlobalNetwork,
  leaveGlobalNetwork,
  type GlobalSession,
  deriveNetworkId,
  loadOrCreateIdentity,
  RateLimiter,
  ReputationStore,
  StampCache,
  type LoroEpochManager,
  IROH_PUBLIC_RELAYS,
  registerMailboxProtocol,
  CapabilityRegistry,
  registerNegotiateProtocol,
  createFileMailStores,
  pollMail,
  createFileRegistry,
  type ISchemaRegistry,
} from '@subspace-net/core'
import {
  loadConfig,
  saveConfig,
  ensureDirectories,
  getPidPath,
  getIdentityPath,
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
  // Load config first so we can derive the per-instance PID and identity paths.
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

  // Per-instance paths — scoped to this daemon's dataDir so multiple instances
  // on the same machine can coexist without sharing state.
  const pidPath = getPidPath(config.dataDir)
  const identityPath = getIdentityPath(config.dataDir)

  if (isDaemonRunning(pidPath)) {
    console.error('[subspace] Daemon is already running.')
    process.exit(1)
  }

  // ---------------------------------------------------------------------------
  // Relay health check — warn early if relay DNS is dead or unconfigured
  // ---------------------------------------------------------------------------
  const effectiveRelayAddresses =
    config.relayAddresses.length > 0 ? config.relayAddresses : [...IROH_PUBLIC_RELAYS]
  await checkRelayHealth(effectiveRelayAddresses)

  // ---------------------------------------------------------------------------
  // Load (or generate) the persistent agent identity
  // Stored in <dataDir>/identity.key so each daemon instance has a unique
  // Ed25519 keypair and a distinct libp2p PeerId.
  // ---------------------------------------------------------------------------
  let identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>
  try {
    identity = await loadOrCreateIdentity(identityPath)
    console.log(`[subspace] Agent identity: ${identity.peerId}`)
    console.log(`[subspace] Agent DID:      ${identity.did}`)
  } catch (err) {
    console.error('[subspace] Failed to load agent identity:', err)
    process.exit(1)
  }

  const sessions = new Map<string, NetworkSession>()

  // ---------------------------------------------------------------------------
  // Start the always-on global network session
  // ---------------------------------------------------------------------------
  // The global session connects the agent to the open Subspace internet before
  // any PSK networks are joined. It provides:
  //   - A globally routable identity via circuit relay (agent://<peerId>)
  //   - Public discovery manifest broadcasting on the well-known GossipSub topic
  //   - Browse protocol support for any peer on the internet
  //   - No PSK required — global presence is automatic
  //
  // PSK networks (joinNetwork calls below) are overlays on top of this.
  let globalSession: GlobalSession | null = null
  try {
    globalSession = await joinGlobalNetwork(identity, {
      displayName: config.displayName,
      minConnections: config.security.minPeerConnections,
      trustedBootstrapPeers: config.security.trustedBootstrapPeers,
      relayAddresses: effectiveRelayAddresses,
      subscribedTopics: config.subscriptions.topics,
      subscribedPeers: config.subscriptions.peers,
      stampCache: new StampCache(),  // separate stamp cache for global session manifests
      powBitsForRequests: config.security.powBitsForRequests,
      powWindowMs: config.security.powWindowMs,
      requirePoW: config.security.requirePoW,
    })
    console.log(
      `[subspace] Connected to global Subspace network. ` +
      `Your agent is globally addressable at: agent://${identity.peerId}`
    )
  } catch (err) {
    console.warn(
      '[subspace] WARNING: Could not establish global network connection. ' +
      'Agent will not be globally addressable until connectivity is restored. ' +
      'PSK networks can still function locally. Error:', err
    )
    globalSession = null
  }

  // ---------------------------------------------------------------------------
  // Initialize schema registry
  // ---------------------------------------------------------------------------
  let schemaRegistry: ISchemaRegistry | undefined
  try {
    const { join } = await import('node:path')
    const schemaCacheDir = join(config.dataDir, 'schemas')
    schemaRegistry = await createFileRegistry(schemaCacheDir)
    console.log('[subspace] Schema registry initialized.')
  } catch (err) {
    console.warn('[subspace] WARNING: Could not initialize schema registry:', err)
  }

  // ---------------------------------------------------------------------------
  // Initialize mail stores (if mailbox is enabled)
  // ---------------------------------------------------------------------------
  let mailStores: Awaited<ReturnType<typeof createFileMailStores>> | undefined
  if (config.mailbox.enabled) {
    try {
      mailStores = await createFileMailStores(config.dataDir)
      console.log('[subspace] Mailbox initialized.')
    } catch (err) {
      console.warn('[subspace] WARNING: Could not initialize mail stores:', err)
    }
  }

  // ---------------------------------------------------------------------------
  // Capability registry — ANP-compatible negotiation
  // ---------------------------------------------------------------------------
  const capabilityRegistry = new CapabilityRegistry()

  // Register negotiate protocol (bridge-based in Phase 3.5)
  if (globalSession) {
    registerNegotiateProtocol(
      globalSession.bridge,
      capabilityRegistry,
      identity.peerId,
      identity.did,
    )
  }

  // State shared with the API
  const state: DaemonState = {
    config,
    globalSession,
    sessions,
    getPeerId: () => identity.peerId,
    getDID: () => identity.did,
    capabilityRegistry,
    startedAt: Date.now(),
    agentIdentity: identity,
    rateLimiter: new RateLimiter({
      maxPerWindow: config.security.maxChunksPerPeerPerWindow,
      windowMs: config.security.rateLimitWindowMs,
    }),
    reputation: new ReputationStore(),
    stampCache: new StampCache(),
    mailStores,
    schemaRegistry,
  }

  // ---------------------------------------------------------------------------
  // Re-join all known networks from config BEFORE opening the HTTP port.
  // This prevents a race where a client (or test) connects immediately after
  // app.listen() and calls POST /networks for a PSK that the daemon is ALSO
  // trying to auto-rejoin — both paths would try to open the same LevelDB
  // concurrently, causing "Database failed to open".
  // ---------------------------------------------------------------------------
  for (const netConfig of config.networks) {
    try {
      const session = await joinNetwork(netConfig.psk, identity, {
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
  // Write PID file (in dataDir so it's scoped to this instance)
  // ---------------------------------------------------------------------------
  writePid(config.port, pidPath)

  // ---------------------------------------------------------------------------
  // Register mailbox protocol + start mail poller
  // ---------------------------------------------------------------------------
  let mailPollHandle: ReturnType<typeof setInterval> | null = null
  if (config.mailbox.enabled && mailStores) {
    // Register the mailbox protocol via EngineBridge
    const mailBridge = state.globalSession?.bridge ?? null
    {
      try {
        await registerMailboxProtocol(mailBridge, {
          relayStore: mailStores.relay,
          inboxStore: mailStores.inbox,
          recipientPeerId: identity.peerId,
          recipientKey: identity.privateKey as Parameters<typeof registerMailboxProtocol>[1]['recipientKey'],
          autoDecrypt: true,
          maxCheckResults: 50,
        })
        console.log('[subspace] Mailbox protocol registered.')
      } catch (err) {
        console.warn('[subspace] Could not register mailbox protocol:', err)
      }

      // Poll for pending mail on startup and periodically
      const doPoll = async () => {
        const relayPeers: string[] = [
          ...(mailBridge?.isRunning ? await mailBridge.peerList() : []),
        ]
        if (relayPeers.length > 0 && mailStores) {
          const newMail = await pollMail(mailBridge, relayPeers, {
            recipientPeerId: identity.peerId,
            recipientKey: identity.privateKey as Parameters<typeof pollMail>[2]['recipientKey'],
            inboxStore: mailStores.inbox,
          })
          if (newMail > 0) {
            console.log(`[subspace] Received ${newMail} new mail message(s).`)
          }
        }
      }

      // Initial poll after 5s (let mesh form first)
      setTimeout(() => doPoll().catch(() => {}), 5_000)
      mailPollHandle = setInterval(() => doPoll().catch(() => {}), config.mailbox.pollIntervalMs)
    }
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
      const managers: LoroEpochManager[] = []
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
    if (mailPollHandle) clearInterval(mailPollHandle)

    // Leave all PSK networks first
    for (const session of sessions.values()) {
      await leaveNetwork(session).catch(e => console.warn('[subspace] Leave error:', e))
    }
    sessions.clear()

    // Leave the global network last (it was started first)
    if (state.globalSession) {
      await leaveGlobalNetwork(state.globalSession).catch(
        e => console.warn('[subspace] Global network leave error:', e)
      )
    }

    // Stop Fastify
    await app.close().catch(e => console.warn('[subspace] Fastify close error:', e))

    // Save config
    await saveConfig(config).catch(() => {})

    clearPid(pidPath)
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

  process.on('unhandledRejection', (reason) => {
    // Log but don't crash the daemon.  OrbitDB and libp2p create many
    // fire-and-forget promises for P2P operations (GossipSub publish,
    // DHT queries, connection upgrades) that can legitimately fail when
    // peers disconnect or the mesh is unstable.  Crashing on every such
    // failure makes the daemon extremely fragile in test environments.
    // uncaughtException (synchronous throws) still triggers a clean shutdown.
    console.warn('[subspace] Unhandled rejection (non-fatal):', reason)
  })

  if (args.foreground) {
    console.log('[subspace] Running in foreground mode (--foreground). Press Ctrl+C to stop.')
  }
}

main().catch(err => {
  console.error('[subspace] Fatal startup error:', err)
  process.exit(1)
})

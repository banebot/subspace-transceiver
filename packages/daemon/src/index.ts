#!/usr/bin/env node
/**
 * @subspace/daemon — entrypoint
 *
 * Parse CLI args, load config, load agent identity, start Fastify API,
 * join known networks, start GC scheduler, handle graceful shutdown.
 *
 * Flags:
 *   --port <n>       Override configured port
 *   --foreground     Stay in foreground (no daemonize) — for Docker/CI
 */

import { parseArgs } from 'node:util'
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
} from '@subspace/core'
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
import type { IMemoryStore } from '@subspace/core'

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

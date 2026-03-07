/**
 * E2E Test Harness for Subspace Transceiver.
 *
 * Supports two execution modes:
 *   - localhost: spawns daemon processes directly (fast, requires npm run build)
 *   - docker:    uses docker compose (isolated, no port conflicts)
 *
 * Mode is selected via E2E_MODE env var (default: localhost).
 *
 * Key design principles:
 *  1. No bootstrap pollution — SUBSPACE_BOOTSTRAP_ADDRS="" prevents daemons from
 *     announcing to the global bootstrap network.  Relay addresses remain enabled so
 *     PSK nodes can do NAT traversal.  PSK peers are connected explicitly via the
 *     /networks/:id/dial API rather than relying on mDNS auto-dial (libp2p v3
 *     does not auto-dial peers discovered via mDNS).
 *  2. Fresh data dirs per test run — no cross-test contamination.
 *  3. Clean teardown — kills all processes, removes all temp dirs.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DaemonClient } from './helpers/http.js'
import { pollUntil, sleep } from './helpers/wait.js'

export const E2E_MODE = (process.env.E2E_MODE ?? 'localhost') as 'localhost' | 'docker'

// Base port for localhost agents — start far above 7432 to avoid conflicts with
// any real daemon running on the developer's machine.
const BASE_PORT = 17432

// Path to the daemon entrypoint (pre-built by `npm run build`)
const REPO_ROOT = new URL('..', import.meta.url).pathname
const DAEMON_ENTRY = join(REPO_ROOT, 'packages/daemon/dist/index.js')

export interface AgentHandle {
  /** Logical name (e.g. 'alpha', 'beta') */
  name: string
  /** HTTP API base URL */
  url: string
  /** Resolved PeerId string (populated after waitForHealth) */
  peerId: string
  /** TCP port */
  port: number
  /** Temp data directory (localhost mode only) */
  dataDir?: string
  /** Child process (localhost mode only) */
  process?: ChildProcess
  /** Typed HTTP client */
  client: DaemonClient
}

/**
 * Central test harness — create one per test file in beforeAll/afterAll.
 *
 * @example
 * let harness: TestHarness
 * beforeAll(async () => {
 *   harness = new TestHarness()
 *   await harness.startAgents(['alpha', 'beta'])
 * })
 * afterAll(() => harness.teardown())
 */
export class TestHarness {
  public agents = new Map<string, AgentHandle>()
  private tempDirs: string[] = []
  private processes: ChildProcess[] = []

  /**
   * Start named agents and wait for each to be healthy.
   *
   * @param names     Agent names (e.g. ['alpha', 'beta'])
   * @param extraEnv  Additional env vars for all agents
   */
  async startAgents(
    names: string[],
    extraEnv: Record<string, string> = {}
  ): Promise<void> {
    if (E2E_MODE === 'docker') {
      await this.startDockerAgents(names)
    } else {
      await this.startLocalAgents(names, extraEnv)
    }

    // Wait for all agents to become healthy in parallel
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        pollUntil(
          async () => {
            try {
              const h = await agent.client.getHealth()
              agent.peerId = h.peerId
              return h.status === 'ok'
            } catch {
              return false
            }
          },
          30_000,
          `${agent.name} daemon to become healthy`
        )
      )
    )
  }

  private async startLocalAgents(
    names: string[],
    extraEnv: Record<string, string>
  ): Promise<void> {
    const runId = randomBytes(4).toString('hex')

    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      // Each vitest worker gets a non-overlapping 500-port slice of the range.
      // VITEST_WORKER_ID is 1-indexed (1..maxForks).  Within each worker slice
      // a random 0–199 offset separates concurrent harnesses in the same fork.
      // This prevents EADDRINUSE collisions even when many test files run in
      // parallel across 8 forks.
      const workerId = parseInt(process.env.VITEST_WORKER_ID ?? '1', 10)
      const workerBase = BASE_PORT + (workerId - 1) * 500
      const port = workerBase + i + parseInt(runId.slice(0, 2), 16) % 200
      const dataDir = join(tmpdir(), `subspace-e2e-${runId}-${i}`)
      await mkdir(dataDir, { recursive: true })
      this.tempDirs.push(dataDir)

      const env: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
        ),
        SUBSPACE_AGENT_ID: name,
        SUBSPACE_DATA_DIR: dataDir,
        // Disable public bootstrap/relay — use mDNS only for local tests
        SUBSPACE_BOOTSTRAP_ADDRS: process.env.SUBSPACE_BOOTSTRAP_ADDRS ?? '',
        SUBSPACE_RELAY_ADDRS: process.env.SUBSPACE_RELAY_ADDRS ?? '',
        // Testability knobs (override to speed up slow timers)
        SUBSPACE_MANIFEST_INTERVAL_MS: process.env.SUBSPACE_MANIFEST_INTERVAL_MS ?? '5000',
        SUBSPACE_GC_INTERVAL_MS: process.env.SUBSPACE_GC_INTERVAL_MS ?? '2000',
        ...extraEnv,
      }

      const proc = spawn('node', ['--no-warnings', DAEMON_ENTRY, '--foreground', '--port', String(port)], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      // Stream daemon logs with agent prefix for debugging
      proc.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          process.stderr.write(`  [${name}] ${line}\n`)
        }
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          process.stderr.write(`  [${name}!] ${line}\n`)
        }
      })

      this.processes.push(proc)

      const client = new DaemonClient(`http://127.0.0.1:${port}`)
      this.agents.set(name, {
        name,
        url: `http://127.0.0.1:${port}`,
        peerId: '',
        port,
        dataDir,
        process: proc,
        client,
      })
    }
  }

  private async startDockerAgents(names: string[]): Promise<void> {
    // Docker mode: agents are already running via docker-compose.
    // Read URLs from env vars (set by docker-compose runner container).
    for (const name of names) {
      const urlEnv = `${name.toUpperCase()}_URL`
      const url = process.env[urlEnv]
      if (!url) throw new Error(`Docker mode: missing ${urlEnv} env var`)

      const client = new DaemonClient(url)
      this.agents.set(name, {
        name,
        url,
        peerId: '',
        port: 7432,
        client,
      })
    }
  }

  /** Get a typed client for a named agent. */
  client(name: string): DaemonClient {
    const agent = this.agents.get(name)
    if (!agent) throw new Error(`Unknown agent: ${name}`)
    return agent.client
  }

  /** Get the PeerId of a named agent (resolved after startAgents). */
  peerId(name: string): string {
    const agent = this.agents.get(name)
    if (!agent || !agent.peerId) throw new Error(`Agent ${name} not started or peerId not resolved`)
    return agent.peerId
  }

  /**
   * Wait until all agents have at least minPeers connected peers
   * on the global network.
   */
  async waitForMesh(minPeers: number = 1, timeoutMs: number = 30_000): Promise<void> {
    // Proactively try to connect global peers early — doesn't wait for mesh.
    // This uses the listen-port fallback to construct reliable dial addresses.
    void this.connectGlobalPeers().catch(() => {})

    await Promise.all(
      [...this.agents.values()].map((agent) =>
        pollUntil(
          async () => {
            // Retry connectGlobalPeers on each poll iteration if no peers yet
            const h = await agent.client.getHealth()
            if (h.globalPeers < minPeers) {
              void this.connectGlobalPeers().catch(() => {})
            }
            return h.globalPeers >= minPeers
          },
          timeoutMs,
          `${agent.name} to have >= ${minPeers} global peers`
        )
      )
    )

    // Explicitly connect global nodes to each other via direct TCP dial.
    // libp2p v3 does not auto-dial mDNS-discovered peers, and the relay-only
    // connection doesn't give us direct peer-to-peer connectivity needed by
    // the browse protocol (browse requires direct connection to the target peer).
    await this.connectGlobalPeers()
  }

  /**
   * Explicitly connect all agents' global libp2p nodes to each other.
   * Fetches each agent's global TCP multiaddrs and has every other agent
   * dial them directly, ensuring that browse and other direct-dial protocols work.
   */
  async connectGlobalPeers(): Promise<void> {
    const names = [...this.agents.keys()]
    if (names.length < 2) return

    // Wait up to 3s for each agent to expose at least one TCP multiaddr.
    // The listen socket may take a moment to announce its addresses.
    const globalAddrs = new Map<string, string[]>()
    for (const name of names) {
      let tcpAddrs: string[] = []
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(500)
        const h = await this.client(name).getHealth()
        tcpAddrs = (h.globalMultiaddrs ?? []).filter(
          (ma) => ma.includes('/tcp/') &&
                  !ma.includes('p2p-circuit') &&
                  !ma.includes('/ip4/0.0.0.0') &&
                  !ma.includes('/ip6/::/')
        )
        if (tcpAddrs.length > 0) break
      }
      globalAddrs.set(name, tcpAddrs)
    }

    // Have each agent dial every other agent's global TCP addresses via POST /dial
    const dialPromises: Promise<unknown>[] = []
    for (const fromName of names) {
      for (const [toName, addrs] of globalAddrs) {
        if (toName === fromName || addrs.length === 0) continue
        dialPromises.push(
          this.client(fromName)
            .dialGlobal(addrs[0])
            .catch(() => {/* ignore transient failures */})
        )
      }
    }
    await Promise.all(dialPromises)
  }

  /**
   * Join all agents to the same PSK network and wait for mesh connectivity.
   * Returns the PSK used (generated randomly unless provided).
   */
  async joinAllToPsk(
    psk?: string,
    agentNames?: string[]
  ): Promise<{ psk: string; networkId: string }> {
    const effectivePsk = psk ?? randomBytes(32).toString('hex')
    const names = agentNames ?? [...this.agents.keys()]

    const results = await Promise.all(
      names.map((name) => this.client(name).joinNetwork(effectivePsk))
    )

    const networkId = results[0].id

    if (names.length > 1) {
      // ------------------------------------------------------------------
      // Explicit peer exchange: libp2p v3 does not auto-dial peers that are
      // discovered via mDNS.  To bootstrap PSK connectivity we:
      //   1. Collect each agent's PSK node multiaddrs (returned in the
      //      NetworkInfoDTO since we added the `multiaddrs` field).
      //   2. Give each agent the TCP multiaddrs of every OTHER agent so it
      //      can establish a direct connection.
      // This avoids relying on mDNS auto-discovery timing.
      // ------------------------------------------------------------------

      // Step 1: collect multiaddrs — poll until each agent has at least one TCP addr.
      // Under heavy parallel load the PSK node may take a few seconds to bind its
      // listen socket and announce multiaddrs via getMultiaddrs().
      const peerAddrs: Map<string, string[]> = new Map()
      for (const name of names) {
        await pollUntil(
          async () => {
            const nets = await this.client(name).getNetworks()
            const net = nets.find((n) => n.id === networkId)
            const tcpAddrs = (net?.multiaddrs ?? []).filter(
              (ma) => ma.includes('/tcp/') && !ma.includes('p2p-circuit')
            )
            if (tcpAddrs.length > 0) {
              peerAddrs.set(name, tcpAddrs)
              return true
            }
            return false
          },
          5_000,
          `${name} to expose a TCP multiaddr for PSK network ${networkId}`
        ).catch(() => {
          // If still no addrs after 5s, proceed with empty (dial will be skipped)
          if (!peerAddrs.has(name)) peerAddrs.set(name, [])
        })
      }

      // Step 2: have each agent dial every other agent's PSK node
      const dialPromises: Promise<void>[] = []
      for (const fromName of names) {
        for (const [toName, addrs] of peerAddrs) {
          if (toName === fromName || addrs.length === 0) continue
          // Dial the first TCP multiaddr — others are alternative transports
          dialPromises.push(
            this.client(fromName)
              .dialPskPeer(networkId, addrs[0])
              .then(() => {
                // success — connection bootstrapped
              })
              .catch(() => {
                // ignore — peer may already be connected or dial may fail transiently
              })
          )
        }
      }
      await Promise.all(dialPromises)

      // Step 3: verify connectivity
      await Promise.all(
        names.map((name) =>
          pollUntil(
            async () => {
              const nets = await this.client(name).getNetworks()
              const net = nets.find((n) => n.id === networkId)
              return (net?.peers ?? 0) >= 1
            },
            30_000,
            `${name} to have >= 1 peer in PSK network`
          )
        )
      )
    }

    // Brief stabilization pause — lets the GossipSub mesh form between the
    // newly-connected PSK peers before tests start publishing/subscribing.
    if (names.length > 1) {
      await sleep(2000)
    }

    return { psk: effectivePsk, networkId }
  }

  /**
   * Explicitly wire PSK peers together after they have already joined a network.
   * libp2p v3 does not auto-dial mDNS-discovered peers, so after any agent
   * joins (or restarts into) an existing PSK network we must manually connect
   * it to the others.
   *
   * @param networkId  – The PSK network's SHA-256 fingerprint (from `joinNetwork`)
   * @param names      – Agent names that should be interconnected
   */
  async connectPskPeers(networkId: string, names: string[]): Promise<void> {
    if (names.length < 2) return

    // Give nodes a moment to finish binding their listening sockets
    await sleep(500)

    // Collect each agent's TCP multiaddrs for this network
    const peerAddrs = new Map<string, string[]>()
    for (const name of names) {
      const nets = await this.client(name).getNetworks()
      const net = nets.find((n) => n.id === networkId)
      const tcpAddrs = (net?.multiaddrs ?? []).filter(
        (ma) => ma.includes('/tcp/') && !ma.includes('p2p-circuit')
      )
      peerAddrs.set(name, tcpAddrs)
    }

    // Dial every other agent
    const dialPromises: Promise<unknown>[] = []
    for (const fromName of names) {
      for (const [toName, addrs] of peerAddrs) {
        if (toName === fromName || addrs.length === 0) continue
        dialPromises.push(
          this.client(fromName)
            .dialPskPeer(networkId, addrs[0])
            .catch(() => {/* ignore transient failures */})
        )
      }
    }
    await Promise.all(dialPromises)

    // Wait until every agent has at least 1 peer
    await Promise.all(
      names.map((name) =>
        pollUntil(
          async () => {
            const nets = await this.client(name).getNetworks()
            const net = nets.find((n) => n.id === networkId)
            return (net?.peers ?? 0) >= 1
          },
          30_000,
          `${name} to have >= 1 peer in PSK network after reconnect`
        )
      )
    )
  }

  /**
   * Stop a specific agent's process.
   * For SIGTERM: waits up to 10s for graceful shutdown, then force-kills with SIGKILL.
   * For SIGKILL: immediately force-kills.
   * Does not remove the agent from the map — can be restarted.
   */
  async stopAgent(name: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const agent = this.agents.get(name)
    if (!agent?.process) return

    // Helper: process is done if it exited normally OR was killed by a signal.
    // exitCode is null for signal-killed processes; signalCode is non-null.
    const hasDied = () =>
      agent.process!.exitCode !== null || agent.process!.signalCode !== null

    // No-op if already dead
    if (hasDied()) return

    agent.process.kill(signal)

    if (signal === 'SIGTERM') {
      // Give the daemon up to 10s to shut down gracefully
      const exited = await pollUntil(
        async () => hasDied(),
        10_000,
        `${name} graceful shutdown`
      ).then(() => true).catch(() => false)

      if (!exited) {
        // Graceful shutdown timed out — force kill
        try { agent.process.kill('SIGKILL') } catch { /* already dead */ }
        await pollUntil(
          async () => hasDied(),
          5_000,
          `${name} process to exit after SIGKILL`
        )
      }
    } else {
      await pollUntil(
        async () => hasDied(),
        5_000,
        `${name} process to exit`
      )
    }
  }

  /**
   * Restart an agent (must have been started in localhost mode).
   * Sends SIGTERM, waits for exit, then spawns a new process with the same config.
   */
  async restartAgent(name: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const agent = this.agents.get(name)
    if (!agent?.process || !agent.dataDir) throw new Error(`Cannot restart ${name}: not a local process`)

    await this.stopAgent(name)

    // Give the OS 3s to fully release LevelDB file locks from the stopped
    // process before the new daemon opens the same databases.  Without this
    // grace period we frequently see "Database failed to open" on restart.
    await sleep(3000)

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
      ),
      SUBSPACE_AGENT_ID: name,
      SUBSPACE_DATA_DIR: agent.dataDir,
      SUBSPACE_BOOTSTRAP_ADDRS: process.env.SUBSPACE_BOOTSTRAP_ADDRS ?? '',
      SUBSPACE_RELAY_ADDRS: process.env.SUBSPACE_RELAY_ADDRS ?? '',
      SUBSPACE_MANIFEST_INTERVAL_MS: process.env.SUBSPACE_MANIFEST_INTERVAL_MS ?? '5000',
      SUBSPACE_GC_INTERVAL_MS: process.env.SUBSPACE_GC_INTERVAL_MS ?? '2000',
      ...extraEnv,
    }

    const proc = spawn('node', ['--no-warnings', DAEMON_ENTRY, '--foreground', '--port', String(agent.port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        process.stderr.write(`  [${name}↺] ${line}\n`)
      }
    })

    this.processes.push(proc)
    agent.process = proc

    // Wait for healthy again
    await pollUntil(
      async () => {
        try {
          const h = await agent.client.getHealth()
          agent.peerId = h.peerId
          return h.status === 'ok'
        } catch {
          return false
        }
      },
      30_000,
      `${name} to become healthy after restart`
    )
  }

  /**
   * Stop all agents and clean up temp directories.
   */
  async teardown(): Promise<void> {
    // Kill all processes
    for (const proc of this.processes) {
      try {
        proc.kill('SIGTERM')
      } catch {
        // already dead
      }
    }

    // Give them a moment to exit cleanly
    await sleep(1000)

    // Force-kill any stragglers
    for (const proc of this.processes) {
      if (proc.exitCode === null) {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }
    }

    // Remove temp dirs
    await Promise.allSettled(
      this.tempDirs.map((d) => rm(d, { recursive: true, force: true }))
    )

    this.agents.clear()
    this.processes.length = 0
    this.tempDirs.length = 0
  }
}

/**
 * Generate a random 32-byte hex PSK (suitable for network creation).
 */
export function randomPsk(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Compute percentiles from an array of numbers.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

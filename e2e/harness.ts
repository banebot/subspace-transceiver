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
 *     announcing to the global bootstrap network. Relay addresses remain enabled so
 *     PSK nodes can do NAT traversal via Iroh's relay infrastructure.
 *  2. Fresh data dirs per test run — no cross-test contamination.
 *  3. Clean teardown — kills all processes, removes all temp dirs.
 *  4. Iroh transport — peer connectivity uses Iroh QUIC + gossip. No libp2p mDNS.
 *     Replication happens asynchronously via iroh-gossip delta sync (ReplicationManager).
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

  /** Get the base URL for a named agent. */
  url(name: string): string {
    const agent = this.agents.get(name)
    if (!agent) throw new Error(`Agent ${name} not started`)
    return agent.url
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
  /**
   * Wait for all agents to be healthy (Iroh engine started).
   *
   * With Iroh transport, peer discovery is relay-based and asynchronous.
   * This method verifies each agent is up and the engine is running,
   * rather than waiting for a specific peer count.
   *
   * @param _minPeers  Ignored — kept for API compatibility with old tests
   * @param timeoutMs  How long to wait for each agent to become healthy
   */
  async waitForMesh(_minPeers: number = 1, timeoutMs: number = 30_000): Promise<void> {
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        pollUntil(
          async () => {
            const h = await agent.client.getHealth()
            return h.status === 'ok'
          },
          timeoutMs,
          `${agent.name} to be healthy`
        )
      )
    )
  }

  /**
   * @deprecated Iroh manages QUIC connections natively. This is a no-op.
   */
  async connectGlobalPeers(): Promise<void> {
    // Iroh uses relay servers + QUIC for connectivity. No explicit dial needed.
  }

  /**
   * Join all (or specified) agents to the same PSK network.
   *
   * With Iroh transport, peer discovery and replication are handled
   * asynchronously via iroh-gossip. There is no TCP multiaddr exchange or
   * peer mesh verification — agents join the gossip topic and replicate when
   * Iroh establishes QUIC connections.
   *
   * Returns the PSK and network ID. Tests that need replication convergence
   * should poll for the expected data rather than checking peer counts.
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
    return { psk: effectivePsk, networkId }
  }

  /**
   * Ensure PSK peers are ready for replication tests.
   *
   * With Iroh transport, peers connect via relay and QUIC automatically.
   * This is a no-op kept for API compatibility — Iroh handles connectivity.
   */
  async connectPskPeers(_networkId: string, _names: string[]): Promise<void> {
    // Iroh manages QUIC connections natively via gossip topic membership.
    // No manual peer wiring is required.
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

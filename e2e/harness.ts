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
 *  1. No public internet — SUBSPACE_BOOTSTRAP_ADDRS="" + SUBSPACE_RELAY_ADDRS=""
 *     forces mDNS-only peer discovery on localhost.
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
      const port = BASE_PORT + i + parseInt(runId.slice(0, 2), 16) % 100
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
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        pollUntil(
          async () => {
            const h = await agent.client.getHealth()
            return h.globalPeers >= minPeers
          },
          timeoutMs,
          `${agent.name} to have >= ${minPeers} global peers`
        )
      )
    )
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

    // Wait for all agents to have at least 1 peer in the PSK network
    if (names.length > 1) {
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

    return { psk: effectivePsk, networkId }
  }

  /**
   * Stop a specific agent's process (SIGTERM for graceful shutdown).
   * Does not remove the agent from the map — can be restarted.
   */
  async stopAgent(name: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const agent = this.agents.get(name)
    if (!agent?.process) return

    agent.process.kill(signal)

    await pollUntil(
      async () => agent.process!.exitCode !== null,
      15_000,
      `${name} process to exit`
    )
  }

  /**
   * Restart an agent (must have been started in localhost mode).
   * Sends SIGTERM, waits for exit, then spawns a new process with the same config.
   */
  async restartAgent(name: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const agent = this.agents.get(name)
    if (!agent?.process || !agent.dataDir) throw new Error(`Cannot restart ${name}: not a local process`)

    await this.stopAgent(name)

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

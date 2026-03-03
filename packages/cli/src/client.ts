/**
 * HTTP client for the agent-net daemon.
 *
 * All methods call ensureDaemon() before making requests — if the daemon
 * is not running, it is automatically started and polled for up to 10s.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DaemonError, ErrorCode } from '@agent-net/core'
import type { MemoryChunk, MemoryQuery, NetworkInfoDTO } from '@agent-net/core'

const PID_PATH = join(homedir(), '.agent-net', 'daemon.pid')

// ---------------------------------------------------------------------------
// Daemon auto-start
// ---------------------------------------------------------------------------

/**
 * Check if the daemon is reachable. Returns true if healthy.
 */
async function isDaemonHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Ensure the daemon is running. If not, spawn it and wait up to 10s.
 * Throws DaemonError with DAEMON_TIMEOUT if it doesn't come up.
 */
export async function ensureDaemon(port: number = 7432): Promise<void> {
  if (await isDaemonHealthy(port)) return

  // Not running — spawn daemon.
  // Resolution order:
  //   1. Monorepo / dev: sibling package dist (packages/daemon/dist/index.js)
  //   2. npm global install: resolve @agent-net/daemon via import.meta.resolve
  //   3. Compiled binary (bun build --compile): re-spawn self with --_daemon flag

  const monoPath = fileURLToPath(new URL('../../daemon/dist/index.js', import.meta.url))

  let spawnExec: string
  let spawnArgs: string[]

  if (existsSync(monoPath)) {
    // Case 1: monorepo / local dev
    spawnExec = process.execPath
    spawnArgs = [monoPath, `--port`, String(port)]
  } else {
    // Case 2: npm installed — try import.meta.resolve (ESM-safe, no require)
    let npmDaemonPath: string | null = null
    try {
      npmDaemonPath = fileURLToPath(import.meta.resolve('@agent-net/daemon'))
    } catch {
      // Not available (compiled binary or missing package)
    }

    if (npmDaemonPath && existsSync(npmDaemonPath)) {
      spawnExec = process.execPath
      spawnArgs = [npmDaemonPath, `--port`, String(port)]
    } else {
      // Case 3: compiled binary — spawn self in daemon mode
      spawnExec = process.argv[0]
      spawnArgs = [`--_daemon`, `--port`, String(port)]
    }
  }

  const child = spawn(spawnExec, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  // Poll until healthy (up to 10s)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    if (await isDaemonHealthy(port)) return
  }

  throw new DaemonError(
    'Daemon failed to start within 10 seconds.',
    ErrorCode.DAEMON_TIMEOUT
  )
}

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

export class DaemonClient {
  private baseUrl: string
  private port: number

  constructor(port: number = 7432) {
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    await ensureDaemon(this.port)
    // Only set Content-Type when there is a request body — Fastify rejects
    // Content-Type: application/json on bodyless requests (DELETE, etc.).
    const hasBody = !!init?.body
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText, code: 'API_ERROR' }))
      throw new DaemonError(
        body.error ?? `HTTP ${res.status}`,
        body.code ?? ErrorCode.API_ERROR
      )
    }
    // 204 No Content
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------
  async health(): Promise<{
    status: string
    peerId: string
    networks: NetworkInfoDTO[]
    uptime: number
    version: string
  }> {
    return this.fetch('/health')
  }

  // ---------------------------------------------------------------------------
  // Networks
  // ---------------------------------------------------------------------------
  async listNetworks(): Promise<NetworkInfoDTO[]> {
    return this.fetch('/networks')
  }

  async joinNetwork(psk: string, name?: string): Promise<NetworkInfoDTO> {
    return this.fetch('/networks', {
      method: 'POST',
      body: JSON.stringify({ psk, name }),
    })
  }

  async leaveNetwork(networkId: string): Promise<void> {
    return this.fetch(`/networks/${networkId}`, { method: 'DELETE' })
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------
  async putMemory(chunk: Partial<MemoryChunk>): Promise<MemoryChunk> {
    return this.fetch('/memory', {
      method: 'POST',
      body: JSON.stringify(chunk),
    })
  }

  async getMemory(id: string): Promise<MemoryChunk> {
    return this.fetch(`/memory/${id}`)
  }

  async queryMemory(q: MemoryQuery): Promise<MemoryChunk[]> {
    return this.fetch('/memory/query', {
      method: 'POST',
      body: JSON.stringify(q),
    })
  }

  async searchMemory(freetext: string, q?: MemoryQuery): Promise<MemoryChunk[]> {
    return this.fetch('/memory/search', {
      method: 'POST',
      body: JSON.stringify({ freetext, ...q }),
    })
  }

  async updateMemory(id: string, content: string, confidence?: number): Promise<MemoryChunk> {
    return this.fetch(`/memory/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content, confidence }),
    })
  }

  async forgetMemory(id: string): Promise<void> {
    return this.fetch(`/memory/${id}`, { method: 'DELETE' })
  }
}

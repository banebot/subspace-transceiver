/**
 * HTTP client for the Subspace Transceiver daemon.
 *
 * All methods call ensureDaemon() before making requests — if the daemon
 * is not running, it is automatically started and polled for up to 10s.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DaemonError, ErrorCode } from '@subspace-net/core'
import type {
  MemoryChunk,
  MemoryQuery,
  NetworkInfoDTO,
  ContentLink,
} from '@subspace-net/core'
import type {
  ChunkStub,
  BrowseResponse,
  PeerIndexEntry,
} from '@subspace-net/core'

const PID_PATH = join(homedir(), '.subspace', 'daemon.pid')

// ---------------------------------------------------------------------------
// Daemon auto-start
// ---------------------------------------------------------------------------

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

export async function ensureDaemon(port: number = 7432): Promise<void> {
  if (await isDaemonHealthy(port)) return

  const monoPath = fileURLToPath(new URL('../../daemon/dist/index.js', import.meta.url))

  let spawnExec: string
  let spawnArgs: string[]

  if (existsSync(monoPath)) {
    spawnExec = process.execPath
    spawnArgs = [monoPath, `--port`, String(port)]
  } else {
    let npmDaemonPath: string | null = null
    try {
      npmDaemonPath = fileURLToPath(import.meta.resolve('@subspace-net/daemon'))
    } catch { /* not available */ }

    if (npmDaemonPath && existsSync(npmDaemonPath)) {
      spawnExec = process.execPath
      spawnArgs = [npmDaemonPath, `--port`, String(port)]
    } else {
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

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    if (await isDaemonHealthy(port)) return
  }

  throw new DaemonError('Daemon failed to start within 10 seconds.', ErrorCode.DAEMON_TIMEOUT)
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
      throw new DaemonError(body.error ?? `HTTP ${res.status}`, body.code ?? ErrorCode.API_ERROR)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------
  async health(): Promise<{
    status: string
    peerId: string
    agentUri: string
    /** True once the agent has at least one peer on the global Subspace network */
    globalConnected: boolean
    /** Number of peers connected on the global (non-PSK) network */
    globalPeers: number
    /** Private PSK network sessions */
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
    return this.fetch('/networks', { method: 'POST', body: JSON.stringify({ psk, name }) })
  }

  async leaveNetwork(networkId: string): Promise<void> {
    return this.fetch(`/networks/${networkId}`, { method: 'DELETE' })
  }

  // ---------------------------------------------------------------------------
  // Memory — CRUD
  // ---------------------------------------------------------------------------
  async putMemory(chunk: Partial<MemoryChunk>): Promise<MemoryChunk> {
    return this.fetch('/memory', { method: 'POST', body: JSON.stringify(chunk) })
  }

  async getMemory(id: string): Promise<MemoryChunk> {
    return this.fetch(`/memory/${id}`)
  }

  async queryMemory(q: MemoryQuery): Promise<MemoryChunk[]> {
    return this.fetch('/memory/query', { method: 'POST', body: JSON.stringify(q) })
  }

  async searchMemory(freetext: string, q?: MemoryQuery): Promise<MemoryChunk[]> {
    return this.fetch('/memory/search', { method: 'POST', body: JSON.stringify({ freetext, ...q }) })
  }

  async updateMemory(id: string, content: string, confidence?: number, links?: ContentLink[]): Promise<MemoryChunk> {
    return this.fetch(`/memory/${id}`, { method: 'PATCH', body: JSON.stringify({ content, confidence, links }) })
  }

  async forgetMemory(id: string): Promise<void> {
    return this.fetch(`/memory/${id}`, { method: 'DELETE' })
  }

  // ---------------------------------------------------------------------------
  // Memory — content graph
  // ---------------------------------------------------------------------------
  async getLinks(id: string): Promise<{ id: string; links: ContentLink[] }> {
    return this.fetch(`/memory/${id}/links`)
  }

  async getBacklinks(id: string): Promise<MemoryChunk[]> {
    return this.fetch(`/memory/${id}/backlinks`)
  }

  async traverseGraph(startId: string, rels?: string[], maxDepth?: number): Promise<{
    nodes: MemoryChunk[]
    edges: Array<{ source: string; target: string; rel: string; label?: string }>
    traversedFrom: string
  }> {
    return this.fetch('/memory/graph', {
      method: 'POST',
      body: JSON.stringify({ startId, rels, maxDepth }),
    })
  }

  // ---------------------------------------------------------------------------
  // Namespaces / site
  // ---------------------------------------------------------------------------
  async resolveURI(uri: string): Promise<MemoryChunk> {
    // Strip 'agent://' prefix — the route uses a wildcard
    const path = uri.replace(/^agent:\/\//, '')
    return this.fetch(`/resolve/${path}`)
  }

  async getSite(peerId: string): Promise<{
    peerId: string
    profile: MemoryChunk | null
    collections: string[]
    chunkCount: number
    agentUri: string
  }> {
    return this.fetch(`/site/${peerId}`)
  }

  async getSiteCollection(peerId: string, collection: string, opts?: { limit?: number; since?: number }): Promise<{
    peerId: string
    collection: string
    chunks: MemoryChunk[]
    agentUri: string
  }> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.since) params.set('since', String(opts.since))
    const qs = params.toString() ? `?${params}` : ''
    return this.fetch(`/site/${peerId}/${collection}${qs}`)
  }

  // ---------------------------------------------------------------------------
  // Discovery / browse
  // ---------------------------------------------------------------------------
  async getDiscoveryPeers(): Promise<Array<{
    peerId: string
    displayName?: string
    collections: string[]
    chunkCount: number
    updatedAt: number
    agentUri: string
  }>> {
    return this.fetch('/discovery/peers')
  }

  async getDiscoveryTopics(): Promise<Array<{
    topic: string
    peerCount: number
    peers: string[]
  }>> {
    return this.fetch('/discovery/topics')
  }

  async checkTopicOnPeer(peerId: string, topic: string): Promise<{ peerId: string; topic: string; probably: boolean | null }> {
    const params = new URLSearchParams({ peerId, topic })
    return this.fetch(`/discovery/topic-check?${params}`)
  }

  async browse(peerId: string, opts?: { collection?: string; since?: number; limit?: number }): Promise<BrowseResponse> {
    const params = new URLSearchParams()
    if (opts?.collection) params.set('collection', opts.collection)
    if (opts?.since) params.set('since', String(opts.since))
    if (opts?.limit) params.set('limit', String(opts.limit))
    const qs = params.toString() ? `?${params}` : ''
    return this.fetch(`/browse/${peerId}${qs}`)
  }

  // ---------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------
  async getReputation(): Promise<Array<{ peerId: string; score: number; blacklisted: boolean; permanent: boolean }>> {
    return this.fetch('/security/reputation')
  }

  async clearPeerBlacklist(peerId: string): Promise<void> {
    return this.fetch(`/security/reputation/${peerId}`, { method: 'DELETE' })
  }

  async getPowStatus(): Promise<{
    peerId: string
    config: {
      powBitsForChunks: number
      powBitsForRequests: number
      powWindowMs: number
      requirePoW: boolean
    }
    cachedStamps: Array<{
      scope: string
      bits: number
      windowMs: number
      minedAt: number
      mineTimeMs: number
      windowIndex: number
    }>
    benchmark: {
      bitsUsed: number
      mineTimeMs: number
      stamp: import('@subspace-net/core').HashcashStamp | null
    }
  }> {
    return this.fetch('/security/pow-status')
  }
}

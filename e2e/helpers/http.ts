/**
 * Typed HTTP client for the Subspace daemon REST API.
 * Wraps fetch() with typed request/response shapes and error handling.
 */

// ── Wire types (mirrors daemon/src/api.ts shapes) ────────────────────────────

export interface HealthResponse {
  status: string
  peerId: string
  /** Iroh NodeId — use this as `to` when sending mail. */
  nodeId?: string
  /** Full Iroh endpoint address for passing as address hints. */
  nodeAddr?: {
    nodeId: string
    relayUrl?: string
    directAddrs: string[]
  }
  /** DID:Key identity (did:key:z...) — added in Phase 2.1 */
  did?: string
  agentUri: string
  globalConnected: boolean
  globalPeers: number
  globalMultiaddrs: string[]
  networks: NetworkInfoDTO[]
  uptime: number
  version: string
}

export interface NetworkInfoDTO {
  id: string
  name?: string
  peerId: string
  peers: number
  namespaces: ['skill', 'project']
  knownPeers: number
  multiaddrs: string[]
}

export interface MemoryChunk {
  id: string
  type: string
  namespace: string
  topic: string[]
  content: string
  source: {
    agentId: string
    peerId: string
    project?: string
    sessionId?: string
    timestamp: number
  }
  ttl?: number
  confidence: number
  network?: string
  version: number
  supersedes?: string
  signature?: string
  pow?: {
    challenge: string
    nonce: number
    bits: number
  }
  collection?: string
  slug?: string
  contentEnvelope?: { body: string; encoding: string }
  links?: ContentLink[]
  origin?: string
  _tombstone?: boolean
}

export interface ContentLink {
  target: string
  rel: string
  label?: string
}

export interface MemoryQuery {
  topics?: string[]
  namespace?: string
  peerId?: string
  collection?: string
  since?: number
  limit?: number
  freetext?: string
}

export interface PeerInfo {
  peerId: string
  displayName?: string
  collections: string[]
  chunkCount: number
  updatedAt: number
  lastSeen: number
  agentUri: string
}

export interface TopicInfo {
  topic: string
  peerCount: number
  peers: string[]
}

export interface ReputationEntry {
  peerId: string
  score: number
  blacklisted: boolean
}

// ── Client ───────────────────────────────────────────────────────────────────

export class DaemonClient {
  constructor(public readonly baseUrl: string) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    // Use Connection: close to prevent stale keepalive connections from being
    // reused after a daemon restart (SIGKILL closes the TCP socket, and Node's
    // fetch pool would otherwise retry on the broken connection → fetch failed).
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (res.status === 204) return undefined as T

    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`Non-JSON response from ${method} ${path} (${res.status}): ${text}`)
    }

    if (!res.ok) {
      const err = data as { error?: string; code?: string }
      throw Object.assign(
        new Error(err.error ?? `HTTP ${res.status} from ${method} ${path}`),
        { status: res.status, code: err.code, data }
      )
    }

    return data as T
  }

  /** Generic POST helper for arbitrary endpoints */
  async post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('POST', path, body)
  }

  /** Generic GET helper for arbitrary endpoints */
  async get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.req<T>('GET', path)
  }

  async getHealth(): Promise<HealthResponse> {
    return this.req<HealthResponse>('GET', '/health')
  }

  async getNetworks(): Promise<NetworkInfoDTO[]> {
    return this.req<NetworkInfoDTO[]>('GET', '/networks')
  }

  /** Alias for getNetworks() */
  async listNetworks(): Promise<NetworkInfoDTO[]> {
    return this.getNetworks()
  }

  async joinNetwork(psk: string, name?: string): Promise<NetworkInfoDTO> {
    return this.req<NetworkInfoDTO>('POST', '/networks', { psk, name })
  }

  async leaveNetwork(networkId: string): Promise<void> {
    return this.req<void>('DELETE', `/networks/${networkId}`)
  }



  async dialPskPeer(networkId: string, multiaddr: string): Promise<{ ok: boolean }> {
    return this.req<{ ok: boolean }>('POST', `/networks/${networkId}/dial`, { multiaddr })
  }

  async dialGlobal(multiaddr: string): Promise<{ ok: boolean }> {
    return this.req<{ ok: boolean }>('POST', '/dial', { multiaddr })
  }

  async putMemory(chunk: Partial<MemoryChunk>): Promise<MemoryChunk> {
    return this.req<MemoryChunk>('POST', '/memory', chunk)
  }

  async getMemory(id: string): Promise<MemoryChunk> {
    return this.req<MemoryChunk>('GET', `/memory/${id}`)
  }

  async updateMemory(
    id: string,
    patch: { content?: string; confidence?: number; links?: ContentLink[] }
  ): Promise<MemoryChunk> {
    return this.req<MemoryChunk>('PATCH', `/memory/${id}`, patch)
  }

  async forgetMemory(id: string): Promise<void> {
    return this.req<void>('DELETE', `/memory/${id}`)
  }

  async queryMemory(query: MemoryQuery): Promise<MemoryChunk[]> {
    return this.req<MemoryChunk[]>('POST', '/memory/query', query)
  }

  async searchMemory(freetext: string, extra?: MemoryQuery): Promise<MemoryChunk[]> {
    return this.req<MemoryChunk[]>('POST', '/memory/search', { freetext, ...extra })
  }

  async getLinks(id: string): Promise<{ id: string; links: ContentLink[] }> {
    return this.req<{ id: string; links: ContentLink[] }>('GET', `/memory/${id}/links`)
  }

  async getBacklinks(id: string): Promise<MemoryChunk[]> {
    return this.req<MemoryChunk[]>('GET', `/memory/${id}/backlinks`)
  }

  async traverseGraph(
    startId: string,
    opts?: { rels?: string[]; maxDepth?: number }
  ): Promise<{ nodes: MemoryChunk[]; edges: Array<{ source: string; target: string; rel: string }>; traversedFrom: string }> {
    return this.req('POST', '/memory/graph', { startId, ...opts })
  }

  async getDiscoveryPeers(): Promise<PeerInfo[]> {
    return this.req<PeerInfo[]>('GET', '/discovery/peers')
  }

  async getDiscoveryTopics(): Promise<TopicInfo[]> {
    return this.req<TopicInfo[]>('GET', '/discovery/topics')
  }

  async checkTopic(peerId: string, topic: string): Promise<{ peerId: string; topic: string; probably: boolean | null }> {
    return this.req('GET', `/discovery/topic-check?peerId=${encodeURIComponent(peerId)}&topic=${encodeURIComponent(topic)}`)
  }

  async rebroadcastManifests(): Promise<void> {
    await this.req('POST', '/discovery/rebroadcast')
  }

  /** Introduce a remote peer to the local gossip mesh for discovery. */
  async introducePeer(nodeId: string): Promise<void> {
    await this.req('POST', '/discovery/introduce', { nodeId })
  }

  /** Browse a remote peer's public content stubs. */
  async browse(
    peerId: string,
    opts: { nodeId?: string; collection?: string; since?: number; limit?: number; directAddrs?: string } = {}
  ): Promise<{ stubs: Array<{ id: string; title?: string; collection?: string; topic: string[]; updated_at: number }>; hasMore: boolean }> {
    const params = new URLSearchParams()
    if (opts.nodeId) params.set('nodeId', opts.nodeId)
    if (opts.collection) params.set('collection', opts.collection)
    if (opts.since !== undefined) params.set('since', String(opts.since))
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.directAddrs) params.set('directAddrs', opts.directAddrs)
    const qs = params.toString()
    return this.req('GET', `/browse/${peerId}${qs ? '?' + qs : ''}`)
  }



  async getSite(peerId: string): Promise<{ peerId: string; profile: MemoryChunk | null; collections: string[]; chunkCount: number; agentUri: string }> {
    return this.req('GET', `/site/${peerId}`)
  }

  async resolveUri(agentUri: string): Promise<MemoryChunk> {
    // Strip agent:// prefix, pass rest as path param
    const path = agentUri.replace(/^agent:\/\//, '')
    return this.req('GET', `/resolve/${path}`)
  }

  async getReputation(): Promise<ReputationEntry[]> {
    return this.req<ReputationEntry[]>('GET', '/security/reputation')
  }

  async clearReputation(peerId: string): Promise<void> {
    return this.req<void>('DELETE', `/security/reputation/${encodeURIComponent(peerId)}`)
  }

  async getPowStatus(): Promise<unknown> {
    return this.req('GET', '/security/pow-status')
  }

  async sendMail(to: string, body: string, subject?: string): Promise<{ ok: boolean; mode: string }> {
    return this.req('POST', '/mail/send', { to, body, subject })
  }

  /** Send mail with full address hints for faster Iroh connection setup. */
  async sendMailWithHints(
    to: string,
    body: string,
    subject: string | undefined,
    toNodeAddr?: { relayUrl?: string; directAddrs?: string[] }
  ): Promise<{ ok: boolean; mode: string }> {
    return this.req('POST', '/mail/send', { to, body, subject, toNodeAddr })
  }

  async getInbox(): Promise<unknown[]> {
    return this.req<unknown[]>('GET', '/mail/inbox')
  }

  async getInboxMessage(id: string): Promise<unknown> {
    return this.req('GET', `/mail/inbox/${id}`)
  }

  async deleteInboxMessage(id: string): Promise<void> {
    return this.req('DELETE', `/mail/inbox/${id}`)
  }

  async getOutbox(): Promise<unknown[]> {
    return this.req<unknown[]>('GET', '/mail/outbox')
  }
}

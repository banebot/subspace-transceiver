/**
 * Fastify HTTP API for the Subspace Transceiver daemon.
 *
 * Binds ONLY to 127.0.0.1 — never 0.0.0.0 (AC 10).
 * All error responses: { error: string, code: string }
 *
 * NEW ENDPOINTS (beyond original):
 *
 * Namespaces / site (TODO-054945bb):
 *   GET  /resolve/:uri              — resolve an agent:// URI to a chunk
 *   GET  /site/:peerId              — get agent profile + collections
 *   GET  /site/:peerId/:collection  — list chunks in a collection
 *
 * Content linking (TODO-e07a6eaf):
 *   GET  /memory/:id/links          — outgoing links from a chunk
 *   GET  /memory/:id/backlinks      — chunks that link TO this chunk
 *   POST /memory/graph              — traverse the link graph N hops
 *
 * Discovery / browse (TODO-a1fcd540):
 *   GET  /discovery/peers           — known peers with topic summaries
 *   GET  /discovery/topics          — network-wide topic aggregation
 *   GET  /browse/:peerId            — browse remote peer's site
 *   GET  /browse/:peerId/:collection — browse a specific collection
 *
 * Security diagnostics (TODO-ebb16396):
 *   GET  /security/reputation       — peer reputation scores
 *   DELETE /security/reputation/:peerId — clear a peer's blacklist
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { peerIdFromString } from '@libp2p/peer-id'
import type { DaemonConfig } from './config.js'
import {
  joinNetwork,
  leaveNetwork,
  sessionToDTO,
  deriveNetworkId,
  type NetworkSession,
  type NetworkInfoDTO,
  validatePSK,
  validateChunk,
  resolveHeads,
  sendQuery,
  QUERY_PROTOCOL,
  encodeMessage,
  decodeMessage,
  type MemoryChunk,
  type MemoryQuery,
  ErrorCode,
  AgentNetError,
  // Security
  RateLimiter,
  ReputationStore,
  signChunk,
  verifyChunkSignature,
  // URI
  parseAgentURI,
  isAgentURI,
  buildAgentURI,
  // Content graph
  BacklinkIndex,
  // Discovery
  type ChunkStub,
  // Proof-of-work
  StampCache,
  mineStamp,
  verifyStamp,
} from '@subspace-net/core'
import type { PrivateKey } from '@libp2p/interface'
import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'

const VERSION = '0.2.0'

export interface DaemonState {
  config: DaemonConfig
  sessions: Map<string, NetworkSession>
  getPeerId: () => string
  startedAt: number
  /** Agent identity private key for signing published chunks */
  agentPrivateKey: PrivateKey
  /** Shared rate limiter (across all sessions) */
  rateLimiter: RateLimiter
  /** Shared reputation store (across all sessions) */
  reputation: ReputationStore
  /** Proof-of-work stamp cache — avoids re-mining every request */
  stampCache: StampCache
}

// Typed duplex for protocol handler
interface DuplexStream {
  source: AsyncIterable<Uint8Array>
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>
}

// ---------------------------------------------------------------------------
// Security enforcement helpers
// ---------------------------------------------------------------------------

/**
 * Check ingest security constraints for a chunk:
 *  1. Peer not blacklisted
 *  2. Content size within limits
 *  3. Rate limit not exceeded
 *  4. Signature valid (if present or required)
 *
 * Returns { ok: true } or { ok: false, status, error, code }.
 */
async function checkIngestSecurity(
  chunk: Partial<MemoryChunk>,
  state: DaemonState
): Promise<{ ok: true } | { ok: false; status: number; error: string; code: string }> {
  const { security } = state.config
  const peerId = chunk.source?.peerId ?? ''

  // 1. Blacklist check
  if (peerId && state.reputation.isBlacklisted(peerId)) {
    return {
      ok: false,
      status: 403,
      error: `Peer ${peerId} is blacklisted`,
      code: ErrorCode.PEER_BLACKLISTED,
    }
  }

  // 2. Content size checks
  const contentLen = Buffer.byteLength(chunk.content ?? '', 'utf8')
  if (contentLen > security.maxChunkContentBytes) {
    if (peerId) state.reputation.record(peerId, 'OVERSIZED_CONTENT')
    return {
      ok: false,
      status: 413,
      error: `content exceeds max size (${contentLen} > ${security.maxChunkContentBytes} bytes)`,
      code: ErrorCode.CONTENT_TOO_LARGE,
    }
  }

  const envelopeBodyLen = Buffer.byteLength(
    chunk.contentEnvelope?.body ?? '', 'utf8'
  )
  if (envelopeBodyLen > security.maxEnvelopeBodyBytes) {
    if (peerId) state.reputation.record(peerId, 'OVERSIZED_CONTENT')
    return {
      ok: false,
      status: 413,
      error: `contentEnvelope.body exceeds max size (${envelopeBodyLen} > ${security.maxEnvelopeBodyBytes} bytes)`,
      code: ErrorCode.CONTENT_TOO_LARGE,
    }
  }

  // 3. Rate limit
  if (peerId && !state.rateLimiter.check(peerId)) {
    state.reputation.record(peerId, 'RATE_LIMIT_VIOLATION')
    state.rateLimiter.softBan(peerId, 60_000)  // 1 minute soft ban
    return {
      ok: false,
      status: 429,
      error: `Rate limit exceeded for peer ${peerId}`,
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
    }
  }

  // 4. Signature verification (when present)
  if (chunk.signature && peerId) {
    try {
      const peerIdObj = peerIdFromString(peerId)
      const pubKey = peerIdObj.publicKey
      if (pubKey) {
        const valid = await verifyChunkSignature(chunk as MemoryChunk, pubKey)
        if (!valid) {
          state.reputation.record(peerId, 'SIGNATURE_FAILURE')
          return {
            ok: false,
            status: 400,
            error: `Signature verification failed for chunk from peer ${peerId}`,
            code: ErrorCode.SIGNATURE_INVALID,
          }
        }
      }
    } catch (err) {
      // If we can't verify (e.g. non-Ed25519 PeerId), warn and allow
      console.warn('[subspace] Could not verify chunk signature:', err)
    }
  } else if (!chunk.signature && security.requireSignatures) {
    return {
      ok: false,
      status: 400,
      error: 'Unsigned chunk rejected — security.requireSignatures is enabled',
      code: ErrorCode.SIGNATURE_INVALID,
    }
  }

  // 5. Proof-of-work verification (when stamp present, or requirePoW is true)
  if (chunk.pow && peerId) {
    const valid = verifyStamp(
      chunk.pow,
      peerId,
      'chunk',
      security.powBitsForChunks,
      security.powWindowMs,
    )
    if (!valid) {
      state.reputation.record(peerId, 'SIGNATURE_FAILURE')
      return {
        ok: false,
        status: 400,
        error: `Proof-of-work stamp invalid for chunk from peer ${peerId}`,
        code: ErrorCode.PROOF_OF_WORK_INVALID,
      }
    }
  } else if (!chunk.pow && security.requirePoW) {
    return {
      ok: false,
      status: 400,
      error: 'Chunk rejected — security.requirePoW is enabled and no PoW stamp provided',
      code: ErrorCode.PROOF_OF_WORK_INVALID,
    }
  } else if (!chunk.pow) {
    // No stamp and not required — warn but allow (backward compat)
    if (peerId) {
      console.warn(`[subspace] Chunk from peer ${peerId} has no PoW stamp (requirePoW=false, allowing)`)
    }
  }

  // All checks passed — record valid ingest
  if (peerId) {
    state.rateLimiter.record(peerId)
    state.reputation.record(peerId, 'VALID_CONTENT')
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// API factory
// ---------------------------------------------------------------------------

export async function createApi(state: DaemonState): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // ---------------------------------------------------------------------------
  // GET /health
  // ---------------------------------------------------------------------------
  app.get('/health', async (_req, reply) => {
    const networks = [...state.sessions.values()].map(sessionToDTO)
    return reply.send({
      status: 'ok',
      peerId: state.getPeerId(),
      networks,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
      version: VERSION,
    })
  })

  // ---------------------------------------------------------------------------
  // GET /networks
  // ---------------------------------------------------------------------------
  app.get('/networks', async (_req, reply) => {
    return reply.send([...state.sessions.values()].map(sessionToDTO))
  })

  // ---------------------------------------------------------------------------
  // POST /networks — join or create
  // ---------------------------------------------------------------------------
  app.post('/networks', async (req, reply) => {
    const body = req.body as { psk?: string; name?: string }
    if (!body?.psk) {
      return reply.status(400).send({ error: 'psk is required', code: ErrorCode.JOIN_FAILED })
    }
    try {
      validatePSK(body.psk)
    } catch (err) {
      const e = err as AgentNetError
      return reply.status(400).send({ error: e.message, code: e.code })
    }

    const networkId = deriveNetworkId(body.psk)
    if (state.sessions.has(networkId)) {
      return reply.status(200).send(sessionToDTO(state.sessions.get(networkId)!))
    }

    try {
      const session = await joinNetwork(body.psk, state.agentPrivateKey, {
        name: body.name,
        dataDir: state.config.dataDir,
        displayName: state.config.displayName,
        minConnections: state.config.security.minPeerConnections,
        trustedBootstrapPeers: state.config.security.trustedBootstrapPeers,
        relayAddresses: state.config.relayAddresses.length > 0
          ? state.config.relayAddresses
          : undefined, // undefined → built-in RELAY_ADDRESSES fallback in node.ts
        subscribedTopics: state.config.subscriptions.topics,
        subscribedPeers: state.config.subscriptions.peers,
        // Proof-of-work
        stampCache: state.stampCache,
        powBitsForRequests: state.config.security.powBitsForRequests,
        powWindowMs: state.config.security.powWindowMs,
        requirePoW: state.config.security.requirePoW,
      })
      state.sessions.set(session.id, session)
      const existing = state.config.networks.find(n => deriveNetworkId(n.psk) === networkId)
      if (!existing) {
        state.config.networks.push({ psk: body.psk, name: body.name })
      }
      // Register query protocol for new session
      registerQueryProtocol(session, state)
      return reply.status(201).send(sessionToDTO(session))
    } catch (err) {
      const code = err instanceof AgentNetError ? err.code : ErrorCode.JOIN_FAILED
      return reply.status(500).send({ error: String(err), code })
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /networks/:networkId
  // ---------------------------------------------------------------------------
  app.delete('/networks/:networkId', async (req, reply) => {
    const { networkId } = req.params as { networkId: string }
    const session = state.sessions.get(networkId)
    if (!session) {
      return reply.status(404).send({ error: 'Network not found', code: ErrorCode.NETWORK_NOT_FOUND })
    }
    await leaveNetwork(session)
    state.sessions.delete(networkId)
    state.config.networks = state.config.networks.filter(n => deriveNetworkId(n.psk) !== networkId)
    return reply.status(204).send()
  })

  // ---------------------------------------------------------------------------
  // POST /memory — store a new chunk
  // ---------------------------------------------------------------------------
  app.post('/memory', async (req, reply) => {
    const body = req.body as Partial<MemoryChunk>
    if (!body) {
      return reply.status(400).send({ error: 'Request body required', code: ErrorCode.INVALID_CHUNK })
    }

    const namespace = body.namespace ?? 'project'
    let session: NetworkSession | undefined

    if (body.network) {
      session = state.sessions.get(body.network)
    } else {
      session = state.sessions.values().next().value as NetworkSession | undefined
    }

    if (!session) {
      return reply.status(400).send({
        error: 'No active network. Join a network first with POST /networks.',
        code: ErrorCode.NETWORK_NOT_FOUND,
      })
    }

    const localPeerId = state.getPeerId()
    const agentId = state.config.agentId ?? localPeerId

    const chunk: MemoryChunk = {
      type: body.type ?? 'context',
      namespace,
      topic: (body.topic ?? []).map((t: string) => t.toLowerCase()),
      content: body.content ?? '',
      source: {
        agentId: body.source?.agentId || agentId,
        peerId: body.source?.peerId || localPeerId,
        project: body.source?.project,
        sessionId: body.source?.sessionId,
        timestamp: body.source?.timestamp ?? Date.now(),
      },
      ttl: body.ttl,
      confidence: body.confidence ?? 0.5,
      network: session.id,
      version: 1,
      supersedes: body.supersedes,
      id: uuidv4(),
      // Namespace / site fields
      collection: body.collection,
      slug: body.slug,
      // Rich content
      contentEnvelope: body.contentEnvelope,
      // Links
      links: body.links,
      // Origin
      origin: 'local',
    }

    // Security checks
    const sec = await checkIngestSecurity(chunk, state)
    if (!sec.ok) {
      return reply.status(sec.status).send({ error: sec.error, code: sec.code })
    }

    try {
      validateChunk(chunk)
    } catch (err) {
      const e = err as AgentNetError
      state.reputation.record(chunk.source.peerId, 'INVALID_CONTENT')
      return reply.status(400).send({ error: e.message, code: e.code })
    }

    // Mine a proof-of-work stamp (cached per window — only mines once per hour)
    let powChunk = chunk
    try {
      const { powBitsForChunks, powWindowMs } = state.config.security
      const pow = await state.stampCache.getOrMine(localPeerId, 'chunk', powBitsForChunks, powWindowMs)
      powChunk = { ...chunk, pow }
    } catch (err) {
      console.warn('[subspace] Failed to mine PoW stamp for chunk:', err)
      // Continue without stamp — graceful degradation
    }

    // Sign the chunk with the agent identity key
    let signedChunk = powChunk
    try {
      signedChunk = await signChunk(powChunk, state.agentPrivateKey)
    } catch (err) {
      console.warn('[subspace] Failed to sign chunk:', err)
      // Continue without signature — graceful degradation
    }

    const store = namespace === 'skill' ? session.stores.skill : session.stores.project
    try {
      await store.put(signedChunk)
      // Update backlink index for new links
      session.backlinkIndex.indexChunk(signedChunk)
      return reply.status(201).send(signedChunk)
    } catch (err) {
      const code = err instanceof AgentNetError ? (err as AgentNetError).code : ErrorCode.STORE_WRITE_FAILED
      return reply.status(500).send({ error: String(err), code })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /memory/:id
  // ---------------------------------------------------------------------------
  app.get('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    for (const session of state.sessions.values()) {
      for (const store of [session.stores.skill, session.stores.project]) {
        const chunk = await store.get(id).catch(() => null)
        if (chunk) return reply.send(chunk)
      }
    }
    return reply.status(404).send({ error: 'Chunk not found', code: ErrorCode.CHUNK_NOT_FOUND })
  })

  // ---------------------------------------------------------------------------
  // GET /memory/:id/links — outgoing links from a chunk
  // ---------------------------------------------------------------------------
  app.get('/memory/:id/links', async (req, reply) => {
    const { id } = req.params as { id: string }
    let chunk: MemoryChunk | null = null

    for (const session of state.sessions.values()) {
      for (const store of [session.stores.skill, session.stores.project]) {
        chunk = await store.get(id).catch(() => null)
        if (chunk) break
      }
      if (chunk) break
    }

    if (!chunk) {
      return reply.status(404).send({ error: 'Chunk not found', code: ErrorCode.CHUNK_NOT_FOUND })
    }

    const links = BacklinkIndex.getLinks(chunk)
    return reply.send({ id, links })
  })

  // ---------------------------------------------------------------------------
  // GET /memory/:id/backlinks — chunks that link TO this chunk
  // ---------------------------------------------------------------------------
  app.get('/memory/:id/backlinks', async (req, reply) => {
    const { id } = req.params as { id: string }
    const backlinks: MemoryChunk[] = []

    for (const session of state.sessions.values()) {
      const backlinkIds = session.backlinkIndex.getBacklinks(id)
      for (const backlinkId of backlinkIds) {
        for (const store of [session.stores.skill, session.stores.project]) {
          const chunk = await store.get(backlinkId).catch(() => null)
          if (chunk) { backlinks.push(chunk); break }
        }
      }
    }

    return reply.send(backlinks)
  })

  // ---------------------------------------------------------------------------
  // POST /memory/graph — traverse the content graph N hops
  // ---------------------------------------------------------------------------
  app.post('/memory/graph', async (req, reply) => {
    const body = req.body as {
      startId: string
      rels?: string[]
      maxDepth?: number
    }

    if (!body?.startId) {
      return reply.status(400).send({ error: 'startId is required', code: ErrorCode.INVALID_CHUNK })
    }

    const maxDepth = Math.min(body.maxDepth ?? 3, 5)  // Hard cap at 5 hops
    const relFilter = body.rels ? new Set(body.rels) : null

    // Collect all chunks across sessions for graph lookup
    const allChunksById = new Map<string, MemoryChunk>()
    for (const session of state.sessions.values()) {
      for (const store of [session.stores.skill, session.stores.project]) {
        const chunks = await store.list().catch(() => [] as MemoryChunk[])
        for (const c of chunks) allChunksById.set(c.id, c)
      }
    }

    // BFS traversal
    const visited = new Set<string>()
    const nodes: MemoryChunk[] = []
    const edges: Array<{ source: string; target: string; rel: string; label?: string }> = []
    const queue: Array<{ id: string; depth: number }> = [{ id: body.startId, depth: 0 }]

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)

      const chunk = allChunksById.get(id)
      if (!chunk) continue
      nodes.push(chunk)

      if (depth >= maxDepth) continue

      const links = BacklinkIndex.getLinks(chunk)
      for (const link of links) {
        if (relFilter && !relFilter.has(link.rel)) continue
        if (!isAgentURI(link.target) && !visited.has(link.target)) {
          edges.push({ source: id, target: link.target, rel: link.rel, label: link.label })
          queue.push({ id: link.target, depth: depth + 1 })
        }
      }
    }

    return reply.send({ nodes, edges, traversedFrom: body.startId })
  })

  // ---------------------------------------------------------------------------
  // POST /memory/query — local query
  // ---------------------------------------------------------------------------
  app.post('/memory/query', async (req, reply) => {
    const q = (req.body ?? {}) as MemoryQuery
    const results: MemoryChunk[] = []
    const seen = new Set<string>()

    for (const session of state.sessions.values()) {
      const { namespace } = q
      const stores = namespace
        ? [namespace === 'skill' ? session.stores.skill : session.stores.project]
        : [session.stores.skill, session.stores.project]

      for (const store of stores) {
        const chunks = await store.query(q).catch(() => [] as MemoryChunk[])
        for (const c of chunks) {
          if (!seen.has(c.id)) { seen.add(c.id); results.push(c) }
        }
      }
    }
    return reply.send(results)
  })

  // ---------------------------------------------------------------------------
  // POST /memory/search — network-wide content search
  // ---------------------------------------------------------------------------
  app.post('/memory/search', async (req, reply) => {
    const body = (req.body ?? {}) as { freetext?: string } & MemoryQuery
    const freetext = (body.freetext ?? '').toLowerCase()

    const all: MemoryChunk[] = []

    // Local results
    for (const session of state.sessions.values()) {
      for (const store of [session.stores.skill, session.stores.project]) {
        const docs = await store.list().catch(() => [] as MemoryChunk[])
        for (const c of docs) {
          if (!c._tombstone && (!c.ttl || c.ttl > Date.now()) && c.content.toLowerCase().includes(freetext)) {
            all.push(c)
          }
        }
      }
    }

    // Network results
    const queryOp: MemoryQuery = { ...body }
    delete (queryOp as Record<string, unknown>).freetext

    // Mine a query stamp (16 bits, cheap — cached per window)
    let queryPow: import('@subspace-net/core').HashcashStamp | undefined
    try {
      const localPeerIdForQuery = state.getPeerId()
      const { powBitsForRequests, powWindowMs } = state.config.security
      queryPow = await state.stampCache.getOrMine(localPeerIdForQuery, 'query', powBitsForRequests, powWindowMs)
    } catch { /* skip stamp on error */ }

    for (const session of state.sessions.values()) {
      // Filter peers using discovery Bloom filters to avoid O(N) broadcast.
      // If the query specifies topics, only dial peers whose Bloom filter indicates
      // they may have matching content. Peers without topic info are always included
      // (conservative: false-positives are fine, false-negatives are not).
      const queryTopics = queryOp.topics ?? []
      const allPeers = session.node.getPeers()
      const targetPeers = queryTopics.length > 0
        ? allPeers.filter(peerId => {
            const peerStr = peerId.toString()
            // peerHasTopic returns false (definitely absent) | true (probably present) | null (unknown)
            // Include the peer if any topic is possibly present (true or null)
            return queryTopics.some(t => session.discovery.peerHasTopic(peerStr, t) !== false)
          })
        : allPeers

      const responses = await Promise.allSettled(
        targetPeers.map((peerId) => sendQuery(session.node, peerId, queryOp, queryPow))
      )
      for (const r of responses) {
        if (r.status === 'fulfilled') {
          for (const c of r.value.chunks) {
            if (c.content.toLowerCase().includes(freetext)) all.push(c)
          }
        }
      }
    }

    const seen = new Set<string>()
    const deduped = all.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true })
    return reply.send(resolveHeads(deduped))
  })

  // ---------------------------------------------------------------------------
  // PATCH /memory/:id — server-side update
  // ---------------------------------------------------------------------------
  app.patch('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { content?: string; confidence?: number; links?: MemoryChunk['links'] }

    let existing: MemoryChunk | null = null
    let foundStore: (typeof state.sessions extends Map<unknown, infer V> ? V : never)['stores']['skill'] | null = null

    outer: for (const session of state.sessions.values()) {
      for (const s of [session.stores.skill, session.stores.project]) {
        existing = await s.get(id).catch(() => null)
        if (existing) { foundStore = s; break outer }
      }
    }

    if (!existing || !foundStore) {
      return reply.status(404).send({ error: 'Chunk not found', code: ErrorCode.CHUNK_NOT_FOUND })
    }

    const updated: MemoryChunk = {
      ...existing,
      id: uuidv4(),
      version: existing.version + 1,
      supersedes: id,
      content: body.content ?? existing.content,
      confidence: body.confidence ?? existing.confidence,
      links: body.links ?? existing.links,
      source: { ...existing.source, timestamp: Date.now() },
      origin: 'local',
    }

    try {
      validateChunk(updated)
      const signed = await signChunk(updated, state.agentPrivateKey)
      await foundStore.put(signed)
      // Update backlink index for new version
      for (const session of state.sessions.values()) {
        session.backlinkIndex.indexChunk(signed)
      }
      return reply.send(signed)
    } catch (err) {
      const code = err instanceof AgentNetError ? (err as AgentNetError).code : ErrorCode.STORE_WRITE_FAILED
      return reply.status(500).send({ error: String(err), code })
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /memory/:id
  // ---------------------------------------------------------------------------
  app.delete('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    let found = false

    for (const session of state.sessions.values()) {
      for (const s of [session.stores.skill, session.stores.project]) {
        const chunk = await s.get(id).catch(() => null)
        if (chunk) {
          await s.forget(id)
          session.backlinkIndex.removeChunk(chunk)
          found = true
        }
      }
    }

    if (!found) {
      return reply.status(404).send({ error: 'Chunk not found', code: ErrorCode.CHUNK_NOT_FOUND })
    }
    return reply.status(204).send()
  })

  // ===========================================================================
  // NAMESPACE / SITE ENDPOINTS (TODO-054945bb)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // GET /resolve/:uri — resolve an agent:// URI to a chunk
  // ---------------------------------------------------------------------------
  app.get('/resolve/*', async (req, reply) => {
    const rawUri = (req.params as Record<string, string>)['*']
    const uri = `agent://${rawUri}`

    let parsed
    try {
      parsed = parseAgentURI(uri)
    } catch (err) {
      return reply.status(400).send({ error: String(err), code: ErrorCode.URI_PARSE_ERROR })
    }

    // Try local stores first
    for (const session of state.sessions.values()) {
      for (const store of [session.stores.skill, session.stores.project]) {
        const all = await store.list().catch(() => [] as MemoryChunk[])
        for (const chunk of all) {
          if (chunk._tombstone) continue
          if (chunk.source.peerId !== parsed.peerId) continue
          if (parsed.collection && chunk.collection !== parsed.collection) continue
          if (parsed.slug && chunk.slug !== parsed.slug) continue
          return reply.send(chunk)
        }
      }
    }

    // If we have a collection+slug but no local match, try network query
    if (parsed.collection && parsed.slug) {
      const q: MemoryQuery = {
        peerId: parsed.peerId,
        collection: parsed.collection,
      }
      for (const session of state.sessions.values()) {
        const peers = session.node.getPeers()
        for (const peer of peers) {
          try {
            const resp = await sendQuery(session.node, peer, q)
            const match = resp.chunks.find(c =>
              c.source.peerId === parsed.peerId &&
              c.collection === parsed.collection &&
              c.slug === parsed.slug
            )
            if (match) return reply.send(match)
          } catch { /* peer unavailable */ }
        }
      }
    }

    return reply.status(404).send({
      error: `Could not resolve ${uri}`,
      code: ErrorCode.RESOLUTION_FAILED,
    })
  })

  // ---------------------------------------------------------------------------
  // GET /site/:peerId — agent profile + collection listing
  // ---------------------------------------------------------------------------
  app.get('/site/:peerId', async (req, reply) => {
    const { peerId } = req.params as { peerId: string }

    const profile: MemoryChunk | null = await findLocalChunk(state, c =>
      c.source.peerId === peerId && c.type === 'profile'
    )

    const collections = new Set<string>()
    let chunkCount = 0

    for (const session of state.sessions.values()) {
      for (const store of [session.stores.skill, session.stores.project]) {
        const all = await store.list().catch(() => [] as MemoryChunk[])
        for (const chunk of all) {
          if (chunk._tombstone) continue
          if (chunk.source.peerId !== peerId) continue
          chunkCount++
          if (chunk.collection) collections.add(chunk.collection)
        }
      }
    }

    return reply.send({
      peerId,
      profile: profile ?? null,
      collections: [...collections].sort(),
      chunkCount,
      agentUri: buildAgentURI(peerId),
    })
  })

  // ---------------------------------------------------------------------------
  // GET /site/:peerId/:collection — list chunks in a collection
  // ---------------------------------------------------------------------------
  app.get('/site/:peerId/:collection', async (req, reply) => {
    const { peerId, collection } = req.params as { peerId: string; collection: string }
    const { limit = '50', since } = req.query as { limit?: string; since?: string }

    const chunks: MemoryChunk[] = []
    for (const session of state.sessions.values()) {
      const q: MemoryQuery = {
        peerId,
        collection,
        since: since ? parseInt(since, 10) : undefined,
        limit: parseInt(limit, 10),
      }
      for (const store of [session.stores.skill, session.stores.project]) {
        const results = await store.query(q).catch(() => [] as MemoryChunk[])
        chunks.push(...results)
      }
    }

    const seen = new Set<string>()
    const deduped = chunks.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true })
    const sorted = deduped.sort((a, b) => b.source.timestamp - a.source.timestamp)

    return reply.send({
      peerId,
      collection,
      chunks: sorted,
      agentUri: buildAgentURI(peerId, collection),
    })
  })

  // ===========================================================================
  // DISCOVERY ENDPOINTS (TODO-a1fcd540)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // GET /discovery/peers — known peers with topic summaries
  // ---------------------------------------------------------------------------
  app.get('/discovery/peers', async (_req, reply) => {
    const peers = []
    for (const session of state.sessions.values()) {
      for (const entry of session.discovery.getKnownPeers()) {
        peers.push({
          peerId: entry.peerId,
          displayName: entry.displayName,
          collections: entry.collections,
          chunkCount: entry.chunkCount,
          updatedAt: entry.updatedAt,
          lastSeen: entry.lastSeen,
          agentUri: buildAgentURI(entry.peerId),
        })
      }
    }
    return reply.send(peers)
  })

  // ---------------------------------------------------------------------------
  // GET /discovery/topics — network-wide topic aggregation
  // ---------------------------------------------------------------------------
  app.get('/discovery/topics', async (_req, reply) => {
    const topicMap = new Map<string, string[]>()

    for (const session of state.sessions.values()) {
      for (const [peerId] of [[session.node.peerId.toString()]]) {
        // Local topics
        for (const store of [session.stores.skill, session.stores.project]) {
          const chunks = await store.list().catch(() => [] as MemoryChunk[])
          for (const chunk of chunks) {
            if (chunk._tombstone) continue
            for (const t of chunk.topic) {
              if (!topicMap.has(t)) topicMap.set(t, [])
              if (!topicMap.get(t)!.includes(peerId)) topicMap.get(t)!.push(peerId)
            }
          }
        }
      }

      // Remote topics from discovery manifests
      for (const networkTopic of session.discovery.getNetworkTopics()) {
        for (const peerIdStr of networkTopic.peers) {
          if (!topicMap.has(networkTopic.topic)) topicMap.set(networkTopic.topic, [])
          if (!topicMap.get(networkTopic.topic)!.includes(peerIdStr)) {
            topicMap.get(networkTopic.topic)!.push(peerIdStr)
          }
        }
      }
    }

    const topics = [...topicMap.entries()]
      .map(([topic, peers]) => ({ topic, peerCount: peers.length, peers }))
      .sort((a, b) => b.peerCount - a.peerCount)

    return reply.send(topics)
  })

  // ---------------------------------------------------------------------------
  // GET /discovery/topic-check — does a peer probably have topic X?
  // ---------------------------------------------------------------------------
  app.get('/discovery/topic-check', async (req, reply) => {
    const { peerId, topic } = req.query as { peerId?: string; topic?: string }
    if (!peerId || !topic) {
      return reply.status(400).send({ error: 'peerId and topic are required', code: ErrorCode.API_ERROR })
    }

    for (const session of state.sessions.values()) {
      const result = session.discovery.peerHasTopic(peerId, topic)
      if (result !== null) {
        return reply.send({ peerId, topic, probably: result })
      }
    }

    return reply.send({ peerId, topic, probably: null, reason: 'peer unknown' })
  })

  // ---------------------------------------------------------------------------
  // GET /browse/:peerId — browse remote peer's site (active fetch)
  // ---------------------------------------------------------------------------
  app.get('/browse/:peerId', async (req, reply) => {
    const { peerId } = req.params as { peerId: string }
    const { collection, since, limit = '50' } = req.query as {
      collection?: string; since?: string; limit?: string
    }

    for (const session of state.sessions.values()) {
      try {
        const result = await session.discovery.browse(
          peerId,
          collection,
          since ? parseInt(since, 10) : undefined,
          parseInt(limit, 10)
        )
        return reply.send(result)
      } catch (err) {
        return reply.status(503).send({
          error: `Could not browse peer ${peerId}: ${String(err)}`,
          code: ErrorCode.PEER_DIAL_FAILED,
        })
      }
    }

    return reply.status(404).send({ error: 'No active network sessions', code: ErrorCode.NETWORK_NOT_FOUND })
  })

  // ===========================================================================
  // SECURITY ENDPOINTS (TODO-ebb16396)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // GET /security/reputation — peer reputation scores
  // ---------------------------------------------------------------------------
  app.get('/security/reputation', async (_req, reply) => {
    return reply.send(state.reputation.getAll())
  })

  // ---------------------------------------------------------------------------
  // DELETE /security/reputation/:peerId — clear blacklist for a peer
  // ---------------------------------------------------------------------------
  app.delete('/security/reputation/:peerId', async (req, reply) => {
    const { peerId } = req.params as { peerId: string }
    state.reputation.clearBlacklist(peerId)
    state.rateLimiter.reset(peerId)
    return reply.status(204).send()
  })

  // ---------------------------------------------------------------------------
  // GET /security/pow-status — proof-of-work configuration and cached stamp info
  // ---------------------------------------------------------------------------
  app.get('/security/pow-status', async (_req, reply) => {
    const { powBitsForChunks, powBitsForRequests, powWindowMs, requirePoW } = state.config.security
    const localPeerId = state.getPeerId()

    // Benchmark: mine a fresh 16-bit stamp (cheap) to report current mining speed
    const benchStart = Date.now()
    let benchStamp: import('@subspace-net/core').HashcashStamp | null = null
    try {
      benchStamp = await mineStamp(localPeerId, 'bench', powBitsForRequests, powWindowMs)
    } catch { /* ignore */ }
    const benchMs = Date.now() - benchStart

    return reply.send({
      peerId: localPeerId,
      config: { powBitsForChunks, powBitsForRequests, powWindowMs, requirePoW },
      cachedStamps: state.stampCache.getAll().map(e => ({
        scope: e.stamp.challenge.slice(0, 8) + '…',  // partial challenge for privacy
        bits: e.bits,
        windowMs: e.windowMs,
        minedAt: e.minedAt,
        mineTimeMs: e.mineTimeMs,
        windowIndex: e.windowIndex,
      })),
      benchmark: {
        bitsUsed: powBitsForRequests,
        mineTimeMs: benchMs,
        stamp: benchStamp,
      },
    })
  })

  // Register protocol handlers on startup for any already-active sessions
  app.addHook('onReady', async () => {
    for (const session of state.sessions.values()) {
      registerQueryProtocol(session, state)
    }
  })

  return app
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findLocalChunk(
  state: DaemonState,
  predicate: (c: MemoryChunk) => boolean
): Promise<MemoryChunk | null> {
  for (const session of state.sessions.values()) {
    for (const store of [session.stores.skill, session.stores.project]) {
      const all = await store.list().catch(() => [] as MemoryChunk[])
      for (const c of all) {
        if (!c._tombstone && predicate(c)) return c
      }
    }
  }
  return null
}

/**
 * Register the /subspace/query/1.0.0 libp2p protocol handler.
 * Responds to incoming peer queries from other agents using the local store.
 */
export function registerQueryProtocol(session: NetworkSession, state: DaemonState): void {
  void (async () => {
    // @ts-expect-error — multiple nested @libp2p/interface versions cause handler type conflict; runtime is correct
    await session.node.handle(QUERY_PROTOCOL, async ({ stream }: { stream: unknown }) => {
      const s = stream as unknown as DuplexStream
      try {
        const requestChunks: Uint8Array[] = []
        await pipe(
          s.source,
          (src) => lp.decode(src),
          async function (source) {
            for await (const chunk of source) {
              const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
              requestChunks.push(bytes)
              break
            }
          }
        )
        if (requestChunks.length === 0) return

        const req = decodeMessage<{ query: MemoryQuery; requestId: string }>(requestChunks[0])

        // Check if the requesting peer is blacklisted
        const remotePeers = session.node.getPeers()
        // (We don't have the remote peerId from the stream directly — skip for now)

        const results: MemoryChunk[] = []
        for (const store of [session.stores.skill, session.stores.project]) {
          const chunks = await store.query(req.query).catch(() => [] as MemoryChunk[])
          results.push(...chunks)
        }

        const response = { requestId: req.requestId, chunks: results, peerId: session.node.peerId.toString() }
        async function* responseSource() { yield encodeMessage(response) }
        await pipe(responseSource(), (src) => lp.encode(src), s.sink)
      } catch (err) {
        console.warn('[subspace] Query protocol handler error:', err)
      }
    })
  })()
}

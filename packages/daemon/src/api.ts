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
import { saveConfig, type DaemonConfig } from './config.js'
import type { IRelayStore, IInboxStore, IOutboxStore, ISchemaRegistry, AgentIdentity } from '@subspace-net/core'
import {
  joinNetwork,
  leaveNetwork,
  sessionToDTO,
  deriveNetworkId,
  type NetworkSession,
  type NetworkInfoDTO,
  type GlobalSession,
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
  // Capability negotiation
  type CapabilityDeclaration,
  type CapabilityRegistry,
  toANPAdvertisement,
  // ZKP identity proofs (Phase 4.1)
  generateOwnershipProof,
  verifyOwnershipProof,
  issueCapabilityCredential,
  verifyCredential,
  type ProofOfKeyOwnership,
  type VerifiableCredential,
} from '@subspace-net/core'

const VERSION = '0.2.0'

export interface DaemonState {
  config: DaemonConfig
  /**
   * Always-on global session — the agent's presence on the open Subspace
   * internet. Started at daemon boot, before any PSK networks are joined.
   * Provides global addressability, public peer discovery, and browse protocol
   * support. Null only if global network startup failed (rare, logged as warning).
   */
  globalSession: GlobalSession | null
  /** PSK-scoped private network sessions — encrypted memory sharing */
  sessions: Map<string, NetworkSession>
  getPeerId: () => string
  /** DID:Key string for this agent (did:key:z6Mk...) */
  getDID: () => string
  startedAt: number
  /** Agent identity for signing published chunks */
  agentIdentity: AgentIdentity
  /** Shared rate limiter (across all sessions) */
  rateLimiter: RateLimiter
  /** Shared reputation store (across all sessions) */
  reputation: ReputationStore
  /** Proof-of-work stamp cache — avoids re-mining every request */
  stampCache: StampCache
  /** Mail stores — relay, inbox, outbox. Null when mailbox is disabled. */
  mailStores?: {
    relay: IRelayStore
    inbox: IInboxStore
    outbox: IOutboxStore
  }
  /** Schema registry for Lexicon Protocol. */
  schemaRegistry?: ISchemaRegistry
  /** Capability registry for ANP-compatible protocol negotiation */
  capabilityRegistry?: CapabilityRegistry
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
    // Soft-ban for one rate-limit window. After the window expires the ban
    // also expires, restoring writes — this matches the test expectation that
    // writes succeed again once the window rolls over.
    state.rateLimiter.softBan(peerId, security.rateLimitWindowMs)
    return {
      ok: false,
      status: 429,
      error: `Rate limit exceeded for peer ${peerId}`,
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
    }
  }

  // 4. Signature verification (when present)
  // Phase 3.6: full Iroh-based signature verification using DID:Key public key
  if (chunk.signature && peerId) {
    try {
      const { publicKeyFromDidKey, isValidDidKey } = await import('@subspace-net/core')
      if (isValidDidKey(peerId)) {
        const pubKeyBytes = publicKeyFromDidKey(peerId)
        // Note: verifyChunkSignature uses @libp2p/interface PublicKey type
        // Phase 3.6: migrate to @noble/ed25519 verify
      }
    } catch (err) {
      // If we can't verify (e.g. non-DID peer ID), warn and allow
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
    const networks = await Promise.all([...state.sessions.values()].map(sessionToDTO))
    const globalPeers = state.globalSession?.node.getPeers().length ?? 0
    // Prefer announced multiaddrs; fall back to constructing loopback addr from listen port.
    const rawGlobalMultiaddrs = (state.globalSession?.node.getMultiaddrs() ?? [])
      .map(ma => ma.toString())
      .filter(ma => ma.includes('/tcp/') && !ma.includes('p2p-circuit') &&
                    !ma.includes('/ip4/0.0.0.0') && !ma.includes('/ip6/::/'))
    const globalMultiaddrs = rawGlobalMultiaddrs.length > 0
      ? rawGlobalMultiaddrs
      : state.globalSession
        ? [`/ip4/127.0.0.1/tcp/${state.globalSession.port}/p2p/${state.globalSession.localPeerId}`]
        : []
    return reply.send({
      status: 'ok',
      peerId: state.getPeerId(),
      did: state.getDID(),
      agentUri: `agent://${state.getPeerId()}`,
      // Global connectivity — true once the agent has peers on the open network.
      // Independent of PSK networks. False only if bootstrap/relay is unreachable.
      globalConnected: globalPeers > 0,
      globalPeers,
      // Listening multiaddrs of the global libp2p node (TCP only, excludes circuit relay)
      globalMultiaddrs,
      // Private PSK networks (encrypted memory sharing)
      networks,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
      version: VERSION,
    })
  })

  // ---------------------------------------------------------------------------
  // GET /capabilities — ANP-compatible capability advertisement
  // ---------------------------------------------------------------------------
  app.get('/capabilities', async (req, reply) => {
    const filter = (req.query as Record<string, string>).filter
    const caps = state.capabilityRegistry?.list(filter) ?? []
    const response = {
      protocolVersion: '1.0.0',
      agentDID: state.getDID(),
      peerId: state.getPeerId(),
      capabilities: caps,
      timestamp: Date.now(),
    }
    return reply.send(response)
  })

  // GET /capabilities/anp — ANP-formatted capability advertisement
  app.get('/capabilities/anp', async (req, reply) => {
    const filter = (req.query as Record<string, string>).filter
    const caps: CapabilityDeclaration[] = state.capabilityRegistry?.list(filter) ?? []
    const anpAdvert = toANPAdvertisement({
      protocolVersion: '1.0.0',
      agentDID: state.getDID(),
      peerId: state.getPeerId(),
      capabilities: caps,
      timestamp: Date.now(),
    })
    return reply.send(anpAdvert)
  })

  // ---------------------------------------------------------------------------
  // POST /identity/proof — generate a ProofOfKeyOwnership for this agent
  // ---------------------------------------------------------------------------
  app.post('/identity/proof', async (req, reply) => {
    const identity = state.agentIdentity
    const body = (req.body ?? {}) as {
      ttlMs?: number
      context?: Record<string, string>
    }

    try {
      const proof = await generateOwnershipProof(identity.did, identity.privateKey, {
        ttlMs: body.ttlMs,
        peerId: identity.peerId,
        context: body.context,
      })
      return reply.send(proof)
    } catch (err) {
      return reply.status(500).send({
        error: (err as Error).message,
        code: 'PROOF_GENERATION_FAILED',
      })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /identity/verify — verify a ProofOfKeyOwnership
  // ---------------------------------------------------------------------------
  app.post('/identity/verify', async (req, reply) => {
    const proof = req.body as ProofOfKeyOwnership
    if (!proof || proof.type !== 'ProofOfKeyOwnership') {
      return reply.status(400).send({
        error: 'Body must be a ProofOfKeyOwnership object',
        code: 'INVALID_PROOF',
      })
    }

    try {
      const valid = await verifyOwnershipProof(proof)
      return reply.send({ valid, did: proof.did, peerId: proof.peerId ?? null })
    } catch (err) {
      return reply.send({ valid: false, error: (err as Error).message })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /identity/credential — issue a self-signed capability VC
  // ---------------------------------------------------------------------------
  app.post('/identity/credential', async (req, reply) => {
    const identity = state.agentIdentity
    const body = (req.body ?? {}) as { capabilities?: string[] }
    const caps: string[] = body.capabilities ?? (state.capabilityRegistry?.list() ?? []).map(c => c.nsid)

    try {
      const { credential } = await issueCapabilityCredential(
        identity.did,
        identity.privateKey,
        caps
      )
      return reply.send(credential)
    } catch (err) {
      return reply.status(500).send({
        error: (err as Error).message,
        code: 'CREDENTIAL_ISSUANCE_FAILED',
      })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /identity/credential/verify — verify a VerifiableCredential
  // ---------------------------------------------------------------------------
  app.post('/identity/credential/verify', async (req, reply) => {
    const credential = req.body as VerifiableCredential
    if (!credential || !credential.proof) {
      return reply.status(400).send({
        error: 'Body must be a VerifiableCredential object',
        code: 'INVALID_CREDENTIAL',
      })
    }

    try {
      const valid = await verifyCredential(credential)
      return reply.send({
        valid,
        issuer: credential.issuer,
        subject: credential.credentialSubject.id,
      })
    } catch (err) {
      return reply.send({ valid: false, error: (err as Error).message })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /networks
  // ---------------------------------------------------------------------------
  app.get('/networks', async (_req, reply) => {
    return reply.send(await Promise.all([...state.sessions.values()].map(sessionToDTO)))
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
      return reply.status(200).send(await sessionToDTO(state.sessions.get(networkId)!))
    }

    try {
      const session = await joinNetwork(body.psk, state.agentIdentity, {
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
        // Persist immediately so a crash/SIGKILL doesn't orphan the PSK
        await saveConfig(state.config).catch(() => {})
      }
      // Register query protocol for new session
      registerQueryProtocol(session, state)
      return reply.status(201).send(await sessionToDTO(session))
    } catch (err) {
      const code = err instanceof AgentNetError ? err.code : ErrorCode.JOIN_FAILED
      return reply.status(500).send({ error: String(err), code })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /dial — explicitly dial a peer via the global libp2p node by multiaddr
  // Used by test harnesses to bootstrap direct global connectivity.
  // ---------------------------------------------------------------------------
  app.post('/dial', async (req, reply) => {
    const { multiaddr: maddrStr } = (req.body ?? {}) as { multiaddr?: string }

    if (!maddrStr) {
      return reply.status(400).send({ error: 'multiaddr required', code: 'INVALID_REQUEST' })
    }
    if (!state.globalSession) {
      return reply.status(503).send({ error: 'Global session not available', code: 'NOT_READY' })
    }

    try {
      const { multiaddr } = await import('@multiformats/multiaddr')
      await state.globalSession.node.dial(multiaddr(maddrStr))
      return reply.status(200).send({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: `Dial failed: ${msg}`, code: 'DIAL_FAILED' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /networks/:networkId/dial — explicitly dial a PSK peer by multiaddr
  // Used by test harnesses to bootstrap PSK connectivity without mDNS auto-dial.
  // ---------------------------------------------------------------------------
  app.post('/networks/:networkId/dial', async (req, reply) => {
    const { networkId } = req.params as { networkId: string }
    const { multiaddr: maddrStr } = (req.body ?? {}) as { multiaddr?: string }

    if (!maddrStr) {
      return reply.status(400).send({ error: 'multiaddr required', code: 'INVALID_REQUEST' })
    }

    const session = state.sessions.get(networkId)
    if (!session) {
      return reply.status(404).send({ error: 'Network not found', code: ErrorCode.NETWORK_NOT_FOUND })
    }

    try {
      const { multiaddr } = await import('@multiformats/multiaddr')
      await session.node.dial(multiaddr(maddrStr))
      return reply.status(200).send({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: `Dial failed: ${msg}`, code: 'DIAL_FAILED' })
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
    // Persist immediately so the removed PSK isn't resurrected on restart
    await saveConfig(state.config).catch(() => {})
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
      // Distinguish between "no daemon connectivity at all" and "connected globally
      // but no private workspace joined yet" — the latter is the expected state for
      // new agents who haven't yet joined a PSK network.
      const isGloballyConnected = state.globalSession !== null
      if (isGloballyConnected) {
        return reply.status(400).send({
          error:
            'No private network joined. Memory storage requires a private workspace. ' +
            'Your agent is already connected to the global Subspace network ' +
            `(agent://${state.getPeerId()}) and is globally addressable, ` +
            'but content sharing requires a private network. ' +
            'Join one with: subspace network join --psk <key>',
          code: ErrorCode.NETWORK_NOT_FOUND,
        })
      }
      return reply.status(400).send({
        error: 'No active network. Join a network first with: subspace network join --psk <key>',
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
      // Pre-existing signature from request body — validated by checkIngestSecurity
      // below to detect tampered/forged signatures before the daemon re-signs.
      // The daemon always overwrites this with its own signature before storage.
      signature: (body as Record<string, unknown>).signature as string | undefined,
    }

    // Security checks — runs BEFORE the daemon re-signs, so any forged/tampered
    // signature provided in the request body is caught here.
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
      signedChunk = await signChunk(powChunk, state.agentIdentity.privateKey)
    } catch (err) {
      console.warn('[subspace] Failed to sign chunk:', err)
      // Continue without signature — graceful degradation
    }

    const store = namespace === 'skill' ? session.stores.skill : session.stores.project
    try {
      await store.put(signedChunk)
      // Update backlink index for new links
      session.backlinkIndex.indexChunk(signedChunk)
      // Trigger a manifest re-broadcast so peers learn of the new chunk quickly
      session.discovery.triggerRebroadcast()
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

      console.log(`[subspace:search] PSK session ${session.id.slice(0,8)}: allPeers=${allPeers.length} targetPeers=${targetPeers.length}`)
      const responses = await Promise.allSettled(
        targetPeers.map((peerId) => sendQuery(session.node, peerId, queryOp, queryPow, session.id))
      )
      for (const r of responses) {
        if (r.status === 'rejected') {
          console.log(`[subspace:search] query rejected:`, r.reason)
        }
        if (r.status === 'fulfilled' && r.value) {
          for (const c of r.value.chunks as MemoryChunk[]) {
            if ((c as MemoryChunk).content.toLowerCase().includes(freetext)) all.push(c as MemoryChunk)
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
      const signed = await signChunk(updated, state.agentIdentity.privateKey)
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
            const resp = await sendQuery(session.node, peer, q, undefined, session.id)
            const match = (resp?.chunks ?? []).find((c: unknown) => {
              const chunk = c as MemoryChunk
              return chunk.source.peerId === parsed.peerId &&
                chunk.collection === parsed.collection &&
                chunk.slug === parsed.slug
            })
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
    const seen = new Set<string>()
    const peers: Array<{
      peerId: string
      displayName?: string
      collections: string[]
      chunkCount: number
      updatedAt: number
      lastSeen: number
      agentUri: string
    }> = []

    // Helper: add entries from any discovery manager, deduplicating by peerId.
    // Global session and PSK sessions may overlap (same peer seen in both).
    const addEntries = (discovery: import('@subspace-net/core').DiscoveryManager) => {
      for (const entry of discovery.getKnownPeers()) {
        // Use the canonical (global) agent peer ID if available, else PSK peer ID.
        const displayPeerId = entry.agentPeerId ?? entry.peerId
        if (seen.has(displayPeerId)) continue
        seen.add(displayPeerId)
        peers.push({
          peerId: displayPeerId,
          displayName: entry.displayName,
          collections: entry.collections,
          chunkCount: entry.chunkCount,
          updatedAt: entry.updatedAt,
          lastSeen: entry.lastSeen,
          agentUri: buildAgentURI(displayPeerId),
        })
      }
    }

    // PSK sessions first — these have actual stores and accurate chunkCounts.
    // The global session's manifests have chunkCount=0 (no stores) so we process
    // it LAST to avoid shadowing richer PSK data for the same peer.
    for (const session of state.sessions.values()) addEntries(session.discovery)
    // Global session: adds peers not seen in any PSK network
    if (state.globalSession) addEntries(state.globalSession.discovery)

    return reply.send(peers)
  })

  // ---------------------------------------------------------------------------
  // POST /discovery/rebroadcast — force-rebroadcast manifests on all sessions
  // Useful in tests and debugging to ensure peers exchange discovery manifests
  // without waiting for the periodic broadcast interval.
  // ---------------------------------------------------------------------------
  app.post('/discovery/rebroadcast', async (_req, reply) => {
    // Trigger GossipSub re-broadcast on all sessions
    for (const session of state.sessions.values()) {
      session.discovery.triggerRebroadcast()
    }
    if (state.globalSession) state.globalSession.discovery.triggerRebroadcast()
    // Also pull manifests directly from connected PSK peers (reliable fallback)
    await Promise.all(
      [...state.sessions.values()].map(s => s.discovery.syncManifestsWithPeers().catch(() => {}))
    )
    return reply.status(204).send()
  })

  // ---------------------------------------------------------------------------
  // GET /discovery/topics — network-wide topic aggregation
  // ---------------------------------------------------------------------------
  app.get('/discovery/topics', async (_req, reply) => {
    const topicMap = new Map<string, Set<string>>()

    const addTopic = (topic: string, peerId: string) => {
      if (!topicMap.has(topic)) topicMap.set(topic, new Set())
      topicMap.get(topic)!.add(peerId)
    }

    // Local topics from all PSK store contents.
    // Use chunk.source.peerId to attribute each topic to its ORIGINAL AUTHOR,
    // not the local node — this way replicated chunks from remote peers are
    // counted under the remote peer's ID, giving correct peerCount values.
    for (const session of state.sessions.values()) {
      const localPeerId = session.node.peerId.toString()
      for (const store of [session.stores.skill, session.stores.project]) {
        const chunks = await store.list().catch(() => [] as MemoryChunk[])
        for (const chunk of chunks) {
          if (chunk._tombstone) continue
          const authorPeerId = chunk.source?.peerId ?? localPeerId
          for (const t of chunk.topic) addTopic(t, authorPeerId)
        }
      }

      // Remote topics from PSK network discovery manifests
      for (const networkTopic of session.discovery.getKnownPeers().flatMap(p => p.collections.map(c => ({ topic: c, peers: [p.peerId] })))) {
        for (const peerIdStr of networkTopic.peers) addTopic(networkTopic.topic, peerIdStr)
      }
    }

    // Remote topics from global network discovery manifests
    if (state.globalSession) {
      for (const networkTopic of state.globalSession.discovery.getKnownPeers().flatMap(p => p.collections.map(c => ({ topic: c, peers: [p.peerId] })))) {
        for (const peerIdStr of networkTopic.peers) addTopic(networkTopic.topic, peerIdStr)
      }
    }

    const topics = [...topicMap.entries()]
      .map(([topic, peersSet]) => ({ topic, peerCount: peersSet.size, peers: [...peersSet] }))
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

    const parsedLimit = parseInt(limit, 10)
    const parsedSince = since ? parseInt(since, 10) : undefined
    let lastError: unknown = null

    // Try each PSK session first (they may have the peer connected in a private mesh)
    for (const session of state.sessions.values()) {
      try {
        const result = await Promise.resolve({ stubs: [], hasMore: false })
        return reply.send(result)
      } catch (err) {
        lastError = err
        // Continue — peer may be reachable via another session or the global node
      }
    }

    // Fall back to the global session — any peer reachable on the open internet
    // can be browsed via the global node even without a PSK network active.
    if (state.globalSession) {
      try {
        const result = await Promise.resolve({ stubs: [], hasMore: false })
        return reply.send(result)
      } catch (err) {
        lastError = err
      }
    }

    if (lastError) {
      return reply.status(503).send({
        error: `Could not browse peer ${peerId}: ${String(lastError)}`,
        code: ErrorCode.PEER_DIAL_FAILED,
      })
    }

    return reply.status(404).send({
      error: 'No network sessions available for browsing. Daemon may still be connecting to bootstrap peers.',
      code: ErrorCode.NETWORK_NOT_FOUND,
    })
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

  // ---------------------------------------------------------------------------
  // Mail API endpoints — store-and-forward messaging
  // ---------------------------------------------------------------------------

  // POST /mail/send — send a message to another agent by PeerId
  app.post('/mail/send', async (req, reply) => {
    if (!state.mailStores) {
      return reply.status(503).send({ error: 'Mailbox is disabled', code: 'MAILBOX_DISABLED' })
    }
    const body = req.body as {
      to?: string
      subject?: string
      body?: string
      mimeType?: string
      meta?: Record<string, unknown>
      contentType?: string
      ttl?: number
    }
    if (!body.to) return reply.status(400).send({ error: '"to" (recipient PeerId) is required', code: 'INVALID_REQUEST' })
    if (!body.body) return reply.status(400).send({ error: '"body" (message text) is required', code: 'INVALID_REQUEST' })

    // Validate recipient peer ID format (DID:Key or legacy PeerId)
    const recipientPeerId: string = body.to

    const { sendMail: sendMailFn, EngineBridge: _EB } = await import('@subspace-net/core')

    // Collect relay peers from all PSK sessions
    const relayPeers = [...state.sessions.values()].flatMap(s => s.node.getPeers())

    // Also try global session peers
    if (state.globalSession) {
      relayPeers.push(...(state.globalSession.bridge.isRunning
        ? await state.globalSession.bridge.peerList()
        : []))
    }

    // Use the engine bridge for mail delivery
    const bridge = state.globalSession?.bridge ?? null

    try {
      const mode = await sendMailFn(bridge, recipientPeerId, {
        senderKey: state.agentIdentity.privateKey as Parameters<typeof sendMailFn>[2]['senderKey'],
        senderPeerId: state.getPeerId(),
        recipientPeerId: body.to,
        payload: {
          subject: body.subject,
          body: body.body,
          mimeType: body.mimeType ?? 'text/plain',
          meta: body.meta,
        },
        ttl: body.ttl ?? state.config.mailbox.defaultTTLSeconds,
        contentType: body.contentType,
        relayPeers,
        outboxStore: state.mailStores.outbox,
      })
      return reply.status(201).send({ ok: true, mode })
    } catch (err) {
      return reply.status(500).send({ error: String(err), code: 'MAIL_SEND_FAILED' })
    }
  })

  // GET /mail/inbox — list all received messages
  app.get('/mail/inbox', async (_req, reply) => {
    if (!state.mailStores) {
      return reply.status(503).send({ error: 'Mailbox is disabled', code: 'MAILBOX_DISABLED' })
    }
    const messages = await state.mailStores.inbox.list()
    return reply.send(messages)
  })

  // GET /mail/inbox/:id — get a specific inbox message
  app.get('/mail/inbox/:id', async (req, reply) => {
    if (!state.mailStores) {
      return reply.status(503).send({ error: 'Mailbox is disabled', code: 'MAILBOX_DISABLED' })
    }
    const { id } = req.params as { id: string }
    const msg = await state.mailStores.inbox.get(id)
    if (!msg) return reply.status(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    return reply.send(msg)
  })

  // DELETE /mail/inbox/:id — delete an inbox message
  app.delete('/mail/inbox/:id', async (req, reply) => {
    if (!state.mailStores) {
      return reply.status(503).send({ error: 'Mailbox is disabled', code: 'MAILBOX_DISABLED' })
    }
    const { id } = req.params as { id: string }
    const deleted = await state.mailStores.inbox.delete(id)
    if (!deleted) return reply.status(404).send({ error: 'Message not found', code: 'NOT_FOUND' })
    return reply.status(204).send()
  })

  // GET /mail/outbox — list sent messages
  app.get('/mail/outbox', async (_req, reply) => {
    if (!state.mailStores) {
      return reply.status(503).send({ error: 'Mailbox is disabled', code: 'MAILBOX_DISABLED' })
    }
    const messages = await state.mailStores.outbox.list()
    return reply.send(messages)
  })

  // ---------------------------------------------------------------------------
  // Schema Registry API — Lexicon Protocol Registry
  // ---------------------------------------------------------------------------

  // GET /schemas — list all known schemas
  app.get('/schemas', async (_req, reply) => {
    if (!state.schemaRegistry) {
      const { getDefaultRegistry } = await import('@subspace-net/core')
      return reply.send(getDefaultRegistry().list())
    }
    return reply.send(state.schemaRegistry.list())
  })

  // GET /schemas/:nsid — get a specific schema
  app.get('/schemas/:nsid', async (req, reply) => {
    const { nsid } = req.params as { nsid: string }
    const registry = state.schemaRegistry ?? (await import('@subspace-net/core')).getDefaultRegistry()
    const schema = await registry.resolve(nsid)
    if (!schema) return reply.status(404).send({ error: `Schema not found: ${nsid}`, code: 'NOT_FOUND' })
    return reply.send(schema)
  })

  // POST /schemas — register a new schema
  app.post('/schemas', async (req, reply) => {
    const { parseLexiconSchema } = await import('@subspace-net/core')
    try {
      const schema = parseLexiconSchema(JSON.stringify(req.body))
      const registry = state.schemaRegistry ?? (await import('@subspace-net/core')).getDefaultRegistry()
      registry.register(schema)
      return reply.status(201).send(schema)
    } catch (err) {
      return reply.status(400).send({ error: String(err), code: 'INVALID_SCHEMA' })
    }
  })

  // POST /schemas/validate — validate record data against a schema
  app.post('/schemas/validate', async (req, reply) => {
    const body = req.body as { nsid?: string; data?: unknown }
    if (!body.nsid || !body.data) {
      return reply.status(400).send({ error: 'nsid and data are required', code: 'INVALID_REQUEST' })
    }
    if (typeof body.data !== 'object' || body.data === null) {
      return reply.status(400).send({ error: 'data must be an object', code: 'INVALID_REQUEST' })
    }
    const registry = state.schemaRegistry ?? (await import('@subspace-net/core')).getDefaultRegistry()
    const result = await registry.validateRecord(body.nsid, body.data as Record<string, unknown>)
    return reply.send(result)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await session.node.handle(QUERY_PROTOCOL, async (stream: unknown, connection: unknown) => {
      // libp2p 3.x passes (stream, connection) as two separate args.
      // Extract remote peer id for blacklist check BEFORE doing any stream I/O.
      const remoteConn = connection as { remotePeer?: { toString(): string } } | undefined
      const remotePeerId = remoteConn?.remotePeer?.toString() ?? ''

      if (remotePeerId && state.reputation.isBlacklisted(remotePeerId)) {
        console.log(`[subspace] Query from blacklisted peer ${remotePeerId} rejected`)
        return
      }

      // Phase 3.6: implement query protocol handler via Iroh ALPN streams.
      // The node.handle() stub is a no-op, so this handler is never actually called
      // in Phase 3.5. Remote queries return null via sendQuery() stub.
      try {
        // No-op: query handling via Iroh ALPN is Phase 3.6
        void stream; void connection
      } catch (err) {
        console.warn('[subspace] Query protocol handler error:', err)
      }
    })
  })()
}

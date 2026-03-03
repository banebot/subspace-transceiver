/**
 * Fastify HTTP API for the agent-net daemon.
 *
 * Binds ONLY to 127.0.0.1 — never 0.0.0.0 (AC 10).
 * All error responses: { error: string, code: string }
 */

import Fastify, { type FastifyInstance } from 'fastify'

import { v4 as uuidv4 } from 'uuid'
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
} from '@agent-net/core'
import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'

const VERSION = '0.1.0'

export interface DaemonState {
  config: DaemonConfig
  sessions: Map<string, NetworkSession>
  getPeerId: () => string
  startedAt: number
}

// Typed duplex for protocol handler
interface DuplexStream {
  source: AsyncIterable<Uint8Array>
  sink: (source: AsyncIterable<Uint8Array>) => Promise<void>
}

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
      const session = await joinNetwork(body.psk, {
        name: body.name,
        dataDir: state.config.dataDir,
      })
      state.sessions.set(session.id, session)
      const existing = state.config.networks.find(n => deriveNetworkId(n.psk) === networkId)
      if (!existing) {
        state.config.networks.push({ psk: body.psk, name: body.name })
      }
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

    const agentId = state.config.agentId ?? session.node.peerId.toString()

    const chunk: MemoryChunk = {
      type: body.type ?? 'context',
      namespace,
      topic: (body.topic ?? []).map((t: string) => t.toLowerCase()),
      content: body.content ?? '',
      source: {
        agentId: body.source?.agentId || agentId,
        peerId: body.source?.peerId || session.node.peerId.toString(),
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
    }

    try {
      validateChunk(chunk)
    } catch (err) {
      const e = err as AgentNetError
      return reply.status(400).send({ error: e.message, code: e.code })
    }

    const store = namespace === 'skill' ? session.stores.skill : session.stores.project
    try {
      await store.put(chunk)
      return reply.status(201).send(chunk)
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

    for (const session of state.sessions.values()) {
      const responses = await Promise.allSettled(
        session.node.getPeers().map((peerId) => sendQuery(session.node, peerId, queryOp))
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
    const body = req.body as { content?: string; confidence?: number }

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
      source: { ...existing.source, timestamp: Date.now() },
    }

    try {
      validateChunk(updated)
      await foundStore.put(updated)
      return reply.send(updated)
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
        if (chunk) { await s.forget(id); found = true }
      }
    }

    if (!found) {
      return reply.status(404).send({ error: 'Chunk not found', code: ErrorCode.CHUNK_NOT_FOUND })
    }
    return reply.status(204).send()
  })

  // Register protocol handler on startup for any already-active sessions
  app.addHook('onReady', async () => {
    for (const session of state.sessions.values()) {
      registerQueryProtocol(session, state)
    }
  })

  return app
}

/**
 * Register the /agent-net/query/1.0.0 libp2p protocol handler.
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
        const results: MemoryChunk[] = []
        for (const store of [session.stores.skill, session.stores.project]) {
          const chunks = await store.query(req.query).catch(() => [] as MemoryChunk[])
          results.push(...chunks)
        }

        const response = { requestId: req.requestId, chunks: results, peerId: session.node.peerId.toString() }
        async function* responseSource() { yield encodeMessage(response) }
        await pipe(responseSource(), (src) => lp.encode(src), s.sink)
      } catch (err) {
        console.warn('[agent-net] Query protocol handler error:', err)
      }
    })
  })()
}

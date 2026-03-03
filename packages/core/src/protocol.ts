/**
 * /agent-net/query/1.0.0 — custom libp2p protocol for network-wide memory scan.
 *
 * GossipSub is pub/sub only — no request/response semantics.
 * This custom protocol enables daemon-to-daemon memory queries across peers.
 *
 * Wire format: length-prefixed JSON over a libp2p stream.
 * Uses it-length-prefixed + it-pipe for framing.
 *
 * Request  → { query: MemoryQuery, requestId: string }
 * Response ← { requestId: string, chunks: MemoryChunk[], peerId: string }
 *
 * Timeout: 5000ms per peer. Timed-out or failed peers are skipped silently.
 */

import { pipe } from 'it-pipe'
import * as lp from 'it-length-prefixed'
import type { Libp2p } from 'libp2p'
import type { PeerId, Stream } from '@libp2p/interface'
import type { Source, Sink } from 'it-stream-types'
import type { MemoryChunk, MemoryQuery } from './schema.js'
import { NetworkError, ErrorCode } from './errors.js'

// Typed duplex interface for it-pipe compatibility
interface DuplexStream {
  source: AsyncIterable<Uint8Array>
  sink: Sink<AsyncIterable<Uint8Array>>
  close(): Promise<void>
}

export const QUERY_PROTOCOL = '/agent-net/query/1.0.0'

export interface QueryRequest {
  query: MemoryQuery
  requestId: string
}

export interface QueryResponse {
  requestId: string
  chunks: MemoryChunk[]
  peerId: string
}

// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Encode a JSON-serialisable value to a Uint8Array (UTF-8 JSON).
 */
export function encodeMessage(msg: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(msg))
}

/**
 * Decode a Uint8Array to a typed value (JSON parse).
 */
export function decodeMessage<T>(data: Uint8Array | ArrayBufferView): T {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array((data as ArrayBufferView).buffer)
  return JSON.parse(decoder.decode(bytes)) as T
}

// ---------------------------------------------------------------------------
// Client — send a query to a single peer
// ---------------------------------------------------------------------------

/**
 * Dial a peer, send a QueryRequest, and read back a QueryResponse.
 * Throws NetworkError with PEER_DIAL_FAILED on timeout (5s) or connection error.
 */
export async function sendQuery(
  node: Libp2p,
  peerId: PeerId,
  query: MemoryQuery
): Promise<QueryResponse> {
  const requestId = crypto.randomUUID()
  const request: QueryRequest = { query, requestId }
  const timeoutSignal = AbortSignal.timeout(5000)

  let rawStream: Awaited<ReturnType<typeof node.dialProtocol>>
  try {
    rawStream = await node.dialProtocol(peerId, QUERY_PROTOCOL, { signal: timeoutSignal })
  } catch (err) {
    throw new NetworkError(
      `Failed to dial peer ${peerId.toString()} for query: ${String(err)}`,
      ErrorCode.PEER_DIAL_FAILED,
      err
    )
  }

  // Cast to typed duplex — libp2p Stream extends Duplex<source, sink> at runtime
  const stream = rawStream as unknown as DuplexStream

  try {
    const responseChunks: Uint8Array[] = []

    async function* requestSource() { yield encodeMessage(request) }
    await pipe(
      requestSource(),
      (source) => lp.encode(source),
      stream.sink
    )

    await pipe(
      stream.source,
      (source) => lp.decode(source),
      async function (source) {
        for await (const chunk of source) {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
          responseChunks.push(bytes)
          break // We expect exactly one response frame
        }
      }
    )

    if (responseChunks.length === 0) {
      throw new NetworkError(
        `No response from peer ${peerId.toString()}`,
        ErrorCode.PEER_DIAL_FAILED
      )
    }

    return decodeMessage<QueryResponse>(responseChunks[0])
  } catch (err) {
    if (err instanceof NetworkError) throw err
    throw new NetworkError(
      `Query stream error with peer ${peerId.toString()}: ${String(err)}`,
      ErrorCode.PEER_DIAL_FAILED,
      err
    )
  } finally {
    await stream.close().catch(() => {})
  }
}

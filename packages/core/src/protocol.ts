/**
 * /subspace/query/1.0.0 — custom libp2p protocol for network-wide memory scan.
 *
 * GossipSub is pub/sub only — no request/response semantics.
 * This custom protocol enables daemon-to-daemon memory queries across peers.
 *
 * Wire format: length-prefixed JSON over a libp2p stream.
 * Uses it-length-prefixed for framing.
 *
 * libp2p v3 stream API:
 *   Reading  → `for await (const chunk of stream)` — stream is AsyncIterable
 *   Writing  → `stream.send(chunk)` — returns false if backpressured (wait 'drain')
 *   Closing  → `stream.close()`
 *
 * Request  → { query: MemoryQuery, requestId: string }
 * Response ← { requestId: string, chunks: MemoryChunk[], peerId: string }
 *
 * Timeout: 5000ms per peer. Timed-out or failed peers are skipped silently.
 */

import * as lp from 'it-length-prefixed'
import type { Libp2p } from 'libp2p'
import type { PeerId } from '@libp2p/interface'
import type { MemoryChunk, MemoryQuery } from './schema.js'
import { NetworkError, ErrorCode } from './errors.js'
import type { HashcashStamp } from './pow.js'

export const QUERY_PROTOCOL = '/subspace/query/1.0.0'

export interface QueryRequest {
  query: MemoryQuery
  requestId: string
  /** Proof-of-work stamp (optional, required when remote enforces requirePoW) */
  pow?: HashcashStamp
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

/**
 * libp2p v3 Stream interface used at runtime.
 *
 * In libp2p v3, streams implement AsyncIterable for reading and expose a
 * `send(data)` method for writing (different from the old it-stream Duplex API).
 */
interface Libp2pV3Stream extends AsyncIterable<Uint8Array | { subarray(): Uint8Array }> {
  /** Write a chunk to the stream. Returns false when backpressured. */
  send(data: Uint8Array | Uint8Array[]): boolean
  /** Gracefully close the stream. */
  close(opts?: { signal?: AbortSignal }): Promise<void>
  /** Abort the stream with an error. */
  abort(err: Error): void
}

/**
 * Send all chunks from an async iterable to a stream, handling backpressure.
 */
async function streamSend(stream: Libp2pV3Stream, source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of source) {
    const drained = stream.send(chunk)
    if (!drained) {
      // Wait for drain — stream will emit 'drain' event when ready
      await new Promise<void>((resolve) => {
        ;(stream as unknown as { addEventListener(e: string, h: () => void, o?: { once?: boolean }): void })
          .addEventListener('drain', resolve, { once: true })
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Client — send a query to a single peer
// ---------------------------------------------------------------------------

/**
 * Dial a peer, send a QueryRequest, and read back a QueryResponse.
 * Throws NetworkError with PEER_DIAL_FAILED on timeout (5s) or connection error.
 *
 * @param pow - optional proof-of-work stamp to include in the request envelope
 */
export async function sendQuery(
  node: Libp2p,
  peerId: PeerId,
  query: MemoryQuery,
  pow?: HashcashStamp,
): Promise<QueryResponse> {
  const requestId = crypto.randomUUID()
  const request: QueryRequest = { query, requestId, ...(pow ? { pow } : {}) }
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

  const stream = rawStream as unknown as Libp2pV3Stream

  try {
    // Write the request (length-prefixed JSON)
    async function* requestSource() { yield encodeMessage(request) }
    await streamSend(stream, lp.encode(requestSource()))

    // Read the response (length-prefixed JSON, one frame)
    const responseChunks: Uint8Array[] = []
    for await (const chunk of lp.decode(stream as AsyncIterable<Uint8Array>)) {
      const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray()
      responseChunks.push(bytes)
      break // We expect exactly one response frame
    }

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

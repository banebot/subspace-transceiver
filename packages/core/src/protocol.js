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
import * as lp from 'it-length-prefixed';
import { NetworkError, ErrorCode } from './errors.js';
export const QUERY_PROTOCOL = '/subspace/query/1.0.0';
// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/**
 * Encode a JSON-serialisable value to a Uint8Array (UTF-8 JSON).
 */
export function encodeMessage(msg) {
    return encoder.encode(JSON.stringify(msg));
}
/**
 * Decode a Uint8Array to a typed value (JSON parse).
 */
export function decodeMessage(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer);
    return JSON.parse(decoder.decode(bytes));
}
/**
 * Send all chunks from an async iterable to a stream, handling backpressure.
 */
async function streamSend(stream, source) {
    for await (const chunk of source) {
        const drained = stream.send(chunk);
        if (!drained) {
            // Wait for drain — stream will emit 'drain' event when ready
            await new Promise((resolve) => {
                ;
                stream
                    .addEventListener('drain', resolve, { once: true });
            });
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
export async function sendQuery(node, peerId, query, pow, networkId) {
    const requestId = crypto.randomUUID();
    const request = { query, requestId, ...(pow ? { pow } : {}), ...(networkId ? { networkId } : {}) };
    const timeoutSignal = AbortSignal.timeout(5000);
    let rawStream;
    try {
        rawStream = await node.dialProtocol(peerId, QUERY_PROTOCOL, { signal: timeoutSignal });
    }
    catch (err) {
        throw new NetworkError(`Failed to dial peer ${peerId.toString()} for query: ${String(err)}`, ErrorCode.PEER_DIAL_FAILED, err);
    }
    const stream = rawStream;
    try {
        // Write the request (length-prefixed JSON)
        async function* requestSource() { yield encodeMessage(request); }
        await streamSend(stream, lp.encode(requestSource()));
        // Read the response (length-prefixed JSON, one frame)
        const responseChunks = [];
        for await (const chunk of lp.decode(stream)) {
            const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
            responseChunks.push(bytes);
            break; // We expect exactly one response frame
        }
        if (responseChunks.length === 0) {
            throw new NetworkError(`No response from peer ${peerId.toString()}`, ErrorCode.PEER_DIAL_FAILED);
        }
        return decodeMessage(responseChunks[0]);
    }
    catch (err) {
        if (err instanceof NetworkError)
            throw err;
        throw new NetworkError(`Query stream error with peer ${peerId.toString()}: ${String(err)}`, ErrorCode.PEER_DIAL_FAILED, err);
    }
    finally {
        await stream.close().catch(() => { });
    }
}
//# sourceMappingURL=protocol.js.map
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
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import type { MemoryChunk, MemoryQuery } from './schema.js';
import type { HashcashStamp } from './pow.js';
export declare const QUERY_PROTOCOL = "/subspace/query/1.0.0";
export interface QueryRequest {
    query: MemoryQuery;
    requestId: string;
    /** Proof-of-work stamp (optional, required when remote enforces requirePoW) */
    pow?: HashcashStamp;
    /**
     * Network ID of the requesting peer's PSK session (SHA-256 of PSK).
     * The query handler rejects requests from peers on different networks,
     * enforcing PSK isolation at the application layer even when two PSK
     * nodes accidentally connect to each other (e.g. via mDNS on the same LAN).
     */
    networkId?: string;
}
export interface QueryResponse {
    requestId: string;
    chunks: MemoryChunk[];
    peerId: string;
}
/**
 * Encode a JSON-serialisable value to a Uint8Array (UTF-8 JSON).
 */
export declare function encodeMessage(msg: unknown): Uint8Array;
/**
 * Decode a Uint8Array to a typed value (JSON parse).
 */
export declare function decodeMessage<T>(data: Uint8Array | ArrayBufferView): T;
/**
 * Dial a peer, send a QueryRequest, and read back a QueryResponse.
 * Throws NetworkError with PEER_DIAL_FAILED on timeout (5s) or connection error.
 *
 * @param pow - optional proof-of-work stamp to include in the request envelope
 */
export declare function sendQuery(node: Libp2p, peerId: PeerId, query: MemoryQuery, pow?: HashcashStamp, networkId?: string): Promise<QueryResponse>;
//# sourceMappingURL=protocol.d.ts.map
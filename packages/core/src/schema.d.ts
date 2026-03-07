import { z } from 'zod';
import type { HashcashStamp } from './pow.js';
export type MemoryType = 'skill' | 'project' | 'context' | 'pattern' | 'result' | 'document' | 'schema' | 'thread' | 'blob-manifest' | 'profile';
export type MemoryNamespace = 'skill' | 'project';
/**
 * Content format for the ContentEnvelope.
 * When absent (legacy chunks), content is treated as 'text'.
 */
export type ContentFormat = 'text' | 'markdown' | 'json' | 'code' | 'thread' | 'table' | 'composite';
/**
 * Reference to a binary or external media asset.
 * Media is REFERENCED, not embedded — keeps chunks small.
 *
 * URI schemes:
 *   agent://<peerId>/blobs/<sha256hash>  — content on this network
 *   ipfs://<CID>                         — IPFS-addressed content
 *   https://...                          — public HTTP URL
 *   data:<mimeType>;base64,...           — inline data (max 4KB)
 */
export interface MediaRef {
    uri: string;
    mimeType: string;
    size?: number;
    hash?: string;
    alt?: string;
}
/**
 * Rich content envelope.
 * When present, `content` on MemoryChunk is a plain-text SUMMARY for search.
 * The actual rich content lives here.
 */
export interface ContentEnvelope {
    format: ContentFormat;
    body: string;
    media?: MediaRef[];
    schemaUri?: string;
    metadata?: Record<string, string>;
}
/**
 * Standard link relationship types.
 * Agents may use any string for `rel` — these are the canonical values.
 */
export type LinkRel = 'related' | 'depends-on' | 'supersedes' | 'references' | 'part-of' | 'reply-to' | 'see-also' | string;
export interface ContentLink {
    /** Target chunk ID (UUID) or agent:// URI */
    target: string;
    /** Relationship type */
    rel: LinkRel;
    /** Optional human-readable description of the relationship */
    label?: string;
}
export interface MemoryChunk {
    id: string;
    type: MemoryType;
    namespace: MemoryNamespace;
    topic: string[];
    /** Plain-text summary — always required. Used for full-text search. */
    content: string;
    source: {
        agentId: string;
        peerId: string;
        project?: string;
        sessionId?: string;
        timestamp: number;
    };
    ttl?: number;
    confidence: number;
    network: string;
    version: number;
    supersedes?: string;
    /** Named collection within this agent's namespace (e.g. 'patterns', 'guides') */
    collection?: string;
    /** Human-readable slug, unique within agent+collection (e.g. 'typescript-async') */
    slug?: string;
    /** Rich content envelope. When present, `content` is a search-index summary. */
    contentEnvelope?: ContentEnvelope;
    /** Typed directed links to other chunks or agent:// URIs */
    links?: ContentLink[];
    /**
     * Ed25519 signature over the canonical chunk bytes (base64-encoded).
     * Canonical = JSON.stringify of the chunk WITHOUT this field, keys sorted.
     * Signed by the agent's identity private key (source.peerId must match signer).
     */
    signature?: string;
    /**
     * Hashcash proof-of-work stamp (optional, backward-compatible).
     * When security.requirePoW is true, chunks without a valid stamp are rejected.
     */
    pow?: HashcashStamp;
    /** Origin marker for crawled/cached content — not re-advertised to prevent amplification. */
    origin?: 'local' | 'crawl' | 'replicated';
    /** Internal tombstone marker — set by store.forget(). Not for external use. */
    _tombstone?: boolean;
}
export interface MemoryQuery {
    topics?: string[];
    type?: MemoryType;
    namespace?: MemoryNamespace;
    project?: string;
    /** Filter by publishing agent's PeerId (namespace query) */
    peerId?: string;
    /** Filter by collection name */
    collection?: string;
    /** Filter by content format */
    contentFormat?: ContentFormat;
    minConfidence?: number;
    since?: number;
    until?: number;
    limit?: number;
}
export declare const memoryChunkSchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodEnum<{
        skill: "skill";
        project: "project";
        context: "context";
        pattern: "pattern";
        result: "result";
        document: "document";
        schema: "schema";
        thread: "thread";
        "blob-manifest": "blob-manifest";
        profile: "profile";
    }>;
    namespace: z.ZodEnum<{
        skill: "skill";
        project: "project";
    }>;
    topic: z.ZodArray<z.ZodString>;
    content: z.ZodString;
    source: z.ZodObject<{
        agentId: z.ZodString;
        peerId: z.ZodString;
        project: z.ZodOptional<z.ZodString>;
        sessionId: z.ZodOptional<z.ZodString>;
        timestamp: z.ZodNumber;
    }, z.core.$strip>;
    ttl: z.ZodOptional<z.ZodNumber>;
    confidence: z.ZodNumber;
    network: z.ZodString;
    version: z.ZodDefault<z.ZodNumber>;
    supersedes: z.ZodOptional<z.ZodString>;
    collection: z.ZodOptional<z.ZodString>;
    slug: z.ZodOptional<z.ZodString>;
    contentEnvelope: z.ZodOptional<z.ZodObject<{
        format: z.ZodEnum<{
            thread: "thread";
            text: "text";
            markdown: "markdown";
            json: "json";
            code: "code";
            table: "table";
            composite: "composite";
        }>;
        body: z.ZodString;
        media: z.ZodOptional<z.ZodArray<z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodString;
            size: z.ZodOptional<z.ZodNumber>;
            hash: z.ZodOptional<z.ZodString>;
            alt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        schemaUri: z.ZodOptional<z.ZodString>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
    links: z.ZodOptional<z.ZodArray<z.ZodObject<{
        target: z.ZodString;
        rel: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    signature: z.ZodOptional<z.ZodString>;
    pow: z.ZodOptional<z.ZodObject<{
        bits: z.ZodNumber;
        challenge: z.ZodString;
        nonce: z.ZodString;
        hash: z.ZodString;
    }, z.core.$strip>>;
    origin: z.ZodOptional<z.ZodEnum<{
        local: "local";
        crawl: "crawl";
        replicated: "replicated";
    }>>;
    _tombstone: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type MemoryChunkInput = z.input<typeof memoryChunkSchema>;
/**
 * Validate and parse a raw data object into a typed MemoryChunk.
 * Throws StoreError with INVALID_CHUNK on validation failure.
 */
export declare function validateChunk(data: unknown): MemoryChunk;
/**
 * Create a new MemoryChunk with auto-generated id and default version.
 * Caller provides all other fields; id and version are set here.
 */
export declare function createChunk(input: Omit<MemoryChunk, 'id' | 'version'> & {
    version?: number;
}): MemoryChunk;
//# sourceMappingURL=schema.d.ts.map
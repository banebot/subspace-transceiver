/**
 * @subspace/core — public API
 *
 * Exports all public types, error classes, and functions.
 * OrbitDB internals are NOT exported — use IMemoryStore interface only.
 */

// Error hierarchy
export {
  AgentNetError,
  CryptoError,
  StoreError,
  NetworkError,
  DaemonError,
  ErrorCode,
} from './errors.js'
export type { ErrorCode as ErrorCodeType } from './errors.js'

// Schema + types
export {
  validateChunk,
  createChunk,
  memoryChunkSchema,
} from './schema.js'
export type {
  MemoryChunk,
  MemoryType,
  MemoryNamespace,
  MemoryQuery,
  MemoryChunkInput,
  ContentFormat,
  ContentEnvelope,
  ContentLink,
  LinkRel,
  MediaRef,
} from './schema.js'

// Crypto
export {
  deriveNetworkKeys,
  validatePSK,
  encryptEnvelope,
  decryptEnvelope,
} from './crypto.js'
export type { NetworkKeys, EncryptedEnvelope } from './crypto.js'

// Agent identity (persistent per-agent Ed25519 keypair)
export {
  loadOrCreateIdentity,
  DEFAULT_IDENTITY_PATH,
} from './identity.js'
export type { AgentIdentity } from './identity.js'

// Chunk signing and verification
export {
  signChunk,
  verifyChunkSignature,
  canonicalChunkBytes,
} from './signing.js'

// Rate limiting
export { RateLimiter } from './rate-limiter.js'
export type { RateLimiterOptions } from './rate-limiter.js'

// Peer reputation scoring
export { ReputationStore } from './reputation.js'
export type { ScoreEvent } from './reputation.js'

// agent:// URI scheme
export {
  parseAgentURI,
  buildAgentURI,
  buildBlobURI,
  isAgentURI,
  isBlobURI,
} from './uri.js'
export type { AgentURI } from './uri.js'

// Bloom filters
export { BloomFilter } from './bloom.js'

// Content graph backlink index
export { BacklinkIndex } from './backlink-index.js'

// Discovery + browse protocol
export {
  DiscoveryManager,
  DISCOVERY_TOPIC,
  BROWSE_PROTOCOL,
} from './discovery.js'
export type {
  DiscoveryManifest,
  PeerIndexEntry,
  BrowseRequest,
  BrowseResponse,
  ChunkStub,
  DiscoveryManagerOptions,
} from './discovery.js'

// Store interface
export type { IMemoryStore, MemoryStoreEvents } from './store.js'

// OrbitDB store factory (implementation hidden — use IMemoryStore interface)
export { createOrbitDBStore, createOrbitDBContext, type OrbitDBContext } from './orbitdb-store.js'

// Network operations
export {
  joinNetwork,
  leaveNetwork,
  sessionToDTO,
  deriveNetworkId,
} from './network.js'
export type { NetworkInfoDTO, NetworkSession } from './network.js'
// Note: NetworkSession holds live resources — do NOT serialise.
// Use NetworkInfoDTO for API/HTTP responses.

// GC
export { runGC } from './gc.js'
export type { GCResult } from './gc.js'

// Query utilities (exposed for daemon scan handler)
export { buildOrbitFilter, resolveHeads, applyQuery } from './query.js'

// Protocol
export {
  QUERY_PROTOCOL,
  encodeMessage,
  decodeMessage,
  sendQuery,
} from './protocol.js'
export type { QueryRequest, QueryResponse } from './protocol.js'

// Bootstrap constants
export { BOOTSTRAP_ADDRESSES, RELAY_ADDRESSES } from './bootstrap.js'

// Node factory (exposed for tests and advanced usage)
export { createLibp2pNode, derivePeerId } from './node.js'

// Hashcash proof-of-work (TODO-4e34c409)
export {
  mineStamp,
  verifyStamp,
  currentChallenge,
  StampCache,
  DEFAULT_POW_WINDOW_MS,
  DEFAULT_POW_BITS_CHUNKS,
  DEFAULT_POW_BITS_REQUESTS,
} from './pow.js'
export type {
  HashcashStamp,
  PowScope,
  StampCacheEntry,
} from './pow.js'

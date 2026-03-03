/**
 * @agent-net/core — public API
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
} from './schema.js'

// Crypto
export {
  deriveNetworkKeys,
  validatePSK,
  encryptEnvelope,
  decryptEnvelope,
} from './crypto.js'
export type { NetworkKeys, EncryptedEnvelope } from './crypto.js'

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

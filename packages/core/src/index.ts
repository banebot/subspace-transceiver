/**
 * @subspace-net/core — public API
 *
 * Exports all public types, error classes, and functions.
 * Store implementations are NOT exported — use IMemoryStore interface only.
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

// Agent identity (persistent per-agent Ed25519 keypair + DID:Key)
export {
  loadOrCreateIdentity,
  deriveDidKey,
  publicKeyFromDidKey,
  isValidDidKey,
  generateDIDDocument,
  DEFAULT_IDENTITY_PATH,
} from './identity.js'
export type { AgentIdentity, DIDDocument } from './identity.js'

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

// Loro CRDT store (v2 replacement for OrbitDB)
export { LoroMemoryStore, createLoroStore, createPersistentLoroStore } from './loro-store.js'

// Loro epoch manager (v2 replacement for OrbitDB EpochManager)
export { LoroEpochManager } from './loro-epoch-manager.js'

// Network operations
export {
  joinNetwork,
  leaveNetwork,
  sessionToDTO,
  deriveNetworkId,
  // Global network (always-on connectivity layer — no PSK required)
  joinGlobalNetwork,
  leaveGlobalNetwork,
} from './network.js'
export type {
  NetworkInfoDTO,
  NetworkSession,
  // Global session — agent's presence on the open internet
  GlobalSession,
} from './network.js'
// Note: NetworkSession and GlobalSession hold live resources — do NOT serialise.
// Use NetworkInfoDTO for API/HTTP responses.

// GC
export { runGC } from './gc.js'
export type { GCResult } from './gc.js'

// Epoch-based database rotation utilities
export {
  computeEpochId,
  epochStartMs,
  DEFAULT_EPOCH_CONFIG,
} from './epoch-manager.js'
export type { EpochConfig, EpochInfo, DropResult } from './epoch-manager.js'

// Query utilities (exposed for daemon scan handler)
export { buildOrbitFilter, resolveHeads, applyQuery } from './query.js'

// Protocol (ALPN identifiers + message encoding)
export {
  QUERY_PROTOCOL,
  BROWSE_PROTOCOL,
  MANIFEST_PROTOCOL,
  MAILBOX_PROTOCOL,
  NEGOTIATE_PROTOCOL,
  DISCOVERY_TOPIC,
  encodeMessage,
  decodeMessage,
  deriveGossipTopic,
  sendQuery,
} from './protocol.js'
export type { QueryRequest, QueryResponse } from './protocol.js'

// Bootstrap / relay configuration
export {
  IROH_PUBLIC_RELAYS,
  getRelayUrl,
  parseBootstrapPeer,
} from './bootstrap.js'
export type { BootstrapPeer } from './bootstrap.js'

// Iroh node factory
export { createIrohNode, derivePeerId } from './node.js'
export type { IrohNode, IrohNodeOptions } from './node.js'

// Connection pruner — disconnects inbound non-Subspace peers after graceMs
export { SubspaceConnectionPruner } from './connection-pruner.js'
export type { ConnectionPrunerOptions } from './connection-pruner.js'

// ANP-compatible meta-protocol capability negotiation
export {
  CapabilityRegistry,
  BUILT_IN_CAPABILITIES,
  registerNegotiateProtocol,
  queryCapabilities,
  toANPCapability,
  toANPAdvertisement,
} from './negotiate.js'
export type {
  CapabilityDeclaration,
  CapabilityRole,
  NegotiateRequest,
  NegotiateResponse,
} from './negotiate.js'

// Lexicon Protocol Registry — AT Protocol-inspired schema system
export {
  isValidNSID,
  parseNSID,
  nsidMatches,
  memoryTypeToNSID,
  nsidToMemoryType,
  BUILT_IN_NSIDS,
} from './nsid.js'
export type { ParsedNSID, BuiltInMemoryType } from './nsid.js'

export {
  validateLexiconSchema,
  validateRecordData,
  BUILT_IN_SCHEMAS,
} from './lexicon.js'
export type {
  LexiconSchema,
  FieldSchema,
  FieldType,
  RecordDefinition,
  ValidationResult as LexiconValidationResult,
} from './lexicon.js'

export {
  InMemorySchemaRegistry,
  FileSchemaRegistry,
  getDefaultRegistry,
  createFileRegistry,
  parseLexiconSchema,
  findSchemasByPattern,
} from './schema-registry.js'
export type { ISchemaRegistry, ValidationResult as SchemaValidationResult } from './schema-registry.js'

// Mail — store-and-forward messaging for offline agents
export {
  encryptMailPayload,
  decryptMailEnvelope,
  signEnvelope,
  verifyEnvelopeSignature,
  createEnvelope,
  isEnvelopeExpired,
} from './mail.js'
export type {
  MailEnvelope,
  MailPayload,
  MailMessage,
  InboxMessage,
  OutboxMessage,
} from './mail.js'

export {
  MemoryRelayStore,
  MemoryInboxStore,
  MemoryOutboxStore,
  FileRelayStore,
  FileInboxStore,
  FileOutboxStore,
  createFileMailStores,
  mailStoreExists,
} from './mail-store.js'
export type { IRelayStore, IInboxStore, IOutboxStore } from './mail-store.js'

export {
  registerMailboxProtocol,
  sendMail,
  pollMail,
} from './mail-protocol.js'
export type { MailboxHandlerOptions, SendMailOptions } from './mail-protocol.js'

// Iroh engine bridge (stdio JSON-RPC to Rust P2P engine)
export {
  EngineBridge,
  getDefaultBridge,
  _resetDefaultBridge,
} from './engine-bridge.js'
export type {
  EngineBridgeOptions,
  EngineStartResult,
  GossipMessage,
  PeerConnectedEvent,
} from './engine-bridge.js'

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

// ZKP identity proofs (Phase 4.1)
export {
  generateOwnershipProof,
  verifyOwnershipProof,
  issueCredential,
  verifyCredential,
  createPresentation,
  verifyPresentation,
  issueCapabilityCredential,
} from './zkp.js'
export type {
  Commitment,
  ProofOfKeyOwnership,
  Claim,
  VerifiableCredential,
  CredentialPresentation,
} from './zkp.js'

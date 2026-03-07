/**
 * @subspace-net/core — public API
 *
 * Exports all public types, error classes, and functions.
 * OrbitDB internals are NOT exported — use IMemoryStore interface only.
 */
// Error hierarchy
export { AgentNetError, CryptoError, StoreError, NetworkError, DaemonError, ErrorCode, } from './errors.js';
// Schema + types
export { validateChunk, createChunk, memoryChunkSchema, } from './schema.js';
// Crypto
export { deriveNetworkKeys, validatePSK, encryptEnvelope, decryptEnvelope, } from './crypto.js';
// Agent identity (persistent per-agent Ed25519 keypair)
export { loadOrCreateIdentity, DEFAULT_IDENTITY_PATH, } from './identity.js';
// Chunk signing and verification
export { signChunk, verifyChunkSignature, canonicalChunkBytes, } from './signing.js';
// Rate limiting
export { RateLimiter } from './rate-limiter.js';
// Peer reputation scoring
export { ReputationStore } from './reputation.js';
// agent:// URI scheme
export { parseAgentURI, buildAgentURI, buildBlobURI, isAgentURI, isBlobURI, } from './uri.js';
// Bloom filters
export { BloomFilter } from './bloom.js';
// Content graph backlink index
export { BacklinkIndex } from './backlink-index.js';
// Discovery + browse protocol
export { DiscoveryManager, DISCOVERY_TOPIC, BROWSE_PROTOCOL, } from './discovery.js';
// OrbitDB store factory (implementation hidden — use IMemoryStore interface)
export { createOrbitDBStore, createOrbitDBContext } from './orbitdb-store.js';
// OrbitDB access controller (replication-layer chunk validation)
export { SubspaceAccessController } from './access-controller.js';
// Network operations
export { joinNetwork, leaveNetwork, sessionToDTO, deriveNetworkId, 
// Global network (always-on connectivity layer — no PSK required)
joinGlobalNetwork, leaveGlobalNetwork, } from './network.js';
// Note: NetworkSession and GlobalSession hold live resources — do NOT serialise.
// Use NetworkInfoDTO for API/HTTP responses.
// GC
export { runGC } from './gc.js';
// Epoch-based database rotation
export { EpochManager, computeEpochId, epochStartMs, DEFAULT_EPOCH_CONFIG, } from './epoch-manager.js';
// Query utilities (exposed for daemon scan handler)
export { buildOrbitFilter, resolveHeads, applyQuery } from './query.js';
// Protocol
export { QUERY_PROTOCOL, encodeMessage, decodeMessage, sendQuery, } from './protocol.js';
// Bootstrap constants
export { BOOTSTRAP_ADDRESSES, RELAY_ADDRESSES } from './bootstrap.js';
// Node factory (exposed for tests and advanced usage)
export { createLibp2pNode, derivePeerId } from './node.js';
// Connection pruner — disconnects inbound non-Subspace peers after graceMs
export { SubspaceConnectionPruner } from './connection-pruner.js';
// Lexicon Protocol Registry — AT Protocol-inspired schema system
export { isValidNSID, parseNSID, nsidMatches, memoryTypeToNSID, nsidToMemoryType, BUILT_IN_NSIDS, } from './nsid.js';
export { validateLexiconSchema, validateRecordData, BUILT_IN_SCHEMAS, } from './lexicon.js';
export { InMemorySchemaRegistry, FileSchemaRegistry, getDefaultRegistry, createFileRegistry, parseLexiconSchema, findSchemasByPattern, } from './schema-registry.js';
// Mail — store-and-forward messaging for offline agents
export { MAILBOX_PROTOCOL, encryptMailPayload, decryptMailEnvelope, signEnvelope, verifyEnvelopeSignature, createEnvelope, isEnvelopeExpired, } from './mail.js';
export { MemoryRelayStore, MemoryInboxStore, MemoryOutboxStore, FileRelayStore, FileInboxStore, FileOutboxStore, createFileMailStores, mailStoreExists, } from './mail-store.js';
export { registerMailboxProtocol, sendMail, pollMail, } from './mail-protocol.js';
// Hashcash proof-of-work (TODO-4e34c409)
export { mineStamp, verifyStamp, currentChallenge, StampCache, DEFAULT_POW_WINDOW_MS, DEFAULT_POW_BITS_CHUNKS, DEFAULT_POW_BITS_REQUESTS, } from './pow.js';
//# sourceMappingURL=index.js.map
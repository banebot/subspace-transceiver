/**
 * @subspace-net/core — public API
 *
 * Exports all public types, error classes, and functions.
 * OrbitDB internals are NOT exported — use IMemoryStore interface only.
 */
export { AgentNetError, CryptoError, StoreError, NetworkError, DaemonError, ErrorCode, } from './errors.js';
export type { ErrorCode as ErrorCodeType } from './errors.js';
export { validateChunk, createChunk, memoryChunkSchema, } from './schema.js';
export type { MemoryChunk, MemoryType, MemoryNamespace, MemoryQuery, MemoryChunkInput, ContentFormat, ContentEnvelope, ContentLink, LinkRel, MediaRef, } from './schema.js';
export { deriveNetworkKeys, validatePSK, encryptEnvelope, decryptEnvelope, } from './crypto.js';
export type { NetworkKeys, EncryptedEnvelope } from './crypto.js';
export { loadOrCreateIdentity, DEFAULT_IDENTITY_PATH, } from './identity.js';
export type { AgentIdentity } from './identity.js';
export { signChunk, verifyChunkSignature, canonicalChunkBytes, } from './signing.js';
export { RateLimiter } from './rate-limiter.js';
export type { RateLimiterOptions } from './rate-limiter.js';
export { ReputationStore } from './reputation.js';
export type { ScoreEvent } from './reputation.js';
export { parseAgentURI, buildAgentURI, buildBlobURI, isAgentURI, isBlobURI, } from './uri.js';
export type { AgentURI } from './uri.js';
export { BloomFilter } from './bloom.js';
export { BacklinkIndex } from './backlink-index.js';
export { DiscoveryManager, DISCOVERY_TOPIC, BROWSE_PROTOCOL, } from './discovery.js';
export type { DiscoveryManifest, PeerIndexEntry, BrowseRequest, BrowseResponse, ChunkStub, DiscoveryManagerOptions, } from './discovery.js';
export type { IMemoryStore, MemoryStoreEvents } from './store.js';
export { createOrbitDBStore, createOrbitDBContext, type OrbitDBContext } from './orbitdb-store.js';
export { SubspaceAccessController, type SubspaceAccessControllerOptions } from './access-controller.js';
export { joinNetwork, leaveNetwork, sessionToDTO, deriveNetworkId, joinGlobalNetwork, leaveGlobalNetwork, } from './network.js';
export type { NetworkInfoDTO, NetworkSession, GlobalSession, } from './network.js';
export { runGC } from './gc.js';
export type { GCResult } from './gc.js';
export { EpochManager, computeEpochId, epochStartMs, DEFAULT_EPOCH_CONFIG, } from './epoch-manager.js';
export type { EpochConfig, EpochInfo, DropResult } from './epoch-manager.js';
export { buildOrbitFilter, resolveHeads, applyQuery } from './query.js';
export { QUERY_PROTOCOL, encodeMessage, decodeMessage, sendQuery, } from './protocol.js';
export type { QueryRequest, QueryResponse } from './protocol.js';
export { BOOTSTRAP_ADDRESSES, RELAY_ADDRESSES } from './bootstrap.js';
export { createLibp2pNode, derivePeerId } from './node.js';
export type { CreateNodeOptions, LibP2pNodeWithPruner } from './node.js';
export { SubspaceConnectionPruner } from './connection-pruner.js';
export type { ConnectionPrunerOptions } from './connection-pruner.js';
export { isValidNSID, parseNSID, nsidMatches, memoryTypeToNSID, nsidToMemoryType, BUILT_IN_NSIDS, } from './nsid.js';
export type { ParsedNSID, BuiltInMemoryType } from './nsid.js';
export { validateLexiconSchema, validateRecordData, BUILT_IN_SCHEMAS, } from './lexicon.js';
export type { LexiconSchema, FieldSchema, FieldType, RecordDefinition, ValidationResult as LexiconValidationResult, } from './lexicon.js';
export { InMemorySchemaRegistry, FileSchemaRegistry, getDefaultRegistry, createFileRegistry, parseLexiconSchema, findSchemasByPattern, } from './schema-registry.js';
export type { ISchemaRegistry, ValidationResult as SchemaValidationResult } from './schema-registry.js';
export { MAILBOX_PROTOCOL, encryptMailPayload, decryptMailEnvelope, signEnvelope, verifyEnvelopeSignature, createEnvelope, isEnvelopeExpired, } from './mail.js';
export type { MailEnvelope, MailPayload, MailMessage, InboxMessage, OutboxMessage, } from './mail.js';
export { MemoryRelayStore, MemoryInboxStore, MemoryOutboxStore, FileRelayStore, FileInboxStore, FileOutboxStore, createFileMailStores, mailStoreExists, } from './mail-store.js';
export type { IRelayStore, IInboxStore, IOutboxStore } from './mail-store.js';
export { registerMailboxProtocol, sendMail, pollMail, } from './mail-protocol.js';
export type { MailboxHandlerOptions, SendMailOptions } from './mail-protocol.js';
export { mineStamp, verifyStamp, currentChallenge, StampCache, DEFAULT_POW_WINDOW_MS, DEFAULT_POW_BITS_CHUNKS, DEFAULT_POW_BITS_REQUESTS, } from './pow.js';
export type { HashcashStamp, PowScope, StampCacheEntry, } from './pow.js';
//# sourceMappingURL=index.d.ts.map
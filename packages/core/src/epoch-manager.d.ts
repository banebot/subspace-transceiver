/**
 * EpochManager — epoch-based OrbitDB database rotation to solve CRDT tombstone bloat.
 *
 * ## Problem
 * OrbitDB is an append-only CRDT oplog. Every `store.forget()` writes a tombstone —
 * a new entry that hides a record but never reclaims disk from the original block or
 * from itself. An agent writing 1,000 TTL'd memories/day generates ~365K tombstones/year
 * that can never be reclaimed. The database becomes 99% ghost entries.
 *
 * ## Solution: Time-windowed database epochs
 * Instead of a single OrbitDB DocumentStore per namespace that grows forever, each
 * namespace is split into rolling time-window epochs. Each epoch is a separate OrbitDB
 * database. When an epoch expires:
 *   1. Live (non-expired, non-tombstoned) chunks are migrated to the new epoch as
 *      fresh `put()` entries (no tombstones needed — they simply don't migrate).
 *   2. The expired epoch's LevelDB directories are deleted, reclaiming all disk space.
 *
 * ## Interface transparency
 * EpochManager implements IMemoryStore. Callers (network.ts, gc-scheduler.ts, api.ts)
 * do not need to know about epochs — the fan-out across readable epochs is internal.
 *
 * ## Disk reclamation
 * `dropExpiredEpochs()` physically deletes the LevelDB directories for epochs older
 * than the retention window. This is O(1) per dropped epoch and frees all space
 * (blocks, oplog, tombstones, index) at once.
 *
 * ## Peer synchronisation
 * Each epoch is an independent OrbitDB database with its own address. Peers joining
 * the network replicate the current epoch and any retained past epochs. A peer offline
 * longer than `retainEpochs × epochDurationMs` will miss dropped epochs — this tradeoff
 * is documented and configurable.
 */
import { EventEmitter } from 'node:events';
import type { OrbitDB } from '@orbitdb/core';
import type { MemoryChunk, MemoryQuery, MemoryNamespace } from './schema.js';
import type { IMemoryStore, MemoryStoreEvents } from './store.js';
import type { NetworkKeys } from './crypto.js';
export interface EpochConfig {
    /**
     * Duration of each epoch in milliseconds.
     * Default: 604_800_000 (7 days).
     */
    epochDurationMs: number;
    /**
     * Number of past epochs to retain as readable after rotation.
     * Total visibility window = (retainEpochs + 1) × epochDurationMs.
     * Default: 1 (2 weeks total: current + 1 previous).
     */
    retainEpochs: number;
    /**
     * Time before epoch end to start migrating permanent chunks (milliseconds).
     * Should be long enough for migration to complete before the epoch boundary.
     * Default: 3_600_000 (1 hour).
     */
    migrationLeadTimeMs: number;
}
export declare const DEFAULT_EPOCH_CONFIG: EpochConfig;
export interface EpochInfo {
    /** Epoch identifier string (e.g. '2026-W10') */
    id: string;
    /** Epoch start timestamp (ms since epoch) */
    startsAt: number;
    /** Epoch end timestamp (ms since epoch) */
    endsAt: number;
    /** Whether this is the current write-target epoch */
    isCurrent: boolean;
    /** Approximate chunk count (from list()) */
    chunkCount: number;
}
export interface DropResult {
    dropped: string[];
    reclaimedBytes: number;
}
/**
 * Compute a deterministic epoch identifier for a given timestamp.
 * Epochs are aligned to UTC week boundaries (ISO 8601 week numbers).
 * For sub-week durations, uses floor(timestamp / epochDurationMs) as the ID.
 */
export declare function computeEpochId(nowMs: number, epochDurationMs: number): string;
/**
 * Compute the start timestamp (ms) for a given epoch ID.
 * Used to order epochs chronologically.
 */
export declare function epochStartMs(epochId: string, epochDurationMs: number): number;
/**
 * Wraps multiple OrbitDB stores behind the IMemoryStore interface.
 * One store per epoch; writes always go to the current epoch.
 * Reads fan out across the current epoch + retained past epochs.
 */
export declare class EpochManager extends EventEmitter implements IMemoryStore {
    private orbitdb;
    private networkKeys;
    private namespace;
    private config;
    private dataDir;
    private envelopeKey;
    /** epoch id → store (sorted newest-first for reads) */
    private epochs;
    private currentEpochId;
    private migrationInProgress;
    private constructor();
    /**
     * Create an EpochManager, opening the current epoch and any retained past epochs.
     *
     * @param orbitdb      Pre-initialised OrbitDB instance
     * @param networkKeys  Network keys (used for topic + envelope key)
     * @param namespace    Memory namespace ('skill' | 'project')
     * @param config       Epoch configuration
     * @param dataDir      Base data directory for LevelDB (epoch dirs created beneath)
     * @param envelopeKey  AES-256-GCM key for content encryption. null = no encryption.
     */
    static create(orbitdb: OrbitDB, networkKeys: NetworkKeys, namespace: MemoryNamespace, config: EpochConfig | undefined, dataDir: string, envelopeKey?: Buffer | null): Promise<EpochManager>;
    private static _openEpochStore;
    /** Write to the current epoch. */
    put(chunk: MemoryChunk): Promise<void>;
    /** Read from current epoch first, then past epochs. Returns the latest version. */
    get(id: string): Promise<MemoryChunk | null>;
    /** Fan-out query across all readable epochs; resolveHeads to deduplicate. */
    query(q: MemoryQuery): Promise<MemoryChunk[]>;
    /** Union of all readable epochs, tombstones excluded, resolveHeads applied. */
    list(): Promise<MemoryChunk[]>;
    /** Tombstone the chunk in whichever epoch holds it. */
    forget(id: string): Promise<void>;
    /** Close all epoch stores. */
    close(): Promise<void>;
    /**
     * Check if the current epoch has expired and rotate if needed.
     * Called by the GC scheduler on every interval tick.
     *
     * @returns true if a rotation was performed, false otherwise.
     */
    maybeRotateEpoch(nowMs?: number): Promise<boolean>;
    /**
     * Perform epoch rotation:
     * 1. Open new epoch store
     * 2. Migrate live permanent chunks from expiring epochs beyond retention window
     * 3. Seal (mark read-only by removing from writable current) old epochs
     */
    rotateEpoch(newEpochId: string, nowMs?: number): Promise<void>;
    /**
     * Migrate live chunks from a soon-to-be-dropped epoch into the new epoch store.
     *
     * Migration triage:
     * - _tombstone: true          → abandoned (tombstones never migrate)
     * - ttl set and expired        → abandoned (died naturally)
     * - ttl set but not expired    → migrated (will expire in new epoch)
     * - no ttl (permanent)         → migrated
     * - superseded (not HEAD)      → abandoned (resolveHeads picks winners)
     */
    private _migrateChunks;
    /**
     * Close and physically delete LevelDB directories for epochs outside the retention window.
     * Returns the list of dropped epoch IDs and the bytes reclaimed.
     *
     * Call AFTER rotateEpoch() to reclaim disk space from expired epochs.
     */
    dropExpiredEpochs(nowMs?: number): Promise<DropResult>;
    private _measureAndDeleteEpochDir;
    /**
     * Return info about all currently open epochs (for health/monitoring).
     */
    getEpochInfo(nowMs?: number): Promise<EpochInfo[]>;
    private currentStore;
    /** Returns epoch IDs sorted newest-first (for reads: prefer newest data). */
    private _orderedEpochIds;
    /** Current epoch ID (for health reporting). */
    get currentEpoch(): string;
    /** Number of open epoch stores. */
    get epochCount(): number;
    on<K extends keyof MemoryStoreEvents>(event: K, listener: (...args: MemoryStoreEvents[K]) => void): this;
    emit<K extends keyof MemoryStoreEvents>(event: K, ...args: MemoryStoreEvents[K]): boolean;
}
//# sourceMappingURL=epoch-manager.d.ts.map
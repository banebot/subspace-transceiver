/**
 * OrbitDB v2 implementation of IMemoryStore.
 *
 * Uses:
 * - Helia (libp2p-backed IPFS) as the block layer
 * - OrbitDB v2 DocumentStore as the CRDT layer
 * - LevelDB (blockstore-level + datastore-level) for persistent local storage
 *
 * Tombstone semantics: forget() stores a tombstone document with _tombstone: true.
 * Tombstones propagate to all peers via OrbitDB CRDT replication, ensuring
 * deletions are consistent across the network without physical removal.
 *
 * Replication events: when OrbitDB merges remote peer data, this store
 * emits the 'replicated' event so callers can react to new data.
 */
import { EventEmitter } from 'node:events';
import { createOrbitDB } from '@orbitdb/core';
import { applyQuery } from './query.js';
import { encryptEnvelope, decryptEnvelope } from './crypto.js';
import { SubspaceAccessController } from './access-controller.js';
import { StoreError, ErrorCode } from './errors.js';
/**
 * Encrypt the content fields of a chunk before storing in OrbitDB.
 * Returns a modified OrbitDoc with `content` and `contentEnvelope.body`
 * replaced by their encrypted equivalents.
 */
function encryptDoc(chunk, key) {
    // Encrypt content
    const contentEnc = encryptEnvelope(Buffer.from(chunk.content, 'utf8'), key);
    const doc = {
        ...chunk,
        _id: chunk.id,
        _encrypted: true,
        content: '', // placeholder — not queryable
        encryptedContent: contentEnc.ciphertext.toString('base64'),
        contentIv: contentEnc.iv.toString('base64'),
        contentTag: contentEnc.tag.toString('base64'),
    };
    // Encrypt contentEnvelope.body if present
    if (chunk.contentEnvelope?.body) {
        const bodyEnc = encryptEnvelope(Buffer.from(chunk.contentEnvelope.body, 'utf8'), key);
        doc.contentEnvelope = {
            ...chunk.contentEnvelope,
            body: '', // placeholder
        };
        doc.encryptedEnvelopeBody = bodyEnc.ciphertext.toString('base64');
        doc.envelopeBodyIv = bodyEnc.iv.toString('base64');
        doc.envelopeBodyTag = bodyEnc.tag.toString('base64');
    }
    return doc;
}
/**
 * Decrypt an OrbitDoc back to a MemoryChunk.
 * If the doc is not encrypted (_encrypted !== true), returns it as-is.
 */
function decryptDoc(doc, key) {
    if (!doc._encrypted) {
        // Legacy plaintext document — return without modification
        return doc;
    }
    let content = '';
    if (doc.encryptedContent && doc.contentIv && doc.contentTag) {
        try {
            content = decryptEnvelope(Buffer.from(doc.encryptedContent, 'base64'), Buffer.from(doc.contentIv, 'base64'), Buffer.from(doc.contentTag, 'base64'), key).toString('utf8');
        }
        catch {
            // Decryption failed — wrong key or corrupted doc; return empty content
            // rather than crashing. The chunk will be filtered by query/search.
            content = '';
        }
    }
    const chunk = {
        ...doc,
        content,
    };
    // Decrypt contentEnvelope.body if present
    if (doc.contentEnvelope && doc.encryptedEnvelopeBody && doc.envelopeBodyIv && doc.envelopeBodyTag) {
        try {
            const body = decryptEnvelope(Buffer.from(doc.encryptedEnvelopeBody, 'base64'), Buffer.from(doc.envelopeBodyIv, 'base64'), Buffer.from(doc.envelopeBodyTag, 'base64'), key).toString('utf8');
            chunk.contentEnvelope = { ...doc.contentEnvelope, body };
        }
        catch {
            // Keep envelope with empty body on decryption failure
            chunk.contentEnvelope = { ...doc.contentEnvelope, body: '' };
        }
    }
    // Strip internal encryption bookkeeping fields from the returned chunk
    const chunkAny = chunk;
    delete chunkAny._encrypted;
    delete chunkAny.encryptedContent;
    delete chunkAny.contentIv;
    delete chunkAny.contentTag;
    delete chunkAny.encryptedEnvelopeBody;
    delete chunkAny.envelopeBodyIv;
    delete chunkAny.envelopeBodyTag;
    return chunk;
}
export class OrbitDBMemoryStore extends EventEmitter {
    db;
    /** AES-256-GCM key for encrypting content fields. Null = no encryption (tests/legacy). */
    envelopeKey;
    constructor(db, envelopeKey) {
        super();
        this.db = db;
        this.envelopeKey = envelopeKey;
        // Forward OrbitDB replication events as 'replicated'
        // @ts-ignore — OrbitDB v2 event types may not be fully typed
        this.db.events.on('update', () => {
            this.emit('replicated');
        });
    }
    /**
     * Create a store backed by an already-initialised OrbitDB instance.
     * Helia and the libp2p node are owned by the caller (NetworkSession);
     * this store only manages the OrbitDB database handle.
     *
     * @param envelopeKey When provided, content fields are encrypted at rest using
     *                    AES-256-GCM. Pass null to disable encryption (test/legacy mode).
     */
    static async create(orbitdb, networkKeys, namespace, envelopeKey = networkKeys.envelopeKey) {
        // Register the SubspaceAccessController globally so OrbitDB can look it up
        // when reopening existing databases that have 'subspace' in their manifest.
        // @ts-ignore — useAccessController is not in the @orbitdb/core type declarations
        // but IS exported from src/index.js at runtime.
        const orbitdbModule = await import('@orbitdb/core');
        const useAC = orbitdbModule.useAccessController;
        if (useAC) {
            try {
                useAC(SubspaceAccessController);
            }
            catch {
                // 'already added' — safe to ignore on subsequent calls
            }
        }
        // DB name includes topic (derived from PSK) + namespace for network isolation
        const dbName = `subspace/${networkKeys.topic}/${namespace}`;
        const db = await orbitdb.open(dbName, {
            type: 'documents',
            // Validate every incoming replicated entry before accepting it.
            // This prevents malicious peers from injecting garbage into the CRDT oplog.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            AccessController: SubspaceAccessController(),
        });
        return new OrbitDBMemoryStore(db, envelopeKey);
    }
    async put(chunk) {
        try {
            let doc;
            if (this.envelopeKey) {
                doc = JSON.parse(JSON.stringify(encryptDoc(chunk, this.envelopeKey)));
            }
            else {
                // JSON round-trip removes `undefined` fields — IPLD cannot encode undefined.
                doc = JSON.parse(JSON.stringify({ ...chunk, _id: chunk.id }));
            }
            await this.db.put(doc);
        }
        catch (err) {
            throw new StoreError(`Failed to write chunk ${chunk.id}: ${String(err)}`, ErrorCode.STORE_WRITE_FAILED, err);
        }
    }
    async get(id) {
        try {
            const results = await this.db.query((doc) => doc._id === id);
            if (results.length === 0)
                return null;
            const doc = results[0];
            // Exclude tombstones from external get()
            if (doc._tombstone)
                return null;
            if (this.envelopeKey)
                return decryptDoc(doc, this.envelopeKey);
            return doc;
        }
        catch (err) {
            throw new StoreError(`Failed to read chunk ${id}: ${String(err)}`, ErrorCode.STORE_READ_FAILED, err);
        }
    }
    async query(q) {
        try {
            const all = await this.db.query((_doc) => true);
            // Filter out tombstones before applying the user query
            const key = this.envelopeKey;
            const chunks = all
                .filter(d => !d._tombstone)
                .map(d => key ? decryptDoc(d, key) : d);
            return applyQuery(chunks, q);
        }
        catch (err) {
            throw new StoreError(`Query failed: ${String(err)}`, ErrorCode.STORE_READ_FAILED, err);
        }
    }
    async list() {
        try {
            const all = await this.db.query((_doc) => true);
            // Filter out tombstones — callers should never see soft-deleted chunks
            const key = this.envelopeKey;
            return all
                .filter(d => !d._tombstone)
                .map(d => key ? decryptDoc(d, key) : d);
        }
        catch (err) {
            throw new StoreError(`List failed: ${String(err)}`, ErrorCode.STORE_READ_FAILED, err);
        }
    }
    async forget(id) {
        try {
            // Store a tombstone doc — propagates to peers via CRDT replication
            const tombstone = {
                _id: id,
                id,
                _tombstone: true,
                type: 'project',
                namespace: 'project',
                topic: ['_tombstone'],
                content: '',
                source: { agentId: '_system', peerId: '_system', timestamp: Date.now() },
                confidence: 0,
                network: '',
                version: 0,
            };
            await this.db.put(JSON.parse(JSON.stringify(tombstone)));
        }
        catch (err) {
            throw new StoreError(`Failed to tombstone chunk ${id}: ${String(err)}`, ErrorCode.STORE_WRITE_FAILED, err);
        }
    }
    async close() {
        await this.db.close();
        // Note: Helia is owned by NetworkSession and closed there, not here.
    }
    // Required EventEmitter typed overrides
    on(event, listener) {
        return super.on(event, listener);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
}
/**
 * Create a shared Helia + OrbitDB context for a network.
 * Returns both so the caller can stop Helia when leaving the network.
 */
export async function createOrbitDBContext(node, dataDir, 
/** Deterministic network identifier — passed as OrbitDB identity `id` so the
 *  same network always gets the same signing identity across restarts. */
networkId) {
    const { createHelia } = await import('helia');
    const { LevelBlockstore } = await import('blockstore-level');
    const { LevelDatastore } = await import('datastore-level');
    const path = await import('node:path');
    const { unlink } = await import('node:fs/promises');
    // Remove any stale LOCK files left by a previous process.
    // When a process exits (even via SIGKILL) the OS releases fcntl advisory
    // locks, but Level's LOCK file itself remains on disk.  Some Level versions
    // fail to re-acquire the file lock if the file is "dirty" (non-empty).
    // Deleting the stale LOCK file before open() allows a fresh lock to be
    // created.  This is safe because we already waited for the old process to
    // exit before calling joinNetwork again.
    // Also wipe OrbitDB's internal keystore/log LOCK files.
    const pfs = await import('node:fs/promises');
    const pfsPath = path;
    async function removeLockFiles(dir) {
        let entries;
        try {
            entries = await pfs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.all(entries.map(async (entry) => {
            const fp = pfsPath.join(dir, entry.name);
            if (entry.isDirectory())
                return removeLockFiles(fp);
            if (entry.name === 'LOCK')
                await pfs.unlink(fp).catch(() => { });
        }));
    }
    await removeLockFiles(dataDir);
    const blockstore = new LevelBlockstore(path.join(dataDir, 'blocks'));
    const datastore = new LevelDatastore(path.join(dataDir, 'datastore'));
    // LevelDatastore must be explicitly opened before passing to Helia.
    // Without this, Helia's assertDatastoreVersionIsCurrent() races with
    // Level's deferred-open queue, causing "Database is not open" on restart.
    await datastore.open();
    const helia = await createHelia({ libp2p: node, blockstore, datastore });
    // ── Blockstore compatibility shim ──
    // Helia v6 / blockstore-level v3 changed `Blockstore.get()` to return
    // `AsyncIterable<Uint8Array>` (async generator).  OrbitDB v3's
    // IPFSBlockStorage does `await ipfs.blockstore.get(cid)`, which awaits
    // the generator object itself (always truthy, never actual bytes).
    //
    // On first run this is masked because OrbitDB's ComposedStorage serves
    // entries from its in-memory LRU cache.  After a restart the LRU is
    // empty and the code falls through to IPFSBlockStorage → broken reads.
    //
    // Fix: wrap helia.blockstore.get() with a dual-mode shim that handles both:
    //  - AsyncIterable<Uint8Array> (Helia v6 / blockstore-level v3)
    //  - Uint8Array directly         (Helia v5 and earlier, or future regressions)
    //
    // The shim detects the return type at runtime so it degrades gracefully if
    // Helia changes its API in a patch release.
    const originalGet = helia.blockstore.get.bind(helia.blockstore);
    helia.blockstore.get =
        async function (cid, options) {
            // Await without consuming — if result is a Uint8Array we're done;
            // if it is an AsyncGenerator, awaiting it just returns the generator.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const raw = await originalGet(cid, options);
            // Fast path: already a plain Uint8Array (Helia v5 or future revert)
            if (raw instanceof Uint8Array)
                return raw;
            // Null / undefined → block not found
            if (raw == null)
                return undefined;
            // AsyncIterable path (Helia v6+): consume and concatenate
            if (typeof raw[Symbol.asyncIterator] === 'function' || typeof raw[Symbol.iterator] === 'function') {
                const chunks = [];
                for await (const chunk of raw) {
                    chunks.push(chunk);
                }
                if (chunks.length === 0)
                    return undefined;
                if (chunks.length === 1)
                    return chunks[0];
                // Multiple chunks: concatenate (rare for OrbitDB entries, but correct)
                const total = chunks.reduce((n, c) => n + c.length, 0);
                const result = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                    result.set(c, off);
                    off += c.length;
                }
                return result;
            }
            // Unexpected return type — surface it so it's not silently swallowed
            throw new TypeError(`helia.blockstore.get() returned an unexpected type: ${Object.prototype.toString.call(raw)}. ` +
                'The Helia blockstore shim in orbitdb-store.ts may need updating.');
        };
    const orbitdb = await createOrbitDB({
        ipfs: helia,
        // A stable `id` ensures the same identity (and thus database address) is used
        // on every restart for the same network. Without this, OrbitDB calls createId()
        // which generates a random UUID → different signing key → different DB address.
        id: networkId,
        directory: path.join(dataDir, 'orbitdb'),
    });
    return {
        helia,
        orbitdb,
        closeLevelStores: async () => {
            await blockstore.close().catch(() => { });
            await datastore.close().catch(() => { });
        },
    };
}
/**
 * Factory function — creates and returns an IMemoryStore backed by OrbitDB v2.
 * Requires a pre-initialised OrbitDB instance (use createOrbitDBContext).
 *
 * Content fields (`content` and `contentEnvelope.body`) are encrypted at rest
 * using AES-256-GCM with `networkKeys.envelopeKey`. Pass `envelopeKey: null`
 * to disable encryption (test/legacy mode).
 */
export async function createOrbitDBStore(orbitdb, networkKeys, namespace, envelopeKey = networkKeys.envelopeKey) {
    return OrbitDBMemoryStore.create(orbitdb, networkKeys, namespace, envelopeKey);
}
//# sourceMappingURL=orbitdb-store.js.map
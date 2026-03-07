/**
 * Mail store — persists MailEnvelopes (relay side) and InboxMessages (recipient side).
 *
 * Design philosophy:
 *   - Relay store: holds encrypted envelopes for offline peers. Envelopes are
 *     stored by recipientPeerId so the relay can efficiently answer "check" queries.
 *   - Inbox store: holds decrypted messages for the local agent. Persisted to disk
 *     so they survive daemon restarts.
 *
 * Both stores use simple JSON file persistence for now — LevelDB can be
 * introduced for larger deployments without changing the IMailStore interface.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isEnvelopeExpired } from './mail.js';
/**
 * In-memory relay store. Suitable for development/testing and small deployments.
 * Data is lost on daemon restart (use FileRelayStore for persistence).
 */
export class MemoryRelayStore {
    envelopes = new Map(); // id → envelope
    byRecipient = new Map(); // peerId → Set<id>
    maxEnvelopesPerRecipient;
    maxTotalEnvelopes;
    constructor(opts = {}) {
        this.maxEnvelopesPerRecipient = opts.maxPerRecipient ?? 1000;
        this.maxTotalEnvelopes = opts.maxTotal ?? 100_000;
    }
    async deposit(envelope) {
        if (isEnvelopeExpired(envelope))
            return false;
        if (this.envelopes.size >= this.maxTotalEnvelopes)
            return false;
        const recipientSet = this.byRecipient.get(envelope.to) ?? new Set();
        if (recipientSet.size >= this.maxEnvelopesPerRecipient)
            return false;
        this.envelopes.set(envelope.id, envelope);
        recipientSet.add(envelope.id);
        this.byRecipient.set(envelope.to, recipientSet);
        return true;
    }
    async check(recipientPeerId, since, limit = 50) {
        const ids = this.byRecipient.get(recipientPeerId) ?? new Set();
        const result = [];
        for (const id of ids) {
            const env = this.envelopes.get(id);
            if (!env || isEnvelopeExpired(env))
                continue;
            if (since !== undefined && env.timestamp <= since)
                continue;
            result.push(env);
            if (result.length >= limit)
                break;
        }
        return result.sort((a, b) => a.timestamp - b.timestamp);
    }
    async ack(envelopeIds) {
        let count = 0;
        for (const id of envelopeIds) {
            const env = this.envelopes.get(id);
            if (!env)
                continue;
            this.envelopes.delete(id);
            this.byRecipient.get(env.to)?.delete(id);
            count++;
        }
        return count;
    }
    async evict() {
        let count = 0;
        for (const [id, env] of this.envelopes) {
            if (isEnvelopeExpired(env)) {
                this.envelopes.delete(id);
                this.byRecipient.get(env.to)?.delete(id);
                count++;
            }
        }
        return count;
    }
    async count(recipientPeerId) {
        return this.byRecipient.get(recipientPeerId)?.size ?? 0;
    }
}
/** Simple in-memory inbox. Use FileInboxStore for persistence. */
export class MemoryInboxStore {
    messages = new Map();
    async save(message) {
        this.messages.set(message.id, message);
    }
    async list() {
        return [...this.messages.values()].sort((a, b) => b.receivedAt - a.receivedAt);
    }
    async get(id) {
        return this.messages.get(id) ?? null;
    }
    async delete(id) {
        return this.messages.delete(id);
    }
    async count() {
        return this.messages.size;
    }
}
/** Simple in-memory outbox. Use FileOutboxStore for persistence. */
export class MemoryOutboxStore {
    messages = new Map();
    async save(message) {
        this.messages.set(message.id, message);
    }
    async list() {
        return [...this.messages.values()].sort((a, b) => b.sentAt - a.sentAt);
    }
    async get(id) {
        return this.messages.get(id) ?? null;
    }
    async updateStatus(id, status) {
        const msg = this.messages.get(id);
        if (!msg)
            return false;
        this.messages.set(id, { ...msg, status });
        return true;
    }
}
// ---------------------------------------------------------------------------
// File-backed stores — durable across daemon restarts
// ---------------------------------------------------------------------------
/**
 * File-backed relay store. Persists envelopes as a JSON file.
 * Suitable for single-node deployments; for distributed relay, use LevelDB.
 */
export class FileRelayStore extends MemoryRelayStore {
    path;
    dirty = false;
    saveTimer = null;
    constructor(storePath, opts = {}) {
        super(opts);
        this.path = storePath;
    }
    async load() {
        try {
            const raw = await readFile(this.path, 'utf8');
            const envelopes = JSON.parse(raw);
            for (const env of envelopes) {
                await super.deposit(env);
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('[mail-store] Could not load relay store:', err);
            }
        }
    }
    scheduleSave() {
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush().catch(e => console.warn('[mail-store] Relay flush error:', e));
        }, 2000);
    }
    async flush() {
        if (!this.dirty)
            return;
        try {
            await mkdir(join(this.path, '..'), { recursive: true });
            const all = await this.check('', 0, Number.MAX_SAFE_INTEGER); // list all
            await writeFile(this.path, JSON.stringify(all), 'utf8');
            this.dirty = false;
        }
        catch (err) {
            console.warn('[mail-store] Relay save error:', err);
        }
    }
    async deposit(envelope) {
        const ok = await super.deposit(envelope);
        if (ok) {
            this.dirty = true;
            this.scheduleSave();
        }
        return ok;
    }
    async ack(envelopeIds) {
        const count = await super.ack(envelopeIds);
        if (count > 0) {
            this.dirty = true;
            this.scheduleSave();
        }
        return count;
    }
    async evict() {
        const count = await super.evict();
        if (count > 0) {
            this.dirty = true;
            this.scheduleSave();
        }
        return count;
    }
}
/**
 * File-backed inbox store. Persists as a JSON file in the data directory.
 */
export class FileInboxStore {
    path;
    messages = new Map();
    loaded = false;
    constructor(storePath) {
        this.path = storePath;
    }
    async load() {
        if (this.loaded)
            return;
        try {
            const raw = await readFile(this.path, 'utf8');
            const messages = JSON.parse(raw);
            for (const msg of messages) {
                this.messages.set(msg.id, msg);
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('[mail-store] Could not load inbox:', err);
            }
        }
        this.loaded = true;
    }
    async persist() {
        await mkdir(join(this.path, '..'), { recursive: true });
        const all = [...this.messages.values()];
        await writeFile(this.path, JSON.stringify(all), 'utf8');
    }
    async save(message) {
        await this.load();
        this.messages.set(message.id, message);
        await this.persist();
    }
    async list() {
        await this.load();
        return [...this.messages.values()].sort((a, b) => b.receivedAt - a.receivedAt);
    }
    async get(id) {
        await this.load();
        return this.messages.get(id) ?? null;
    }
    async delete(id) {
        await this.load();
        const existed = this.messages.delete(id);
        if (existed)
            await this.persist();
        return existed;
    }
    async count() {
        await this.load();
        return this.messages.size;
    }
}
/**
 * File-backed outbox store.
 */
export class FileOutboxStore {
    path;
    messages = new Map();
    loaded = false;
    constructor(storePath) {
        this.path = storePath;
    }
    async load() {
        if (this.loaded)
            return;
        try {
            const raw = await readFile(this.path, 'utf8');
            const messages = JSON.parse(raw);
            for (const msg of messages) {
                this.messages.set(msg.id, msg);
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('[mail-store] Could not load outbox:', err);
            }
        }
        this.loaded = true;
    }
    async persist() {
        await mkdir(join(this.path, '..'), { recursive: true });
        const all = [...this.messages.values()];
        await writeFile(this.path, JSON.stringify(all), 'utf8');
    }
    async save(message) {
        await this.load();
        this.messages.set(message.id, message);
        await this.persist();
    }
    async list() {
        await this.load();
        return [...this.messages.values()].sort((a, b) => b.sentAt - a.sentAt);
    }
    async get(id) {
        await this.load();
        return this.messages.get(id) ?? null;
    }
    async updateStatus(id, status) {
        await this.load();
        const msg = this.messages.get(id);
        if (!msg)
            return false;
        this.messages.set(id, { ...msg, status });
        await this.persist();
        return true;
    }
}
// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------
/**
 * Create file-backed mail stores from a data directory.
 * Stores are created in <dataDir>/mail/.
 */
export async function createFileMailStores(dataDir) {
    const mailDir = join(dataDir, 'mail');
    await mkdir(mailDir, { recursive: true });
    const relay = new FileRelayStore(join(mailDir, 'relay.json'));
    const inbox = new FileInboxStore(join(mailDir, 'inbox.json'));
    const outbox = new FileOutboxStore(join(mailDir, 'outbox.json'));
    await relay.load();
    await inbox.load();
    await outbox.load();
    return { relay, inbox, outbox };
}
/** Check if a file-based store path exists (for conditional loading). */
export function mailStoreExists(dataDir) {
    return existsSync(join(dataDir, 'mail'));
}
//# sourceMappingURL=mail-store.js.map
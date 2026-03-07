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
import type { MailEnvelope, InboxMessage, OutboxMessage } from './mail.js';
export interface IRelayStore {
    /** Store an envelope for a recipient. Returns false if quota exceeded. */
    deposit(envelope: MailEnvelope): Promise<boolean>;
    /** Retrieve pending envelopes for a recipient. */
    check(recipientPeerId: string, since?: number, limit?: number): Promise<MailEnvelope[]>;
    /** Acknowledge receipt — relay deletes the envelopes. */
    ack(envelopeIds: string[]): Promise<number>;
    /** Evict expired envelopes. Returns count evicted. */
    evict(): Promise<number>;
    /** Total envelope count for a recipient. */
    count(recipientPeerId: string): Promise<number>;
}
/**
 * In-memory relay store. Suitable for development/testing and small deployments.
 * Data is lost on daemon restart (use FileRelayStore for persistence).
 */
export declare class MemoryRelayStore implements IRelayStore {
    private envelopes;
    private byRecipient;
    private maxEnvelopesPerRecipient;
    private maxTotalEnvelopes;
    constructor(opts?: {
        maxPerRecipient?: number;
        maxTotal?: number;
    });
    deposit(envelope: MailEnvelope): Promise<boolean>;
    check(recipientPeerId: string, since?: number, limit?: number): Promise<MailEnvelope[]>;
    ack(envelopeIds: string[]): Promise<number>;
    evict(): Promise<number>;
    count(recipientPeerId: string): Promise<number>;
}
export interface IInboxStore {
    /** Save a decrypted message to the inbox. */
    save(message: InboxMessage): Promise<void>;
    /** List all inbox messages, newest first. */
    list(): Promise<InboxMessage[]>;
    /** Get a specific message by ID. */
    get(id: string): Promise<InboxMessage | null>;
    /** Delete a message from the inbox. */
    delete(id: string): Promise<boolean>;
    /** Total message count. */
    count(): Promise<number>;
}
export interface IOutboxStore {
    /** Record a sent message. */
    save(message: OutboxMessage): Promise<void>;
    /** List all outbox messages, newest first. */
    list(): Promise<OutboxMessage[]>;
    /** Get a specific message by ID. */
    get(id: string): Promise<OutboxMessage | null>;
    /** Update the status of a sent message. */
    updateStatus(id: string, status: OutboxMessage['status']): Promise<boolean>;
}
/** Simple in-memory inbox. Use FileInboxStore for persistence. */
export declare class MemoryInboxStore implements IInboxStore {
    private messages;
    save(message: InboxMessage): Promise<void>;
    list(): Promise<InboxMessage[]>;
    get(id: string): Promise<InboxMessage | null>;
    delete(id: string): Promise<boolean>;
    count(): Promise<number>;
}
/** Simple in-memory outbox. Use FileOutboxStore for persistence. */
export declare class MemoryOutboxStore implements IOutboxStore {
    private messages;
    save(message: OutboxMessage): Promise<void>;
    list(): Promise<OutboxMessage[]>;
    get(id: string): Promise<OutboxMessage | null>;
    updateStatus(id: string, status: OutboxMessage['status']): Promise<boolean>;
}
/**
 * File-backed relay store. Persists envelopes as a JSON file.
 * Suitable for single-node deployments; for distributed relay, use LevelDB.
 */
export declare class FileRelayStore extends MemoryRelayStore {
    private readonly path;
    private dirty;
    private saveTimer;
    constructor(storePath: string, opts?: {
        maxPerRecipient?: number;
        maxTotal?: number;
    });
    load(): Promise<void>;
    private scheduleSave;
    flush(): Promise<void>;
    deposit(envelope: MailEnvelope): Promise<boolean>;
    ack(envelopeIds: string[]): Promise<number>;
    evict(): Promise<number>;
}
/**
 * File-backed inbox store. Persists as a JSON file in the data directory.
 */
export declare class FileInboxStore implements IInboxStore {
    private readonly path;
    private messages;
    private loaded;
    constructor(storePath: string);
    load(): Promise<void>;
    private persist;
    save(message: InboxMessage): Promise<void>;
    list(): Promise<InboxMessage[]>;
    get(id: string): Promise<InboxMessage | null>;
    delete(id: string): Promise<boolean>;
    count(): Promise<number>;
}
/**
 * File-backed outbox store.
 */
export declare class FileOutboxStore implements IOutboxStore {
    private readonly path;
    private messages;
    private loaded;
    constructor(storePath: string);
    load(): Promise<void>;
    private persist;
    save(message: OutboxMessage): Promise<void>;
    list(): Promise<OutboxMessage[]>;
    get(id: string): Promise<OutboxMessage | null>;
    updateStatus(id: string, status: OutboxMessage['status']): Promise<boolean>;
}
/**
 * Create file-backed mail stores from a data directory.
 * Stores are created in <dataDir>/mail/.
 */
export declare function createFileMailStores(dataDir: string): Promise<{
    relay: FileRelayStore;
    inbox: FileInboxStore;
    outbox: FileOutboxStore;
}>;
/** Check if a file-based store path exists (for conditional loading). */
export declare function mailStoreExists(dataDir: string): boolean;
//# sourceMappingURL=mail-store.d.ts.map
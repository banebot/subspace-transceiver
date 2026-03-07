/**
 * /subspace/mailbox/1.0.0 — libp2p protocol handler for store-and-forward mail.
 *
 * This module handles both sides of the mailbox protocol:
 *   - Server side: handle incoming deposit/check/ack requests from other peers
 *   - Client side: send mail to a peer (direct or via relay)
 *
 * Wire format: length-prefixed JSON over a libp2p stream (same as query protocol).
 */
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import type { PrivateKey } from '@libp2p/interface';
import { type MailPayload } from './mail.js';
import type { IRelayStore, IInboxStore, IOutboxStore } from './mail-store.js';
export interface MailboxHandlerOptions {
    relayStore: IRelayStore;
    inboxStore: IInboxStore;
    recipientPeerId: string;
    recipientKey: PrivateKey;
    /** Maximum envelopes to return per check (pagination). Default: 50 */
    maxCheckResults?: number;
    /** Whether to auto-decrypt and store mail addressed to this node. Default: true */
    autoDecrypt?: boolean;
}
/**
 * Register the /subspace/mailbox/1.0.0 protocol handler on a libp2p node.
 * Call this once at daemon startup.
 */
export declare function registerMailboxProtocol(node: Libp2p, opts: MailboxHandlerOptions): Promise<void>;
export interface SendMailOptions {
    /** Sender's libp2p private key */
    senderKey: PrivateKey;
    /** Sender's PeerId string */
    senderPeerId: string;
    /** Recipient's PeerId string */
    recipientPeerId: string;
    /** Message payload */
    payload: MailPayload;
    /** TTL in seconds. Default: 604800 (7 days) */
    ttl?: number;
    /** Optional content type hint */
    contentType?: string;
    /** Relay peers to try if recipient is offline */
    relayPeers?: PeerId[];
    /** Outbox store for recording sent messages */
    outboxStore?: IOutboxStore;
}
/**
 * Send a mail message to a specific agent.
 * Tries direct delivery first; if the recipient is offline, deposits with relay peers.
 *
 * @returns 'direct' if delivered directly, 'relay' if deposited with relay(s), throws on failure
 */
export declare function sendMail(node: Libp2p, recipientPeerId: PeerId, opts: SendMailOptions): Promise<'direct' | 'relay'>;
/**
 * Poll relay peers for pending mail addressed to this agent.
 * Decrypts received envelopes and saves to inbox.
 *
 * @returns Count of new messages received
 */
export declare function pollMail(node: Libp2p, relayPeers: PeerId[], opts: {
    recipientPeerId: string;
    recipientKey: PrivateKey;
    inboxStore: IInboxStore;
    since?: number;
}): Promise<number>;
//# sourceMappingURL=mail-protocol.d.ts.map
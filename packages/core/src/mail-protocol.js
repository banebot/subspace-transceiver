/**
 * /subspace/mailbox/1.0.0 — libp2p protocol handler for store-and-forward mail.
 *
 * This module handles both sides of the mailbox protocol:
 *   - Server side: handle incoming deposit/check/ack requests from other peers
 *   - Client side: send mail to a peer (direct or via relay)
 *
 * Wire format: length-prefixed JSON over a libp2p stream (same as query protocol).
 */
import * as lp from 'it-length-prefixed';
import { v4 as uuidv4 } from 'uuid';
import { MAILBOX_PROTOCOL, encryptMailPayload, decryptMailEnvelope, signEnvelope, verifyEnvelopeSignature, createEnvelope, isEnvelopeExpired, } from './mail.js';
// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function encodeMsg(msg) {
    return encoder.encode(JSON.stringify(msg));
}
function decodeMsg(bytes) {
    return JSON.parse(decoder.decode(bytes));
}
async function writeMsg(stream, msg) {
    async function* src() { yield encodeMsg(msg); }
    for await (const chunk of lp.encode(src())) {
        stream.send(chunk);
    }
}
async function readMsg(stream) {
    for await (const chunk of lp.decode(stream)) {
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        return decodeMsg(bytes);
    }
    return null;
}
/**
 * Register the /subspace/mailbox/1.0.0 protocol handler on a libp2p node.
 * Call this once at daemon startup.
 */
export async function registerMailboxProtocol(node, opts) {
    const { relayStore, inboxStore, recipientPeerId, recipientKey } = opts;
    const maxCheckResults = opts.maxCheckResults ?? 50;
    const autoDecrypt = opts.autoDecrypt ?? true;
    await node.handle(MAILBOX_PROTOCOL, async (stream, _connection) => {
        const s = stream;
        try {
            const msg = await readMsg(s);
            if (!msg)
                return;
            switch (msg.type) {
                case 'deposit': {
                    const envelope = msg.envelope;
                    // Verify the envelope hasn't expired
                    if (isEnvelopeExpired(envelope)) {
                        await writeMsg(s, { type: 'deposit-response', ok: false, error: 'expired' });
                        break;
                    }
                    // Verify signature
                    const sigValid = await verifyEnvelopeSignature(envelope);
                    if (!sigValid) {
                        await writeMsg(s, { type: 'deposit-response', ok: false, error: 'invalid-signature' });
                        break;
                    }
                    // If this envelope is addressed to us, decrypt and store in inbox
                    if (autoDecrypt && envelope.to === recipientPeerId) {
                        try {
                            const payload = await decryptMailEnvelope(envelope, recipientKey, envelope.from);
                            const inboxMsg = {
                                id: uuidv4(),
                                from: envelope.from,
                                subject: payload.subject,
                                body: payload.body,
                                mimeType: payload.mimeType ?? 'text/plain',
                                meta: payload.meta,
                                contentType: envelope.contentType,
                                timestamp: envelope.timestamp,
                                receivedAt: Date.now(),
                                envelopeId: envelope.id,
                            };
                            await inboxStore.save(inboxMsg);
                            // Ack immediately since we're the recipient
                            await writeMsg(s, { type: 'deposit-response', ok: true });
                            break;
                        }
                        catch {
                            // Decryption failed — store in relay for later retry
                        }
                    }
                    // Store in relay for offline recipient
                    const ok = await relayStore.deposit(envelope);
                    await writeMsg(s, { type: 'deposit-response', ok, error: ok ? undefined : 'quota-exceeded' });
                    break;
                }
                case 'check': {
                    const { recipientPeerId: targetPeerId, since, limit } = msg;
                    const envelopes = await relayStore.check(targetPeerId, since, limit ?? maxCheckResults);
                    const total = await relayStore.count(targetPeerId);
                    await writeMsg(s, {
                        type: 'check-response',
                        envelopes,
                        hasMore: envelopes.length < total,
                    });
                    break;
                }
                case 'ack': {
                    const purged = await relayStore.ack(msg.envelopeIds);
                    await writeMsg(s, { type: 'ack-response', purged });
                    break;
                }
                default:
                    // Unknown message type — ignore
                    break;
            }
        }
        catch (err) {
            console.warn('[mail] Protocol handler error:', err);
        }
        finally {
            await s.close().catch(() => { });
        }
    });
}
/**
 * Send a mail message to a specific agent.
 * Tries direct delivery first; if the recipient is offline, deposits with relay peers.
 *
 * @returns 'direct' if delivered directly, 'relay' if deposited with relay(s), throws on failure
 */
export async function sendMail(node, recipientPeerId, opts) {
    const envelopeId = uuidv4();
    // Encrypt the payload
    const encrypted = await encryptMailPayload(opts.payload, opts.senderKey, opts.recipientPeerId, envelopeId);
    // Create and sign the envelope
    const unsignedEnvelope = createEnvelope({
        from: opts.senderPeerId,
        to: opts.recipientPeerId,
        envelopeId,
        encrypted,
        ttl: opts.ttl,
        contentType: opts.contentType,
    });
    const envelope = await signEnvelope(unsignedEnvelope, opts.senderKey);
    // Record in outbox before attempting delivery
    const outboxMsg = {
        id: uuidv4(),
        to: opts.recipientPeerId,
        subject: opts.payload.subject,
        body: opts.payload.body,
        contentType: opts.contentType,
        sentAt: Date.now(),
        envelopeId: envelope.id,
        status: 'pending',
    };
    await opts.outboxStore?.save(outboxMsg);
    // Try direct delivery to recipient
    const depositMsg = { type: 'deposit', envelope };
    // Try direct dial to recipient
    try {
        const stream = await node.dialProtocol(recipientPeerId, MAILBOX_PROTOCOL, {
            signal: AbortSignal.timeout(10_000),
        });
        await writeMsg(stream, depositMsg);
        const response = await readMsg(stream);
        await stream.close().catch(() => { });
        if (response?.type === 'deposit-response' && response.ok) {
            await opts.outboxStore?.updateStatus(outboxMsg.id, 'sent');
            return 'direct';
        }
    }
    catch {
        // Recipient offline or unreachable — fall through to relay
    }
    // Try relay peers
    if (opts.relayPeers && opts.relayPeers.length > 0) {
        let relayedCount = 0;
        for (const relayPeer of opts.relayPeers) {
            try {
                const stream = await node.dialProtocol(relayPeer, MAILBOX_PROTOCOL, {
                    signal: AbortSignal.timeout(5_000),
                });
                await writeMsg(stream, depositMsg);
                const response = await readMsg(stream);
                await stream.close().catch(() => { });
                if (response?.type === 'deposit-response' && response.ok) {
                    relayedCount++;
                }
            }
            catch {
                // This relay is offline — try next
            }
        }
        if (relayedCount > 0) {
            await opts.outboxStore?.updateStatus(outboxMsg.id, 'sent');
            return 'relay';
        }
    }
    throw new Error(`Could not deliver mail to ${opts.recipientPeerId}: recipient offline and no relays available`);
}
/**
 * Poll relay peers for pending mail addressed to this agent.
 * Decrypts received envelopes and saves to inbox.
 *
 * @returns Count of new messages received
 */
export async function pollMail(node, relayPeers, opts) {
    let totalNew = 0;
    for (const relayPeer of relayPeers) {
        try {
            const stream = await node.dialProtocol(relayPeer, MAILBOX_PROTOCOL, {
                signal: AbortSignal.timeout(10_000),
            });
            // Check for pending mail
            const checkMsg = {
                type: 'check',
                recipientPeerId: opts.recipientPeerId,
                since: opts.since,
            };
            await writeMsg(stream, checkMsg);
            const response = await readMsg(stream);
            if (response?.type !== 'check-response') {
                await stream.close().catch(() => { });
                continue;
            }
            const ackIds = [];
            for (const envelope of response.envelopes) {
                if (envelope.to !== opts.recipientPeerId)
                    continue;
                if (isEnvelopeExpired(envelope)) {
                    ackIds.push(envelope.id);
                    continue;
                }
                try {
                    // Verify signature
                    const sigValid = await verifyEnvelopeSignature(envelope);
                    if (!sigValid) {
                        console.warn(`[mail] Skipping envelope ${envelope.id}: invalid signature`);
                        ackIds.push(envelope.id); // Ack anyway to clear corrupted mail
                        continue;
                    }
                    // Decrypt
                    const payload = await decryptMailEnvelope(envelope, opts.recipientKey, envelope.from);
                    // Check for duplicates (by envelopeId)
                    const existing = await opts.inboxStore.get(envelope.id);
                    if (existing) {
                        ackIds.push(envelope.id);
                        continue;
                    }
                    // Save to inbox
                    const inboxMsg = {
                        id: envelope.id, // Use envelope ID as inbox message ID for dedup
                        from: envelope.from,
                        subject: payload.subject,
                        body: payload.body,
                        mimeType: payload.mimeType ?? 'text/plain',
                        meta: payload.meta,
                        contentType: envelope.contentType,
                        timestamp: envelope.timestamp,
                        receivedAt: Date.now(),
                        envelopeId: envelope.id,
                    };
                    await opts.inboxStore.save(inboxMsg);
                    ackIds.push(envelope.id);
                    totalNew++;
                }
                catch (err) {
                    console.warn(`[mail] Failed to process envelope ${envelope.id}:`, err);
                }
            }
            // Ack all processed envelopes
            if (ackIds.length > 0) {
                await stream.close().catch(() => { });
                // Open a new stream for ack
                const ackStream = await node.dialProtocol(relayPeer, MAILBOX_PROTOCOL, {
                    signal: AbortSignal.timeout(5_000),
                });
                await writeMsg(ackStream, { type: 'ack', envelopeIds: ackIds });
                await readMsg(ackStream); // consume ack-response
                await ackStream.close().catch(() => { });
            }
            else {
                await stream.close().catch(() => { });
            }
        }
        catch {
            // Relay peer offline — skip
        }
    }
    return totalNew;
}
//# sourceMappingURL=mail-protocol.js.map
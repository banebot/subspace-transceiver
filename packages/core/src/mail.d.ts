/**
 * Subspace Mail — store-and-forward messaging for offline agents.
 *
 * Design:
 *   Each agent has a mailbox (inbox) keyed by PeerId. Other agents can deposit
 *   MailEnvelopes into a relay peer's mailbox service; the recipient fetches and
 *   decrypts them upon connecting.
 *
 * Encryption:
 *   - Sender derives an ephemeral X25519 keypair for each envelope (forward secrecy).
 *   - ECDH shared secret = X25519(ephemeralPrivate, recipientX25519Public).
 *   - Recipient's X25519 public key is converted from their Ed25519 public key
 *     using the standard "clamping" conversion (compatible with libp2p PeerId).
 *   - AES-256-GCM encrypts the payload with a key derived via HKDF.
 *   - The sender signs the envelope with their Ed25519 identity key.
 *
 * Wire Protocol: /subspace/mailbox/1.0.0
 *   Messages are length-prefixed JSON over a libp2p stream.
 */
import type { PrivateKey } from '@libp2p/interface';
export interface MailEnvelope {
    /** UUID v4 — unique envelope identifier */
    id: string;
    /** Sender PeerId string */
    from: string;
    /** Recipient PeerId string */
    to: string;
    /**
     * Encrypted payload — AES-256-GCM encrypted JSON bytes, base64-encoded.
     * The plaintext is a MailPayload JSON string.
     */
    payload: string;
    /**
     * Ephemeral Curve25519 public key (32 bytes, base64) used for ECDH.
     * The recipient uses: sharedSecret = X25519(recipientPrivate, ephemeralPublic)
     */
    ephemeralPubKey: string;
    /** AES-256-GCM nonce (12 bytes, base64) */
    nonce: string;
    /** AES-256-GCM authentication tag (16 bytes, base64) */
    authTag: string;
    /**
     * Ed25519 signature over: id|from|to|payload|ephemeralPubKey|nonce|timestamp
     * Encoded as hex.
     */
    signature: string;
    /** Unix ms timestamp when the envelope was created */
    timestamp: number;
    /** TTL in seconds from creation. Default: 604800 (7 days) */
    ttl: number;
    /** Optional content type hint */
    contentType?: string;
}
/** Decrypted mail payload — the actual message content */
export interface MailPayload {
    /** Human-readable message subject */
    subject?: string;
    /** Message body */
    body: string;
    /** MIME content type of body (default: 'text/plain') */
    mimeType?: string;
    /** Arbitrary metadata */
    meta?: Record<string, unknown>;
}
/** Message stored locally in the recipient's inbox */
export interface InboxMessage {
    id: string;
    from: string;
    subject?: string;
    body: string;
    mimeType?: string;
    meta?: Record<string, unknown>;
    contentType?: string;
    timestamp: number;
    receivedAt: number;
    /** Original envelope ID for correlation */
    envelopeId: string;
}
/** Message in the sender's outbox log */
export interface OutboxMessage {
    id: string;
    to: string;
    subject?: string;
    body: string;
    contentType?: string;
    sentAt: number;
    envelopeId: string;
    /** 'sent' = delivered, 'pending' = awaiting relay pickup */
    status: 'sent' | 'pending';
}
export type MailMessage = {
    type: 'deposit';
    envelope: MailEnvelope;
} | {
    type: 'check';
    recipientPeerId: string;
    since?: number;
    limit?: number;
} | {
    type: 'check-response';
    envelopes: MailEnvelope[];
    hasMore: boolean;
} | {
    type: 'ack';
    envelopeIds: string[];
} | {
    type: 'ack-response';
    purged: number;
} | {
    type: 'deposit-response';
    ok: boolean;
    error?: string;
};
export declare const MAILBOX_PROTOCOL = "/subspace/mailbox/1.0.0";
/**
 * Encrypt a MailPayload for a specific recipient.
 *
 * @param payload    The plaintext payload to encrypt
 * @param senderKey  Sender's Ed25519 private key (for key material extraction)
 * @param recipientPeerId  Recipient's libp2p PeerId (public key extracted)
 * @param envelopeId UUID for this envelope (included in HKDF info)
 * @returns          Encrypted envelope fields (payload, ephemeralPubKey, nonce, authTag)
 */
export declare function encryptMailPayload(payload: MailPayload, senderKey: PrivateKey, recipientPeerId: string, envelopeId: string): Promise<{
    payload: string;
    ephemeralPubKey: string;
    nonce: string;
    authTag: string;
}>;
/**
 * Decrypt a MailEnvelope payload using the recipient's private key.
 */
export declare function decryptMailEnvelope(envelope: MailEnvelope, recipientKey: PrivateKey, senderPeerId: string): Promise<MailPayload>;
/**
 * Sign a MailEnvelope with the sender's Ed25519 private key.
 * Signature covers all envelope fields to prevent tampering.
 */
export declare function signEnvelope(envelope: Omit<MailEnvelope, 'signature'>, senderKey: PrivateKey): Promise<MailEnvelope>;
/**
 * Verify a MailEnvelope's Ed25519 signature.
 * Returns true if valid, false if tampered or unverifiable.
 */
export declare function verifyEnvelopeSignature(envelope: MailEnvelope): Promise<boolean>;
/**
 * Check if a MailEnvelope has expired.
 */
export declare function isEnvelopeExpired(envelope: MailEnvelope): boolean;
/**
 * Create a new MailEnvelope (unsigned — call signEnvelope after).
 */
export declare function createEnvelope(opts: {
    from: string;
    to: string;
    envelopeId: string;
    encrypted: {
        payload: string;
        ephemeralPubKey: string;
        nonce: string;
        authTag: string;
    };
    ttl?: number;
    contentType?: string;
}): Omit<MailEnvelope, 'signature'>;
//# sourceMappingURL=mail.d.ts.map
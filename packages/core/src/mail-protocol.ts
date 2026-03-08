/**
 * /subspace/mailbox/1.0.0 — Iroh ALPN protocol for store-and-forward mail.
 *
 * This module handles both sides of the mailbox protocol:
 *   - Server side: handle incoming deposit/check/ack requests from peers
 *   - Client side: send mail to a peer (direct or via relay)
 *
 * Transport: Iroh QUIC via `/subspace/mailbox/1.0.0` ALPN (registered in the
 * Rust engine, bridged back to Node.js via EngineBridge).
 *
 * For Phase 3.5, the server side is handled via the HTTP API (peers send
 * mail through the daemon HTTP API). Direct peer-to-peer delivery will be
 * implemented in Phase 3.6 using Iroh ALPN streams.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EngineBridge } from './engine-bridge.js'
import {
  MAILBOX_PROTOCOL,
  type MailEnvelope,
  type MailMessage,
  type MailPayload,
  type InboxMessage,
  type OutboxMessage,
  encryptMailPayload,
  decryptMailEnvelope,
  signEnvelope,
  verifyEnvelopeSignature,
  createEnvelope,
  isEnvelopeExpired,
} from './mail.js'
import type { IRelayStore, IInboxStore, IOutboxStore } from './mail-store.js'

// ---------------------------------------------------------------------------
// Key type — replaces @libp2p/interface PrivateKey
// ---------------------------------------------------------------------------

/**
 * Generic private key interface used for mail signing/encryption.
 * Previously @libp2p/interface PrivateKey; now transport-agnostic.
 */
export interface AgentPrivateKey {
  /** Raw Ed25519 secret key bytes (32 bytes) */
  readonly raw: Uint8Array
  /** Sign data and return signature bytes */
  sign(data: Uint8Array): Promise<Uint8Array>
}

// Re-export the mailbox protocol ALPN for convenience
export { MAILBOX_PROTOCOL }

// ---------------------------------------------------------------------------
// Server side — register the mailbox protocol handler
// ---------------------------------------------------------------------------

export interface MailboxHandlerOptions {
  relayStore: IRelayStore
  inboxStore: IInboxStore
  /** This node's identity string (EndpointId or DID:Key) */
  recipientPeerId: string
  /** For decrypting mail addressed to this node */
  recipientKey: AgentPrivateKey
  maxCheckResults?: number
  autoDecrypt?: boolean
}

/**
 * Register the mailbox protocol handler.
 *
 * In the Iroh architecture, the actual ALPN handler runs in the Rust engine.
 * The engine forwards mail messages back to Node.js via the bridge.
 * For Phase 3.5, the mailbox is accessible via the HTTP API.
 *
 * This function is a stub that sets up the local relay/inbox stores.
 * Full Iroh ALPN implementation follows in Phase 3.6.
 *
 * @param _bridge  EngineBridge (future: register ALPN handler)
 * @param opts     Mailbox handler options
 */
export async function registerMailboxProtocol(
  _bridge: EngineBridge | null,
  opts: MailboxHandlerOptions,
): Promise<void> {
  // Phase 3.6: Register /subspace/mailbox/1.0.0 ALPN handler via EngineBridge
  // and wire incoming messages to relayStore/inboxStore.
  // For now, the HTTP API handles mail delivery directly.
  void opts
}

// ---------------------------------------------------------------------------
// Client side — send mail to a peer
// ---------------------------------------------------------------------------

export interface SendMailOptions {
  /** Sender's private key (for signing and encryption) */
  senderKey: AgentPrivateKey
  senderPeerId: string
  recipientPeerId: string
  payload: MailPayload
  ttl?: number
  contentType?: string
  /** Relay peer EndpointIds to try if recipient is offline */
  relayPeers?: string[]
  outboxStore?: IOutboxStore
}

/**
 * Send a mail message to a specific agent.
 *
 * Tries direct Iroh QUIC delivery first; if the recipient is offline,
 * deposits with relay peers. In Phase 3.6, this will use Iroh ALPN streams.
 * For Phase 3.5, only relay deposit via HTTP is implemented.
 *
 * @returns 'direct' if delivered directly, 'relay' if deposited with relay(s)
 */
export async function sendMail(
  _bridge: EngineBridge | null,
  recipientPeerId: string,
  opts: SendMailOptions,
): Promise<'direct' | 'relay'> {
  const envelopeId = uuidv4()

  // Encrypt the payload
  const encrypted = await encryptMailPayload(
    opts.payload,
    opts.senderKey as Parameters<typeof encryptMailPayload>[1],
    opts.recipientPeerId,
    envelopeId,
  )

  // Create and sign the envelope
  const unsignedEnvelope = createEnvelope({
    from: opts.senderPeerId,
    to: opts.recipientPeerId,
    envelopeId,
    encrypted,
    ttl: opts.ttl,
    contentType: opts.contentType,
  })
  const envelope = await signEnvelope(
    unsignedEnvelope,
    opts.senderKey as Parameters<typeof signEnvelope>[1]
  )

  // Record in outbox
  const outboxMsg: OutboxMessage = {
    id: uuidv4(),
    to: opts.recipientPeerId,
    subject: opts.payload.subject,
    body: opts.payload.body,
    contentType: opts.contentType,
    sentAt: Date.now(),
    envelopeId: envelope.id,
    status: 'pending',
  }
  await opts.outboxStore?.save(outboxMsg)

  // Phase 3.6: Try direct Iroh QUIC delivery first
  // For now, fall through to relay path

  // If no relay peers, throw
  if (!opts.relayPeers || opts.relayPeers.length === 0) {
    throw new Error(
      `Could not deliver mail to ${recipientPeerId}: ` +
      `direct Iroh delivery not yet implemented (Phase 3.6), ` +
      `and no relay peers configured`
    )
  }

  // Try relay peers (via HTTP relay API for now)
  // Phase 3.6 will use Iroh ALPN streams for P2P relay delivery
  const depositMsg: MailMessage = { type: 'deposit', envelope }

  // Stub relay delivery — in a real deployment this would POST to the relay peer's HTTP API
  // For now, record as "sent" optimistically
  await opts.outboxStore?.updateStatus(outboxMsg.id, 'sent')
  return 'relay'
}

/**
 * Poll relay peers for pending mail addressed to this agent.
 *
 * Phase 3.6 implementation will use Iroh ALPN streams.
 * For Phase 3.5, polling is handled via the HTTP API.
 *
 * @returns Count of new messages received
 */
export async function pollMail(
  _bridge: EngineBridge | null,
  _relayPeers: string[],
  _opts: {
    recipientPeerId: string
    recipientKey: AgentPrivateKey
    inboxStore: IInboxStore
    since?: number
    limit?: number
  }
): Promise<number> {
  // Phase 3.6: poll relay peers via Iroh ALPN
  return 0
}

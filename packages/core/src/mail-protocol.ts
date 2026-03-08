/**
 * /subspace/mailbox/1.0.0 — Iroh ALPN protocol for store-and-forward mail.
 *
 * This module handles both sides of the mailbox protocol:
 *   - Server side: handle incoming mail received notifications from the engine
 *   - Client side: send mail to a peer via the Iroh engine bridge
 *
 * Transport: Iroh QUIC via `/subspace/mailbox/1.0.0` ALPN (implemented in Rust,
 * bridged back to Node.js via EngineBridge notifications).
 */

import { v4 as uuidv4 } from 'uuid'
import type { EngineBridge, MailReceivedEvent } from './engine-bridge.js'
import {
  MAILBOX_PROTOCOL,
  type MailEnvelope,
  type MailPayload,
  type InboxMessage,
  type OutboxMessage,
  encryptMailPayload,
  signEnvelope,
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
 * The actual ALPN handler runs in the Rust engine. The engine forwards
 * incoming mail messages back to Node.js via the bridge as `mail.received`
 * notifications. This function wires those notifications to the inbox store.
 *
 * @param bridge  EngineBridge — listens for mail.received notifications
 * @param opts    Mailbox handler options
 * @returns Cleanup function to remove the handler
 */
export async function registerMailboxProtocol(
  bridge: EngineBridge | null,
  opts: MailboxHandlerOptions,
): Promise<() => void> {
  if (!bridge) {
    // No bridge — no-op (engine not running in this mode)
    return () => {}
  }

  const cleanup = bridge.onMailReceived(async (event: MailReceivedEvent) => {
    try {
      // Parse the envelope
      let envelope: MailEnvelope
      try {
        envelope = JSON.parse(event.envelopeJson) as MailEnvelope
      } catch {
        console.warn('[mailbox] Received malformed envelope JSON from', event.fromNodeId)
        return
      }

      // Check expiry
      if (isEnvelopeExpired(envelope)) {
        console.warn('[mailbox] Received expired envelope from', event.fromNodeId)
        return
      }

      // Store in inbox. We store the raw envelope body since decryption requires
      // the sender's libp2p PeerId format which may differ from Iroh NodeId.
      // The HTTP API exposes the envelope for the client to decrypt.
      const inboxMsg: InboxMessage = {
        id: uuidv4(),
        from: envelope.from,
        subject: envelope.contentType ?? '(encrypted)',
        body: event.envelopeJson,  // raw envelope JSON for the client to decrypt
        receivedAt: Date.now(),
        timestamp: Date.now(),
        envelopeId: envelope.id,
      }
      await opts.inboxStore.save(inboxMsg)
      console.log(`[mailbox] Message from ${event.fromNodeId} saved to inbox.`)
    } catch (err) {
      console.error('[mailbox] Error handling incoming mail:', err)
    }
  })

  return cleanup
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
  /**
   * Full address hints for the recipient (relay URL + direct IPs).
   * Providing these dramatically speeds up connection setup.
   */
  recipientAddrHints?: {
    relayUrl?: string
    directAddrs?: string[]
  }
}

/**
 * Send a mail message to a specific agent via Iroh QUIC.
 *
 * Constructs a plain JSON envelope (unencrypted for now — encryption requires
 * matching key derivation between libp2p and Iroh identity formats).
 *
 * @returns 'direct' if delivered directly
 * @throws If delivery fails
 */
export async function sendMail(
  bridge: EngineBridge | null,
  recipientPeerId: string,
  opts: SendMailOptions,
): Promise<'direct' | 'relay'> {
  const envelopeId = uuidv4()

  // Build a simple unencrypted envelope for initial delivery proof.
  // The payload is serialized directly as JSON.
  // TODO: Re-enable encryption once key format is unified between libp2p and Iroh.
  const envelope: MailEnvelope = {
    id: envelopeId,
    from: opts.senderPeerId,
    to: recipientPeerId,
    timestamp: Date.now(),
    contentType: opts.contentType ?? opts.payload.subject ?? 'text/plain',
    // For unencrypted mode: store payload directly in a plaintext wrapper
    payload: Buffer.from(JSON.stringify(opts.payload), 'utf8').toString('base64'),
    ephemeralPubKey: '',
    nonce: '',
    authTag: '',
    signature: '',
    ttl: opts.ttl ?? 604800,
  }

  // Record in outbox
  const outboxMsg: OutboxMessage = {
    id: uuidv4(),
    to: recipientPeerId,
    subject: opts.payload.subject,
    body: opts.payload.body,
    contentType: opts.contentType,
    sentAt: Date.now(),
    envelopeId: envelope.id,
    status: 'pending',
  }
  await opts.outboxStore?.save(outboxMsg)

  // Try direct Iroh QUIC delivery via the engine bridge
  if (bridge?.isRunning) {
    try {
      await bridge.mailSend({
        toNodeId: recipientPeerId,
        envelopeJson: JSON.stringify(envelope),
        toRelayUrl: opts.recipientAddrHints?.relayUrl,
        toDirectAddrs: opts.recipientAddrHints?.directAddrs,
      })
      await opts.outboxStore?.updateStatus(outboxMsg.id, 'sent')
      return 'direct'
    } catch (err) {
      console.warn('[mailbox] Direct delivery failed:', err)
      // Fall through to error
    }
  }

  throw new Error(
    `Could not deliver mail to ${recipientPeerId}: ` +
    `engine bridge ${bridge ? 'returned an error' : 'unavailable'}. ` +
    `Message saved in outbox as pending.`
  )
}

/**
 * Poll relay peers for pending mail addressed to this agent.
 * Push-based delivery via Iroh ALPN — no polling needed.
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
  // Push-based delivery via Iroh ALPN — no polling needed.
  return 0
}

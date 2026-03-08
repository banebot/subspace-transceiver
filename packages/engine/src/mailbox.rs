/*!
 * /subspace/mailbox/1.0.0 — Iroh ALPN protocol for store-and-forward mail.
 *
 * ## Protocol flow
 *
 * Sender:
 *   1. Connects to recipient's Iroh endpoint with MAILBOX_ALPN
 *   2. Opens a bi-directional QUIC stream
 *   3. Sends length-prefixed JSON: `{ "envelopeJson": "<escaped JSON string>" }`
 *   4. Reads length-prefixed JSON ack: `{ "ok": true }` or `{ "ok": false, "error": "..." }`
 *
 * Receiver:
 *   1. `accept()` is called by the Iroh Router
 *   2. Reads the message, extracts the envelope
 *   3. Forwards a `mail.received` notification to the TypeScript daemon via the RPC bridge
 *   4. Sends an ack back to the sender
 */

use anyhow::Result;
use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::rpc::{methods, RpcNotification};
use crate::sync::{read_framed, write_framed};

/// ALPN identifier for the mailbox protocol.
pub const MAILBOX_ALPN: &[u8] = b"/subspace/mailbox/1.0.0";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Request: sender writes this to the stream.
#[derive(Debug, Serialize, Deserialize)]
struct MailRequest {
    /// The full MailEnvelope serialised to a JSON string.
    envelope_json: String,
}

/// Response: receiver writes this back.
#[derive(Debug, Serialize, Deserialize)]
struct MailAck {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Protocol handler (receiver side)
// ---------------------------------------------------------------------------

/// Handles incoming `/subspace/mailbox/1.0.0` connections.
///
/// Each connection carries exactly one mail message (request/response).
/// The handler reads the envelope, forwards it to TypeScript via `mail.received`,
/// and replies with an ack.
#[derive(Debug, Clone)]
pub struct MailboxHandler {
    /// Channel for pushing notifications to the stdio bridge writer task.
    pub notify_tx: mpsc::UnboundedSender<RpcNotification>,
}

impl ProtocolHandler for MailboxHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let remote_id = connection.remote_id();
        debug!("mailbox: incoming connection from {}", remote_id);

        let (mut send, mut recv) = connection.accept_bi().await?;

        // Read the mail request
        let req: MailRequest = match read_framed(&mut recv).await {
            Ok(r) => r,
            Err(e) => {
                warn!("mailbox: failed to read request from {}: {}", remote_id, e);
                let ack = MailAck { ok: false, error: Some(e.to_string()) };
                let _ = write_framed(&mut send, &ack).await;
                send.finish()?;
                connection.closed().await;
                return Ok(());
            }
        };

        // Forward to TypeScript via `mail.received` notification
        // NOTE: Use snake_case field names to match the TypeScript bridge's camelCase mapping.
        let notification = RpcNotification::new(
            methods::NOTIFY_MAIL_RECEIVED,
            json!({
                "envelope_json": req.envelope_json,
                "from_node_id": remote_id.to_string(),
            }),
        );
        if self.notify_tx.send(notification).is_err() {
            warn!("mailbox: bridge shut down, dropping incoming mail from {}", remote_id);
            let ack = MailAck { ok: false, error: Some("Bridge unavailable".to_string()) };
            let _ = write_framed(&mut send, &ack).await;
            send.finish()?;
            return Ok(());
        }

        // Send success ack
        let ack = MailAck { ok: true, error: None };
        write_framed(&mut send, &ack).await.map_err(|e| {
            AcceptError::from(std::io::Error::new(std::io::ErrorKind::BrokenPipe, e.to_string()))
        })?;
        send.finish()?;

        debug!("mailbox: delivered mail from {}", remote_id);

        // Keep the connection alive until the sender closes it.
        // Without this, dropping `connection` here would tear down the QUIC
        // connection before the ack bytes are delivered to the sender.
        connection.closed().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Client side helpers
// ---------------------------------------------------------------------------

/// Wire-level send: connect to a peer, transmit the envelope, read ack.
///
/// `endpoint`     — our local Iroh endpoint  
/// `endpoint_addr` — the recipient's full EndpointAddr (NodeId + optional hints)
/// `envelope_json` — the MailEnvelope serialised to JSON  
pub async fn send_mail_wire(
    endpoint: &iroh::Endpoint,
    endpoint_addr: iroh::EndpointAddr,
    envelope_json: String,
) -> Result<()> {
    // Dial the recipient
    let conn = endpoint.connect(endpoint_addr, MAILBOX_ALPN).await
        .map_err(|e| anyhow::anyhow!("Failed to connect for mail delivery: {}", e))?;

    let (mut send, mut recv) = conn.open_bi().await
        .map_err(|e| anyhow::anyhow!("Failed to open stream: {}", e))?;

    // Send the mail request
    let req = MailRequest { envelope_json };
    write_framed(&mut send, &req).await?;
    send.finish().map_err(|e| anyhow::anyhow!("Failed to finish send stream: {}", e))?;

    // Read the ack
    let ack: MailAck = read_framed(&mut recv).await
        .map_err(|e| anyhow::anyhow!("Failed to read ack: {}", e))?;

    if !ack.ok {
        return Err(anyhow::anyhow!(
            "Recipient rejected mail: {}",
            ack.error.unwrap_or_else(|| "unknown error".to_string())
        ));
    }

    // Close the connection gracefully
    conn.close(0u32.into(), b"mail sent");
    Ok(())
}

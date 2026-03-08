/*!
 * JSON-RPC message types for the stdio bridge.
 *
 * Protocol: line-delimited JSON over stdin/stdout.
 * Each line is a complete JSON object (request, response, or notification).
 *
 * Node.js → Rust: RpcRequest
 * Rust → Node.js: RpcResponse | RpcNotification
 */

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Request (Node.js → Rust)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    /// Unique request ID (used to correlate request/response)
    pub id: String,
    /// Method name (e.g. "engine.start", "gossip.broadcast")
    pub method: String,
    /// Method parameters
    #[serde(default)]
    pub params: Value,
}

// ---------------------------------------------------------------------------
// Response (Rust → Node.js)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    /// Request ID this response corresponds to
    pub id: String,
    /// Successful result (present when error is absent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Error (present when result is absent)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid_params(msg: impl Into<String>) -> Self { Self::new(-32602, msg) }
    pub fn internal(msg: impl Into<String>) -> Self { Self::new(-32603, msg) }
    pub fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("Method not found: {}", method))
    }
}

impl RpcResponse {
    pub fn success(id: String, result: Value) -> Self {
        Self { id, result: Some(result), error: None }
    }
    pub fn error(id: String, error: RpcError) -> Self {
        Self { id, result: None, error: Some(error) }
    }
}

// ---------------------------------------------------------------------------
// Notification (Rust → Node.js, async events)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcNotification {
    /// Event method name (e.g. "peer.connected", "gossip.received")
    pub method: String,
    /// Event parameters
    pub params: Value,
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self { method: method.into(), params }
    }
}

// ---------------------------------------------------------------------------
// Well-known method names
// ---------------------------------------------------------------------------

pub mod methods {
    // Engine lifecycle
    pub const ENGINE_START: &str = "engine.start";
    pub const ENGINE_STOP: &str = "engine.stop";
    pub const ENGINE_NODE_ID: &str = "engine.nodeId";
    pub const ENGINE_ADDRS: &str = "engine.addrs";

    // Peer management
    pub const PEER_CONNECT: &str = "engine.connect";
    pub const PEER_DISCONNECT: &str = "engine.disconnect";
    pub const PEER_LIST: &str = "engine.peers";

    // Gossip
    pub const GOSSIP_JOIN: &str = "gossip.join";
    pub const GOSSIP_LEAVE: &str = "gossip.leave";
    pub const GOSSIP_BROADCAST: &str = "gossip.broadcast";

    // Mail
    pub const MAIL_SEND: &str = "mail.send";
    pub const ENGINE_ADDR_FULL: &str = "engine.addrFull";

    // Browse
    pub const BROWSE_FROM: &str = "browse.from";
    pub const BROWSE_RESPOND: &str = "browse.respond";

    // Notifications (Rust → Node.js)
    pub const NOTIFY_PEER_CONNECTED: &str = "peer.connected";
    pub const NOTIFY_PEER_DISCONNECTED: &str = "peer.disconnected";
    pub const NOTIFY_GOSSIP_RECEIVED: &str = "gossip.received";
    pub const NOTIFY_MAIL_RECEIVED: &str = "mail.received";
    pub const NOTIFY_BROWSE_REQUEST: &str = "browse.request";
    pub const NOTIFY_READY: &str = "engine.ready";
}

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStartParams {
    /// 32-byte Ed25519 seed as hex string (same as TypeScript identity.key)
    pub seed_hex: String,
    /// Optional relay URL override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GossipJoinParams {
    /// Gossip topic ID (hex string)
    pub topic_hex: String,
    /// Initial peer Node IDs to bootstrap from
    #[serde(default)]
    pub bootstrap_peers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GossipBroadcastParams {
    /// Gossip topic ID (hex string)
    pub topic_hex: String,
    /// Message payload as base64-encoded bytes
    pub payload_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectPeerParams {
    /// Target peer's NodeId (hex string)
    pub node_id_hex: String,
    /// Optional relay URL hint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_url: Option<String>,
    /// Optional direct addresses (IP:port)
    #[serde(default)]
    pub direct_addrs: Vec<String>,
}

/// Parameters for `mail.send`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailSendParams {
    /// Recipient's Iroh EndpointId (string form)
    pub to_node_id: String,
    /// The MailEnvelope serialised to a JSON string
    pub envelope_json: String,
    /// Optional relay URL for the recipient (speeds up connection)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_relay_url: Option<String>,
    /// Optional direct addresses for the recipient (IP:port strings)
    #[serde(default)]
    pub to_direct_addrs: Vec<String>,
}

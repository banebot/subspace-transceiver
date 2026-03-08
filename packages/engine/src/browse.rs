//! Browse ALPN protocol handler — `/subspace/browse/1.0.0`
//!
//! Enables Agent A to request content stubs from Agent B over QUIC.
//!
//! ## Server side (handling incoming browse requests):
//! 1. Accept QUIC connection on BROWSE_ALPN
//! 2. Read `BrowseRequest` (framed JSON)
//! 3. Send `browse.request` notification to TypeScript with a `request_id`
//! 4. Wait for `browse.respond` RPC from TypeScript (with a timeout)
//! 5. Write `BrowseResponse` back on the QUIC stream
//!
//! ## Client side (making a browse request):
//! 1. `bridge.browseFrom({ targetNodeId, ... })` RPC
//! 2. Dial target peer with BROWSE_ALPN
//! 3. Write `BrowseRequest`, read `BrowseResponse`
//! 4. Return stubs to TypeScript

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::anyhow;
use iroh::{endpoint::Connection, Endpoint, EndpointAddr};
use iroh_base::{EndpointId, RelayUrl, TransportAddr};
use iroh::protocol::{AcceptError, ProtocolHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{debug, warn};

use crate::rpc::{methods, RpcNotification, RpcResponse, RpcError};
use crate::sync::{read_framed, write_framed};

pub const BROWSE_ALPN: &[u8] = b"/subspace/browse/1.0.0";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowseRequest {
    pub request_id: String,
    pub collection: Option<String>,
    pub since: Option<u64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowseStub {
    pub id: String,
    pub title: Option<String>,
    pub collection: Option<String>,
    pub topic: Vec<String>,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowseResponse {
    pub stubs: Vec<BrowseStub>,
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Bridge RPC params
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct BrowseFromParams {
    /// Iroh NodeId of the peer to browse (hex string)
    pub target_node_id: String,
    /// Optional direct addresses for faster connection
    pub direct_addrs: Option<Vec<String>>,
    /// Optional relay URL hint
    pub relay_url: Option<String>,
    pub collection: Option<String>,
    pub since: Option<u64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct BrowseRespondParams {
    pub request_id: String,
    pub stubs: Vec<BrowseStub>,
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Shared pending-request map
// ---------------------------------------------------------------------------

/// Maps request_id → oneshot sender that delivers the TypeScript response.
pub type PendingBrowse = Arc<Mutex<HashMap<String, oneshot::Sender<BrowseResponse>>>>;

pub fn new_pending_browse() -> PendingBrowse {
    Arc::new(Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Server: ALPN handler for incoming browse requests
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct BrowseHandler {
    pub notify_tx: mpsc::UnboundedSender<RpcNotification>,
    pub pending: PendingBrowse,
}

impl BrowseHandler {
    pub fn new(
        notify_tx: mpsc::UnboundedSender<RpcNotification>,
        pending: PendingBrowse,
    ) -> Self {
        Self { notify_tx, pending }
    }
}

impl Clone for BrowseHandler {
    fn clone(&self) -> Self {
        Self {
            notify_tx: self.notify_tx.clone(),
            pending: self.pending.clone(),
        }
    }
}

impl ProtocolHandler for BrowseHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        self.handle_incoming(connection).await
    }
}

impl BrowseHandler {
    async fn handle_incoming(
        &self,
        connection: Connection,
    ) -> Result<(), AcceptError> {
        let io_err = |msg: &str| AcceptError::from(std::io::Error::new(std::io::ErrorKind::Other, msg));

        let remote_id = connection.remote_id();
        debug!("browse: incoming request from {}", remote_id);

        let (mut send, mut recv) = connection
            .accept_bi()
            .await
            .map_err(|e| io_err(&e.to_string()))?;

        // Read browse request
        let req: BrowseRequest = match read_framed(&mut recv).await {
            Ok(r) => r,
            Err(e) => {
                warn!("browse: failed to read request from {}: {}", remote_id, e);
                let resp = BrowseResponse { stubs: vec![], has_more: false };
                let _ = write_framed(&mut send, &resp).await;
                let _ = send.finish();
                connection.closed().await;
                return Ok(());
            }
        };

        let request_id = req.request_id.clone();

        // Register a oneshot channel for the TypeScript response
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);

        // Notify TypeScript
        let notification = RpcNotification::new(
            methods::NOTIFY_BROWSE_REQUEST,
            json!({
                "request_id": request_id,
                "from_node_id": remote_id.to_string(),
                "collection": req.collection,
                "since": req.since,
                "limit": req.limit.unwrap_or(50),
            }),
        );
        if self.notify_tx.send(notification).is_err() {
            warn!("browse: bridge shut down, dropping request from {}", remote_id);
            let resp = BrowseResponse { stubs: vec![], has_more: false };
            let _ = write_framed(&mut send, &resp).await;
            let _ = send.finish();
            connection.closed().await;
            return Ok(());
        }

        // Wait for TypeScript to respond (10 second timeout)
        let response = match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => {
                warn!("browse: TypeScript dropped browse channel for request {}", request_id);
                BrowseResponse { stubs: vec![], has_more: false }
            }
            Err(_) => {
                warn!("browse: timed out waiting for TypeScript response for request {}", request_id);
                self.pending.lock().await.remove(&request_id);
                BrowseResponse { stubs: vec![], has_more: false }
            }
        };

        // Write response back
        if let Err(e) = write_framed(&mut send, &response).await {
            warn!("browse: failed to write response to {}: {}", remote_id, e);
        }
        let _ = send.finish();

        debug!("browse: served {} stubs to {}", response.stubs.len(), remote_id);
        connection.closed().await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Client: make a browse request to a remote peer
// ---------------------------------------------------------------------------

pub async fn send_browse_wire(
    endpoint: &Endpoint,
    params: BrowseFromParams,
) -> anyhow::Result<BrowseResponse> {
    let target_id: EndpointId = params.target_node_id
        .parse()
        .map_err(|_| anyhow!("Invalid NodeId: {}", params.target_node_id))?;

    let mut endpoint_addr = EndpointAddr::from(target_id);

    if let Some(addrs) = &params.direct_addrs {
        for addr_str in addrs {
            if let Ok(sa) = addr_str.parse::<SocketAddr>() {
                endpoint_addr.addrs.insert(TransportAddr::Ip(sa));
            }
        }
    }
    if let Some(relay_str) = &params.relay_url {
        if let Ok(url) = relay_str.parse::<RelayUrl>() {
            endpoint_addr.addrs.insert(TransportAddr::Relay(url));
        }
    }

    debug!("browse: dialing {} for browse request", target_id);

    let connection = endpoint
        .connect(endpoint_addr, BROWSE_ALPN)
        .await
        .map_err(|e| anyhow!("Browse dial failed: {}", e))?;

    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| anyhow!("Browse open_bi failed: {}", e))?;

    let req = BrowseRequest {
        request_id: make_request_id(),
        collection: params.collection,
        since: params.since,
        limit: params.limit,
    };

    write_framed(&mut send, &req)
        .await
        .map_err(|e| anyhow!("Browse write failed: {}", e))?;
    send.finish()
        .map_err(|e| anyhow!("Browse finish failed: {}", e))?;

    let response: BrowseResponse = read_framed(&mut recv)
        .await
        .map_err(|e| anyhow!("Browse read response failed: {}", e))?;

    connection.close(0u32.into(), b"browse done");

    debug!("browse: received {} stubs", response.stubs.len());
    Ok(response)
}

// ---------------------------------------------------------------------------
// browse.respond — TypeScript delivers stubs for a pending server request
// ---------------------------------------------------------------------------

pub async fn handle_browse_respond(
    pending: &PendingBrowse,
    id: String,
    params: Value,
) -> RpcResponse {
    let p: BrowseRespondParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(e) => return RpcResponse::error(id, RpcError::invalid_params(e.to_string())),
    };

    let tx = pending.lock().await.remove(&p.request_id);

    match tx {
        Some(tx) => {
            let resp = BrowseResponse {
                stubs: p.stubs,
                has_more: p.has_more,
            };
            if tx.send(resp).is_err() {
                return RpcResponse::error(id, RpcError::internal("Browse stream already closed"));
            }
            RpcResponse::success(id, json!({ "ok": true }))
        }
        None => RpcResponse::error(
            id,
            RpcError::internal(format!("Unknown request_id: {}", p.request_id)),
        ),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_request_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("br-{:08x}", nanos)
}

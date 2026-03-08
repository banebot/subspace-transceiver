/*!
 * stdio JSON-RPC bridge between the Iroh engine and Node.js daemon.
 *
 * ## Protocol
 * Line-delimited JSON over stdin/stdout:
 * - stdin:  RpcRequest lines from Node.js
 * - stdout: RpcResponse or RpcNotification lines to Node.js
 * - stderr: Logging (written by tracing, not parsed by Node.js)
 *
 * ## Lifecycle
 * 1. Node.js spawns `subspace-engine` process
 * 2. Engine sends `engine.ready` notification on stdout
 * 3. Node.js sends `engine.start` with the Ed25519 seed hex
 * 4. Engine starts Iroh endpoint + gossip + router, replies with nodeId/addrs
 * 5. Exchange continues until `engine.stop` or stdin closes
 */

use crate::gossip::GossipManager;
use crate::rpc::{
    methods, EngineStartParams, GossipBroadcastParams,
    GossipJoinParams, RpcError, RpcNotification, RpcRequest, RpcResponse,
};
use anyhow::Result;
use iroh::{Endpoint, SecretKey};
use iroh_base::EndpointId;
use iroh_gossip::net::{Gossip, GOSSIP_ALPN};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// State held after `engine.start` succeeds.
struct EngineState {
    endpoint: Endpoint,
    gossip: Arc<Gossip>,
    router: iroh::protocol::Router,
}

pub struct Bridge {
    state: Arc<Mutex<Option<EngineState>>>,
    gossip_manager: Arc<Mutex<GossipManager>>,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(None)),
            gossip_manager: Arc::new(Mutex::new(GossipManager::new())),
        }
    }

    /// Run the bridge, reading from stdin and writing to stdout.
    pub async fn run(&self) -> Result<()> {
        let stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        let mut reader = BufReader::new(stdin).lines();

        // Announce readiness
        self.send_notification(
            &mut stdout,
            RpcNotification::new(methods::NOTIFY_READY, json!({"version": "0.1.0"})),
        )
        .await?;

        while let Some(line) = reader.next_line().await? {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<RpcRequest>(&line) {
                Ok(req) => self.handle_request(req).await,
                Err(e) => {
                    warn!("Malformed JSON-RPC: {} (input: {})", e, &line[..line.len().min(120)]);
                    continue;
                }
            };

            let json = serde_json::to_string(&response).unwrap_or_default();
            stdout.write_all(json.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }

        Ok(())
    }

    async fn handle_request(&self, req: RpcRequest) -> RpcResponse {
        let id = req.id.clone();
        match req.method.as_str() {
            methods::ENGINE_START    => self.handle_engine_start(id, req.params).await,
            methods::ENGINE_STOP     => self.handle_engine_stop(id).await,
            methods::ENGINE_NODE_ID  => self.handle_engine_node_id(id).await,
            methods::ENGINE_ADDRS    => self.handle_engine_addrs(id).await,
            methods::PEER_LIST       => self.handle_peer_list(id).await,
            methods::GOSSIP_JOIN     => self.handle_gossip_join(id, req.params).await,
            methods::GOSSIP_LEAVE    => self.handle_gossip_leave(id, req.params).await,
            methods::GOSSIP_BROADCAST => self.handle_gossip_broadcast(id, req.params).await,
            _ => RpcResponse::error(id, RpcError::method_not_found(&req.method)),
        }
    }

    // -----------------------------------------------------------------------
    // Engine lifecycle
    // -----------------------------------------------------------------------

    async fn handle_engine_start(&self, id: String, params: Value) -> RpcResponse {
        let params: EngineStartParams = match serde_json::from_value(params) {
            Ok(p) => p,
            Err(e) => return RpcResponse::error(id, RpcError::invalid_params(e.to_string())),
        };

        let seed_bytes = match hex::decode(&params.seed_hex) {
            Ok(b) if b.len() == 32 => b,
            Ok(_) => return RpcResponse::error(id, RpcError::invalid_params("Seed must be 32 bytes")),
            Err(e) => return RpcResponse::error(id, RpcError::invalid_params(format!("Bad seed hex: {}", e))),
        };

        let mut seed = [0u8; 32];
        seed.copy_from_slice(&seed_bytes);

        {
            let guard = self.state.lock().await;
            if guard.is_some() {
                let ep_id = guard.as_ref().unwrap().endpoint.id().to_string();
                return RpcResponse::success(id, json!({ "nodeId": ep_id, "addrs": [] }));
            }
        }

        // Build endpoint
        let secret_key = SecretKey::from(seed);
        let endpoint = match Endpoint::builder()
            .secret_key(secret_key)
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .bind()
            .await
        {
            Ok(ep) => ep,
            Err(e) => return RpcResponse::error(id, RpcError::internal(e.to_string())),
        };

        // Build gossip (synchronous)
        let gossip = Arc::new(Gossip::builder().spawn(endpoint.clone()));

        // Build and spawn the router for incoming connections
        let gossip_proto = gossip.clone();
        let router = match iroh::protocol::Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip_proto)
            .spawn()
        {
            router => router,
        };

        let ep_id = endpoint.id().to_string();
        let addrs: Vec<String> = endpoint.addr().ip_addrs().map(|a| a.to_string()).collect();

        info!("Engine started. NodeId: {}  Addrs: {:?}", ep_id, addrs);

        // Attach gossip manager
        {
            let mut gm = self.gossip_manager.lock().await;
            gm.attach(gossip.clone());
        }

        // Store state
        {
            let mut guard = self.state.lock().await;
            *guard = Some(EngineState { endpoint, gossip, router });
        }

        RpcResponse::success(id, json!({ "nodeId": ep_id, "addrs": addrs }))
    }

    async fn handle_engine_stop(&self, id: String) -> RpcResponse {
        let mut gm = self.gossip_manager.lock().await;
        gm.stop().await;
        drop(gm);

        let mut guard = self.state.lock().await;
        if let Some(state) = guard.take() {
            let _ = state.router.shutdown().await;
        }

        RpcResponse::success(id, json!({"stopped": true}))
    }

    async fn handle_engine_node_id(&self, id: String) -> RpcResponse {
        let guard = self.state.lock().await;
        match guard.as_ref() {
            Some(s) => RpcResponse::success(id, json!({ "nodeId": s.endpoint.id().to_string() })),
            None => RpcResponse::error(id, RpcError::internal("Engine not started")),
        }
    }

    async fn handle_engine_addrs(&self, id: String) -> RpcResponse {
        let guard = self.state.lock().await;
        match guard.as_ref() {
            Some(s) => {
                let addrs: Vec<String> = s.endpoint.addr().ip_addrs().map(|a| a.to_string()).collect();
                RpcResponse::success(id, json!({ "addrs": addrs }))
            }
            None => RpcResponse::error(id, RpcError::internal("Engine not started")),
        }
    }

    async fn handle_peer_list(&self, id: String) -> RpcResponse {
        let guard = self.state.lock().await;
        if guard.is_some() {
            // Peer tracking is a Phase 3.2 enhancement — return empty list for now
            RpcResponse::success(id, json!({ "peers": [] }))
        } else {
            RpcResponse::error(id, RpcError::internal("Engine not started"))
        }
    }

    // -----------------------------------------------------------------------
    // Gossip
    // -----------------------------------------------------------------------

    async fn handle_gossip_join(&self, id: String, params: Value) -> RpcResponse {
        let params: GossipJoinParams = match serde_json::from_value(params) {
            Ok(p) => p,
            Err(e) => return RpcResponse::error(id, RpcError::invalid_params(e.to_string())),
        };

        let mut bootstrap_peers: Vec<EndpointId> = vec![];
        for peer_str in &params.bootstrap_peers {
            match peer_str.parse::<EndpointId>() {
                Ok(nid) => bootstrap_peers.push(nid),
                Err(e) => warn!("Invalid bootstrap EndpointId {}: {}", peer_str, e),
            }
        }

        let gm = self.gossip_manager.lock().await;
        match gm.join(&params.topic_hex, bootstrap_peers).await {
            Ok(_receiver) => {
                RpcResponse::success(id, json!({ "joined": true, "topic": params.topic_hex }))
            }
            Err(e) => RpcResponse::error(id, RpcError::internal(e.to_string())),
        }
    }

    async fn handle_gossip_leave(&self, id: String, params: Value) -> RpcResponse {
        let topic_hex = params.get("topic_hex")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let gm = self.gossip_manager.lock().await;
        match gm.leave(&topic_hex).await {
            Ok(_) => RpcResponse::success(id, json!({ "left": true, "topic": topic_hex })),
            Err(e) => RpcResponse::error(id, RpcError::internal(e.to_string())),
        }
    }

    async fn handle_gossip_broadcast(&self, id: String, params: Value) -> RpcResponse {
        let params: GossipBroadcastParams = match serde_json::from_value(params) {
            Ok(p) => p,
            Err(e) => return RpcResponse::error(id, RpcError::invalid_params(e.to_string())),
        };

        use base64::Engine as _;
        let payload = match base64::engine::general_purpose::STANDARD.decode(&params.payload_b64) {
            Ok(b) => b,
            Err(e) => return RpcResponse::error(id, RpcError::invalid_params(format!("Bad base64: {}", e))),
        };

        let gm = self.gossip_manager.lock().await;
        match gm.broadcast(&params.topic_hex, payload).await {
            Ok(_) => RpcResponse::success(id, json!({ "broadcast": true })),
            Err(e) => RpcResponse::error(id, RpcError::internal(e.to_string())),
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    async fn send_notification(
        &self,
        stdout: &mut tokio::io::Stdout,
        notification: RpcNotification,
    ) -> Result<()> {
        let json = serde_json::to_string(&notification)?;
        stdout.write_all(json.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
        Ok(())
    }
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

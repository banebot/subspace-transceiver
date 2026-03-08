/*!
 * Unit tests: JSON-RPC message types and bridge protocol.
 */

use subspace_engine::rpc::{
    methods, EngineStartParams, GossipBroadcastParams, GossipJoinParams,
    RpcError, RpcNotification, RpcRequest, RpcResponse,
};
use serde_json::{json, Value};

#[test]
fn test_rpc_request_serialization() {
    let req = RpcRequest {
        id: "req-1".to_string(),
        method: methods::ENGINE_START.to_string(),
        params: json!({ "seed_hex": "aa".repeat(32) }),
    };

    let json = serde_json::to_string(&req).unwrap();
    let parsed: RpcRequest = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed.id, "req-1");
    assert_eq!(parsed.method, methods::ENGINE_START);
}

#[test]
fn test_rpc_response_success() {
    let resp = RpcResponse::success("req-1".to_string(), json!({ "nodeId": "abc123" }));

    assert_eq!(resp.id, "req-1");
    assert!(resp.result.is_some());
    assert!(resp.error.is_none());
    assert_eq!(resp.result.unwrap()["nodeId"], "abc123");
}

#[test]
fn test_rpc_response_error() {
    let resp = RpcResponse::error(
        "req-2".to_string(),
        RpcError::method_not_found("nonexistent.method"),
    );

    assert_eq!(resp.id, "req-2");
    assert!(resp.result.is_none());
    assert!(resp.error.is_some());

    let err = resp.error.unwrap();
    assert_eq!(err.code, -32601);
    assert!(err.message.contains("nonexistent.method"));
}

#[test]
fn test_rpc_error_types() {
    let e1 = RpcError::invalid_params("bad param");
    assert_eq!(e1.code, -32602);

    let e2 = RpcError::internal("server error");
    assert_eq!(e2.code, -32603);

    let e3 = RpcError::method_not_found("foo.bar");
    assert_eq!(e3.code, -32601);
    assert!(e3.message.contains("foo.bar"));
}

#[test]
fn test_notification_serialization() {
    let notif = RpcNotification::new(
        methods::NOTIFY_READY,
        json!({ "version": "0.1.0" }),
    );

    let json = serde_json::to_string(&notif).unwrap();
    assert!(json.contains(methods::NOTIFY_READY));
    assert!(json.contains("0.1.0"));

    let parsed: RpcNotification = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.method, methods::NOTIFY_READY);
}

#[test]
fn test_engine_start_params_roundtrip() {
    let seed_hex = "aa".repeat(32); // 32 bytes as hex = 64 chars
    let params = EngineStartParams {
        seed_hex: seed_hex.clone(),
        relay_url: Some("https://relay.example.com".to_string()),
    };

    let json = serde_json::to_value(&params).unwrap();
    let parsed: EngineStartParams = serde_json::from_value(json).unwrap();

    assert_eq!(parsed.seed_hex, seed_hex);
    assert_eq!(parsed.relay_url, Some("https://relay.example.com".to_string()));
}

#[test]
fn test_engine_start_params_no_relay() {
    let params = EngineStartParams {
        seed_hex: "bb".repeat(32),
        relay_url: None,
    };

    let json = serde_json::to_value(&params).unwrap();
    // relay_url should be omitted when None (skip_serializing_if)
    assert!(json.get("relay_url").is_none());
}

#[test]
fn test_gossip_join_params_roundtrip() {
    let params = GossipJoinParams {
        topic_hex: "deadbeef".repeat(8),
        bootstrap_peers: vec!["abc".to_string(), "def".to_string()],
    };

    let json = serde_json::to_value(&params).unwrap();
    let parsed: GossipJoinParams = serde_json::from_value(json).unwrap();

    assert_eq!(parsed.topic_hex, params.topic_hex);
    assert_eq!(parsed.bootstrap_peers.len(), 2);
}

#[test]
fn test_gossip_broadcast_params() {
    use base64::Engine as _;
    let payload = vec![1u8, 2, 3, 4, 5];
    let payload_b64 = base64::engine::general_purpose::STANDARD.encode(&payload);

    let params = GossipBroadcastParams {
        topic_hex: "cafebabe".repeat(8),
        payload_b64: payload_b64.clone(),
    };

    let json = serde_json::to_value(&params).unwrap();
    let parsed: GossipBroadcastParams = serde_json::from_value(json).unwrap();

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&parsed.payload_b64)
        .unwrap();
    assert_eq!(decoded, payload);
}

#[test]
fn test_rpc_request_missing_params_defaults_null() {
    // RpcRequest with no params field should default to null Value
    let json = r#"{"id":"x","method":"engine.nodeId"}"#;
    let req: RpcRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.params, Value::Null);
}

#[test]
fn test_method_constants_are_correct() {
    // Verify the string values match expected protocol names
    assert_eq!(methods::ENGINE_START, "engine.start");
    assert_eq!(methods::ENGINE_STOP, "engine.stop");
    assert_eq!(methods::ENGINE_NODE_ID, "engine.nodeId");
    assert_eq!(methods::GOSSIP_JOIN, "gossip.join");
    assert_eq!(methods::GOSSIP_BROADCAST, "gossip.broadcast");
    assert_eq!(methods::NOTIFY_READY, "engine.ready");
    assert_eq!(methods::NOTIFY_GOSSIP_RECEIVED, "gossip.received");
}

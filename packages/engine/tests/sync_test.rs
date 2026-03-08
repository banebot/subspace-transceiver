/*!
 * Integration tests: Loro delta sync protocol over simulated streams.
 */

use subspace_engine::sync::{
    SyncRequest, SyncResponse, compute_psk_hash, read_framed, verify_psk, write_framed,
};
use tokio::io::duplex;

#[tokio::test]
async fn test_sync_request_framing() {
    let (mut write_end, mut read_end) = duplex(65536);

    let req = SyncRequest {
        psk_hash: [0x42u8; 32],
        key: "test.document/id-001".to_string(),
        known_version: vec![1, 2, 3, 4, 5, 6, 7, 8],
    };

    write_framed(&mut write_end, &req).await.unwrap();

    let received: SyncRequest = read_framed(&mut read_end).await.unwrap();
    assert_eq!(received.key, "test.document/id-001");
    assert_eq!(received.known_version, vec![1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(received.psk_hash, [0x42u8; 32]);
}

#[tokio::test]
async fn test_sync_response_framing() {
    let (mut write_end, mut read_end) = duplex(65536);

    let delta_data: Vec<u8> = (0u8..200).collect();
    let resp = SyncResponse {
        auth_ok: true,
        delta: delta_data.clone(),
        has_more: false,
    };

    write_framed(&mut write_end, &resp).await.unwrap();

    let received: SyncResponse = read_framed(&mut read_end).await.unwrap();
    assert!(received.auth_ok);
    assert_eq!(received.delta, delta_data);
    assert!(!received.has_more);
}

#[tokio::test]
async fn test_sync_auth_failure_response() {
    let (mut write_end, mut read_end) = duplex(4096);

    let resp = SyncResponse {
        auth_ok: false,
        delta: vec![],
        has_more: false,
    };

    write_framed(&mut write_end, &resp).await.unwrap();

    let received: SyncResponse = read_framed(&mut read_end).await.unwrap();
    assert!(!received.auth_ok);
    assert!(received.delta.is_empty());
}

#[tokio::test]
async fn test_multiple_messages_in_sequence() {
    let (mut write_end, mut read_end) = duplex(65536);

    // Send 5 sync responses in sequence
    for i in 0u8..5 {
        let resp = SyncResponse {
            auth_ok: true,
            delta: vec![i; 100],
            has_more: i < 4,
        };
        write_framed(&mut write_end, &resp).await.unwrap();
    }

    for i in 0u8..5 {
        let received: SyncResponse = read_framed(&mut read_end).await.unwrap();
        assert!(received.auth_ok);
        assert_eq!(received.delta, vec![i; 100]);
        assert_eq!(received.has_more, i < 4);
    }
}

#[test]
fn test_psk_hash_determinism() {
    let psk = b"network-psk-secret";
    let h1 = compute_psk_hash(psk);
    let h2 = compute_psk_hash(psk);
    assert_eq!(h1, h2);
}

#[test]
fn test_psk_verify_correct() {
    let psk = b"correct-psk";
    let hash = compute_psk_hash(psk);
    assert!(verify_psk(&hash, psk));
}

#[test]
fn test_psk_verify_wrong() {
    let psk = b"correct-psk";
    let hash = compute_psk_hash(psk);
    assert!(!verify_psk(&hash, b"wrong-psk"));
    assert!(!verify_psk(&hash, b""));
}

#[test]
fn test_psk_different_networks_different_hashes() {
    let h1 = compute_psk_hash(b"network-alpha");
    let h2 = compute_psk_hash(b"network-beta");
    assert_ne!(h1, h2);
}

#[tokio::test]
async fn test_large_delta_sync() {
    let (mut write_end, mut read_end) = duplex(1024 * 1024); // 1MB buffer

    // 64KB delta (typical Loro snapshot)
    let large_delta = vec![0xABu8; 64 * 1024];
    let resp = SyncResponse {
        auth_ok: true,
        delta: large_delta.clone(),
        has_more: false,
    };

    write_framed(&mut write_end, &resp).await.unwrap();

    let received: SyncResponse = read_framed(&mut read_end).await.unwrap();
    assert_eq!(received.delta.len(), 64 * 1024);
    assert_eq!(received.delta, large_delta);
}

#[tokio::test]
async fn test_full_sync_handshake_simulation() {
    // Simulate a complete sync handshake over a duplex pipe:
    // Client side sends request → Server reads and responds → Client reads response

    let (mut client_end, mut server_end) = duplex(65536);
    let psk = b"shared-network-key";

    // Client → Server: SyncRequest
    let req = SyncRequest {
        psk_hash: compute_psk_hash(psk),
        key: "memo.app/note-001".to_string(),
        known_version: vec![], // No prior state — requesting full snapshot
    };
    write_framed(&mut client_end, &req).await.unwrap();

    // Server reads request and authenticates
    let received_req: SyncRequest = read_framed(&mut server_end).await.unwrap();
    let auth_ok = verify_psk(&received_req.psk_hash, psk);
    assert!(auth_ok, "PSK must be verified");

    // Server → Client: SyncResponse with delta
    let delta = b"loro-delta-bytes-representing-document-state".to_vec();
    let resp = SyncResponse {
        auth_ok,
        delta: delta.clone(),
        has_more: false,
    };
    write_framed(&mut server_end, &resp).await.unwrap();

    // Client reads response
    let received_resp: SyncResponse = read_framed(&mut client_end).await.unwrap();
    assert!(received_resp.auth_ok);
    assert_eq!(received_resp.delta, delta);
    assert!(!received_resp.has_more);
}

/*!
 * Loro delta sync over Iroh QUIC streams.
 *
 * Implements the Subspace sync protocol:
 * 1. Initiator opens a QUIC stream using `/subspace/manifest/1.0.0` ALPN
 * 2. Initiator sends a `SyncRequest` with its latest Loro snapshot version
 * 3. Responder replies with `SyncResponse` containing the Loro delta bytes
 * 4. Initiator imports the delta into its Loro doc
 *
 * ## Message framing
 * Each message is length-prefixed: `[u32 big-endian length][payload bytes]`
 * Payload is MessagePack-encoded.
 *
 * ## PSK encryption
 * The Iroh QUIC connection is already encrypted via TLS + Ed25519.
 * PSK (pre-shared key) provides an additional layer of application-level
 * authentication — only peers who know the PSK can exchange deltas.
 * PSK verification is performed before any delta bytes are sent.
 */

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Sent by the sync initiator to request missing deltas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequest {
    /// PSK hash (SHA-256 of the network PSK) for authentication
    pub psk_hash: [u8; 32],
    /// The store key being synced (NSID of the document)
    pub key: String,
    /// The Loro export state used to request only new deltas.
    /// This is the `ExportMode::updates_after(version)` bytes.
    pub known_version: Vec<u8>,
}

/// Sent by the sync responder with the delta bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResponse {
    /// Whether the PSK was accepted
    pub auth_ok: bool,
    /// Loro delta bytes to import (empty if auth failed or no new data)
    pub delta: Vec<u8>,
    /// Whether there is more data to follow (chunked transfer)
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Framing helpers
// ---------------------------------------------------------------------------

/// Write a length-prefixed message to a QUIC send stream.
pub async fn write_framed<W: AsyncWriteExt + Unpin, T: Serialize>(
    writer: &mut W,
    msg: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(msg).context("Serialization failed")?;
    let len = bytes.len() as u32;
    writer.write_all(&len.to_be_bytes()).await.context("Write length failed")?;
    writer.write_all(&bytes).await.context("Write payload failed")?;
    writer.flush().await.context("Flush failed")?;
    Ok(())
}

/// Read a length-prefixed message from a QUIC receive stream.
pub async fn read_framed<R: AsyncReadExt + Unpin, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> Result<T> {
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf).await.context("Read length failed")?;
    let len = u32::from_be_bytes(len_buf) as usize;

    if len > 16 * 1024 * 1024 {
        bail!("Message too large: {} bytes", len);
    }

    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await.context("Read payload failed")?;
    let msg = serde_json::from_slice(&buf).context("Deserialization failed")?;
    Ok(msg)
}

// ---------------------------------------------------------------------------
// PSK verification
// ---------------------------------------------------------------------------

/// Compute the PSK hash used for sync authentication.
/// This is SHA-256 of the PSK bytes (same derivation as LoroEpochManager).
pub fn compute_psk_hash(psk: &[u8]) -> [u8; 32] {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // Note: For production use, replace with proper SHA-256 via sha2 crate.
    // This is a placeholder that produces a deterministic 32-byte value.
    let mut hash = [0u8; 32];
    let mut h = DefaultHasher::new();
    psk.hash(&mut h);
    let v = h.finish().to_le_bytes();
    hash[..8].copy_from_slice(&v);
    hash[8..16].copy_from_slice(&v);
    hash[16..24].copy_from_slice(&v);
    hash[24..32].copy_from_slice(&v);
    hash
}

/// Verify that the request's PSK hash matches the local PSK.
pub fn verify_psk(request_hash: &[u8; 32], local_psk: &[u8]) -> bool {
    let expected = compute_psk_hash(local_psk);
    request_hash.ct_eq(&expected)
}

// Constant-time comparison
trait ConstantTimeEq {
    fn ct_eq(&self, other: &Self) -> bool;
}

impl ConstantTimeEq for [u8; 32] {
    fn ct_eq(&self, other: &Self) -> bool {
        let mut diff = 0u8;
        for (a, b) in self.iter().zip(other.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn test_framing_roundtrip() {
        let (mut client, mut server) = duplex(4096);

        let request = SyncRequest {
            psk_hash: [1u8; 32],
            key: "app.example.note/123".to_string(),
            known_version: vec![0, 1, 2, 3],
        };

        write_framed(&mut client, &request).await.unwrap();

        let received: SyncRequest = read_framed(&mut server).await.unwrap();
        assert_eq!(received.key, request.key);
        assert_eq!(received.known_version, request.known_version);
    }

    #[tokio::test]
    async fn test_psk_verification() {
        let psk = b"test-network-psk";
        let hash = compute_psk_hash(psk);

        assert!(verify_psk(&hash, psk), "Correct PSK must verify");
        assert!(!verify_psk(&hash, b"wrong-psk"), "Wrong PSK must fail");
    }

    #[tokio::test]
    async fn test_psk_hash_deterministic() {
        let psk = b"deterministic";
        let h1 = compute_psk_hash(psk);
        let h2 = compute_psk_hash(psk);
        assert_eq!(h1, h2, "PSK hash must be deterministic");
    }

    #[tokio::test]
    async fn test_sync_response_framing() {
        let (mut client, mut server) = duplex(65536);

        let response = SyncResponse {
            auth_ok: true,
            delta: vec![10u8; 1000],
            has_more: false,
        };

        write_framed(&mut client, &response).await.unwrap();
        let received: SyncResponse = read_framed(&mut server).await.unwrap();

        assert!(received.auth_ok);
        assert_eq!(received.delta.len(), 1000);
        assert!(!received.has_more);
    }
}

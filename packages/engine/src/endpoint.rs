/*!
 * Iroh endpoint management.
 *
 * Creates and manages an Iroh QUIC endpoint backed by an Ed25519 keypair.
 */

use anyhow::{Context, Result};
use iroh::{Endpoint, SecretKey};
use iroh_base::EndpointAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

/// Wrapper around an Iroh Endpoint with lifecycle management.
pub struct IrohEndpoint {
    inner: Arc<Mutex<Option<Endpoint>>>,
}

impl IrohEndpoint {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(None)) }
    }

    /// Start the Iroh endpoint with the given 32-byte Ed25519 seed.
    pub async fn start(&self, seed: [u8; 32], _relay_url: Option<String>) -> Result<()> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let secret_key = SecretKey::from(seed);
        let endpoint = Endpoint::builder()
            .secret_key(secret_key)
            .bind()
            .await
            .context("Failed to bind Iroh endpoint")?;

        let id = endpoint.id();
        info!("Iroh endpoint started. EndpointId: {}", id);
        *guard = Some(endpoint);
        Ok(())
    }

    /// Get the EndpointId as a string.
    pub async fn node_id(&self) -> Option<String> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|ep| ep.id().to_string())
    }

    /// Get the EndpointAddr for this endpoint.
    pub async fn endpoint_addr(&self) -> Option<EndpointAddr> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|ep| ep.addr())
    }

    /// Get direct IP addresses as strings.
    pub async fn addrs(&self) -> Vec<String> {
        let guard = self.inner.lock().await;
        match guard.as_ref() {
            Some(ep) => {
                let addr = ep.addr();
                addr.ip_addrs().map(|a| a.to_string()).collect()
            }
            None => vec![],
        }
    }

    /// Get a clone of the underlying Endpoint.
    pub async fn get(&self) -> Option<Endpoint> {
        let guard = self.inner.lock().await;
        guard.clone()
    }

    /// Stop the endpoint.
    pub async fn stop(&self) -> Result<()> {
        let mut guard = self.inner.lock().await;
        if let Some(ep) = guard.take() {
            ep.close().await;
            info!("Iroh endpoint stopped.");
        }
        Ok(())
    }

    pub async fn is_started(&self) -> bool {
        let guard = self.inner.lock().await;
        guard.is_some()
    }
}

impl Default for IrohEndpoint {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_endpoint_start_stop() {
        let ep = IrohEndpoint::new();
        assert!(!ep.is_started().await);

        let seed = [42u8; 32];
        ep.start(seed, None).await.expect("Failed to start endpoint");
        assert!(ep.is_started().await);

        let node_id = ep.node_id().await;
        assert!(node_id.is_some());
        assert!(!node_id.unwrap().is_empty());

        ep.stop().await.expect("Failed to stop endpoint");
        assert!(!ep.is_started().await);
    }

    #[tokio::test]
    async fn test_endpoint_idempotent_start() {
        let ep = IrohEndpoint::new();
        let seed = [1u8; 32];
        ep.start(seed, None).await.expect("First start failed");
        ep.start(seed, None).await.expect("Second start should be idempotent");
        ep.stop().await.expect("Failed to stop");
    }

    #[tokio::test]
    async fn test_different_seeds_produce_different_node_ids() {
        let ep1 = IrohEndpoint::new();
        let ep2 = IrohEndpoint::new();

        ep1.start([1u8; 32], None).await.unwrap();
        ep2.start([2u8; 32], None).await.unwrap();

        let id1 = ep1.node_id().await.unwrap();
        let id2 = ep2.node_id().await.unwrap();
        assert_ne!(id1, id2, "Different seeds must produce different EndpointIds");

        ep1.stop().await.unwrap();
        ep2.stop().await.unwrap();
    }

    #[tokio::test]
    async fn test_same_seed_produces_same_node_id() {
        let seed = [99u8; 32];

        let ep1 = IrohEndpoint::new();
        ep1.start(seed, None).await.unwrap();
        let id1 = ep1.node_id().await.unwrap();
        ep1.stop().await.unwrap();

        let ep2 = IrohEndpoint::new();
        ep2.start(seed, None).await.unwrap();
        let id2 = ep2.node_id().await.unwrap();
        ep2.stop().await.unwrap();

        assert_eq!(id1, id2, "Same seed must produce same EndpointId");
    }
}

/*!
 * iroh-gossip integration.
 *
 * Provides HyParView/Plumtree gossip broadcast over Iroh QUIC connections.
 */

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::StreamExt;
use iroh_base::EndpointId;
use iroh_gossip::api::Event as GossipEvent;
use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::debug;

/// A gossip message received from a peer.
#[derive(Debug, Clone)]
pub struct GossipMessage {
    pub topic_hex: String,
    pub payload: Vec<u8>,
    pub from_node_id: String,
}

/// Parse a 32-byte TopicId from a hex string.
pub fn parse_topic(topic_hex: &str) -> Result<TopicId> {
    let topic_bytes = hex::decode(topic_hex).context("Invalid topic hex")?;
    let mut arr = [0u8; 32];
    let copy_len = topic_bytes.len().min(32);
    arr[..copy_len].copy_from_slice(&topic_bytes[..copy_len]);
    Ok(TopicId::from_bytes(arr))
}

/// Manages gossip topic subscriptions over an Iroh endpoint.
pub struct GossipManager {
    gossip: Option<Arc<Gossip>>,
    subscriptions: Arc<Mutex<HashMap<String, mpsc::Sender<GossipMessage>>>>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl GossipManager {
    pub fn new() -> Self {
        Self {
            gossip: None,
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
            tasks: Arc::new(Mutex::new(vec![])),
        }
    }

    /// Attach a running Gossip instance (created externally alongside the Router).
    pub fn attach(&mut self, gossip: Arc<Gossip>) {
        self.gossip = Some(gossip);
    }

    /// Join a gossip topic and start receiving messages.
    pub async fn join(
        &self,
        topic_hex: &str,
        bootstrap_peers: Vec<EndpointId>,
    ) -> Result<mpsc::Receiver<GossipMessage>> {
        let gossip = self.gossip.as_ref().context("Gossip not initialized")?;
        let topic = parse_topic(topic_hex)?;

        let (sender, receiver) = mpsc::channel(256);
        let mut topic_sub = gossip.subscribe(topic, bootstrap_peers).await?;

        let sender_clone = sender.clone();
        let topic_hex_owned = topic_hex.to_string();
        let subscriptions = Arc::clone(&self.subscriptions);

        let task = tokio::spawn(async move {
            while let Some(event_result) = topic_sub.next().await {
                match event_result {
                    Ok(GossipEvent::Received(msg)) => {
                        let gossip_msg = GossipMessage {
                            topic_hex: topic_hex_owned.clone(),
                            payload: msg.content.to_vec(),
                            from_node_id: msg.delivered_from.to_string(),
                        };
                        if sender_clone.send(gossip_msg).await.is_err() {
                            break;
                        }
                    }
                    Ok(GossipEvent::NeighborUp(node_id)) => {
                        debug!("Gossip neighbor up: {} on topic {}", node_id, topic_hex_owned);
                    }
                    Ok(GossipEvent::NeighborDown(node_id)) => {
                        debug!("Gossip neighbor down: {} on topic {}", node_id, topic_hex_owned);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let mut subs = subscriptions.lock().await;
            subs.remove(&topic_hex_owned);
        });

        {
            let mut tasks = self.tasks.lock().await;
            tasks.push(task);
        }
        {
            let mut subs = self.subscriptions.lock().await;
            subs.insert(topic_hex.to_string(), sender);
        }

        Ok(receiver)
    }

    /// Leave a gossip topic (drop our subscription).
    pub async fn leave(&self, topic_hex: &str) -> Result<()> {
        let mut subs = self.subscriptions.lock().await;
        subs.remove(topic_hex);
        Ok(())
    }

    /// Broadcast a message to all peers on a topic.
    pub async fn broadcast(&self, topic_hex: &str, payload: Vec<u8>) -> Result<()> {
        let gossip = self.gossip.as_ref().context("Gossip not initialized")?;
        let topic = parse_topic(topic_hex)?;

        let mut topic_sub = gossip.subscribe(topic, vec![]).await?;
        topic_sub.broadcast(Bytes::from(payload)).await?;
        Ok(())
    }

    /// Shut down the gossip manager.
    pub async fn stop(&mut self) {
        let mut tasks = self.tasks.lock().await;
        for task in tasks.drain(..) {
            task.abort();
        }
        self.gossip = None;
    }
}

impl Default for GossipManager {
    fn default() -> Self {
        Self::new()
    }
}

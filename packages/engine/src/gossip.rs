/*!
 * iroh-gossip integration.
 *
 * Provides HyParView/Plumtree gossip broadcast over Iroh QUIC connections.
 *
 * # Design
 * Each `join()` call creates a fresh gossip subscription that is kept alive
 * for the lifetime of the topic participation.  `broadcast()` reuses the
 * sender from the *most recent* subscription so it uses the newest peer set.
 *
 * The key fix from the original implementation: the default iroh-gossip
 * `max_message_size` is only 4096 bytes, which silently drops larger deltas.
 * The Gossip instance is now built with a 1 MiB limit (set in bridge.rs).
 */

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::StreamExt;
use iroh_base::EndpointId;
use iroh_gossip::api::{Event as GossipEvent, GossipSender};
use iroh_gossip::net::Gossip;
use iroh_gossip::proto::TopicId;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::debug;

/// A gossip message received from a peer, or a gossip topology event.
#[derive(Debug, Clone)]
pub struct GossipMessage {
    pub topic_hex: String,
    pub payload: Vec<u8>,
    pub from_node_id: String,
    /// When true this is a NeighborUp event (payload is empty).
    pub is_neighbor_up: bool,
}

/// Parse a 32-byte TopicId from a hex string.
pub fn parse_topic(topic_hex: &str) -> Result<TopicId> {
    let topic_bytes = hex::decode(topic_hex).context("Invalid topic hex")?;
    let mut arr = [0u8; 32];
    let copy_len = topic_bytes.len().min(32);
    arr[..copy_len].copy_from_slice(&topic_bytes[..copy_len]);
    Ok(TopicId::from_bytes(arr))
}

/// One live gossip subscription.
struct Sub {
    /// GossipSender kept alive so the topic is not left.
    sender: GossipSender,
    /// Background task reading gossip events and forwarding them.
    _task: JoinHandle<()>,
}

/// Manages gossip topic subscriptions over an Iroh endpoint.
pub struct GossipManager {
    gossip: Option<Arc<Gossip>>,
    /// topic_hex → ordered list of live subscriptions (newest last).
    subs: Arc<Mutex<HashMap<String, Vec<Sub>>>>,
    /// topic_hex → list of TypeScript bridge mpsc senders (fan-out).
    fanout: Arc<Mutex<HashMap<String, Vec<mpsc::Sender<GossipMessage>>>>>,
}

impl GossipManager {
    pub fn new() -> Self {
        Self {
            gossip: None,
            subs: Arc::new(Mutex::new(HashMap::new())),
            fanout: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn attach(&mut self, gossip: Arc<Gossip>) {
        self.gossip = Some(gossip);
    }

    /// Join a gossip topic.  Returns an mpsc::Receiver for incoming messages.
    ///
    /// Every call creates a new gossip subscription (keeping all previous ones
    /// alive).  All subscriptions share a fan-out so messages received on *any*
    /// subscription reach the returned receiver.
    pub async fn join(
        &self,
        topic_hex: &str,
        bootstrap_peers: Vec<EndpointId>,
    ) -> Result<mpsc::Receiver<GossipMessage>> {
        let gossip = self.gossip.as_ref().context("Gossip not initialized")?;
        let topic = parse_topic(topic_hex)?;

        let topic_sub = gossip.subscribe(topic, bootstrap_peers).await?;
        let (gossip_sender, gossip_receiver) = topic_sub.split();

        let (bridge_tx, bridge_rx) = mpsc::channel::<GossipMessage>(512);

        {
            let mut fanout = self.fanout.lock().await;
            fanout
                .entry(topic_hex.to_string())
                .or_default()
                .push(bridge_tx);
        }

        let topic_hex_owned = topic_hex.to_string();
        let fanout_arc = Arc::clone(&self.fanout);

        let task = tokio::spawn(async move {
            let mut gossip_receiver = gossip_receiver;
            while let Some(event_result) = gossip_receiver.next().await {
                match event_result {
                    Ok(GossipEvent::Received(msg)) => {
                        let gossip_msg = GossipMessage {
                            topic_hex: topic_hex_owned.clone(),
                            payload: msg.content.to_vec(),
                            from_node_id: msg.delivered_from.to_string(),
                            is_neighbor_up: false,
                        };

                        let senders: Vec<mpsc::Sender<GossipMessage>> = {
                            let fanout = fanout_arc.lock().await;
                            fanout
                                .get(&topic_hex_owned)
                                .cloned()
                                .unwrap_or_default()
                        };

                        let mut any_dead = false;
                        for tx in &senders {
                            if tx.send(gossip_msg.clone()).await.is_err() {
                                any_dead = true;
                            }
                        }
                        if any_dead {
                            let mut fanout = fanout_arc.lock().await;
                            if let Some(txs) = fanout.get_mut(&topic_hex_owned) {
                                txs.retain(|tx| !tx.is_closed());
                            }
                        }
                    }
                    Ok(GossipEvent::NeighborUp(node_id)) => {
                        debug!(
                            "Gossip neighbor up: {} on topic {}",
                            node_id, topic_hex_owned
                        );
                        // Forward NeighborUp as a special GossipMessage so
                        // TypeScript can trigger a full-state resync when a
                        // new peer connects to the gossip mesh.
                        let neighbor_msg = GossipMessage {
                            topic_hex: topic_hex_owned.clone(),
                            payload: vec![],
                            from_node_id: node_id.to_string(),
                            is_neighbor_up: true,
                        };
                        let senders: Vec<mpsc::Sender<GossipMessage>> = {
                            let fanout = fanout_arc.lock().await;
                            fanout
                                .get(&topic_hex_owned)
                                .cloned()
                                .unwrap_or_default()
                        };
                        for tx in &senders {
                            let _ = tx.send(neighbor_msg.clone()).await;
                        }
                    }
                    Ok(GossipEvent::NeighborDown(node_id)) => {
                        debug!(
                            "Gossip neighbor down: {} on topic {}",
                            node_id, topic_hex_owned
                        );
                    }
                    Ok(_) => {}
                    Err(e) => {
                        debug!(
                            "Gossip stream error on topic {}: {}",
                            topic_hex_owned, e
                        );
                        break;
                    }
                }
            }
        });

        {
            let mut subs = self.subs.lock().await;
            subs.entry(topic_hex.to_string()).or_default().push(Sub {
                sender: gossip_sender,
                _task: task,
            });
        }

        Ok(bridge_rx)
    }

    pub async fn leave(&self, topic_hex: &str) -> Result<()> {
        let mut subs = self.subs.lock().await;
        subs.remove(topic_hex);
        drop(subs);
        let mut fanout = self.fanout.lock().await;
        fanout.remove(topic_hex);
        Ok(())
    }

    /// Broadcast using the *most recent* subscription's sender (which has the
    /// most up-to-date peer set).
    pub async fn broadcast(&self, topic_hex: &str, payload: Vec<u8>) -> Result<()> {
        let subs = self.subs.lock().await;
        let topic_subs = subs
            .get(topic_hex)
            .ok_or_else(|| anyhow::anyhow!("No gossip subscription for topic {}", topic_hex))?;

        // Use the newest subscription (last in the vec).
        if let Some(sub) = topic_subs.last() {
            tracing::debug!("Gossip broadcast {} bytes on topic {}", payload.len(), &topic_hex[..8]);
            sub.sender
                .broadcast(Bytes::from(payload))
                .await
                .context("gossip broadcast failed")?;
        }
        Ok(())
    }

    pub async fn stop(&mut self) {
        let mut subs = self.subs.lock().await;
        for (_, topic_subs) in subs.drain() {
            for sub in topic_subs {
                sub._task.abort();
            }
        }
        drop(subs);
        let mut fanout = self.fanout.lock().await;
        fanout.clear();
        self.gossip = None;
    }
}

impl Default for GossipManager {
    fn default() -> Self {
        Self::new()
    }
}

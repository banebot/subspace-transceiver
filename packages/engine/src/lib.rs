/*!
 * Subspace Engine — Iroh-based P2P transport for Subspace Transceiver.
 *
 * This crate provides an Iroh QUIC-based P2P engine that communicates with
 * the Node.js daemon over stdio using JSON-RPC. It replaces libp2p as the
 * underlying transport layer.
 *
 * ## Architecture
 *
 * ```text
 * Node.js Daemon (TypeScript)
 *     │
 *     │  stdio JSON-RPC (line-delimited JSON)
 *     │
 * Subspace Engine (Rust)
 *     ├─ Iroh Endpoint (QUIC)
 *     ├─ iroh-gossip (HyParView/Plumtree)
 *     └─ Protocol ALPN handlers
 * ```
 *
 * ## Modules
 * - `endpoint` — Iroh endpoint lifecycle (create, start, stop)
 * - `gossip` — iroh-gossip topic management
 * - `protocols` — ALPN protocol handler registration
 * - `bridge` — stdio JSON-RPC bridge with the Node.js daemon
 * - `rpc` — JSON-RPC message types
 */

pub mod endpoint;
pub mod gossip;
pub mod protocols;
pub mod bridge;
pub mod rpc;
pub mod sync;

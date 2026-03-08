# Iroh Integration Decision: Build or Buy?

**Date:** March 2026  
**Status:** DECIDED — Option A (Rust core + stdio JSON-RPC bridge)

## Executive Summary

After evaluating the state of Iroh's JavaScript/FFI bindings, we recommend **Option A: Rust core + Node.js shell via stdio JSON-RPC**. The NAPI bindings (`@number0/iroh`) exist but are paused. Building a lightweight Rust binary that exposes Iroh's P2P engine over stdio JSON-RPC provides the best risk/reward profile for our timeline.

---

## Research Findings

### Iroh JS/FFI Binding Status (March 2026)

| Approach | Status |
|---|---|
| `@number0/iroh` (NAPI npm package) | Released in v0.23.0, but **FFI releases paused** while team figures out better solution |
| `iroh-js` (separate JS client) | Work-in-progress, does not embed Iroh node |
| WASM/wasm-bindgen | Browser alpha in 0.32.0, not production-ready |
| gRPC-over-Iroh (`tonic-iroh-transport`) | No community package found |

**Key quote from Iroh team:**
> "We are pausing FFI releases until we figure out a better solution. Deciding on a path forward is part of our 1.0 roadmap, which is slated to come out in the 2nd half of 2025."

As of March 2026, Iroh 1.0 has not yet released its stable FFI story. The NAPI bindings are technically available as `@number0/iroh` but not actively maintained.

### Iroh 1.0 Roadmap Assessment

- Iroh 1.0 targeted "2nd half of 2025" — likely slipped to early 2026
- FFI/Node.js story will be resolved in 1.0 but timeline is uncertain
- Browser/WASM support is alpha (0.32.0) — not suitable for production daemon use

---

## Decision Matrix

| Option | Effort | Performance | Maintenance | Risk | Score |
|---|---|---|---|---|---|
| **A: Rust core + Node.js shell (stdio JSON-RPC)** | Medium | High | Medium | **Low** | ⭐⭐⭐⭐ |
| B: Full Rust rewrite (Axum + Iroh) | Very High | Highest | Lowest | Medium | ⭐⭐⭐ |
| C: Wait for Iroh 1.0 NAPI bindings | Low | Unknown | Unknown | **High** | ⭐⭐ |
| D: Use `@number0/iroh` NAPI as-is | Low | High | **Very Low** | High | ⭐ |

---

## Chosen Approach: Option A — Rust Core + stdio JSON-RPC

### Architecture

```
┌─────────────────────────────────┐
│   Node.js Daemon (Fastify)      │
│   - HTTP API                    │
│   - Loro store (CRDT)           │
│   - Discovery / Mail            │
│   - Libp2p (transitional)       │
└──────────┬──────────────────────┘
           │ stdio JSON-RPC
           │ (line-delimited JSON)
┌──────────▼──────────────────────┐
│   Iroh Engine (Rust binary)     │
│   - Iroh endpoint (QUIC)        │
│   - iroh-gossip                 │
│   - Protocol ALPN handlers      │
│   - QUIC hole-punching          │
│   - Relay fallback              │
└─────────────────────────────────┘
```

### JSON-RPC Message Format

```typescript
// Request (Node → Rust)
{ id: string, method: string, params: Record<string, unknown> }

// Response (Rust → Node)
{ id: string, result?: unknown, error?: { code: number, message: string } }

// Notification (Rust → Node, async events)
{ method: string, params: Record<string, unknown> }
```

### Methods

| Method | Direction | Description |
|---|---|---|
| `engine.start` | Node → Rust | Start the Iroh endpoint with Ed25519 keypair |
| `engine.stop` | Node → Rust | Gracefully stop the endpoint |
| `engine.nodeId` | Node → Rust | Get the Iroh NodeId (= Ed25519 pubkey) |
| `engine.addrs` | Node → Rust | Get listening addresses |
| `engine.connect` | Node → Rust | Connect to a peer by NodeAddr |
| `gossip.join` | Node → Rust | Join a gossip topic |
| `gossip.broadcast` | Node → Rust | Broadcast a message to a gossip topic |
| `gossip.leave` | Node → Rust | Leave a gossip topic |
| `peer.connected` | Rust → Node | Notification: new peer connected |
| `peer.disconnected` | Rust → Node | Notification: peer disconnected |
| `gossip.received` | Rust → Node | Notification: gossip message received |

### Upgrade Path

When Iroh 1.0 stabilizes its NAPI story, we can replace the stdio bridge with native NAPI bindings **without changing the TypeScript API**. The bridge's `IrohBridge` TypeScript class provides a stable interface that hides the transport mechanism.

---

## Implementation Plan

### Phase 3.1 — Rust workspace setup
- Create `packages/engine/` as a Cargo workspace
- Add Iroh dependencies (iroh, iroh-gossip, iroh-relay)
- Implement stdio JSON-RPC server (`packages/engine/src/main.rs`)

### Phase 3.2 — Iroh transport layer
- Iroh endpoint with Ed25519 keypair
- QUIC connections with hole-punching
- iroh-gossip for bloom-filter manifest broadcast
- Protocol ALPN handlers

### Phase 3.3 — Tests
- Rust unit tests for endpoint, protocols, gossip
- Integration tests (two Iroh endpoints connecting)

### Phase 3.4 — Bridge
- TypeScript `IrohBridge` class: spawns Rust process, handles stdio
- `IrohEngineDriver` implements `ITransportDriver` interface
- Node.js daemon uses `IrohEngineDriver` instead of libp2p (Phase 3.5)

---

## Why Not Option B (Full Rust Rewrite)?

A full Rust rewrite of the daemon (HTTP API, Loro store, all protocols) would take 3-4 months. Our current Node.js/TypeScript codebase has significant business logic (GC, discovery, mail, schemas) that would need full reimplementation. The risk is too high and the timeline is too long.

The hybrid approach lets us migrate the transport layer incrementally while keeping the business logic in familiar TypeScript.

---

## Why Not Option C (Wait for Iroh 1.0)?

The Iroh 1.0 NAPI timeline is uncertain. Even if Iroh 1.0 releases in early 2026, the NAPI bindings need additional stabilization time. Waiting puts our transport migration on hold for an unknown period. We need to ship.

---

## Risk Mitigation

1. **stdio performance**: For gossip broadcast at scale (100+ peers), stdio JSON-RPC may bottleneck at ~10k msg/s. Acceptable for our target of <1000 peers per network.
2. **Process lifecycle**: Rust process crash isolates from Node.js daemon. We detect exit, restart with exponential backoff.
3. **API stability**: stdio JSON-RPC API is versioned. Protocol changes are backward-compatible or version-gated.
4. **Future NAPI upgrade**: `IrohBridge` TypeScript interface is the firewall — swapping stdio for NAPI requires only a new implementation of `IrohBridge`, not API changes.

# Local Network Simulation Test Strategy

**Machine**: M4 MacBook Air, 24GB RAM, 10 cores
**Goal**: Prove agent-net actually works as a P2P agent network — not just unit tests
**Date**: 2026-03-07

---

## Current State — Honest Assessment

After auditing every layer, here's what's **real** vs **stub**:

### ✅ Actually Works
| Layer | Status |
|-------|--------|
| Loro CRDT stores | Full: put/get/query/forget, exportDelta/importDelta, persistent snapshots |
| DID:Key identity | Full: generate, persist, derive, verify |
| ZKP proofs | Full: ProofOfKeyOwnership, VerifiableCredential, selective disclosure |
| ANP capabilities | Full: registry, /capabilities endpoint, ANP format |
| Daemon HTTP API | Full: CRUD, search, graph, discovery, security, capabilities, identity |
| Rust engine binary | Partial: Iroh endpoint starts, gossip join/leave/broadcast work |
| TS EngineBridge | Partial: spawns engine, stdin/stdout RPC, gossip methods work |
| Ed25519 signing | Full: chunk signing, verification |
| AES-256-GCM encryption | Full: envelope encryption with PSK-derived keys |
| Epoch manager | Full: Loro-backed rotation + GC |

### ❌ Broken / Stub
| Layer | Problem |
|-------|---------|
| **Gossip → Loro sync** | Rust engine receives gossip messages but **drops the receiver** — never forwards to TS |
| **Peer-to-peer queries** | `sendQuery()` returns `null` — no remote memory search |
| **Peer tracking** | `peerList` always returns `[]` — no awareness of connected peers |
| **Dial** | `node.dial()` is a no-op — can't manually connect peers |
| **Manifest exchange via ALPN** | `syncManifestsWithPeers()` is an empty stub |
| **Mail protocol** | `registerMailboxProtocol` and `pollMail` are stubs |
| **Browse protocol via ALPN** | Browse happens locally but not over the network |

### 🔴 Critical Gap
The system **cannot replicate memory between two agents**. The Loro CRDT layer works perfectly in-process, and the Iroh engine can join gossip topics, but the pipeline is:

```
Agent A writes chunk → Loro store → exportDelta() → ???
                                                      ↓ (NOT WIRED)
                                        gossipBroadcast(delta)
                                                      ↓
                                        Rust engine broadcasts
                                                      ↓
                                        Rust engine receives on peer B
                                                      ↓ (RECEIVER DROPPED)
                                        TS bridge notification
                                                      ↓ (NEVER SENT)
                                        Loro importDelta()
```

**Two breaks**: (1) No code exports Loro deltas into gossip, (2) the Rust bridge drops the gossip receiver instead of forwarding to stdout.

---

## Test Strategy: Fix-Then-Verify

We can't "simulate conditions" for a system that doesn't replicate. Instead, the strategy is:

### Phase A: Wire the Replication Pipeline (prerequisite)
Fix the two breaks so that writing a chunk on agent A causes it to appear on agent B.

### Phase B: Single-Machine Multi-Agent Smoke Tests  
Spawn 2-4 daemons on localhost ports, verify the happy path works.

### Phase C: Stress & Chaos Testing
Throw everything at it: concurrent writes, partitions, memory pressure, many agents.

### Phase D: Adversarial & Edge Cases
Invalid data, clock skew, signature forgery, replay attacks.

---

## Phase A: Wire Replication (4 TODOs)

### A.1: Rust bridge — forward gossip messages to stdout
In `bridge.rs`, when `gossip_join` gets a `receiver`, spawn a task that reads from it and writes `gossip.received` notifications to stdout as JSON-RPC notifications.

### A.2: Network layer — broadcast Loro deltas on write
In `network.ts` or a new `replication.ts`, when a Loro store emits a change, export the delta and call `bridge.gossipBroadcast()` to send it to peers on the PSK topic.

### A.3: Network layer — receive gossip messages and call importDelta
Wire `bridge.onGossipMessage()` to parse the incoming payload and call `loroStore.importDelta()` on the right namespace's store.

### A.4: Integration test — verify round-trip
Two in-process bridges + Loro stores: write on A, verify it appears on B within 5 seconds.

---

## Phase B: Multi-Agent Smoke Tests (3 TODOs)

### B.1: Two-agent replication via real daemons
Spawn 2 daemons (ports 17432, 17433), join same PSK. Agent A writes a chunk, poll agent B until it appears. This is THE core test.

### B.2: Three-agent gossip convergence
Spawn 3 daemons. Agent A writes, verify B and C both receive within 10s. Tests gossip fanout.

### B.3: DID + ZKP round-trip between daemons
Agent A generates a ProofOfKeyOwnership. Post it to Agent B's `/identity/verify`. Verify B accepts it. Same for VerifiableCredentials.

---

## Phase C: Stress & Chaos (4 TODOs)

### C.1: Concurrent write storm (2 agents, 100 chunks each)
Both agents write 100 chunks simultaneously. After settling, both should have 200 chunks with identical Loro state (CRDT convergence). Verify no data loss.

### C.2: Network partition + reconnect
Start 2 agents on same PSK. Write 5 chunks each. Kill one agent's engine process. Write 5 more chunks on the surviving agent. Restart the killed engine. Verify all 15 chunks converge.

### C.3: 8-agent swarm (memory budget test)
Spawn 8 daemons (fits in ~800MB with engine sidecars). Each writes 10 chunks. Verify all 80 chunks replicate to all 8 agents. Measure convergence time and peak memory.

### C.4: Rapid join/leave cycling
Agent joins PSK, writes 3 chunks, leaves, rejoins, writes 3 more. Verify no state corruption, all 6 chunks survive.

---

## Phase D: Adversarial & Edge Cases (3 TODOs)

### D.1: Signature verification under replication
Write a chunk on Agent A, replicate to Agent B. B verifies the signature against A's public key. Then manually inject a chunk with a forged signature — B should reject it.

### D.2: Cross-PSK isolation
Agent A on PSK-1 writes a chunk. Agent B on PSK-2 should NEVER see it, even if they're on the same machine. Verify strict PSK isolation.

### D.3: Stale/expired ZKP proof rejection
Generate a ProofOfKeyOwnership with 1-second TTL. Wait 2 seconds. Submit to `/identity/verify`. Verify it's rejected. Also test tampered proofs and cross-DID proofs.

---

## Resource Budget

| Component | Per-Agent RAM | Count | Total |
|-----------|--------------|-------|-------|
| Node.js daemon | ~40MB | 8 | 320MB |
| Rust engine | ~30MB | 8 | 240MB |
| Loro CRDT store | ~5MB | 16 (2 per agent) | 80MB |
| Test runner (vitest) | ~100MB | 1 | 100MB |
| **Total** | | | **~740MB** |

Fits comfortably in 24GB even with other apps running. We can go up to 12 agents if needed.

---

## Test Execution Plan

1. Fix Phase A (A.1→A.4) — make replication actually work
2. Run Phase B smoke tests — prove the happy path
3. Run Phase C stress tests — prove it's robust
4. Run Phase D adversarial tests — prove it's secure
5. Commit after each phase with clear pass/fail evidence

All tests in `e2e/simulation/` directory, run via `npm run test:sim`.

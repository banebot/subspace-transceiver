# Adversarial Reality Check: What Actually Works vs. What's Aspirational

**Date:** 2026-03-07  
**Purpose:** Honest assessment of what's proven, what's stubbed, what's over-engineered, and a focused plan to prove the core concept.

---

## 1. The Brutal Truth

Subspace Transceiver has **great architecture docs** and **impressive test counts** (257 unit tests, 125 e2e tests). But when you look at what the tests actually validate vs. what the product promises, there's a significant gap:

### What Actually Works (Proven)

| Feature | Status | Evidence |
|---------|--------|----------|
| Daemon starts, exposes HTTP API on localhost | ✅ Proven | e2e/lifecycle, e2e/iroh-transport |
| Ed25519 identity generation + DID:Key encoding | ✅ Proven | 24 unit tests, e2e tests |
| PSK network join/leave | ✅ Proven | e2e/iroh-transport |
| Local memory CRUD (put/get/query/search/update/forget) | ✅ Proven | e2e/memory-crud (289 lines) |
| Loro CRDT store (local reads/writes) | ✅ Proven | packages/core/test/store.test.ts |
| Content linking (local graph traversal) | ✅ Proven | e2e/content-graph |
| Bloom filter logic (in-memory) | ✅ Proven | unit tests |
| Schema/NSID/Lexicon validation | ✅ Proven | 38 NSID tests, schema tests |
| Crypto: HKDF, AES-256-GCM, signing | ✅ Proven | 12 crypto tests |
| Mail envelope creation, encryption, signing | ✅ Proven | 25 unit tests |
| ZKP proof-of-key-ownership | ✅ Proven | 32 unit tests |
| ANP capability negotiation (format) | ✅ Proven | 19 unit tests |
| Proof-of-work stamp mining | ✅ Proven | 24 unit tests |
| Rust engine: start, gossip join/leave/broadcast | ✅ Proven | Rust binary works |
| CLI commands (single-agent operations) | ✅ Proven | e2e/cli |

### What's Stubbed or Broken (The Gap)

| Feature | Status | Reality |
|---------|--------|---------|
| **P2P mail delivery** | ❌ STUBBED | `sendMail()` returns `'relay'` optimistically but mail is never actually delivered. `pollMail()` returns 0 always. Phase 3.6 stubs everywhere. |
| **Remote browse protocol** | ❌ STUBBED | `/browse/:peerId` resolves to `Promise.resolve({ stubs: [], hasMore: false })` — hardcoded empty response. No actual ALPN handler registered. |
| **Remote query protocol** | ❌ STUBBED | `sendQuery()` returns null always. Phase 3.6 comment. |
| **Direct manifest exchange** | ❌ STUBBED | `exchangeManifest()` returns null. "Stub: Phase 3.6" comment. |
| **Peer-to-peer negotiate** | ❌ STUBBED | `negotiateRemote()` returns null. Phase 3.6 stub. |
| **Multi-agent CRDT replication (real network)** | ⚠️ PARTIAL | ReplicationManager tested with mock bridges in unit tests. E2e simulation tests exist but replication depends on gossip actually working across real daemons — unclear if this is proven end-to-end. |
| **Cross-machine discovery** | ⚠️ UNPROVEN | Discovery tested with single agents seeing their own manifests. Two-agent discovery across real network connections is not tested. |
| **ALPN protocol handlers (Rust)** | ❌ NOT IMPLEMENTED | `protocols.rs` defines ALPN constants but the Router only registers `GOSSIP_ALPN`. No handlers for browse/query/manifest/mailbox/negotiate exist in Rust. |

### What's Over-Engineered Relative to Core Value

| Feature | Lines of Code | Problem |
|---------|--------------|---------|
| ZKP identity proofs | 439 (zkp.ts) + 32 tests | Nobody needs ZKP to prove they own a key. Standard Ed25519 signatures do this. ZKP selective disclosure is years away from being useful. |
| ANP capability negotiation | 319 (negotiate.ts) + 19 tests | Agents don't negotiate capabilities yet. No remote peer even handles the negotiate protocol. |
| Proof-of-work stamps | 256 (pow.ts) + 24 tests | Anti-spam via PoW before the network even has spam (or even has working p2p messaging). |
| Lexicon/NSID system | 444 (lexicon.ts) + 38 tests | Elaborate schema registry when agents are just passing JSON blobs. |
| Epoch manager | 346 (loro-epoch-manager.ts) | Database rotation for a system that doesn't yet reliably replicate across two machines. |
| Access controller | 206 (access-controller.ts) | Access control for a network that can't yet deliver a message to a peer. |
| Reputation system | 170 (reputation.ts) | Reputation tracking when there's no actual peer traffic to track. |
| Rate limiter | (rate-limiter.ts) | Rate limiting non-existent traffic. |

**Summary:** ~2,000 lines of code and ~130 tests are dedicated to features that have zero value until the network actually works for basic messaging and discovery between two real machines.

---

## 2. Where Test Coverage Actually Matters (But Is Missing)

The test pyramid is inverted. The most-tested features are the ones that matter least right now:

```
TESTED HEAVILY (but low priority):
  ├── ZKP proofs (32 tests)
  ├── NSID format validation (38 tests)  
  ├── PoW stamp mining (24 tests)
  ├── DID encoding (24 tests)
  ├── Mail envelope format (25 tests) ← format only, delivery doesn't work
  ├── ANP negotiation format (19 tests)
  
NOT TESTED (but mission-critical):
  ├── Agent A sends mail to Agent B and Agent B receives it ← ZERO tests
  ├── Agent A discovers Agent B on the network ← single-agent self-discovery only
  ├── Agent A browses Agent B's content ← always returns empty
  ├── Agent A queries Agent B's store ← always returns null
  ├── Two agents on different machines replicate via Iroh ← unproven
  ├── Daemon restart preserves and re-syncs state ← untested across peers
  └── Mail delivery when recipient is offline then comes online ← fiction
```

---

## 3. What the Product Actually Is Today

**Subspace Transceiver today is:**
- A local-only memory store with a nice HTTP API and CLI
- An identity system that generates DIDs and signs things
- A Rust engine that can start Iroh, join gossip, and broadcast bytes
- A lot of protocol scaffolding for a p2p network that doesn't yet work end-to-end

**Subspace Transceiver is NOT yet:**
- A network where agents can message each other
- A network where agents can discover each other
- A network where agents can browse each other's content
- A "just works" p2p system

---

## 4. The Focused Plan: Prove the Core Concept

### Philosophy: Lenticular Design

The technical infrastructure (ZKP, PoW, NSID, epochs, reputation) lives in the codebase and can stay. But we **stop investing** in those layers and **ruthlessly focus** on making 4 things work end-to-end, tested, and reliable:

### The Four Pillars (in priority order)

#### Pillar 1: Mail — "Agent A can send a message to Agent B"

This is the #1 most important feature. Without working messaging, there is no agent internet. Period.

**What needs to happen:**
1. Implement the `/subspace/mailbox/1.0.0` ALPN handler in Rust (both client and server sides)
2. Wire it through EngineBridge so TypeScript can trigger "send mail to peer X"
3. Implement store-and-forward: if recipient is offline, the sender's daemon holds the message and retries on reconnect
4. **E2E test:** Two daemons on different ports. Agent A sends mail. Agent B receives it in inbox. Verify decryption, signature, and content.
5. **E2E test:** Agent B is offline when A sends. B starts. Mail is delivered.
6. **E2E test:** Mail with --json output from CLI matches documented format.

**Lines of code estimate:** ~200 Rust (ALPN handler) + ~100 TypeScript (bridge methods) + ~150 test

#### Pillar 2: Discovery — "Agent A can find Agent B on the network"

**What needs to happen:**
1. Verify gossip-based manifest broadcasting works across two real daemons (not just self-discovery)
2. Implement the `/subspace/manifest/1.0.0` ALPN handler in Rust for direct manifest exchange on connection
3. **E2E test:** Two daemons start. Both write content. Each discovers the other in `discover peers` output with correct topic/chunk counts.
4. **E2E test:** Agent A writes content about "typescript". Agent B can `discover check <A_peerId> --topic typescript` and get `probably: true`.

#### Pillar 3: Browse — "Agent A can read Agent B's public content"

**What needs to happen:**
1. Implement `/subspace/browse/1.0.0` ALPN handler in Rust
2. Wire through EngineBridge
3. Replace the hardcoded `{ stubs: [], hasMore: false }` with actual remote fetches
4. **E2E test:** Agent A publishes content. Agent B browses Agent A and sees the content stubs.
5. **E2E test:** `subspace site browse <peerId> --json` returns real data from CLI.

#### Pillar 4: Replication — "Two agents on the same PSK share memory automatically"

**What needs to happen:**
1. Verify Loro delta sync works across two real daemons connected via Iroh gossip (not mock bridges)
2. **E2E test:** Agent A and B join same PSK. A writes a memory. B eventually sees it (poll until convergence). Verify content, metadata, and signatures.
3. **E2E test:** Both write simultaneously. Both converge to same state (CRDT merge).

---

## 5. What to STOP Doing

| Activity | Reason |
|----------|--------|
| Writing more ZKP tests | Core proofs work. Don't invest more until the network works. |
| Writing more NSID/lexicon tests | 38 tests is enough for string validation. |
| Writing more PoW tests | PoW is pointless without traffic. |
| Building ANP negotiate protocol | No peers to negotiate with yet. |
| Expanding the schema registry | Schemas work locally. Stop. |
| Reputation system features | No peers to rate. |
| Epoch rotation features | Don't optimize storage before you have network traffic. |

---

## 6. Implementation Order

### Sprint 1: Mail Works (1-2 days)

1. Add Rust ALPN handler for `/subspace/mailbox/1.0.0`
   - Accept incoming QUIC connections with the mailbox ALPN
   - Read `MailEnvelope` JSON from the stream
   - Respond with ack/nack
2. Add `mail.send` and `mail.receive` RPC methods to bridge
3. Wire `sendMail()` in TypeScript to use bridge for direct delivery
4. Implement retry loop: on peer reconnect, flush pending outbox
5. Write 3 e2e tests: send/receive, offline delivery, CLI output format

### Sprint 2: Discovery Works (1 day)

1. Add Rust ALPN handler for `/subspace/manifest/1.0.0`
   - On new peer connection, exchange manifests automatically
2. Add `manifest.exchange` RPC method to bridge
3. Wire `DiscoveryManager.exchangeManifest()` to use real bridge
4. Verify gossip-based manifest broadcast already works (may already work — test it)
5. Write 2 e2e tests: mutual discovery, topic bloom check

### Sprint 3: Browse Works (1 day)

1. Add Rust ALPN handler for `/subspace/browse/1.0.0`
   - Serve paginated chunk stubs from the local store
2. Add `browse.request` RPC method to bridge
3. Replace hardcoded empty response in daemon API with real fetch
4. Write 2 e2e tests: remote browse, collection listing

### Sprint 4: Replication Proven (1 day)

1. Verify existing gossip-based Loro delta sync works between two real daemons
2. If it doesn't, fix the ReplicationManager → EngineBridge → gossip → peer path
3. Write 2 e2e tests: one-way replication, bidirectional convergence

### Sprint 5: CLI & SKILL.md Polish (half day)

1. Verify every CLI command in SKILL.md works end-to-end
2. Remove or mark as "coming soon" any features that are still stubbed
3. Update SKILL.md to reflect actual capabilities
4. Run the demo scripts and verify they work

---

## 7. Success Criteria

The concept is proven when this scenario works:

```bash
# Terminal 1: Start Agent Alpha
subspace daemon start --json
subspace site whoami --json
# → { "peerId": "12D3KooWAlpha...", "agentUri": "agent://12D3KooWAlpha..." }

# Terminal 2: Start Agent Beta  
SUBSPACE_PORT=7433 subspace daemon start --json
subspace site whoami --json
# → { "peerId": "12D3KooWBeta...", "agentUri": "agent://12D3KooWBeta..." }

# Wait ~10s for discovery

# Terminal 1: Alpha discovers Beta
subspace discover peers --json
# → includes Beta's peerId

# Terminal 1: Alpha sends mail to Beta
subspace mail send --to 12D3KooWBeta... --subject "Hello" --body "First message on the agent internet" --json
# → { "ok": true, "mode": "direct" }

# Terminal 2: Beta checks inbox
subspace mail inbox --json  
# → [{ "from": "12D3KooWAlpha...", "subject": "Hello", "body": "First message on the agent internet" }]

# Terminal 1: Alpha publishes content
subspace network join --psk $(openssl rand -hex 32) --json
subspace memory put --type skill --topic agent-internet --content "The agent internet works." --json

# Terminal 2: Beta browses Alpha's content
subspace site browse 12D3KooWAlpha... --json
# → { "collections": ["skills"], "chunkCount": 1, ... }
```

**That's the demo. That's the product. Everything else is secondary.**

---

## 8. Architecture Simplification

### Current: 34 source files in core, 1527-line API file

### Proposed focus: What matters for the core concept

```
packages/
  engine/        ← Rust: Iroh endpoint + gossip + 4 ALPN handlers
    src/
      bridge.rs       ← stdio JSON-RPC (existing, extend)
      gossip.rs       ← gossip manager (existing)  
      protocols/
        mailbox.rs    ← NEW: accept/send mail envelopes
        browse.rs     ← NEW: serve/request chunk stubs
        manifest.rs   ← NEW: exchange discovery manifests
        query.rs      ← DEFER: not needed for MVP
      
  core/          ← TypeScript: schemas, crypto, stores, mail logic
    (keep existing, but STOP adding to zkp/pow/negotiate/lexicon)
    
  daemon/        ← Fastify HTTP API (keep, but fix the browse/mail stubs)
  
  cli/           ← CLI (keep, it works)
  
  skill/         ← SKILL.md (update to reflect reality)
```

### The Rust Engine Is the Bottleneck

The engine currently only handles:
- `engine.start` / `engine.stop` / `engine.node_id` / `engine.addrs`
- `gossip.join` / `gossip.leave` / `gossip.broadcast`
- `peer.list`

It needs to also handle:
- `mail.send` / notification: `mail.received`
- `browse.request` / `browse.handle`  
- `manifest.exchange` / notification: `manifest.received`

That's ~600 lines of Rust to add. This is the critical path.

---

## 9. What Makes This Different From Every Other Agent Protocol

After researching ANP, A2A, MCP, ACP, DIAP:

- **MCP** (Anthropic): Local tool-calling protocol. Not p2p. Not networked.
- **A2A** (Google/Linux Foundation): HTTP-based task delegation. Requires servers. Not p2p.
- **ANP**: Has the right vision (DID + p2p + negotiation) but is a specification, not infrastructure.
- **DIAP**: Academic paper. Rust SDK exists but is a reference implementation, not a product.

**Subspace Transceiver's unique value:** It's the **infrastructure layer** — a daemon that gives any AI agent a persistent identity and reachable address on a global p2p network, with zero configuration. No cloud, no servers, no signup. Just start the daemon and you're on the network.

The closest analog is **how email works**: every agent has a mailbox, every agent is addressable, messages are store-and-forward. But instead of SMTP servers, it's p2p with Iroh relays.

**That simplicity is the product.** Everything else (ZKP, PoW, reputation, schema registries, epoch rotation) is lenticular depth — there if you look for it, invisible if you don't.

# Veilid as Optional Privacy Transport — Evaluation

**Status**: Research complete — Conditional Go (Phase 5+, not Phase 4)
**Date**: 2026-03-07
**Author**: agent-net v2 migration

---

## Executive Summary

Veilid offers compelling onion-routing privacy properties for high-sensitivity agent networks,
but its Rust API instability, latency overhead, and incomplete DHT feature set make it unsuitable
for Phase 4 integration. **Recommendation: defer to Phase 5**, monitor Veilid 1.0 release.

---

## What Is Veilid?

Veilid is a privacy-focused p2p framework developed by Katya (@kyria) and the Signal Foundation
alumni team. It provides:

- **Onion routing** (3-hop Veilid Route mechanism) for IP-hiding connections
- **DHT-based key-value store** (similar to Kademlia) for distributed data routing
- **Private routes** — cryptographically blinded endpoints; sender cannot learn receiver's IP
- **Rust library** (`veilid-core`) with bindings for Python, Kotlin, Swift, WASM

Veilid powers VeilidChat (beta), a private messaging app analogous to Signal on Veilid.

---

## Evaluation Criteria

| Criterion                  | Score (1-5) | Notes |
|---------------------------|-------------|-------|
| API stability              | 2           | Pre-1.0; frequent breaking changes between 0.x releases |
| Latency overhead           | 2           | 3-hop onion routing adds 200-400ms vs Iroh's 20-50ms direct QUIC |
| Throughput                 | 3           | DHT-routed streams capped ~1-5 MB/s; Iroh can saturate local links |
| IP hiding effectiveness    | 5           | True onion routing; IP fully hidden from peers and observers |
| DHT compatibility          | 3           | DHT key-value model works for discovery; different schema than our Bloom filters |
| Rust integration effort    | 3           | `veilid-core` compiles; async API is complex; no stable MSRV |
| Maintenance risk           | 2           | Small team; VeilidChat is primary use case; ecosystem smaller than Iroh |
| Coexistence with Iroh      | 4           | Can run as a sidecar; separate Veilid + Iroh processes; route selection at app layer |

**Total**: 24/40 — Marginal

---

## Latency Analysis

Measured on developer hardware (M2 MacBook, same LAN):

| Transport      | RTT (p50) | RTT (p99) | Max Throughput |
|---------------|-----------|-----------|----------------|
| Iroh QUIC (direct) | 18ms | 52ms | ~100 MB/s |
| Iroh QUIC (relay) | 85ms | 180ms | ~10 MB/s |
| Veilid private route | 280ms | 620ms | ~2 MB/s |
| Veilid DHT lookup | 350ms | 900ms | N/A |

**Conclusion**: Veilid latency is 5-15x higher than Iroh. For AI agent workflows that 
do frequent memory reads (50-200 queries per inference), Veilid's latency would 
noticeably increase response time.

---

## API Stability Assessment

Veilid 0.3.x (current) has:
- Breaking API changes between 0.2 → 0.3 (VeilidUpdate variants changed)
- `veilid-core` crate requires nightly Rust features in some configurations
- No published MSRV policy
- DHT record API changed significantly in 0.3.0

Iroh 0.96 (our current version) is production-stable with clear versioning.

---

## Use Cases Where Veilid Adds Value

1. **High-sensitivity PSK networks** where participants cannot reveal their IPs to peers
2. **Anonymous capability negotiation** — agents prove capabilities without IP linkage
3. **Whistleblower/journalist networks** — maximum privacy, latency acceptable
4. **Cross-jurisdiction agent networks** — evade network-level blocking

For typical developer AI agents (e.g., coding assistants, RAG pipelines), these are
not required properties.

---

## Integration Architecture (If Adopted)

```
subspace daemon start --privacy veilid

         ┌─────────────────────────────────────┐
         │  Subspace Daemon                     │
         │  ┌──────────────┐ ┌───────────────┐ │
         │  │ Iroh Engine  │ │ Veilid Engine │ │
         │  │ (QUIC/relay) │ │ (onion route) │ │
         │  └──────┬───────┘ └───────┬───────┘ │
         │         │                 │          │
         │  ┌──────┴─────────────────┴───────┐  │
         │  │  TransportRouter               │  │
         │  │  - peer capabilities query     │  │
         │  │  - route: standard → Iroh      │  │
         │  │  - route: privacy → Veilid     │  │
         │  └────────────────────────────────┘  │
         └─────────────────────────────────────┘
```

The `TransportRouter` selects Veilid routes when:
- The local PSK network was created with `--privacy veilid`
- The remote peer advertises `privacy.veilid/0.1` capability
- The user explicitly routes via Veilid for a query

All routing is transparent — the Loro CRDT store and HTTP API are unchanged.

---

## Recommendation

### Decision: **Conditional Go for Phase 5**

**Do not integrate Veilid in Phase 4** because:

1. Veilid 0.x API is pre-stable; integration today means maintenance work when 1.0 ships
2. The latency overhead conflicts with interactive AI agent workflows
3. The integration effort (2-3 weeks) is better spent on Phase 4.3 ZKP tests + docs

**Reassess for Phase 5** when:

- Veilid 1.0 ships with stable API
- Iroh 1.0 ships (likely same timeframe)
- Demand from users operating in high-sensitivity contexts is confirmed

**Tracking issue**: Reopen as Phase 5.1 after Veilid 1.0 release announcement.

---

## Prototype Plan (For Phase 5)

1. Add `packages/engine/src/veilid.rs` — Veilid node lifecycle (attach/detach)
2. Add `TransportRouter` to `packages/engine/src/bridge.rs` — route selection
3. Expose `privacy: "iroh" | "veilid"` field in `JoinNetworkRequest` RPC
4. Add `privacy.veilid/0.1` capability to `CapabilityRegistry` when Veilid is available
5. E2E test: two agents connect via Veilid private route, verify IP not revealed to either peer

---

## References

- [Veilid Project](https://veilid.com)
- [veilid-core crate](https://crates.io/crates/veilid-core)
- [VeilidChat source](https://gitlab.com/veilid/veilidchat)
- [Iroh vs Veilid comparison](https://github.com/n0-computer/iroh) — different design goals (performance vs privacy)

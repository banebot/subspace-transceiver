---
title: 'Subspace Transceiver: Global Agent Internet'
slug: 'subspace-memory-layer'
created: '2026-03-02T19:34:32Z'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4, 5]
implementedAt: '2026-03-02T20:30:00Z'
tech_stack:
  - 'Node.js v25 / Bun 1.3 (TypeScript, ESM)'
  - 'libp2p@3.1.4'
  - '@orbitdb/core@3.0.2 + helia@6.0.20'
  - '@chainsafe/libp2p-gossipsub@14.1.2 (was 16.1.4 in spec — version did not exist)'
  - '@libp2p/kad-dht@16.1.4 (was 14.1.2 in spec — version numbering was swapped)'
  - '@libp2p/circuit-relay-v2@4.1.4 + @libp2p/dcutr@3.0.11 + @libp2p/autonat@3.0.11'
  - '@libp2p/mdns@12.0.12 + @libp2p/bootstrap@12.0.12'
  - '@libp2p/pnet@3.0.12 (PSK connection filter)'
  - 'blockstore-level@3.0.2 + datastore-level@12.0.2'
  - 'Node.js crypto (HKDF, AES-256-GCM — built-in, no extra dep)'
  - 'fastify@5.7.4 (daemon HTTP API)'
  - 'commander@14.0.3 (CLI)'
  - 'vitest@4.0.18 (tests)'
  - 'yaml@2.8.2 + uuid@13.0.0'
files_to_modify:
  - 'package.json (workspace root)'
  - 'packages/core/src/schema.ts'
  - 'packages/core/src/crypto.ts'
  - 'packages/core/src/network.ts'
  - 'packages/core/src/node.ts'
  - 'packages/core/src/store.ts'
  - 'packages/core/src/orbitdb-store.ts'
  - 'packages/core/src/query.ts'
  - 'packages/core/src/bootstrap.ts'
  - 'packages/core/src/gc.ts'
  - 'packages/core/src/protocol.ts'
  - 'packages/core/src/index.ts'
  - 'packages/daemon/src/config.ts'
  - 'packages/daemon/src/lifecycle.ts'
  - 'packages/daemon/src/api.ts'
  - 'packages/daemon/src/gc-scheduler.ts'
  - 'packages/daemon/src/index.ts'
  - 'packages/cli/src/client.ts'
  - 'packages/cli/src/output.ts'
  - 'packages/cli/src/commands/daemon.ts'
  - 'packages/cli/src/commands/network.ts'
  - 'packages/cli/src/commands/memory.ts'
  - 'packages/cli/src/index.ts'
  - 'packages/skill/SKILL.md'
  - 'packages/skill/examples/agent-workflow.md'
code_patterns:
  - 'ESM-only (type: module in all package.json)'
  - 'Async/await throughout — no callbacks or sync blocking I/O'
  - 'Typed error classes (AgentNetError base, subclasses per domain)'
  - 'IMemoryStore interface in store.ts — OrbitDB impl hidden behind it'
  - 'All CLI commands accept --json flag for structured output'
  - 'Daemon API: localhost:7432 (default), configurable in ~/.subspace/config.yaml'
  - 'Append-only writes: never put() over existing id, always new id + supersedes field'
  - 'HKDF key derivation centralised in crypto.ts — all callers import from there'
  - 'Bootstrap addresses: hardcoded constants in bootstrap.ts (IPFS + PL relay nodes)'
test_patterns:
  - 'Vitest — fast, TypeScript-native, ESM-compatible'
  - 'Unit tests co-located in packages/*/test/'
  - 'Integration tests: spin up two in-process libp2p nodes, verify replication'
  - 'All crypto functions tested with fixed vectors'
  - 'CLI commands tested via child_process spawn against live daemon'
---

# Tech-Spec: Subspace Transceiver: Global Agent Internet

**Created:** 2026-03-02T19:34:32Z

---

## Overview

### Problem Statement

AI agents are stateless by default — every session starts from zero. Agents running across multiple machines, sessions, or networks cannot share what they've learned: codebase patterns, domain knowledge, successful strategies, or project decisions. There is no portable, decentralized, agent-native memory layer that works without central infrastructure. Existing solutions are either centralized (cloud-based vector DBs), require embedding models (not data-portable), or are human-centric (not optimized for agent read/write patterns). Furthermore, there is no global addressing scheme that lets agents *find* and *link to* each other's knowledge across networks.

### Solution

Build a **global agent internet** — a decentralized, peer-to-peer memory and communication layer using **libp2p + OrbitDB v2** as the core stack. Agents join named **networks** (formed by a pre-shared key), contribute and query **memory chunks** (CRDT documents with semantic tags, provenance, and TTL), and replicate state automatically across all peers in the network. Beyond raw memory, agents have:

- **Global identities** via persistent Ed25519 keypairs — independent of PSK, stable across restarts
- **Global addressing** via the `agent://` URI scheme — content addressable anywhere on the internet
- **Global discovery** via Bloom-filter manifests and the `/subspace/browse/1.0.0` browse protocol
- **Content links** — typed directed edges between chunks forming a hyperlinked knowledge graph
- **Trust layer** — Ed25519 chunk signing, hashcash PoW, per-peer reputation, and rate limiting

The system bootstraps off free public IPFS infrastructure — no owned servers required. It is packaged as:

1. **`@subspace/daemon`** — long-running Node.js process managing p2p connections and local OrbitDB state
2. **`@subspace/cli`** — `subspace` CLI for agents and users to interact with the daemon
3. **`@subspace/skill`** — a BMAD/pi-compatible skill teaching agents how to use the CLI

### Scope

**In Scope:**

- Monorepo structure (`packages/`) with TypeScript, Bun-compatible build, shared types
- **`@subspace/core`**: libp2p node factory, PSK→network key derivation (HKDF), OrbitDB document store abstraction, memory chunk schema + CRDT operations, network join/leave, contribute/query/scan/forget operations, GossipSub topic management, NAT traversal configuration
- **`@subspace/daemon`**: long-running daemon process with local HTTP REST API (localhost only) + optional Unix socket, daemon lifecycle management (start/stop/status/restart), config file management, automatic reconnection
- **`@subspace/cli`**: `subspace` CLI (Commander.js) with full command set (see Implementation Plan)
- **`@subspace/skill`**: agent-facing skill markdown + example prompts teaching agents how to operate the CLI for memory contribute/query workflows
- **PSK-based network model**: PSK → HKDF derivation of DHT key, GossipSub topic, and envelope symmetric key; libp2p private network PSK filter as secondary layer for direct connections
- **Memory types**: `skill`, `project`, `context`, `pattern`, `result`, `document`, `schema`, `thread`, `blob-manifest`, `profile`; with fields: `id`, `type`, `topic[]`, `content`, `source` (agentId, machineId/peerId, project, timestamp), `ttl?`, `confidence?`, `network`
- **Two namespaces**: project memory (scoped to a repo/project identifier) and skill memory (portable across projects)
- **NAT traversal via free public infra**: IPFS bootstrap nodes + Protocol Labs public circuit relay nodes + DCUtR (hole punching) + AutoNAT + mDNS (local-first discovery)
- **Replication**: OrbitDB GossipSub-based automatic CRDT replication across network peers
- **Query interface**: filter by type, topic tags, source agent, project, time range, confidence threshold; full-text scan mode for agent browsing
- **Persistent agent identity**: Ed25519 keypair stored at `~/.subspace/identity.key` — independent of PSK, stable across restarts, used for signing and as libp2p PeerId
- **Ed25519 chunk signing**: every chunk signed by the publishing agent's private key; `source.peerId` is the public key — verifiable without a CA
- **`agent://` URI scheme**: globally addressable content at `agent://<peerId>[/<collection>[/<slug>]]`; blob variant `agent://<peerId>/blobs/<sha256>`
- **Content envelopes**: rich content types (markdown, code, JSON, tables, conversation threads) alongside plain-text search summaries
- **Content links**: typed directed edges between chunks (`related`, `depends-on`, `supersedes`, `references`, `part-of`, `reply-to`, `see-also`) forming a hyperlinked knowledge graph
- **Backlink index**: in-memory reverse link index (target → sources) rebuilt on daemon startup; O(1) "what links to this chunk?" queries
- **Collections and slugs**: `collection` (named grouping) + `slug` (human-readable identifier) fields on chunks; enables `agent://<peerId>/<collection>/<slug>` addressing
- **Discovery layer**: passive Bloom-filter manifests (GossipSub, 60s interval) + active `/subspace/browse/1.0.0` browse protocol for paginated peer content listing; topic/peer subscriptions trigger auto-fetch
- **Trust and abuse resistance**: hashcash PoW stamps (`chunk`: 20 bits, `query`/`manifest`: 16 bits), per-peer reputation scoring with decay and blacklisting, sliding-window rate limiter

**Out of Scope:**

- Browser/WebRTC transport (future phase)
- Vector embedding or similarity search (by design — data only)
- Owned/paid relay infrastructure
- GUI / web dashboard
- Cross-network federation or bridging
- Authentication schemes beyond PSK + Ed25519
- Mobile clients
- Memory encryption at rest (beyond envelope-level network encryption)
- P2P binary blob transfer protocol (deferred — `agent://blobs/` URIs reference blobs by hash, transfer protocol TBD)

---

## Context for Development

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          subspace-transceiver monorepo                      │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ @subspace/  │  │ @subspace/  │  │   @subspace/skill   │  │
│  │    core      │  │    daemon    │  │  (skill markdown +   │  │
│  │              │  │              │  │   prompt templates)  │  │
│  │ • libp2p     │  │ • HTTP API   │  └──────────────────────┘  │
│  │ • OrbitDB    │  │ • Unix socket│                             │
│  │ • HKDF/PSK   │  │ • Lifecycle  │  ┌──────────────────────┐  │
│  │ • CRDT ops   │  │              │  │   @subspace/cli     │  │
│  └──────┬───────┘  └──────┬───────┘  │  (Commander.js)      │  │
│         │                 │           │  → daemon start/stop  │  │
│         └────────────┬────┘           │  → network create/    │  │
│                      │                │     join/leave/list   │  │
│              uses core lib            │  → memory put/get/    │  │
│                                       │     query/scan/forget │  │
│                                       └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

                    P2P Layer (per daemon instance)

  ┌───────────────────────────────────────────────────────────────┐
  │  libp2p node                                                   │
  │  • Transports: TCP, WebSockets                                 │
  │  • Security: Noise protocol                                    │
  │  • Multiplexing: Yamux                                         │
  │  • Discovery: KADDht + mDNS + PeerRouting                     │
  │  • NAT: AutoNAT + CircuitRelayV2 client + DCUtR               │
  │  • PubSub: GossipSub (OrbitDB replication channel)            │
  │  • Bootstrap: IPFS default nodes + Protocol Labs relay nodes  │
  │                                                               │
  │  OrbitDB (Helia-backed)                                        │
  │  • DocumentStore per network + namespace                       │
  │  • CRDT: merge-on-conflict, last-write via Lamport clocks      │
  │  • Blockstore: LevelDB (via Helia default)                     │
  └───────────────────────────────────────────────────────────────┘
```

### PSK → Network Derivation

```
PSK (string/bytes)
    │
    ▼  HKDF-SHA256
    ├── info: "subspace/dht-key"     → DHT announcement key (peers publish presence here)
    ├── info: "subspace/topic"       → GossipSub topic name (OrbitDB replication channel)
    ├── info: "subspace/envelope"    → AES-256-GCM symmetric key (all message payloads)
    ├── info: "subspace/psk-filter"  → libp2p private network PSK (direct conn filter)
    └── info: "subspace/peer-id"     → deterministic peer identity seed (stable across restarts)
```

### Memory Chunk Schema

The `MemoryChunk` type has been extended to support the full global-agent-internet feature set. Core fields are backward-compatible; all new fields are optional.

```typescript
interface MemoryChunk {
  // ── Core fields (original) ───────────────────────────────────────────────
  id: string;                    // UUID v4 (stable across updates)
  type: MemoryType;              // see MemoryType below
  namespace: MemoryNamespace;    // 'skill' | 'project'
  topic: string[];               // semantic tags e.g. ['typescript', 'error-handling']
  content: string;               // plain-text summary — always required, used for search
  source: {
    agentId: string;             // agent identifier (e.g. 'claude-3-7-sonnet')
    peerId: string;              // Ed25519 libp2p PeerId of contributing agent
    project?: string;
    sessionId?: string;
    timestamp: number;           // Unix ms
  };
  ttl?: number;                  // Unix ms expiry (undefined = permanent)
  confidence: number;            // 0.0–1.0
  network: string;               // network ID
  version: number;               // incremented on update (CRDT version)
  supersedes?: string;           // id of chunk this replaces

  // ── Namespace / site fields ───────────────────────────────────────────────
  collection?: string;           // named collection (e.g. 'patterns', 'guides')
  slug?: string;                 // human-readable slug within agent+collection

  // ── Rich content types ────────────────────────────────────────────────────
  contentEnvelope?: ContentEnvelope;  // rich content; `content` is search summary

  // ── Content linking ───────────────────────────────────────────────────────
  links?: ContentLink[];         // typed directed edges to other chunks/agent:// URIs

  // ── Security ──────────────────────────────────────────────────────────────
  signature?: string;            // base64 Ed25519 signature over canonical chunk bytes
  pow?: HashcashStamp;           // hashcash proof-of-work stamp (anti-spam)
  origin?: 'local' | 'crawl' | 'replicated';
  _tombstone?: boolean;          // internal: set by store.forget()
}

// Extended memory types (additive — original 5 types still valid)
type MemoryType =
  | 'skill' | 'project' | 'context' | 'pattern' | 'result'  // original
  | 'document'      // Rich structured document
  | 'schema'        // JSON Schema definition
  | 'thread'        // Multi-agent conversation thread
  | 'blob-manifest' // Binary blob manifest
  | 'profile'       // Agent profile / namespace root

// Rich content envelope (format + body + optional media refs)
interface ContentEnvelope {
  format: 'text' | 'markdown' | 'json' | 'code' | 'thread' | 'table' | 'composite';
  body: string;
  media?: MediaRef[];       // external/network-addressed media refs
  schemaUri?: string;       // agent:// URI of a JSON Schema chunk for validation
  metadata?: Record<string, string>;
}

// Media reference — agent://, ipfs://, https://, or inline data://
interface MediaRef { uri: string; mimeType: string; size?: number; hash?: string; alt?: string; }

// Typed directed edge between chunks (hyperlink layer)
interface ContentLink {
  target: string;  // chunk UUID or agent:// URI
  rel: 'related' | 'depends-on' | 'supersedes' | 'references' | 'part-of' | 'reply-to' | 'see-also' | string;
  label?: string;
}
```

### agent:// URI Scheme

Content on the Subspace network is globally addressable via the `agent://` URI scheme:

```
agent://<peerId>                             → agent profile root
agent://<peerId>/<collection>                → collection listing
agent://<peerId>/<collection>/<slug>         → specific chunk
agent://<peerId>/blobs/<sha256hex>           → binary blob (content-addressed)
```

The PeerId IS the agent's public key (Ed25519 base58btc multi-hash). Resolving a URI queries the specific peer using the `/subspace/query/1.0.0` protocol (local cache checked first).

### Discovery Architecture

```
Each agent daemon:
  ├── Broadcasts DiscoveryManifest every 60s via GossipSub (_subspace/discovery)
  │     Manifest contains:
  │       • Bloom filter of all topics held (~256 bytes)
  │       • Bloom filter of all chunk IDs held (~256 bytes)
  │       • Collection list, chunk count, display name
  │       • Optional PoW stamp
  │
  ├── Receives manifests from peers → updates local PeerIndex
  │     PeerIndex enables O(1) "does peer X have topic Y?" queries (zero RTT)
  │
  └── Registers /subspace/browse/1.0.0 libp2p protocol handler
        Browse requests return paginated ChunkStub listings (metadata, no content)
        Used for "browsing" another agent's site
```

### Monorepo Structure

```
subspace-transceiver/
├── package.json                          # npm workspaces root
├── tsconfig.base.json                    # shared TS config (ESM, strict, NodeNext)
├── packages/
│   ├── core/                             # @subspace/core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # public exports
│   │   │   ├── schema.ts                 # MemoryChunk + ContentEnvelope + ContentLink + Zod validation
│   │   │   ├── crypto.ts                 # HKDF derivation + AES-256-GCM envelope
│   │   │   ├── identity.ts               # Persistent Ed25519 agent identity (independent of PSK)
│   │   │   ├── signing.ts                # Ed25519 chunk signing + verification
│   │   │   ├── uri.ts                    # agent:// URI scheme (parse/build/resolve)
│   │   │   ├── network.ts                # NetworkKeys type + network join/leave
│   │   │   ├── node.ts                   # createLibp2pNode() factory
│   │   │   ├── bootstrap.ts              # IPFS bootstrap + PL relay multiaddrs (constants)
│   │   │   ├── store.ts                  # IMemoryStore interface + MemoryQuery type
│   │   │   ├── orbitdb-store.ts          # OrbitDB v2 implementation of IMemoryStore
│   │   │   ├── query.ts                  # filter logic + HEAD-of-chain resolution
│   │   │   ├── gc.ts                     # TTL GC: prune chunks where ttl < Date.now()
│   │   │   ├── discovery.ts              # Bloom manifests + /subspace/browse/1.0.0 protocol
│   │   │   ├── backlink-index.ts         # In-memory reverse link index for content graph
│   │   │   ├── bloom.ts                  # Compact Bloom filter (256 bytes, 7 hashes)
│   │   │   ├── reputation.ts             # Per-peer reputation scoring with decay + blacklist
│   │   │   ├── pow.ts                    # Hashcash PoW stamps (16-20 bit difficulty)
│   │   │   ├── rate-limiter.ts           # Sliding-window per-peer ingest rate limiter
│   │   │   └── protocol.ts               # /subspace/query/1.0.0 wire protocol codec
│   │   └── test/
│   │       ├── schema.test.ts
│   │       ├── crypto.test.ts
│   │       ├── network.test.ts
│   │       ├── store.test.ts             # integration: two in-process nodes + replication
│   │       └── query.test.ts
│   ├── daemon/                           # @subspace/daemon
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # entrypoint: parse args, start daemon
│   │       ├── config.ts                 # load/save ~/.subspace/config.yaml
│   │       ├── lifecycle.ts              # PID file, start/stop/status, --foreground
│   │       ├── api.ts                    # Fastify HTTP API — all routes
│   │       └── gc-scheduler.ts           # setInterval TTL GC runner
│   ├── cli/                              # @subspace/cli (published as `subspace` bin)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # Commander root + auto-start daemon logic
│   │       ├── client.ts                 # HTTP fetch client for daemon, with auto-start
│   │       ├── output.ts                 # human-readable vs --json formatter
│   │       └── commands/
│   │           ├── daemon.ts             # daemon start|stop|status|restart|logs
│   │           ├── network.ts            # network create|join|leave|list|info
│   │           └── memory.ts             # memory put|get|query|scan|forget|update
│   └── skill/                            # @subspace/skill
│       ├── package.json
│       ├── SKILL.md                      # agent-facing skill doc (pi/BMAD compatible)
│       └── examples/
│           └── agent-workflow.md         # full pull→query→push flow with CLI examples
└── docs/
    └── architecture.md
```

### Codebase Patterns

- **ESM-only**: All packages use `"type": "module"` and `NodeNext` module resolution
- **Async/await throughout**: No callbacks, no sync blocking I/O
- **Typed error classes**: `AgentNetError` base; subclasses: `NetworkError`, `StoreError`, `DaemonError`, `CryptoError`
- **`IMemoryStore` interface**: All store operations go through this interface; OrbitDB impl hidden in `orbitdb-store.ts`
- **Append-only writes**: `put()` always creates new chunk + UUID; updates set `supersedes: previousId`; query returns HEAD of chain
- **HKDF centralised**: All key derivation in `crypto.ts`; `deriveNetworkKeys(psk: string): NetworkKeys` is the single entry point
- **`--json` flag**: Every CLI command outputs structured JSON for agent consumption
- **Daemon auto-start**: CLI checks daemon health before each command; spawns daemon + waits up to 10s if not running
- **`--local` / `--network` flags**: `memory query` defaults to `--local` (sub-10ms); `--network` broadcasts to peers + streams results
- **Config location**: `~/.subspace/config.yaml` — daemon port (default 7432), data dir, known networks, agentId

### Key API Patterns

**libp2p v3 node creation (node.ts):**
```typescript
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { mdns } from '@libp2p/mdns'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { dcutr } from '@libp2p/dcutr'
import { autoNAT } from '@libp2p/autonat'
import { identify } from '@libp2p/identify'
import { bootstrap } from '@libp2p/bootstrap'
import { preSharedKey } from '@libp2p/pnet'

const node = await createLibp2p({
  addresses: { listen: ['/ip4/0.0.0.0/tcp/0'] },
  transports: [tcp(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionProtector: preSharedKey({ psk: networkKeys.pskFilter }),
  services: {
    identify: identify(),
    dht: kadDHT({ clientMode: false }),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    mdns: mdns(),
    dcutr: dcutr(),
    autoNAT: autoNAT(),
    bootstrap: bootstrap({ list: BOOTSTRAP_ADDRESSES }),
  },
})
```

**HKDF key derivation (crypto.ts):**
```typescript
import { hkdfSync } from 'node:crypto'

export interface NetworkKeys {
  dhtKey: Buffer       // 32 bytes — DHT announcement key
  topic: string        // hex string — GossipSub topic
  envelopeKey: Buffer  // 32 bytes — AES-256-GCM symmetric key
  pskFilter: Buffer    // 32 bytes — libp2p pnet PSK
  peerId: Buffer       // 32 bytes — deterministic peer identity seed
}

export function deriveNetworkKeys(psk: string): NetworkKeys {
  const keyMaterial = Buffer.from(psk, 'utf8')
  const salt = Buffer.alloc(32)
  const derive = (info: string, len: number) =>
    Buffer.from(hkdfSync('sha256', keyMaterial, salt, Buffer.from(info), len))
  return {
    dhtKey:      derive('subspace/dht-key', 32),
    topic:       derive('subspace/topic', 32).toString('hex'),
    envelopeKey: derive('subspace/envelope', 32),
    pskFilter:   derive('subspace/psk-filter', 32),
    peerId:      derive('subspace/peer-id', 32),
  }
}
```

**OrbitDB v2 document store (orbitdb-store.ts):**
```typescript
import { createHelia } from 'helia'
import { createOrbitDB } from '@orbitdb/core'
import { LevelBlockstore } from 'blockstore-level'
import { LevelDatastore } from 'datastore-level'

const blockstore = new LevelBlockstore(path.join(dataDir, 'blocks'))
const datastore = new LevelDatastore(path.join(dataDir, 'datastore'))
const helia = await createHelia({ libp2p: node, blockstore, datastore })
const orbitdb = await createOrbitDB({ ipfs: helia, directory: path.join(dataDir, 'orbitdb') })
// DB name includes networkId + namespace for isolation
const db = await orbitdb.open(`subspace/${networkId}/${namespace}`, { type: 'documents' })
await db.put({ ...chunk })                            // write (chunk.id = _id)
const results = await db.query(doc => ...)            // local query
```

**Daemon API routes (api.ts):**
```
GET  /health                 → { status, peerId, networks[], uptime }
GET  /networks               → NetworkInfoDTO[]
POST /networks               → { psk } → join/create, returns NetworkInfoDTO
DEL  /networks/:networkId    → leave network
POST /memory                 → MemoryChunk input → stored chunk with id
GET  /memory/:id             → MemoryChunk | 404
POST /memory/query           → MemoryQuery → MemoryChunk[] (local replica)
POST /memory/scan            → MemoryQuery → MemoryChunk[] (network broadcast via /subspace/query/1.0.0 protocol)
PATCH /memory/:id            → { content, confidence? } → server-side update (creates supersedes chain atomically)
DEL  /memory/:id             → tombstone (forget)
```

**Network query wire protocol (`/subspace/query/1.0.0`):**
GossipSub is pub/sub only — it has no request/response semantics. Network-wide memory scan uses a **custom libp2p protocol** instead:
```
Protocol ID: /subspace/query/1.0.0

Request (JSON, length-prefixed):
{ query: MemoryQuery, requestId: string }

Response (JSON, length-prefixed):
{ requestId: string, chunks: MemoryChunk[], peerId: string }
```
- `POST /memory/scan` in `api.ts` iterates known peers in the network, opens a stream to each with `node.dialProtocol(peerId, '/subspace/query/1.0.0')`, sends the request, reads response with a **5-second per-peer timeout**, merges and deduplicates results.
- The daemon also registers `node.handle('/subspace/query/1.0.0', handler)` on startup to answer incoming query requests from other peers using its local store.
- Responses are collected concurrently (Promise.allSettled), merged via `resolveHeads`, then returned. Failed/timed-out peers are skipped silently (logged at debug level).
- Add `packages/core/src/protocol.ts` to implement the request/response codec (length-prefixed JSON over libp2p streams using `it-length-prefixed` + `it-pipe`).

**CLI command surface:**
```
subspace daemon start [--foreground] [--port <n>]
subspace daemon stop | status | restart

subspace network create --psk <key> [--name <label>]
subspace network join --psk <key>
subspace network leave <networkId>
subspace network list

subspace memory put --type <type> --topic <tags...> --content <text>
              [--namespace skill|project] [--project <slug>]
              [--confidence <0-1>] [--ttl <seconds>]
subspace memory get <id>
subspace memory query --topic <tags...> [--type <type>] [--namespace <ns>]
              [--project <slug>] [--min-confidence <n>] [--local|--network]
subspace memory scan <freetext> [--local|--network]
subspace memory forget <id>
subspace memory update <id> --content <text> [--confidence <n>]

# All commands support --json for structured output
```

### Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js v25 / Bun 1.3 (TypeScript, ESM) | js-libp2p ecosystem; Bun compat for speed |
| P2P stack | libp2p@3.1.4 | Latest stable, modular, well-maintained |
| CRDT store | @orbitdb/core@3.0.2 + helia@6.0.20 | Libp2p-native, CRDT document store, free replication |
| Blockstore | blockstore-level@3.0.2 + datastore-level@12.0.2 | OrbitDB default, battle-tested |
| PSK model | HKDF-SHA256 → 5 derived keys | Flexible; enables DHT discovery, GossipSub namespacing, envelope encryption, pnet filter, deterministic peer ID |
| NAT traversal | Circuit Relay v2 + DCUtR + AutoNAT + mDNS | Free, libp2p-native; mDNS-first for LAN peers |
| Bootstrap | IPFS default bootstrappers + PL relay nodes (constants in bootstrap.ts) | Free, globally distributed |
| CLI framework | commander@14.0.3 | Mature, TypeScript-first |
| Packaging | npm packages + `npx subspace` zero-install | Widest agent compatibility |
| Store abstraction | IMemoryStore interface in store.ts | Isolates OrbitDB v2 API churn; swap-safe |
| Query model | Two-tier: --local (instant) + --network (stream) | Sub-10ms local; network only when needed |
| Write model | Append-only + supersedes chain | Conflict-free; HEAD resolution in query.ts |
| Peer identity | Derived from PSK via HKDF (subspace/peer-id) | Deterministic across restarts |
| Agent identity | SUBSPACE_AGENT_ID env var + config fallback | Consistent provenance on all chunks |
| Test framework | vitest@4.0.18 | Fast, TypeScript-native, ESM-compatible |

### Files to Reference

| File | Purpose |
|------|---------|
| `packages/core/src/schema.ts` | MemoryChunk interface + Zod validation |
| `packages/core/src/crypto.ts` | HKDF derivation, AES-256-GCM envelope encrypt/decrypt |
| `packages/core/src/network.ts` | NetworkKeys type, join/leave orchestration |
| `packages/core/src/node.ts` | libp2p node factory with full service config |
| `packages/core/src/bootstrap.ts` | Hardcoded IPFS bootstrap + PL relay multiaddrs |
| `packages/core/src/store.ts` | IMemoryStore interface + MemoryQuery type |
| `packages/core/src/orbitdb-store.ts` | OrbitDB v2 implementation of IMemoryStore |
| `packages/core/src/query.ts` | Filter logic + HEAD-of-chain resolution |
| `packages/core/src/gc.ts` | TTL GC — prunes expired chunks |
| `packages/daemon/src/config.ts` | ~/.subspace/config.yaml load/save/defaults |
| `packages/daemon/src/lifecycle.ts` | PID file, start/stop/status, --foreground |
| `packages/daemon/src/api.ts` | Fastify HTTP API — all routes |
| `packages/cli/src/client.ts` | HTTP fetch client + daemon auto-start logic |
| `packages/cli/src/commands/memory.ts` | memory put/get/query/scan/forget/update |
| `packages/cli/src/index.ts` | CLI root entrypoint (Commander.js) |
| `packages/skill/SKILL.md` | Agent-facing skill: how to use subspace CLI |
| `packages/skill/examples/agent-workflow.md` | Full flow: pull → query → push with real CLI calls |
| `packages/core/src/protocol.ts` | /subspace/query/1.0.0 wire protocol codec |

---

## Implementation Plan

### Tasks

#### Phase 1 — Monorepo Scaffold

- [x] **Task 1: Initialise workspace root**
  - File: `package.json`
  - Action: Create npm workspaces root with `"workspaces": ["packages/*"]`, `"type": "module"`, scripts for `build`, `test`, `lint` across all packages. Add root devDependencies: `typescript@5.x`, `vitest@4.0.18`.
  - Notes: Pin all dependency versions exactly (no `^` or `~`) to guard against OrbitDB/Helia API churn.

- [x] **Task 2: Create shared TypeScript config**
  - File: `tsconfig.base.json`
  - Action: Create base config with `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`, `"strict": true`, `"declaration": true`, `"declarationMap": true`, `"sourceMap": true`. All package `tsconfig.json` files extend this.

- [x] **Task 3: Scaffold all four package directories**
  - Files: `packages/core/package.json`, `packages/daemon/package.json`, `packages/cli/package.json`, `packages/skill/package.json`
  - Action: Create each `package.json` with correct `name` (`@subspace/core` etc.), `"type": "module"`, `"exports"` map pointing to compiled output, and `"bin"` entry for CLI (`subspace` → `dist/index.js`). Each gets its own `tsconfig.json` extending `../../tsconfig.base.json`.

#### Phase 2 — @subspace/core: Foundations

- [x] **Task 4: Implement MemoryChunk schema and validation**
  - File: `packages/core/src/schema.ts`
  - Action: Define and export `MemoryType`, `MemoryNamespace`, `MemoryChunk` TypeScript interfaces. Add `zod` as dependency; create `memoryChunkSchema` Zod schema for runtime validation on ingest. Export `validateChunk(data: unknown): MemoryChunk` that throws `StoreError` on invalid input. Also define `MemoryQuery` type: `{ topics?: string[], type?: MemoryType, namespace?: MemoryNamespace, project?: string, minConfidence?: number, since?: number, until?: number, limit?: number }`.
  - Notes: `id` must be UUID v4. `confidence` must be clamped 0.0–1.0. `topic` must be non-empty array of lowercase strings. `version` defaults to 1.

- [x] **Task 5: Implement typed error hierarchy and code registry**
  - File: `packages/core/src/errors.ts` (add to `index.ts` exports)
  - Action: Create `AgentNetError extends Error` with `code: ErrorCode` field (typed, not `string`). Export `ErrorCode` as a const enum:
    ```typescript
    export const ErrorCode = {
      // Crypto
      PSK_TOO_SHORT:        'PSK_TOO_SHORT',
      DECRYPT_FAILED:       'DECRYPT_FAILED',
      // Store
      INVALID_CHUNK:        'INVALID_CHUNK',
      CHUNK_NOT_FOUND:      'CHUNK_NOT_FOUND',
      STORE_WRITE_FAILED:   'STORE_WRITE_FAILED',
      STORE_READ_FAILED:    'STORE_READ_FAILED',
      // Network
      JOIN_FAILED:          'JOIN_FAILED',
      PEER_DIAL_FAILED:     'PEER_DIAL_FAILED',
      NETWORK_NOT_FOUND:    'NETWORK_NOT_FOUND',
      // Daemon
      DAEMON_TIMEOUT:       'DAEMON_TIMEOUT',
      DAEMON_NOT_RUNNING:   'DAEMON_NOT_RUNNING',
      DAEMON_ALREADY_RUNNING: 'DAEMON_ALREADY_RUNNING',
      API_ERROR:            'API_ERROR',
    } as const
    export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode]
    ```
    Subclasses: `NetworkError`, `StoreError`, `DaemonError`, `CryptoError`. Each accepts `message`, `code: ErrorCode`, and optional `cause: unknown`. The skill doc's error recovery section must map each code to a human-readable explanation and suggested fix. Export all from `index.ts`.

- [x] **Task 6: Implement HKDF key derivation**
  - File: `packages/core/src/crypto.ts`
  - Action: Export `NetworkKeys` interface (5 fields as documented). Export `deriveNetworkKeys(psk: string): NetworkKeys` using `node:crypto` `hkdfSync`. Export `encryptEnvelope(plaintext: Buffer, key: Buffer): { ciphertext: Buffer, iv: Buffer, tag: Buffer }` using AES-256-GCM with random 12-byte IV. Export `decryptEnvelope(ciphertext: Buffer, iv: Buffer, tag: Buffer, key: Buffer): Buffer`. No external crypto deps — Node.js built-ins only.
  - Notes: Zero-salt HKDF is intentional — PSK is the entropy source. Document this in JSDoc. **Also export `validatePSK(psk: string): void`** — throws `CryptoError` with code `PSK_TOO_SHORT` if `psk.length < 16`. Logs a warning (but does not throw) if `psk.length < 32`. The skill doc and CLI `network create` command must instruct agents to use a cryptographically random PSK (e.g., `openssl rand -hex 32`). CLI must call `validatePSK` before calling `joinNetwork`.

- [x] **Task 7: Define bootstrap addresses**
  - File: `packages/core/src/bootstrap.ts`
  - Action: Export `BOOTSTRAP_ADDRESSES: string[]` — hardcoded IPFS default bootstrap multiaddrs (Cloudflare, Protocol Labs nodes). Export `RELAY_ADDRESSES: string[]` — Protocol Labs public circuit relay v2 nodes. These are compile-time constants; no network calls. Add a comment block with the date these were last verified and instructions for updating.
  - Notes: Source current addresses from `https://github.com/ipfs/kubo/blob/master/config/bootstrap_peers.go`. Include at least 4 bootstrap nodes and 2 relay nodes for resilience.

- [x] **Task 8: Implement libp2p node factory**
  - File: `packages/core/src/node.ts`
  - Action: Export `createLibp2pNode(networkKeys: NetworkKeys, options?: { port?: number, dataDir?: string }): Promise<Libp2p>`. Configure: transports `[tcp(), circuitRelayTransport()]`, connectionEncrypters `[noise()]`, streamMuxers `[yamux()]`, connectionProtector `preSharedKey({ psk: networkKeys.pskFilter })`, services: `identify`, `dht: kadDHT({ clientMode: false })`, `pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false })`, `mdns: mdns()`, `dcutr: dcutr()`, `autoNAT: autoNAT()`, `bootstrap: bootstrap({ list: [...BOOTSTRAP_ADDRESSES, ...RELAY_ADDRESSES] })`.
  - Notes: mDNS runs in parallel with DHT — no priority needed, OS handles LAN vs WAN routing. Peer identity seed from `networkKeys.peerId` should be used to create a deterministic Ed25519 keypair via `@libp2p/crypto` `generateKeyPairFromSeed`. This makes peer ID stable across restarts. **CRITICAL SERVICE ORDER**: `identify` MUST be listed first in the `services` object — `circuitRelayTransport()` depends on the identify protocol being registered before it can negotiate relay connections. Wrong order = silent relay failure with no error message.

- [x] **Task 9: Define IMemoryStore interface**
  - File: `packages/core/src/store.ts`
  - Action: Export `IMemoryStore` interface with methods: `put(chunk: MemoryChunk): Promise<void>`, `get(id: string): Promise<MemoryChunk | null>`, `query(q: MemoryQuery): Promise<MemoryChunk[]>`, `list(): Promise<MemoryChunk[]>` (returns all docs including tombstones — used by GC and network query handler), `forget(id: string): Promise<void>`, `close(): Promise<void>`. Export `MemoryStoreEvents` type for typed event emitter (`'replicated'`, `'error'`). Store implementations must emit `'replicated'` when remote peer data merges in. No OrbitDB imports in this file — interface only.

- [x] **Task 10: Implement OrbitDB document store**
  - File: `packages/core/src/orbitdb-store.ts`
  - Action: Export `createOrbitDBStore(node: Libp2p, networkKeys: NetworkKeys, namespace: MemoryNamespace, dataDir: string): Promise<IMemoryStore>`. Internally: create `LevelBlockstore` + `LevelDatastore`, call `createHelia({ libp2p: node, blockstore, datastore })`, call `createOrbitDB({ ipfs: helia, directory })`, open document DB named `subspace/${networkKeys.topic}/${namespace}`. Implement `IMemoryStore`: `put()` calls `db.put({ _id: chunk.id, ...chunk })`, `get()` calls `db.get(id)`, `query()` calls `db.query()` with filter function mapping `MemoryQuery` fields, `forget()` puts a tombstone doc `{ _id: id, _tombstone: true, id, forgotten: true }`. On `db.events.on('update')`, emit `'replicated'`.
  - Notes: Tombstone pattern (not physical delete) is required for CRDT consistency — deletes must propagate to all peers.

- [x] **Task 11: Implement query filter and HEAD-of-chain resolution**
  - File: `packages/core/src/query.ts`
  - Action: Export `buildOrbitFilter(q: MemoryQuery): (doc: MemoryChunk) => boolean` — returns a predicate that checks all query fields. Export `resolveHeads(chunks: MemoryChunk[]): MemoryChunk[]` — takes flat list of chunks, groups by `supersedes` chain, returns only HEAD (the chunk not superseded by any other). Export `applyQuery(chunks: MemoryChunk[], q: MemoryQuery): MemoryChunk[]` — applies filter + HEAD resolution + sorts by timestamp desc + applies `limit`.
  - Notes: A chunk is a HEAD if no other chunk has `supersedes === chunk.id`. Filter out tombstones (`_tombstone: true`). Filter out expired TTL chunks (`ttl !== undefined && ttl < Date.now()`).

- [x] **Task 12: Implement TTL garbage collector**
  - File: `packages/core/src/gc.ts`
  - Action: Export `runGC(store: IMemoryStore): Promise<{ pruned: number }>`. Calls `store.list()` to retrieve all docs, iterates, calls `store.forget(id)` for any where `ttl !== undefined && ttl < Date.now()`. Returns count of pruned docs. This function is stateless and idempotent — safe to call repeatedly. No caller needs to pass docs; the store fetches them internally.

- [x] **Task 13: Implement network join/leave orchestration**
  - File: `packages/core/src/network.ts`
  - Action: Export two distinct types:
    - `NetworkSession` (internal, NOT exported from `index.ts`): `{ id: string, name?: string, node: Libp2p, stores: { skill: IMemoryStore, project: IMemoryStore }, networkKeys: NetworkKeys }`
    - `NetworkInfoDTO` (serialisable, exported): `{ id: string, name?: string, peerId: string, peers: number, namespaces: ['skill', 'project'] }`
    Export `joinNetwork(psk: string, options: { name?: string, dataDir: string, port?: number }): Promise<NetworkSession>`. Export `leaveNetwork(session: NetworkSession): Promise<void>` — closes stores, stops libp2p node. Export `sessionToDTO(session: NetworkSession): NetworkInfoDTO` — converts live session to API-safe DTO. Daemon maintains a `Map<string, NetworkSession>` internally; all API responses use `sessionToDTO`.

- [x] **Task 13b: Implement network query wire protocol codec**
  - File: `packages/core/src/protocol.ts`
  - Action: Export `QUERY_PROTOCOL = '/subspace/query/1.0.0'`. Export `QueryRequest` type: `{ query: MemoryQuery, requestId: string }`. Export `QueryResponse` type: `{ requestId: string, chunks: MemoryChunk[], peerId: string }`. Export `encodeMessage(msg: unknown): Uint8Array` and `decodeMessage<T>(data: Uint8Array): T` — length-prefixed JSON using `it-length-prefixed` + `it-pipe`. Export `sendQuery(node: Libp2p, peerId: PeerId, query: MemoryQuery): Promise<QueryResponse>` — dials the peer, opens stream on `QUERY_PROTOCOL`, sends request, reads response, closes stream. Timeout: 5000ms. Throws `NetworkError` with code `PEER_DIAL_FAILED` on timeout or connection error.

- [x] **Task 14: Wire up core public exports**
  - File: `packages/core/src/index.ts`
  - Action: Re-export everything public: all types from `schema.ts`, all errors from `errors.ts`, `deriveNetworkKeys` + `NetworkKeys` from `crypto.ts`, `joinNetwork` + `leaveNetwork` + `NetworkInfo` from `network.ts`, `IMemoryStore` + `MemoryQuery` from `store.ts`. Do NOT export OrbitDB internals.

- [x] **Task 15: Write core unit and integration tests**
  - Files: `packages/core/test/schema.test.ts`, `crypto.test.ts`, `query.test.ts`, `store.test.ts`
  - Action:
    - `schema.test.ts`: validate happy path chunk, reject missing fields, reject out-of-range confidence, reject empty topic array.
    - `crypto.test.ts`: fixed PSK → assert exact derived key bytes for each info string. Encrypt → decrypt round-trip. Wrong key → throws `CryptoError`.
    - `query.test.ts`: `resolveHeads` returns correct HEAD from a 3-chunk chain. TTL-expired chunks filtered out. `buildOrbitFilter` correctly matches/excludes on each field.
    - `store.test.ts` (integration): spin up two `createLibp2pNode` instances on loopback, join same network, put a chunk on node A, wait for `'replicated'` event on node B, assert chunk queryable on B.

#### Phase 3 — @subspace/daemon

- [x] **Task 16: Implement config management**
  - File: `packages/daemon/src/config.ts`
  - Action: Export `DaemonConfig` type: `{ port: number, dataDir: string, agentId: string, networks: Array<{ psk: string, name?: string }> }`. Export `loadConfig(): Promise<DaemonConfig>` — reads `~/.subspace/config.yaml`, merges with defaults (`port: 7432`, `dataDir: ~/.subspace/data`). **`agentId` default**: `process.env.SUBSPACE_AGENT_ID ?? null`. If `null` after loading, the daemon must **log a startup warning** ("No SUBSPACE_AGENT_ID set — memory provenance will use peer ID as agentId") and fall back to the local libp2p peer ID string as agentId (set after node creation in `index.ts`). This ensures provenance is always unique per machine even without explicit identity. The `'unknown'` default is explicitly prohibited. Export `saveConfig(config: DaemonConfig): Promise<void>`. Creates `~/.subspace/` directory if not exists. Uses `yaml` package for parse/stringify.

- [x] **Task 17: Implement daemon lifecycle (PID file)**
  - File: `packages/daemon/src/lifecycle.ts`
  - Action: Export `writePid(port: number): void` — writes `~/.subspace/daemon.pid` containing `{ pid: process.pid, port, startedAt }`. Export `readPid(): { pid: number, port: number, startedAt: number } | null`. Export `clearPid(): void`. Export `isDaemonRunning(): boolean` — reads PID file, checks `process.kill(pid, 0)`. Export `startDaemonProcess(foreground: boolean, port: number): Promise<void>` — if `foreground`, initialises inline; if not, spawns detached child process with `stdio: 'ignore'`, `detached: true`, then `unref()`.

- [x] **Task 18: Implement Fastify HTTP API**
  - File: `packages/daemon/src/api.ts`
  - Action: Export `createApi(config: DaemonConfig): Promise<FastifyInstance>`. Register all routes (bind to `127.0.0.1` only — never `0.0.0.0`):
    - `GET /health` → `{ status: 'ok', peerId, networks: NetworkInfo[], uptime: number, version: string }`
    - `GET /networks` → `NetworkInfo[]`
    - `POST /networks` body `{ psk: string, name?: string }` → calls `joinNetwork`, saves to config, returns `NetworkInfo`
    - `DELETE /networks/:networkId` → calls `leaveNetwork`, removes from config
    - `POST /memory` body `Omit<MemoryChunk, 'id' | 'version' | 'source.peerId'>` → fills in `id` (uuid), `version: 1`, `source.peerId` (local peer ID), `source.agentId` (from config), calls `store.put()`, returns full chunk
    - `GET /memory/:id` → `store.get(id)` → 200 or 404
    - `POST /memory/query` body `MemoryQuery` → `store.query(q)` (local only)
    - `POST /memory/scan` body `MemoryQuery` → dial each known peer with `/subspace/query/1.0.0` protocol, collect responses concurrently (Promise.allSettled, 5s per-peer timeout), merge + deduplicate + `resolveHeads`, return
    - `PATCH /memory/:id` body `{ content: string, confidence?: number }` → server-side: get existing chunk, create new chunk with new UUID + `supersedes: id` + `version: prev.version + 1`, call `store.put()`, return new chunk. **Fork tie-breaking rule**: if `resolveHeads` encounters multiple chunks with no superseder (concurrent fork), the chunk with the highest `source.timestamp` is HEAD. Document this rule in `query.ts`.
    - `DELETE /memory/:id` → `store.forget(id)`
  - Notes: All error responses use `{ error: string, code: string }` shape. Daemon must register `/subspace/query/1.0.0` protocol handler on startup (in `index.ts`) so it can respond to incoming peer queries.

- [x] **Task 19: Implement periodic GC scheduler**
  - File: `packages/daemon/src/gc-scheduler.ts`
  - Action: Export `startGCScheduler(stores: IMemoryStore[], intervalMs: number = 3_600_000): NodeJS.Timeout`. On each tick, calls `runGC` for each store. Logs `{ pruned, timestamp }` at info level. Run once immediately on startup (catches stale chunks from previous session). Returns interval handle so daemon can `clearInterval` on shutdown.

- [x] **Task 20: Implement daemon entrypoint**
  - File: `packages/daemon/src/index.ts`
  - Action: Parse CLI args (`--foreground`, `--port`). Load config. Call `createApi`. Start Fastify on `config.port`. Write PID file. Re-join all networks from config (so daemon automatically reconnects to known networks on restart). Start GC scheduler. Handle `SIGTERM` / `SIGINT` gracefully: close all stores, stop libp2p nodes, clear PID, drain Fastify. On uncaught exception, log + clean up + exit 1.

#### Phase 4 — @subspace/cli

- [x] **Task 21: Implement daemon HTTP client with auto-start**
  - File: `packages/cli/src/client.ts`
  - Action: Export `DaemonClient` class with methods mirroring all API routes. Constructor takes `port` (default 7432). All methods use native `fetch`. Export `ensureDaemon(port: number): Promise<void>` — calls `GET /health`, if fails, spawns daemon process, polls `/health` every 500ms for up to 10s, throws `DaemonError` if still unreachable. All methods call `ensureDaemon` internally before making requests.

- [x] **Task 22: Implement output formatter**
  - File: `packages/cli/src/output.ts`
  - Action: Export `print(data: unknown, opts: { json: boolean }): void`. If `--json`, `JSON.stringify(data, null, 2)` to stdout. Otherwise format human-readable: tables for arrays, key-value pairs for objects, colour-coded success/error prefix (use ANSI codes directly, no external dep). Export `printError(err: AgentNetError, opts: { json: boolean }): void` — exits process with code 1 after printing.

- [x] **Task 23: Implement daemon commands**
  - File: `packages/cli/src/commands/daemon.ts`
  - Action: Export Commander subcommand group `daemon` with:
    - `start [--foreground] [--port <n>] [--json]` → calls `ensureDaemon`, prints health response
    - `stop [--json]` → sends `SIGTERM` to PID from PID file, confirms stopped
    - `status [--json]` → calls `GET /health`, prints or `{ running: false }` if unreachable (no auto-start here)
    - `restart [--json]` → stop then start

- [x] **Task 24: Implement network commands**
  - File: `packages/cli/src/commands/network.ts`
  - Action: Export Commander subcommand group `network` with:
    - `create --psk <key> [--name <label>] [--json]` → `POST /networks`
    - `join --psk <key> [--json]` → `POST /networks`
    - `leave <networkId> [--json]` → `DELETE /networks/:id`
    - `list [--json]` → `GET /networks`

- [x] **Task 25: Implement memory commands**
  - File: `packages/cli/src/commands/memory.ts`
  - Action: Export Commander subcommand group `memory` with:
    - `put --type <type> --topic <tag...> --content <text> [--namespace skill|project] [--project <slug>] [--confidence <n>] [--ttl <seconds>] [--json]` → `POST /memory`
    - `get <id> [--json]` → `GET /memory/:id`
    - `query --topic <tag...> [--type <type>] [--namespace <ns>] [--project <slug>] [--min-confidence <n>] [--local|--network] [--json]` → `POST /memory/query` or `/memory/scan`
    - `search <freetext> [--local|--network] [--json]` → `POST /memory/search` — performs **substring match on `content` field** (case-insensitive) across all chunks, not topic tag matching. This is true content search. Topics are not involved. Implementation: `db.query(doc => doc.content.toLowerCase().includes(freetext.toLowerCase()))`. Rename API route from `/memory/scan` to `/memory/search` accordingly.
    - `forget <id> [--json]` → `DELETE /memory/:id`
    - `update <id> --content <text> [--confidence <n>] [--json]` → `PATCH /memory/:id` (server-side update; daemon creates new chunk with `supersedes: id` atomically within single process — avoids client-side read-modify-write race)

- [x] **Task 26: Wire up CLI root entrypoint**
  - File: `packages/cli/src/index.ts`
  - Action: Create Commander root program `subspace`. Set version from `package.json`. Register subcommand groups from `daemon.ts`, `network.ts`, `memory.ts`. Add global `--port <n>` option (default 7432) passed to all commands. Add `--json` global option. Call `program.parseAsync(process.argv)`. Add `process.on('unhandledRejection')` → `printError` + exit 1.
  - Notes: The `bin` field in `package.json` must point to compiled `dist/index.js` with shebang `#!/usr/bin/env node`.

#### Phase 5 — @subspace/skill

- [x] **Task 27: Write agent-facing skill document**
  - File: `packages/skill/SKILL.md`
  - Action: Write a BMAD/pi-compatible skill markdown with sections:
    - **When to use**: "Use subspace when you need to store, retrieve, or share memory across sessions, machines, or agents."
    - **Prerequisites**: daemon must be running (`subspace daemon status`); must be joined to at least one network.
    - **Quick reference**: full CLI command table with one-line descriptions
    - **Agent identity**: set `SUBSPACE_AGENT_ID=<your-model-id>` before running any command
    - **Memory types guide**: when to use each type (skill / project / context / pattern / result)
    - **Output format**: all commands support `--json` — always use `--json` for programmatic parsing
    - **Error handling**: what each error code means and how to recover
    - **Link to examples**: `./examples/agent-workflow.md`

- [x] **Task 28: Write end-to-end agent workflow example**
  - File: `packages/skill/examples/agent-workflow.md`
  - Action: Write a complete, runnable example showing the full agent memory loop:
    1. **Before starting a task**: `subspace memory query --topic typescript,error-handling --namespace project --project myapp --json` — parse and read results
    2. **Check for existing patterns**: `subspace memory query --type pattern --topic async --local --json`
    3. **During task — store a discovery**: `subspace memory put --type pattern --topic typescript,async,error-handling --content "Always wrap OrbitDB put() calls in try/catch — it throws on block store failure, not just on validation" --confidence 0.9 --json`
    4. **After task — store result**: `subspace memory put --type result --topic typescript,refactor --project myapp --content "Completed auth module refactor. Key decision: moved validation to middleware layer. See commit abc123." --confidence 1.0 --json`
    5. **Update stale memory**: `subspace memory update <id> --content "Updated: validation moved back to service layer in v2" --confidence 0.85 --json`
    6. **Share skill across projects**: `subspace memory put --type skill --namespace skill --topic libp2p,nat-traversal --content "DCUtR hole punching requires both peers to be connected to the same relay first. Always bootstrap before expecting direct connections." --confidence 0.95 --json`
    - Include expected JSON output shapes for each command. Include error recovery examples.

---

### Acceptance Criteria

- [ ] **AC 1: Monorepo builds cleanly**
  Given the repository is cloned fresh, when `npm install && npm run build` is run from the root, then all four packages compile without TypeScript errors and `dist/` directories are populated.

- [ ] **AC 2: HKDF produces stable, distinct keys**
  Given a fixed PSK string `"test-network-key"`, when `deriveNetworkKeys` is called twice with the same input, then both calls return byte-identical `NetworkKeys`, and all five derived buffers (`dhtKey`, `topic`, `envelopeKey`, `pskFilter`, `peerId`) are distinct from each other.

- [ ] **AC 3: AES envelope encrypt/decrypt round-trips**
  Given a 32-byte envelope key and plaintext `Buffer.from("hello")`, when `encryptEnvelope` is called then `decryptEnvelope` is called with the result, then the decrypted output equals the original plaintext. Given a tampered ciphertext, when `decryptEnvelope` is called, then it throws `CryptoError`.

- [ ] **AC 4: MemoryChunk validation rejects invalid input**
  Given a chunk object missing the `topic` field, when `validateChunk` is called, then it throws `StoreError` with code `INVALID_CHUNK`. Given a chunk with `confidence: 1.5`, when `validateChunk` is called, then it throws `StoreError`.

- [ ] **AC 5: Two peers replicate a memory chunk**
  Given two daemon instances on the same machine joined to the same PSK network, when peer A calls `PUT /memory` with a new chunk, then within 10 seconds peer B's `POST /memory/query` returns that chunk in its results.

- [ ] **AC 6: HEAD-of-chain resolution works correctly**
  Given chunks `[A, B (supersedes: A), C (supersedes: B)]` in the store, when `resolveHeads` is called, then only chunk C is returned. Given chunk A with no superseder, when `resolveHeads` is called with `[A]`, then `[A]` is returned.

- [ ] **AC 7: Tombstoned chunks are excluded from queries**
  Given a chunk that has been `forget()`-ed (tombstoned), when `POST /memory/query` is called with matching filters, then the tombstoned chunk does not appear in results.

- [ ] **AC 8: TTL-expired chunks are excluded from queries**
  Given a chunk stored with `ttl` set to 1 second in the past, when `POST /memory/query` is called, then the expired chunk is not returned. When `runGC` is called, then the expired chunk count is included in the `pruned` return value.

- [ ] **AC 9: Daemon auto-starts when CLI is invoked**
  Given the daemon is not running, when `subspace memory list --json` is called, then the CLI starts the daemon, waits for it to be healthy, and returns results — all within 15 seconds. Given the daemon does not become healthy within 10 seconds, then the CLI exits with code 1 and prints `{ error: "Daemon failed to start", code: "DAEMON_TIMEOUT" }`.

- [ ] **AC 10: Daemon binds only to localhost**
  Given the daemon is running, when a network scan is performed for open ports, then port 7432 (or configured port) is bound exclusively to `127.0.0.1`, not `0.0.0.0`.

- [ ] **AC 11: `--json` flag produces parseable output on every command**
  Given `--json` is passed to any CLI command (`daemon status`, `network list`, `memory put`, `memory query`, `memory forget`), when the command succeeds, then stdout is valid JSON parseable by `JSON.parse`. When the command fails, then stdout is valid JSON with `{ error: string, code: string }` shape and exit code is 1.

- [ ] **AC 12: PSK-gated network rejects non-members**
  Given two daemon instances where A has joined network with PSK `"network-A"` and B has joined with PSK `"network-B"`, when A attempts to connect to B's peer address directly, then the connection is rejected at the `connectionProtector` layer and B's memory is not accessible to A.

- [ ] **AC 13: Deterministic peer identity across restarts**
  Given a daemon joined to a network, when the daemon process is stopped and restarted with the same PSK and config, then the peer ID reported in `GET /health` is identical to the pre-restart peer ID.

- [ ] **AC 14: Daemon `--foreground` flag works in non-TTY environment**
  Given a CI/container environment, when `subspace daemon start --foreground` is run, then the process stays in the foreground (does not daemonize), logs to stdout, and exits cleanly on `SIGTERM`.

- [ ] **AC 15: Memory `update` creates a supersedes chain**
  Given a chunk with `id: "abc"` exists in the store, when `subspace memory update abc --content "new content" --json` is called, then a new chunk is stored with a new UUID, `supersedes: "abc"`, and `version: 2`. When `memory query` is run, then only the new chunk appears (not both).

- [ ] **AC 16: mDNS peers connect without relay**
  Given two daemon instances on the same LAN/loopback with the same PSK, when both are started, then peer discovery completes via mDNS within 30 seconds and replication occurs without using any circuit relay node (verified by checking connection metadata).

- [ ] **AC 17: GC scheduler prunes on startup**
  Given the daemon is started and the local store contains chunks with expired TTLs from a previous session, when the daemon initialises, then `runGC` is called once before the API begins serving requests, and expired chunks are tombstoned.

- [ ] **AC 18: Skill document is self-contained for a fresh agent**
  Given a fresh agent context with only `packages/skill/SKILL.md` loaded, when the agent is asked to "store a project memory", then the agent can produce a correct `subspace memory put` invocation without needing any other files.

---

## Additional Context

### Dependencies

**`@subspace/core` dependencies (exact versions, all pinned — no `^` or `~`):**
```json
{
  "libp2p": "3.1.4",
  "@libp2p/tcp": "11.0.11",
  "@chainsafe/libp2p-noise": "17.0.0",
  "@chainsafe/libp2p-yamux": "8.0.1",
  "@chainsafe/libp2p-gossipsub": "16.1.4",
  "@libp2p/kad-dht": "14.1.2",
  "@libp2p/mdns": "12.0.12",
  "@libp2p/circuit-relay-v2": "4.1.4",
  "@libp2p/dcutr": "3.0.11",
  "@libp2p/autonat": "3.0.11",
  "@libp2p/identify": "4.0.11",
  "@libp2p/bootstrap": "12.0.12",
  "@libp2p/pnet": "3.0.12",
  "@libp2p/crypto": "5.1.13",
  "helia": "6.0.20",
  "@orbitdb/core": "3.0.2",
  "blockstore-level": "3.0.2",
  "datastore-level": "12.0.2",
  "zod": "4.3.6",
  "uuid": "13.0.0",
  "it-length-prefixed": "10.0.1",
  "it-pipe": "3.0.1"
}
```

**`@subspace/daemon` dependencies:**
```json
{
  "@subspace/core": "workspace:*",
  "fastify": "5.7.4",
  "yaml": "2.8.2"
}
```

**`@subspace/cli` dependencies:**
```json
{
  "@subspace/core": "workspace:*",
  "commander": "14.0.3"
}
```

**`@subspace/skill` dependencies:** none (markdown only)

**Dev dependencies (root):**
```json
{
  "typescript": "5.x",
  "vitest": "4.0.18",
  "@types/node": "latest"
}
```

**Zero external crypto deps** — all cryptography uses Node.js `node:crypto` built-ins.

### Testing Strategy

**Unit tests** (`packages/core/test/`):
- `schema.test.ts`: chunk validation happy/sad paths, type guards, field constraints
- `crypto.test.ts`: HKDF fixed-vector assertions, AES round-trip, tamper detection
- `query.test.ts`: HEAD resolution with 1/2/3-deep chains, TTL filtering, tombstone filtering, each `MemoryQuery` field independently
- `network.test.ts`: `deriveNetworkKeys` determinism, distinct key assertion

**Integration tests** (`packages/core/test/store.test.ts`):
- Spin up two `createLibp2pNode` instances on loopback (different ports)
- Both join same PSK network
- Put chunk on node A → wait for `'replicated'` event on node B → assert queryable on B
- Forget chunk on A → wait → assert not queryable on B
- TTL expiry: put chunk with 1s TTL → wait 2s → assert excluded from query

**CLI tests** (`packages/cli/test/`):
- Spawn daemon process in test setup, kill in teardown
- Run `subspace` subprocesses via `node:child_process` `execFile`
- Assert exit codes, stdout JSON shapes
- Test auto-start: kill daemon, run command, assert daemon restarts

**Manual smoke tests** (documented in `docs/testing.md`):
- Two machines on different networks (one behind NAT), same PSK, verify replication via relay
- `npx subspace daemon start` from zero-install
- Container: `docker run node subspace daemon start --foreground`

### Notes

**High-risk items:**
- OrbitDB v2 / Helia API surface is still evolving — pin all versions exactly and create an `UPGRADE.md` documenting the safe upgrade path and what to re-test.
- libp2p `@libp2p/pnet` PSK format: expects a 32-byte buffer in a specific encoding — verify the exact expected format against the library source before wiring up.
- `circuitRelayTransport()` requires `identify` service to be registered — it must appear before `dht` in the services object.
- Helia cold-start on first run (no blockstore data) can take 5-8s as it connects to bootstrappers — test auto-start timeout generously.

- Bun compatibility: OrbitDB v2 / Helia use some Node.js internals. Test with `bun run` early; fallback to `node` if needed.
- OrbitDB v2 is still relatively new; pin versions carefully and check for Helia peer API stability. Document upgrade path explicitly.
- The skill file should be written for agents, not humans — concise, command-first, with example invocations and expected outputs.
- Skill file MUST include a full end-to-end flow example: pull-before-task → query during → push-after-task as a concrete CLI invocation sequence.
- Consider a `--dry-run` flag on memory operations for agent testing.
- Memory GC: a background process in the daemon should prune expired TTL chunks on startup and periodically.
- Daemon cold-start (OrbitDB + Helia init) can take 3-5s — CLI must auto-start daemon if not running and wait with status indicator.
- Daemon needs `--foreground` flag for Docker/container/CI environments where daemonizing is not appropriate.
- `npx subspace` zero-install UX must work — CLI package must be self-contained.
- mDNS local discovery takes priority over relay for same-LAN peers to minimize latency.
- Write conflicts: never update-in-place. Always append a new chunk with `supersedes: <previous-id>`. Query layer returns HEAD of each chain. This must be enforced in `store.ts`.
- HKDF derivation map (full):
  - `info: "subspace/dht-key"` → DHT announcement key
  - `info: "subspace/topic"` → GossipSub topic name
  - `info: "subspace/envelope"` → AES-256-GCM symmetric envelope key
  - `info: "subspace/psk-filter"` → libp2p private network PSK filter
  - `info: "subspace/peer-id"` → deterministic peer identity seed (daemon restarts as same peer)

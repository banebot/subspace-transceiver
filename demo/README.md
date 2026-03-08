# Subspace Transceiver Demo

Two demos that showcase what Subspace Transceiver does: **every agent gets a permanent identity and address on a global P2P network the moment its daemon starts. No signup, no cloud, no central server. Private encrypted meshes are optional, built on top.**

---

## Demos

### 0. `did-identity-demo.sh` — DID:Key Identity + ZKP Proofs (~2 min)

Showcases the v2 identity stack — requires a running daemon:

- DID:Key identity (`did:key:z6Mk...`) in daemon health endpoint
- ANP capability advertisement (`/capabilities` and `/capabilities/anp`)
- ZKP proof-of-key-ownership generation and verification
- W3C Verifiable Credential (self-signed, selective disclosure)

**Best for:** showcasing the v2 identity stack to engineers and protocol architects.

### 1. `solo-demo.sh` — Full Feature Walkthrough (single terminal, ~3 min)

Walks through every capability narrated like an agent actually using the system:

- Daemon lifecycle (start / status / stop)
- Global identity — agent is on the network from first start, no PSK needed
- Creating a private network with a PSK for memory storage
- Storing memories of all 5 types: `skill`, `project`, `context`, `pattern`, `result`
- Querying by topic, type, and namespace
- Freetext content search
- Updating a memory (creates a versioned supersedes chain)
- Tombstoning (soft-deleting) a memory
- Structured JSON output for programmatic agent use

**Best for:** recorded screencasts, slide decks, stakeholder reviews.

### 2. `two-agent-demo.sh` — Live Two-Agent P2P Demo (tmux split-screen, ~4 min)

Launches two daemons on two different ports. Each daemon gets its own permanent global identity the moment it starts. Both then join the same PSK network to share an encrypted memory workspace.

- Left pane: **Agent Alpha** working on auth
- Right pane: **Agent Beta** working on the API layer
- Both agents appear on the global network immediately — no PSK needed for that
- Alpha stores discoveries to the shared PSK workspace → Beta queries and finds them
- Beta stores its own memories → Alpha queries and sees them
- Both search the same keyword — shared corpus appears on both sides

**Best for:** live demos, "wow moment" demos, recordings that need the P2P story.

**Requires:** `tmux`

---

## Quick Start

```bash
# Install dependencies and build first (if not done yet):
npm install && npm run build

# Run the solo demo
./demo/solo-demo.sh

# Run the two-agent demo (requires tmux)
./demo/two-agent-demo.sh

# Clean up / reset between runs
./demo/reset.sh
```

---

## Recording Tips

### asciinema (recommended — shareable + embeddable)
```bash
# Install: brew install asciinema
asciinema rec subspace-demo.cast
./demo/solo-demo.sh
# Ctrl+D to stop recording
asciinema play subspace-demo.cast
asciinema upload subspace-demo.cast  # get a shareable URL
```

### QuickTime / Screen capture
- Set terminal font size to 16–18pt, window ~120×40
- Use a dark theme (One Dark, Dracula, etc.) for contrast
- Hide browser/dock for a clean recording
- Run `./demo/reset.sh` first so the demo is in a clean state

### Zoom / Loom
- Share only the terminal window
- Run `./demo/solo-demo.sh` — each step has deliberate pauses built in

---

## What to Say (Talking Points)

**Opening hook:**
> "Every AI agent you run is stateless. It starts fresh every time. What if agents could actually *remember* — not just within a session, but across machines, models, and teams? And what if every agent, the moment it starts, had a permanent address on the internet — like a person, not a process? No signup. No cloud. No central server. Just start the daemon and you're on the network."

**After `subspace daemon start` — pointing at the `agentUri` in the output:**
> "That `agent://` URI is this agent's permanent global address. It's derived from an Ed25519 keypair that was generated on first run and lives at `~/.subspace/identity.key`. It doesn't change when you upgrade the model, restart the process, or switch networks. It's the agent's identity — not the model's."

**After creating the PSK network:**
> "Now we're joining a *private workspace* on top of the global network. The PSK is a shared secret — any agent that has it can read and write to the same encrypted memory pool. Think of it like a team Slack channel, but P2P and cryptographically enforced. The agent's global identity stays the same; the PSK just scopes what memories are shared."

**After storing the first memory:**
> "That chunk is now signed with this agent's Ed25519 key, stored in a local Loro CRDT, and broadcast-ready to any other agent on the same PSK network. Anyone who can prove they have the PSK can sync this content via Iroh delta sync. Anyone on the open internet can see that this agent *exists* and browse its public profile — but they can't read this memory."

**During the two-agent demo (when Beta finds Alpha's memory):**
> "Beta didn't ask Alpha anything. It just queried the shared private network. Iroh found Alpha's daemon — potentially anywhere on the internet through the Iroh relay layer, even behind NAT — asked it directly, and got the memories back. No API server. No shared database. Pure P2P QUIC."

**Closing:**
> "This is the infrastructure layer for a global agent internet. The moment a daemon starts, that agent has a permanent address — reachable from anywhere. Private collaboration is a one-liner on top: share a PSK and those same agents form an encrypted mesh. The identity is always global; the privacy layer is optional. Build your memory layer once; any agent, anywhere, can participate."

---

## Architecture Quick Reference

```
[Any Agent — from first daemon start]
     │
     ▼
[Daemon]
  Iroh engine (Ed25519/DID:Key identity — permanent)
  Global discovery (broadcasts to _subspace/discovery)
  Browse protocol (serves public content stubs)
     │
     ▼
Global Subspace Network
(bootstrap + relay infrastructure)
     │
     ├── agent is globally addressable: agent://<peerId>
     └── discovers peers via bloom-filter manifests

[Optional: PSK network overlay]
     │
     ▼
Private encrypted mesh
  Loro CRDT stores (auto-merge on reconnect via delta sync)
  AES-256-GCM content encryption (PSK-derived key)
  Private GossipSub topic (PSK-derived hash)
```

Memory chunks are signed with the agent's Ed25519 identity key, encrypted in transit via PSK-derived keys, and stored in OrbitDB CRDTs that merge automatically when peers reconnect. Agents are globally addressable via their `agent://` URIs — reachable from anywhere through the Subspace relay layer.

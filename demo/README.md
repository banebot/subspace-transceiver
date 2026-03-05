# Subspace Transceiver Demo

Two demos that showcase what Subspace Transceiver does: **a global agent internet — decentralized, persistent memory shared across AI agents over a P2P network** — no central server, no shared database, just a PSK and the global Subspace relay infrastructure.

---

## Demos

### 1. `solo-demo.sh` — Full Feature Walkthrough (single terminal, ~3 min)

Walks through every capability narrated like an agent actually using the system:

- Daemon lifecycle (start / status / stop)
- Creating a private network with a PSK
- Storing memories of all 5 types: `skill`, `project`, `context`, `pattern`, `result`
- Querying by topic, type, and namespace
- Freetext content search
- Updating a memory (creates a versioned supersedes chain)
- Tombstoning (soft-deleting) a memory
- Structured JSON output for programmatic agent use

**Best for:** recorded screencasts, slide decks, stakeholder reviews.

### 2. `two-agent-demo.sh` — Live Two-Agent P2P Demo (tmux split-screen, ~4 min)

Launches two daemons on two different ports. Each daemon joins the same PSK network as a distinct agent identity. Demonstrates memory written by one agent being queried live by the other over the P2P network.

- Left pane: **Agent Alpha** (claude-3-7-sonnet) working on auth
- Right pane: **Agent Beta** (claude-3-5-haiku) working on the API layer
- Alpha stores discoveries → Beta queries the network and finds them
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
> "Every AI agent you run is stateless. It starts fresh every time. What if agents could actually *remember* — not just within a session, but across machines, models, and teams? And what if that memory was private, encrypted, and peer-to-peer — no cloud required? What if agents could find and collaborate with *any other agent on the internet*, without a central coordinator?"

**After storing the first memory:**
> "That chunk is now in a local OrbitDB, pinned to this agent's identity, and broadcast-ready to any other agent sharing the same PSK. Think of the PSK like a shared secret your team generates once — it scopes your agents' private mesh within the global Subspace network."

**During the two-agent demo (when Beta finds Alpha's memory):**
> "Beta didn't ask Alpha anything. It just queried the shared network. The libp2p stack found Alpha's daemon — potentially anywhere on the internet through the Subspace relay layer — asked it directly, and got the memories back. No API server. No shared database. Pure P2P."

**Closing:**
> "This is the infrastructure layer for a global agent internet. Any model, any machine, any team — share a PSK and your agents form a private mesh within a globally connected network. Build your memory layer once; any agent, anywhere, can participate."

---

## Architecture Quick Reference

```
[Agent Alpha CLI]         [Agent Beta CLI]
       │                         │
       ▼                         ▼
[Daemon :7432]           [Daemon :7433]
  FastifyHTTP               FastifyHTTP
  libp2p node               libp2p node
  OrbitDB stores            OrbitDB stores
       │                         │
       └──── PSK Network ─────────┘
           (libp2p + GossipSub)
                   │
                   ▼
       Global Subspace Relay Network
       (public bootstrap + relay infra)
```

Memory chunks are signed with the agent's identity, encrypted in transit via the PSK-derived keys, and stored in OrbitDB CRDTs that merge automatically when peers reconnect. Agents are globally addressable via their libp2p peer IDs — reachable from anywhere through the Subspace relay layer.

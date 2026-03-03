# agent-net

**Decentralized, persistent memory for AI agents — no cloud, no central server, just a PSK.**

Agent-net gives AI agents a shared memory layer backed by [libp2p](https://libp2p.io/) and [OrbitDB](https://orbitdb.org/). Agents on different machines (or different models on the same machine) can store, query, and discover each other's memory over an encrypted P2P network. Connectivity is established with a pre-shared key — generate one, share it with your agents, and they form a private mesh.

```
[Agent Alpha CLI]         [Agent Beta CLI]
       │                         │
       ▼                         ▼
[Daemon :7432]           [Daemon :7433]
  Fastify HTTP              Fastify HTTP
  libp2p node               libp2p node
  OrbitDB stores            OrbitDB stores
       │                         │
       └──── PSK Network ─────────┘
           (libp2p + GossipSub)
```

Memory chunks are signed with the agent's identity, encrypted in transit via PSK-derived keys, and stored in OrbitDB CRDTs that merge automatically when peers reconnect.

---

## Install

### npm (recommended — requires Node.js ≥ 24)

```bash
npm install -g @agent-net/cli
```

The daemon is included as a dependency and starts automatically on first use.

### Standalone binary (no Node.js required)

Download the binary for your platform from the [releases page](../../releases) and put it in your `PATH`:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/<your-org>/agent-net/releases/latest/download/agent-net-macos-arm64 \
  -o /usr/local/bin/agent-net && chmod +x /usr/local/bin/agent-net

# macOS (Intel)
curl -L https://github.com/<your-org>/agent-net/releases/latest/download/agent-net-macos-x64 \
  -o /usr/local/bin/agent-net && chmod +x /usr/local/bin/agent-net

# Linux (x64)
curl -L https://github.com/<your-org>/agent-net/releases/latest/download/agent-net-linux-x64 \
  -o /usr/local/bin/agent-net && chmod +x /usr/local/bin/agent-net
```

Verify it works:

```bash
agent-net --version
```

---

## Quick Start

```bash
# 1. Generate a PSK (do this once — share it with all your agents)
openssl rand -hex 32

# 2. Start the daemon (auto-starts on first command, but explicit is fine)
agent-net daemon start --json

# 3. Join a network
agent-net network join --psk <your-psk> --json

# 4. Store a memory
export AGENT_NET_AGENT_ID=claude-sonnet-4
agent-net memory put \
  --type pattern \
  --topic typescript,async \
  --content "Always await async operations before returning from handlers." \
  --json

# 5. Query memories
agent-net memory query --topic typescript --json

# 6. Search by content
agent-net memory search "async operations" --json
```

Every command supports `--json` for programmatic output. Use it whenever an agent is calling the CLI.

---

## For AI Agents

The [`@agent-net/skill`](./packages/skill/SKILL.md) package contains a `SKILL.md` instruction file that teaches AI agents (Claude, GPT, etc.) how to use agent-net correctly — including error recovery, memory types, namespaces, and a full workflow example.

Install it alongside your agent's skills:

```bash
npm install @agent-net/skill
```

Or point your agent at the SKILL.md directly — it's plain markdown, no runtime required.

---

## Memory Types

| Type | Use for |
|------|---------|
| `skill` | Portable knowledge across ALL projects (patterns, gotchas, how-tos) |
| `project` | Decisions and context scoped to a specific codebase |
| `context` | Current task state — often short-lived (use `--ttl`) |
| `pattern` | Validated code patterns and architectural decisions |
| `result` | Outcomes of completed tasks — what was built, key decisions |

---

## Command Reference

```
agent-net daemon start / stop / status / restart
agent-net network create --psk <key>
agent-net network join --psk <key>
agent-net network leave <id>
agent-net network list
agent-net memory put --type <t> --topic <tags...> --content <text>
agent-net memory get <id>
agent-net memory query --topic <tags...>
agent-net memory search <freetext>
agent-net memory update <id> --content <text>
agent-net memory forget <id>
```

All commands accept `--port <n>` (default: 7432) and `--json`.

---

## Demos

```bash
# Full feature walkthrough (~3 min, single terminal)
./demo/solo-demo.sh

# Live two-agent P2P demo (~4 min, requires tmux)
./demo/two-agent-demo.sh

# Reset between runs
./demo/reset.sh
```

See [demo/README.md](./demo/README.md) for narration scripts and recording tips.

---

## Development

```bash
# Clone and install
git clone https://github.com/<your-org>/agent-net.git
cd agent-net
npm install

# Build all packages
npm run build

# Run tests
npm test

# Build standalone binaries (requires bun)
npm run build:binary          # macOS arm64 + x64, Linux x64
npm run build:binary:linux-x64  # individual platforms
```

### Repo layout

```
packages/
  core/     — libp2p + OrbitDB P2P engine (@agent-net/core)
  daemon/   — Fastify HTTP daemon (@agent-net/daemon)
  cli/      — agent-net CLI binary (@agent-net/cli)
  skill/    — AI agent skill documentation (@agent-net/skill)
demo/       — demo scripts and talking points
specs/      — architecture docs and planning artifacts
```

---

## Publishing (maintainers)

```bash
# Create the @agent-net npm org first: https://www.npmjs.com/org/create
npm login

# Publish all packages (builds automatically via prepublishOnly)
npm publish -w packages/core
npm publish -w packages/daemon
npm publish -w packages/cli
npm publish -w packages/skill
```

Packages are published publicly under the MIT license.

---

## License

[MIT](./LICENSE) — use it, break it, ship it. No warranty.

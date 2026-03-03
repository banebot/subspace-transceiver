# Agent-Net Skill

**Use agent-net when you need to store, retrieve, or share memory across sessions, machines, or agents.**

---

## Prerequisites

1. **Daemon must be running.** Check: `agent-net daemon status --json`
   - If `{ "running": false }`, start it: `agent-net daemon start --json`
2. **Must be joined to at least one network.** Check: `agent-net network list --json`
   - If empty, join one: `agent-net network join --psk <psk> --json`
3. **Set your agent identity** (strongly recommended):
   ```bash
   export AGENT_NET_AGENT_ID=claude-3-7-sonnet  # or your model/instance ID
   ```

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `agent-net daemon start` | Start the daemon (auto-starts if needed) |
| `agent-net daemon stop` | Stop the daemon |
| `agent-net daemon status` | Check daemon health |
| `agent-net network create --psk <key>` | Create/join a network |
| `agent-net network join --psk <key>` | Join an existing network |
| `agent-net network leave <id>` | Leave a network |
| `agent-net network list` | List active networks |
| `agent-net memory put --type <t> --topic <tags...> --content <text>` | Store a memory |
| `agent-net memory get <id>` | Retrieve by ID |
| `agent-net memory query --topic <tags...>` | Query by tags (local) |
| `agent-net memory search <freetext>` | Freetext content search |
| `agent-net memory forget <id>` | Tombstone (soft-delete) a chunk |
| `agent-net memory update <id> --content <text>` | Update a chunk |

**Always add `--json` for programmatic parsing.** Every command supports `--json`.

---

## Agent Identity

Set `AGENT_NET_AGENT_ID` before running any command so all stored chunks carry your model identity in `source.agentId`:

```bash
export AGENT_NET_AGENT_ID=claude-3-7-sonnet
```

Without this, the daemon will use its libp2p peer ID as the agentId (unique per machine but not model-identifiable).

---

## Memory Types Guide

| Type | When to use |
|------|-------------|
| `skill` | Portable knowledge you want to carry across ALL projects (how-to patterns, debugging approaches, API gotchas) |
| `project` | Decisions, context, and findings scoped to a specific project or codebase |
| `context` | Current task state, active thread of reasoning — often short-lived (set a `--ttl`) |
| `pattern` | Reusable code patterns, idioms, architectural decisions you've validated |
| `result` | Outcomes of completed tasks — what was built, key decisions, git refs |

---

## Namespaces

- `--namespace skill` — portable across projects (global agent memory)
- `--namespace project` — scoped to one project (default)

Use `--project <slug>` with project-namespace chunks to scope them to a specific repo.

---

## PSK Security

Generate a secure PSK before creating a network:
```bash
openssl rand -hex 32
```
All agents that share the same PSK can read and write to the same network.
**Treat PSKs like passwords** — they control access to all shared memories.

---

## Output Format

All commands support `--json`. **Always use `--json` for programmatic parsing.**

**Success — single chunk:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "pattern",
  "namespace": "skill",
  "topic": ["typescript", "async"],
  "content": "Always await async operations...",
  "source": {
    "agentId": "claude-3-7-sonnet",
    "peerId": "12D3KooW...",
    "timestamp": 1709400000000
  },
  "confidence": 0.9,
  "network": "a1b2c3...",
  "version": 1
}
```

**Success — array (query results):**
```json
[
  { "id": "...", "type": "skill", ... },
  { "id": "...", "type": "pattern", ... }
]
```

**Error:**
```json
{
  "error": "PSK too short: 8 chars. Minimum is 16.",
  "code": "PSK_TOO_SHORT"
}
```
(Exit code 1 on all errors)

---

## Error Codes & Recovery

| Code | Meaning | Recovery |
|------|---------|----------|
| `PSK_TOO_SHORT` | PSK is less than 16 characters | Use `openssl rand -hex 32` to generate a secure PSK |
| `DECRYPT_FAILED` | AES-GCM authentication failed — data tampered or wrong key | Verify you're using the correct PSK for this network |
| `INVALID_CHUNK` | Chunk validation failed (missing fields, bad types) | Check required fields: `--type`, `--topic`, `--content` |
| `CHUNK_NOT_FOUND` | Chunk with that ID doesn't exist | Verify the ID; it may have been tombstoned or not yet replicated |
| `STORE_WRITE_FAILED` | Could not write to local store | Check disk space and permissions in `~/.agent-net/data/` |
| `STORE_READ_FAILED` | Could not read from local store | Check if daemon is running; restart with `agent-net daemon restart` |
| `JOIN_FAILED` | Failed to join the network | Check PSK validity; verify network connectivity |
| `PEER_DIAL_FAILED` | Could not connect to a specific peer | Network issue — peer may be offline; local queries still work |
| `NETWORK_NOT_FOUND` | Network ID not recognised | Run `agent-net network list --json` to see active networks |
| `DAEMON_TIMEOUT` | Daemon failed to start within 10s | Check `~/.agent-net/` for errors; try `agent-net daemon start --foreground` |
| `DAEMON_NOT_RUNNING` | Daemon is not running | Run `agent-net daemon start --json` |
| `DAEMON_ALREADY_RUNNING` | Daemon already started | Use existing daemon; `agent-net daemon status --json` to confirm |
| `API_ERROR` | HTTP error from daemon API | Check daemon logs; restart with `agent-net daemon restart` |

---

## Full Workflow Example

See [examples/agent-workflow.md](./examples/agent-workflow.md) for a complete pull → query → push workflow with real CLI invocations and expected JSON outputs.

# Agent Workflow: Pull → Query → Push

A complete runnable example of the Subspace Transceiver agent memory loop.
Copy-paste any invocation directly — all commands are real.

---

## Setup (once per session)

```bash
# Set your agent identity
export SUBSPACE_AGENT_ID=claude-3-7-sonnet

# Confirm daemon is running
subspace daemon status --json
# Expected: { "running": true, "status": "ok", "uptime": 42, ... }

# Confirm you're in a network
subspace network list --json
# Expected: [{ "id": "a1b2c3...", "peers": 2, ... }]
# If empty: subspace network join --psk <your-psk> --json
```

---

## Step 1: Before Starting a Task — Pull Context

Check if other agents have left relevant memories for the project:

```bash
subspace memory query \
  --topic typescript,error-handling \
  --namespace project \
  --project myapp \
  --json
```

**Expected output (memories found):**
```json
[
  {
    "id": "7f3a2b1c-1234-4abc-8def-112233445566",
    "type": "pattern",
    "namespace": "project",
    "topic": ["typescript", "error-handling"],
    "content": "In this codebase, all async route handlers must be wrapped in asyncHandler() from src/utils/errors.ts — otherwise Express won't catch promise rejections.",
    "source": {
      "agentId": "claude-3-5-haiku",
      "peerId": "12D3KooWABC...",
      "project": "myapp",
      "timestamp": 1709300000000
    },
    "confidence": 0.95,
    "network": "a1b2c3...",
    "version": 1
  }
]
```

**Expected output (no memories yet):**
```json
[]
```

---

## Step 2: Check for Portable Skill Patterns

Look for patterns that apply across projects:

```bash
subspace memory query \
  --type pattern \
  --topic async,typescript \
  --namespace skill \
  --local \
  --json
```

**Expected output:**
```json
[
  {
    "id": "9a8b7c6d-5678-4def-abcd-998877665544",
    "type": "pattern",
    "namespace": "skill",
    "topic": ["async", "typescript", "libp2p"],
    "content": "DCUtR hole punching requires both peers to be connected to the same relay first. Always bootstrap before expecting direct connections.",
    "source": { "agentId": "claude-3-7-sonnet", "peerId": "12D3KooWXYZ...", "timestamp": 1709200000000 },
    "confidence": 0.95,
    "network": "a1b2c3...",
    "version": 1
  }
]
```

---

## Step 3: During Task — Store a Discovery

Found something important while working? Store it immediately:

```bash
subspace memory put \
  --type pattern \
  --namespace skill \
  --topic typescript,async,orbitdb \
  --content "Always wrap OrbitDB put() calls in try/catch — it throws on blockstore failure, not just validation. The error is a raw LevelDB error, not an OrbitDB-typed error." \
  --confidence 0.9 \
  --json
```

**Expected output:**
```json
{
  "id": "aa11bb22-aaaa-4bbb-cccc-dd1122334455",
  "type": "pattern",
  "namespace": "skill",
  "topic": ["typescript", "async", "orbitdb"],
  "content": "Always wrap OrbitDB put() calls in try/catch...",
  "source": {
    "agentId": "claude-3-7-sonnet",
    "peerId": "12D3KooWXYZ...",
    "timestamp": 1709400000000
  },
  "confidence": 0.9,
  "network": "a1b2c3...",
  "version": 1
}
```

---

## Step 4: After Task — Store the Result

Record what was built and the key decisions made:

```bash
subspace memory put \
  --type result \
  --namespace project \
  --project myapp \
  --topic typescript,refactor,auth \
  --content "Completed auth module refactor (2026-03-02). Key decision: moved JWT validation to middleware layer (src/middleware/auth.ts). Previous approach in each route was causing duplication. See commit abc1234." \
  --confidence 1.0 \
  --json
```

---

## Step 5: Update Stale Memory

Discovered a previous memory is outdated?

```bash
# First find the chunk to update
subspace memory query --topic libp2p,nat-traversal --namespace skill --json
# Note the id from the output, e.g. "9a8b7c6d-..."

# Update it — creates a new chunk with supersedes: <old-id>
subspace memory update 9a8b7c6d-5678-4def-abcd-998877665544 \
  --content "DCUtR hole punching requires both peers connected to same relay first. UPDATED: Also requires identify protocol registered before circuitRelayTransport in libp2p services config — otherwise silent failure." \
  --confidence 0.98 \
  --json
```

**Expected output:**
```json
{
  "id": "ff00ee11-9999-4888-7777-666655554444",
  "type": "pattern",
  "namespace": "skill",
  "topic": ["async", "typescript", "libp2p"],
  "content": "DCUtR hole punching requires both peers connected to same relay first. UPDATED: ...",
  "supersedes": "9a8b7c6d-5678-4def-abcd-998877665544",
  "version": 2,
  "confidence": 0.98,
  ...
}
```

Querying now returns only the new chunk (HEAD of chain) — the old one is hidden.

---

## Step 6: Share Portable Skill Memory

Store a skill that's valuable across ALL your projects — any agent on the Subspace network sharing your PSK will have access to it:

```bash
subspace memory put \
  --type skill \
  --namespace skill \
  --topic libp2p,nat-traversal,circuit-relay \
  --content "When using @libp2p/circuit-relay-v2 in a libp2p v3 node: (1) identify service MUST be listed first in the services config. (2) Both peers need to be connected to the same relay before DCUtR can hole-punch. (3) mDNS handles LAN peers automatically — no relay needed on same network." \
  --confidence 0.95 \
  --json
```

---

## Step 7: Freetext Search

Don't know the exact topic? Search content directly:

```bash
subspace memory search "identify service" --json
```

**Expected output:**
```json
[
  {
    "id": "...",
    "content": "...identify service MUST be listed first...",
    ...
  }
]
```

---

## Step 8: Remove Incorrect Memory

```bash
subspace memory forget aa11bb22-aaaa-4bbb-cccc-dd1122334455 --json
# Expected: { "forgotten": true, "id": "aa11bb22-..." }
```

---

## Error Recovery Examples

**Daemon not running:**
```bash
$ subspace memory put --type skill --topic test --content "hi" --json
# Daemon auto-starts. If it times out:
{ "error": "Daemon failed to start within 10 seconds.", "code": "DAEMON_TIMEOUT" }
# Fix: subspace daemon start --foreground   (check for startup errors)
```

**PSK too short:**
```bash
$ subspace network create --psk "weak" --json
{ "error": "PSK too short: 4 chars. Minimum is 16.", "code": "PSK_TOO_SHORT" }
# Fix: use `openssl rand -hex 32` to generate a proper PSK
```

**Chunk not found:**
```bash
$ subspace memory get nonexistent-id --json
{ "error": "Chunk not found", "code": "CHUNK_NOT_FOUND" }
# The chunk may have been tombstoned or not yet replicated from peers.
# Try: subspace memory query --network --json  (waits for peer responses)
```

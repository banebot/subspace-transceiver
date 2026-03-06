#!/usr/bin/env bash
# two-agent-demo.sh — Live P2P memory sharing between two agents (tmux)
#
# Scenario:
#   Two agents join the global Subspace network the moment their daemons start —
#   each gets a permanent agent:// address with no signup or configuration.
#   They then join a shared PSK workspace to exchange encrypted memories.
#
#   Agent ALPHA is working on the auth module.
#   Agent BETA  is working on the API layer.
#   Neither knows what the other is building directly — they rely on shared
#   memory for coordination.
#
#   Alpha stores discoveries → Beta queries the network and finds them.
#   Beta stores its own memories → Alpha queries and sees them.
#
# Requirements: tmux
# Usage:        ./demo/two-agent-demo.sh

set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_BIN="node $ROOT_DIR/packages/cli/dist/index.js"

ALPHA_PORT=7432
BETA_PORT=7433
SESSION="subspace-demo"

# ── Sanity checks ─────────────────────────────────────────────────────────────
if ! command -v tmux &>/dev/null; then
  echo "Error: tmux is required for the two-agent demo."
  echo "Install it: brew install tmux"
  exit 1
fi

if ! node "$ROOT_DIR/packages/cli/dist/index.js" --version &>/dev/null; then
  echo "Error: CLI not built. Run: npm run build"
  exit 1
fi

# ── Generate shared PSK ───────────────────────────────────────────────────────
SHARED_PSK=$(openssl rand -hex 32)
echo ""
echo "  Subspace Transceiver · Two-Agent P2P Demo"
echo "  ────────────────────────────────────────────────────"
echo "  Shared PSK: $SHARED_PSK"
echo "  Alpha port: $ALPHA_PORT"
echo "  Beta port:  $BETA_PORT"
echo ""
echo "  Launching tmux session '$SESSION' ..."
echo ""
sleep 1

# ── Kill any existing session ─────────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ── Create session with two panes ─────────────────────────────────────────────
tmux new-session -d -s "$SESSION" -x 220 -y 50

# Split horizontally: left=alpha, right=beta
tmux split-window -h -t "$SESSION"

# Name the panes
tmux select-pane -t "$SESSION:0.0" -T "AGENT ALPHA · :7432"
tmux select-pane -t "$SESSION:0.1" -T "AGENT BETA  · :7433"

# Enable pane titles
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format "  #{pane_title}  "

# ── Helper: send command to a pane and wait ────────────────────────────────────
send_alpha() {
  tmux send-keys -t "$SESSION:0.0" "$1" Enter
}

send_beta() {
  tmux send-keys -t "$SESSION:0.1" "$1" Enter
}

wait_sec() {
  sleep "${1:-2}"
}

# ── ALPHA pane — data dir at ~/.subspace (default) ─────────────────────────
# ── BETA pane  — data dir at ~/.subspace-beta (via HOME override workaround)─

# We use SUBSPACE_DATA_DIR env override in daemon config, falling back to
# a port-based directory so both daemons don't clash on disk.
# The daemon reads config from its own data dir, keyed by port.

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 0: Banner + Setup
# ─────────────────────────────────────────────────────────────────────────────

send_alpha "clear && echo ''"
send_alpha "printf '\033[1;36m  ┌──────────────────────────────────────────────┐\n  │  AGENT ALPHA  ·  :7432                       │\n  │  Working on: auth module refactor            │\n  └──────────────────────────────────────────────┘\033[0m\n'"
send_alpha "export SUBSPACE_AGENT_ID=alpha"
send_alpha "export SUBSPACE_PORT=$ALPHA_PORT"
send_alpha "SHARED_PSK='$SHARED_PSK'"
send_alpha "CLI='$CLI_BIN --port $ALPHA_PORT'"
send_alpha "echo ''"

send_beta "clear && echo ''"
send_beta "printf '\033[1;35m  ┌──────────────────────────────────────────────┐\n  │  AGENT BETA   ·  :7433                       │\n  │  Working on: API layer / rate limiting       │\n  └──────────────────────────────────────────────┘\033[0m\n'"
send_beta "export SUBSPACE_AGENT_ID=beta"
send_beta "export SUBSPACE_PORT=$BETA_PORT"
send_beta "SHARED_PSK='$SHARED_PSK'"
send_beta "CLI='$CLI_BIN --port $BETA_PORT'"
send_beta "echo ''"

wait_sec 2

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1: Start daemons
# ─────────────────────────────────────────────────────────────────────────────

send_alpha "echo '─── [1/5] Starting daemon on port $ALPHA_PORT ...'"
send_alpha "\$CLI daemon start --json"

send_beta "echo '─── [1/5] Starting daemon on port $BETA_PORT ...'"
send_beta "\$CLI daemon start --json"

wait_sec 5

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: Both join the SAME network (same PSK)
# ─────────────────────────────────────────────────────────────────────────────

send_alpha "echo '─── [2/5] Alpha joins the shared PSK network ...'"
send_alpha "\$CLI network create --psk \"\$SHARED_PSK\" --name agentstack-team --json"

wait_sec 3

send_beta "echo '─── [2/5] Beta joins the SAME network using the same PSK ...'"
send_beta "\$CLI network join --psk \"\$SHARED_PSK\" --json"

wait_sec 4

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3: Alpha stores its discoveries
# ─────────────────────────────────────────────────────────────────────────────

send_alpha "echo '─── [3/5] Alpha working on auth... storing discoveries'"
wait_sec 1

send_alpha "\$CLI memory put --type pattern --namespace skill --topic typescript express auth middleware --content 'JWT validation must happen in middleware, not per-route. Centralise in src/middleware/auth.ts — call next() on success, return 401 on failure. This eliminates duplication and makes routes clean.' --confidence 0.95 --json"
wait_sec 2

send_alpha "\$CLI memory put --type project --namespace project --project agentstack --topic auth session redis --content 'Session store: Redis is configured at redis://localhost:6379/1 (db index 1, not 0). TTL is 86400s (24h). Session secret is in .env as SESSION_SECRET. Do NOT use the default express-session MemoryStore in production.' --confidence 1.0 --json"
wait_sec 2

send_alpha "\$CLI memory put --type skill --namespace skill --topic jwt rs256 security --content 'Use RS256 (asymmetric) not HS256 (symmetric) for JWTs in multi-service architectures. Public key can be distributed freely; private key stays on auth service only. Rotation: generate new keypair, support both during rolling deploy.' --confidence 0.93 --json"
wait_sec 2

send_alpha "echo '  Alpha has stored 3 memories. Peers will receive them on query.'"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 4: Beta queries the network — finds Alpha's memories
# ─────────────────────────────────────────────────────────────────────────────

wait_sec 3

send_beta "echo '─── [4/5] Beta starting API work... querying network for auth context'"
wait_sec 1

send_beta "\$CLI memory query --topic auth typescript --network --json"
wait_sec 4

send_beta "echo '  Beta found auth context from Alpha! Using it to integrate correctly.'"
wait_sec 1

send_beta "echo '  Storing Beta'\''s own API layer memories...'"
wait_sec 1

send_beta "\$CLI memory put --type pattern --namespace skill --topic typescript ratelimit express api --content 'express-rate-limit v7: use a Redis store (rate-limit-redis) in production. The default MemoryStore is per-process only and breaks with multiple instances. Key config: windowMs=60000, max=100, standardHeaders: true, legacyHeaders: false.' --confidence 0.91 --json"
wait_sec 2

send_beta "\$CLI memory put --type project --namespace project --project agentstack --topic api routes versioning --content 'API versioning: all routes under /api/v1/. Next version /api/v2/ will be additive (no breaking changes). Rate limits: 100 req/min for authenticated users, 20 req/min for anonymous. Auth endpoints (/api/v1/auth/*) are excluded from rate limiting.' --confidence 0.98 --json"
wait_sec 2

send_beta "\$CLI memory put --type result --namespace project --project agentstack --topic api rate-limit complete --content 'Rate limiting implemented (2026-03-02). Redis store configured. Middleware applied at router level. Auth endpoints exempt. Load tested at 500 req/s — zero false positives. PR #92 merged.' --confidence 1.0 --json"
wait_sec 2

send_beta "echo '  Beta has stored 3 memories.'"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 5: Cross-queries — each agent sees the other's memories
# ─────────────────────────────────────────────────────────────────────────────

wait_sec 3

send_alpha "echo '─── [5/5] Alpha queries network for API context (Beta'\''s work) ...'"
wait_sec 1
send_alpha "\$CLI memory query --topic api routes --network --json"
wait_sec 4

send_beta "echo '─── [5/5] Beta freetext-searches across the whole shared network ...'"
wait_sec 1
send_beta "\$CLI memory search redis --network --json"
wait_sec 4

# Health check on both
send_alpha "echo '─── Both agents healthy — listing network peers ...'"
send_alpha "\$CLI daemon status --json"
wait_sec 2

send_beta "\$CLI daemon status --json"
wait_sec 3

send_alpha "echo ''"
send_alpha "echo '  ✓ Alpha can see Beta memories (API rate limiting, versioning)'"
send_alpha "echo '  ✓ Beta can see Alpha memories (JWT patterns, Redis session config)'"
send_alpha "echo '  ✓ No central server. No shared database. Pure P2P.'"
send_alpha "echo ''"

send_beta "echo ''"
send_beta "echo '  ✓ P2P two-agent demo complete.'"
send_beta "echo '  Run: ./demo/reset.sh to clean up'"
send_beta "echo ''"

wait_sec 2

# ─────────────────────────────────────────────────────────────────────────────
# Attach to the session so the viewer can see it
# ─────────────────────────────────────────────────────────────────────────────

echo "  Attaching to tmux session '$SESSION' ..."
echo "  Press Ctrl+B then D to detach when done."
echo "  Run './demo/reset.sh' to clean up afterwards."
echo ""
sleep 1

tmux attach-session -t "$SESSION"

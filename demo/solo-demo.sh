#!/usr/bin/env bash
# solo-demo.sh — Full Subspace Transceiver feature walkthrough (single terminal)
#
# Scenario: Agent "alpha" is working on a TypeScript
# project called "agentstack". It discovers useful patterns, stores them,
# queries them back, updates a memory, and finally cleans up.
#
# Runtime: ~3 minutes. Built-in pauses for recording / narration.
# Usage:   ./demo/solo-demo.sh

set -euo pipefail

# ── Resolve CLI path relative to this script ─────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="node $ROOT_DIR/packages/cli/dist/index.js"

# ── Colours ──────────────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[0;36m'
BCYAN='\033[1;36m'
GREEN='\033[0;32m'
BGREEN='\033[1;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────

# Print a section header
header() {
  echo ""
  echo -e "${BCYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BCYAN}║${NC}  ${BOLD}$1${NC}"
  echo -e "${BCYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

# Print a narration line (what's happening / why)
narrate() {
  echo -e "${DIM}▸ $1${NC}"
}

# Print and run a CLI command with nice formatting
run() {
  local label="${1}"
  local cmd="${2}"
  echo -e "${YELLOW}  \$${NC} ${WHITE}${cmd}${NC}"
  sleep 0.4
  eval "$cmd"
  echo ""
}

# Short pause (between commands)
pause() {
  sleep "${1:-1.2}"
}

# Long pause (between sections — time for narration in a recording)
lpause() {
  sleep "${1:-2.5}"
}

# ─────────────────────────────────────────────────────────────────────────────

clear
echo ""
echo -e "${BOLD}${BCYAN}  ╔═══════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BCYAN}  ║        a g e n t - n e t             ║${NC}"
echo -e "${BOLD}${BCYAN}  ║      Global Agent Internet            ║${NC}"
echo -e "${BOLD}${BCYAN}  ╚═══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${DIM}Scenario: Agent \"alpha\" joins the global network and builds on a TypeScript project.${NC}"
echo -e "  ${DIM}It has a permanent address from first start — no signup, no config.${NC}"
echo -e "  ${DIM}It stores discoveries as it works — patterns, context, results.${NC}"
echo -e "  ${DIM}Everything persists. Everything is queryable. Everything is P2P.${NC}"
echo ""
lpause 3

# ─── SECTION 1: Daemon ───────────────────────────────────────────────────────

header "1 / 7  ·  DAEMON LIFECYCLE"

narrate "First, check if the daemon is already running."
pause

run "status check" "$CLI daemon status --json"
pause

narrate "Not running — start it. The daemon manages the P2P node and HTTP API."
pause

run "start daemon" "$CLI daemon start --json"
lpause

narrate "Daemon is up. Let's confirm health."
pause

run "health check" "$CLI daemon status --json"
lpause 3

# ─── SECTION 2: Global Identity ──────────────────────────────────────────────

header "2 / 7  ·  GLOBAL IDENTITY"

narrate "From the moment the daemon started, this agent is on the global Subspace network."
narrate "No signup, no configuration. Check the permanent agent address:"
pause

run "whoami" "$CLI site whoami --json"
lpause

narrate "That agent:// URI is derived from an Ed25519 keypair generated on first run."
narrate "It never changes — stable across restarts, upgrades, and network changes."
pause

narrate "See what other agents are discoverable on the network right now:"
pause

run "discover peers" "$CLI discover peers --json"
lpause 3

# ─── SECTION 3: Network ──────────────────────────────────────────────────────

header "3 / 7  ·  JOIN A PRIVATE WORKSPACE"

narrate "Generate a cryptographically strong PSK — this is the shared secret."
narrate "Any agent with this PSK can join the network. Treat it like a password."
pause

PSK=$(openssl rand -hex 32)
echo -e "${YELLOW}  \$${NC} ${WHITE}PSK=\$(openssl rand -hex 32)${NC}"
echo -e "  ${MAGENTA}${PSK}${NC}"
echo ""
pause

narrate "Join the network. A libp2p node bootstraps, OrbitDB stores are opened."
pause

NET_JSON=$($CLI network create --psk "$PSK" --name "agentstack-team" --json)
echo -e "${YELLOW}  \$${NC} ${WHITE}$CLI network create --psk \$PSK --name agentstack-team --json${NC}"
echo "$NET_JSON" | python3 -m json.tool 2>/dev/null || echo "$NET_JSON"
echo ""
NETWORK_ID=$(echo "$NET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
lpause

narrate "List active networks."
pause

run "list networks" "$CLI network list --json"
lpause 3

# ─── SECTION 3: Storing Memories ─────────────────────────────────────────────

export SUBSPACE_AGENT_ID=alpha

header "4 / 7  ·  STORING MEMORIES  (agent: alpha)"

narrate "Set agent identity — all chunks will carry this in source.agentId."
echo -e "${YELLOW}  \$${NC} ${WHITE}export SUBSPACE_AGENT_ID=alpha${NC}"
echo ""
pause

# ── context chunk ──
narrate "[context] Store current task state — scoped to this project, short-lived."
pause

CONTEXT_JSON=$($CLI memory put \
  --type context \
  --namespace project \
  --project agentstack \
  --topic auth typescript middleware \
  --content "Working on the auth middleware refactor (2026-03-02). Current focus: moving JWT validation out of individual routes and into a central middleware at src/middleware/auth.ts. Previous approach caused duplication across 12 route files." \
  --confidence 1.0 \
  --json)

echo -e "${YELLOW}  \$${NC} ${WHITE}subspace memory put \\${NC}"
echo -e "  ${WHITE}  --type context --namespace project --project agentstack \\${NC}"
echo -e "  ${WHITE}  --topic auth typescript middleware \\${NC}"
echo -e "  ${WHITE}  --content \"Working on the auth middleware refactor...\" \\${NC}"
echo -e "  ${WHITE}  --confidence 1.0 --json${NC}"
echo ""
echo "$CONTEXT_JSON" | python3 -m json.tool 2>/dev/null || echo "$CONTEXT_JSON"
CONTEXT_ID=$(echo "$CONTEXT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
echo ""
lpause

# ── pattern chunk ──
narrate "[pattern] Found a gotcha worth sharing — store as a reusable pattern."
pause

PATTERN_JSON=$($CLI memory put \
  --type pattern \
  --namespace skill \
  --topic typescript express async error-handling \
  --content "Express async route handlers don't catch rejected promises by default (pre-v5). Always wrap handlers with asyncHandler(fn) from 'express-async-handler' or use an explicit try/catch. Silent failures are the #1 bug in Express apps." \
  --confidence 0.95 \
  --json)

echo -e "${YELLOW}  \$${NC} ${WHITE}subspace memory put \\${NC}"
echo -e "  ${WHITE}  --type pattern --namespace skill \\${NC}"
echo -e "  ${WHITE}  --topic typescript express async error-handling \\${NC}"
echo -e "  ${WHITE}  --content \"Express async route handlers don't catch...\" \\${NC}"
echo -e "  ${WHITE}  --confidence 0.95 --json${NC}"
echo ""
echo "$PATTERN_JSON" | python3 -m json.tool 2>/dev/null || echo "$PATTERN_JSON"
PATTERN_ID=$(echo "$PATTERN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
echo ""
lpause

# ── skill chunk ──
narrate "[skill] Cross-project knowledge about JWTs — goes to the skill namespace."
pause

SKILL_JSON=$($CLI memory put \
  --type skill \
  --namespace skill \
  --topic jwt auth security typescript \
  --content "jsonwebtoken v9+ changed the verify() signature: callback is now optional and synchronous mode throws instead of returning null on invalid tokens. Always wrap jwt.verify() in try/catch. Also: RS256 is preferred over HS256 for multi-service systems — public key can be shared freely." \
  --confidence 0.92 \
  --json)

echo -e "${YELLOW}  \$${NC} ${WHITE}subspace memory put \\${NC}"
echo -e "  ${WHITE}  --type skill --namespace skill \\${NC}"
echo -e "  ${WHITE}  --topic jwt auth security typescript \\${NC}"
echo -e "  ${WHITE}  --content \"jsonwebtoken v9+ changed the verify() signature...\" \\${NC}"
echo -e "  ${WHITE}  --confidence 0.92 --json${NC}"
echo ""
echo "$SKILL_JSON" | python3 -m json.tool 2>/dev/null || echo "$SKILL_JSON"
SKILL_ID=$(echo "$SKILL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
echo ""
lpause

# ── result chunk ──
narrate "[result] Task complete — record the outcome for future agents."
pause

RESULT_JSON=$($CLI memory put \
  --type result \
  --namespace project \
  --project agentstack \
  --topic auth refactor complete \
  --content "Auth middleware refactor complete (2026-03-02). All JWT validation centralised in src/middleware/auth.ts. Routes now just call next() on success. 12 route files simplified. Tests pass. PR #88 merged to main. Key commit: abc1234." \
  --confidence 1.0 \
  --json)

echo -e "${YELLOW}  \$${NC} ${WHITE}subspace memory put \\${NC}"
echo -e "  ${WHITE}  --type result --namespace project --project agentstack \\${NC}"
echo -e "  ${WHITE}  --topic auth refactor complete \\${NC}"
echo -e "  ${WHITE}  --content \"Auth middleware refactor complete...\" \\${NC}"
echo -e "  ${WHITE}  --confidence 1.0 --json${NC}"
echo ""
echo "$RESULT_JSON" | python3 -m json.tool 2>/dev/null || echo "$RESULT_JSON"
RESULT_ID=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
echo ""
lpause 3

# ─── SECTION 4: Querying ─────────────────────────────────────────────────────

header "5 / 7  ·  QUERYING MEMORIES"

narrate "Query by topic — fast local lookup, sub-10ms."
pause

run "query by topic" "$CLI memory query --topic auth typescript --json"
lpause

narrate "Filter by type — only results from this project."
pause

run "query by type+project" "$CLI memory query --type result --namespace project --project agentstack --json"
lpause

narrate "Query skill namespace — cross-project portable knowledge."
pause

run "query skill namespace" "$CLI memory query --namespace skill --json"
lpause

narrate "Retrieve a specific chunk by ID."
pause

if [[ -n "$SKILL_ID" ]]; then
  run "get by id" "$CLI memory get $SKILL_ID --json"
fi
lpause

narrate "Freetext search — searches content substring across all memories."
pause

run "freetext search: jwt" "$CLI memory search jwt --json"
lpause

run "freetext search: wrap" "$CLI memory search wrap --json"
lpause 3

# ─── SECTION 5: Update & Versioning ──────────────────────────────────────────

header "6 / 7  ·  UPDATING MEMORIES  (versioned supersedes chain)"

narrate "Found a correction to the Express pattern — update it."
narrate "This creates a NEW chunk with supersedes: <old-id>. The old chunk is hidden."
pause

if [[ -n "$PATTERN_ID" ]]; then
  echo -e "${YELLOW}  \$${NC} ${WHITE}subspace memory update $PATTERN_ID \\${NC}"
  echo -e "  ${WHITE}  --content \"Express v5 finally fixes async error propagation natively...\" \\${NC}"
  echo -e "  ${WHITE}  --confidence 0.98 --json${NC}"
  echo ""

  UPDATED_JSON=$($CLI memory update "$PATTERN_ID" \
    --content "Express async route handlers: in v4 you must wrap with asyncHandler(). UPDATED: Express v5 (released 2024) natively propagates async errors — no wrapper needed. If you're still on v4 and can't upgrade, use 'express-async-errors' package (zero-config monkey-patch)." \
    --confidence 0.98 \
    --json)
  echo "$UPDATED_JSON" | python3 -m json.tool 2>/dev/null || echo "$UPDATED_JSON"
  UPDATED_ID=$(echo "$UPDATED_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
  echo ""
  lpause

  narrate "Query the topic now — only the updated HEAD appears, old version is hidden."
  pause
  run "query after update" "$CLI memory query --topic typescript express --json"
  lpause

  narrate "The supersedes chain: new chunk points back to the original ID."
  if [[ -n "$UPDATED_ID" ]]; then
    echo -e "${DIM}  new id:       ${UPDATED_ID}${NC}"
    echo -e "${DIM}  supersedes:   ${PATTERN_ID}${NC}"
  fi
  echo ""
fi

lpause

narrate "Tombstone the context chunk — it was temporary task state."
pause

if [[ -n "$CONTEXT_ID" ]]; then
  run "forget (tombstone)" "$CLI memory forget $CONTEXT_ID --json"
fi

narrate "Context chunk is gone from query results."
pause
run "verify forget" "$CLI memory query --type context --namespace project --project agentstack --json"
lpause 3

# ─── SECTION 6: JSON Mode ────────────────────────────────────────────────────

header "7 / 7  ·  AGENT-FIRST JSON OUTPUT"

narrate "Every command supports --json for machine-readable structured output."
narrate "Agents pipe this directly into their reasoning loop:"
echo ""
echo -e "  ${DIM}memories=\$(subspace memory query --topic auth --namespace skill --json)${NC}"
echo -e "  ${DIM}# feed \$memories into your LLM context window...${NC}"
echo ""
pause

run "final query (json)" "$CLI memory query --namespace skill --json"
lpause

narrate "The daemon health endpoint — useful for agent pre-flight checks:"
pause

run "health (json)" "$CLI daemon status --json"
lpause 3

# ─── Wrap up ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BGREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BGREEN}║${NC}  ${BOLD}Demo complete.${NC}"
echo -e "${BGREEN}║${NC}"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Daemon started — agent joined global network immediately"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Permanent agent:// identity confirmed (no signup required)"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Private workspace joined (PSK network for memory storage)"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Memories stored: context, pattern, skill, result"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Queried by topic, type, namespace, and freetext"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Memory updated with versioned supersedes chain"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Memory tombstoned (soft-deleted)"
echo -e "${BGREEN}║${NC}  ${GREEN}✓${NC} Structured JSON output throughout"
echo -e "${BGREEN}║${NC}"
echo -e "${BGREEN}║${NC}  ${DIM}Next: run ./demo/two-agent-demo.sh to see P2P memory sharing.${NC}"
echo -e "${BGREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

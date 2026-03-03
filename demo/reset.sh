#!/usr/bin/env bash
# reset.sh — clean slate between demo runs
# Stops any running daemons and wipes all persisted agent-net data.

set -euo pipefail

BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BOLD}agent-net demo reset${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Kill any running daemon (port 7432 and 7433 for two-agent demo)
for PORT in 7432 7433; do
  PID_FILE="$HOME/.agent-net-${PORT}/daemon.pid"
  if [[ -f "$PID_FILE" ]]; then
    PID=$(node -e "try{const e=require('fs').readFileSync('$PID_FILE','utf8');console.log(JSON.parse(e).pid)}catch{}" 2>/dev/null || true)
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      echo -e "  Stopping daemon on port $PORT (PID $PID)..."
      kill "$PID" 2>/dev/null || true
      sleep 1
    fi
  fi
done

# Also kill by port in case pid file is stale
for PORT in 7432 7433; do
  PIDS=$(lsof -ti tcp:$PORT 2>/dev/null || true)
  if [[ -n "$PIDS" ]]; then
    echo -e "  Killing process(es) on port $PORT: $PIDS"
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
done

# Wipe data directories
for DIR in "$HOME/.agent-net" "$HOME/.agent-net-7432" "$HOME/.agent-net-7433"; do
  if [[ -d "$DIR" ]]; then
    echo -e "  Removing $DIR ..."
    rm -rf "$DIR"
  fi
done

# Kill any leftover tmux session from the two-agent demo
if tmux has-session -t agent-net-demo 2>/dev/null; then
  echo -e "  Killing tmux session 'agent-net-demo'..."
  tmux kill-session -t agent-net-demo
fi

echo ""
echo -e "${GREEN}✓ Reset complete. Ready for a fresh demo.${NC}"
echo ""

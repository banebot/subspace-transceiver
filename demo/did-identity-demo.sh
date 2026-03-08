#!/usr/bin/env bash
# did-identity-demo.sh — DID:Key identity + ANP capability negotiation + ZKP proofs
#
# Showcases the v2 identity stack:
#   1. DID:Key identity in daemon health
#   2. ANP capability negotiation endpoint
#   3. ZKP proof-of-key-ownership generation and verification
#   4. Self-signed W3C Verifiable Credential
#
# Runtime: ~2 minutes. Requires daemon to be running.
# Usage:   ./demo/did-identity-demo.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="node $ROOT_DIR/packages/cli/dist/index.js"

BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[0;36m'
BCYAN='\033[1;36m'
GREEN='\033[0;32m'
BGREEN='\033[1;32m'
YELLOW='\033[1;33m'
WHITE='\033[1;37m'
NC='\033[0m'

header() {
  echo ""
  echo -e "${BCYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BCYAN}║${NC}  ${BOLD}$1${NC}"
  echo -e "${BCYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

narrate() { echo -e "${DIM}▸ $1${NC}"; }
pause() { sleep "${1:-1.2}"; }

DAEMON_PORT="${SUBSPACE_PORT:-7432}"
API="http://localhost:$DAEMON_PORT"

header "DID:Key Identity — Subspace v2"

narrate "Every agent has a permanent DID:Key identity derived from its Ed25519 keypair."
narrate "This is stable across restarts and expressed as: did:key:z6Mk..."
pause

echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s $API/health | jq '{peerId,did,agentUri}'${NC}"
curl -s "$API/health" | python3 -m json.tool --no-ensure-ascii 2>/dev/null || \
  curl -s "$API/health"
echo ""
pause 2

header "ANP Capability Negotiation"

narrate "Agents advertise capabilities in Agent Network Protocol (ANP) format."
narrate "Any agent can query what another agent supports — even without a PSK."
pause

echo -e "${YELLOW}  \$${NC} ${WHITE}# Basic capability list${NC}"
echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s $API/capabilities | jq .${NC}"
curl -s "$API/capabilities" | python3 -m json.tool 2>/dev/null || curl -s "$API/capabilities"
echo ""
pause 1.5

echo -e "${YELLOW}  \$${NC} ${WHITE}# ANP-format advertisement (for cross-agent interop)${NC}"
echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s $API/capabilities/anp | jq .${NC}"
curl -s "$API/capabilities/anp" | python3 -m json.tool 2>/dev/null || curl -s "$API/capabilities/anp"
echo ""
pause 2

header "ZKP Proof of Key Ownership"

narrate "Agents can prove they control a DID:Key without revealing their private key."
narrate "This is a challenge-response proof: SHA-256(domain || did || timestamp || nonce)."
narrate "The proof is time-limited (5 minutes by default)."
pause

echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s -X POST $API/identity/proof | jq .${NC}"
PROOF=$(curl -s -X POST "$API/identity/proof" -H "Content-Type: application/json" -d '{}')
echo "$PROOF" | python3 -m json.tool 2>/dev/null || echo "$PROOF"
echo ""
pause 2

narrate "Now verify the proof (simulating what another agent would do):"
echo -e "${YELLOW}  \$${NC} ${WHITE}# Send proof to /identity/verify${NC}"
echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s -X POST $API/identity/verify -d '<proof>'${NC}"
VERIFY_RESULT=$(echo "$PROOF" | curl -s -X POST "$API/identity/verify" \
  -H "Content-Type: application/json" -d @-)
echo "$VERIFY_RESULT" | python3 -m json.tool 2>/dev/null || echo "$VERIFY_RESULT"
echo ""
pause 2

header "W3C Verifiable Credential"

narrate "Agents can issue self-signed Verifiable Credentials for capability advertisement."
narrate "Each claim has a commitment hash enabling selective disclosure."
pause

echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s -X POST $API/identity/credential | jq .${NC}"
CRED=$(curl -s -X POST "$API/identity/credential" -H "Content-Type: application/json" -d '{}')
echo "$CRED" | python3 -c "
import json, sys
data = json.load(sys.stdin)
# Show key fields only
print(json.dumps({
  'type': data.get('type'),
  'issuer': data.get('issuer'),
  'issuanceDate': data.get('issuanceDate'),
  'expirationDate': data.get('expirationDate'),
  'claimCount': len(data.get('credentialSubject', {}).get('claims', [])),
  'proof.type': data.get('proof', {}).get('type'),
}, indent=2))
" 2>/dev/null || echo "$CRED"
echo ""
pause 2

narrate "Verify the credential:"
echo -e "${YELLOW}  \$${NC} ${WHITE}curl -s -X POST $API/identity/credential/verify -d '<credential>'${NC}"
VCVERIFY=$(echo "$CRED" | curl -s -X POST "$API/identity/credential/verify" \
  -H "Content-Type: application/json" -d @-)
echo "$VCVERIFY" | python3 -m json.tool 2>/dev/null || echo "$VCVERIFY"
echo ""

echo -e "${BGREEN}✔${NC}  ${BOLD}Identity demo complete.${NC}"
echo -e "${DIM}DID:Key identity, ANP capabilities, ZKP proofs — all powered by the agent's Ed25519 key.${NC}"
echo ""

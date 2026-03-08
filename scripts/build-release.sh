#!/usr/bin/env bash
# build-release.sh — Build the full Subspace release bundle (CLI + Iroh engine)
#
# Produces per-platform directories under bin/release/:
#   bin/release/macos-arm64/
#     subspace           ← bun-compiled CLI
#     subspace-engine    ← Cargo-compiled Iroh engine binary
#   bin/release/macos-x64/
#   bin/release/linux-x64/
#
# The CLI binary uses EngineBridge to launch the sidecar engine from the same
# directory (looks for ./subspace-engine or ../subspace-engine).
#
# Usage:
#   ./scripts/build-release.sh [macos-arm64|macos-x64|linux-x64|all]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
RELEASE_DIR="$BIN_DIR/release"

TARGET="${1:-all}"

# ── TypeScript build ─────────────────────────────────────────────────────────
build_ts() {
  echo "==> Building TypeScript packages..."
  cd "$REPO_ROOT"
  npm run build
}

# ── Rust engine: native host build ──────────────────────────────────────────
build_rust_native() {
  echo "==> Building Rust engine (native)..."
  cd "$REPO_ROOT/packages/engine"
  cargo build --release
}

# ── Rust engine: cross-compile for target ────────────────────────────────────
build_rust_cross() {
  local rust_target="$1"
  echo "==> Cross-compiling Rust engine for $rust_target..."
  cd "$REPO_ROOT/packages/engine"
  # Requires: cross (cargo install cross) or rustup target add $rust_target
  if command -v cross &>/dev/null; then
    cross build --release --target "$rust_target"
  else
    cargo build --release --target "$rust_target"
  fi
}

# ── CLI: bun compile ─────────────────────────────────────────────────────────
build_cli() {
  local bun_target="$1"
  local out_name="$2"
  echo "==> Compiling CLI for $bun_target..."
  cd "$REPO_ROOT"
  bun build --compile \
    --target="$bun_target" \
    packages/cli/binary-entry.ts \
    --outfile "$out_name"
}

# ── Bundle: assemble platform directory ──────────────────────────────────────
assemble() {
  local platform="$1"
  local cli_binary="$2"
  local engine_binary="$3"

  local out_dir="$RELEASE_DIR/$platform"
  mkdir -p "$out_dir"
  cp "$cli_binary" "$out_dir/subspace"
  cp "$engine_binary" "$out_dir/subspace-engine"
  chmod +x "$out_dir/subspace" "$out_dir/subspace-engine"

  echo "==> Bundle ready: $out_dir"
  ls -lh "$out_dir"
}

# ─────────────────────────────────────────────────────────────────────────────

build_ts

mkdir -p "$RELEASE_DIR"

case "$TARGET" in
  macos-arm64)
    build_cli "bun-darwin-arm64" "$BIN_DIR/subspace-macos-arm64"
    # For local builds on arm64 mac, native build works
    build_rust_native
    assemble "macos-arm64" \
      "$BIN_DIR/subspace-macos-arm64" \
      "$REPO_ROOT/packages/engine/target/release/subspace-engine"
    ;;

  macos-x64)
    build_cli "bun-darwin-x64" "$BIN_DIR/subspace-macos-x64"
    build_rust_cross "x86_64-apple-darwin"
    assemble "macos-x64" \
      "$BIN_DIR/subspace-macos-x64" \
      "$REPO_ROOT/packages/engine/target/x86_64-apple-darwin/release/subspace-engine"
    ;;

  linux-x64)
    build_cli "bun-linux-x64" "$BIN_DIR/subspace-linux-x64"
    build_rust_cross "x86_64-unknown-linux-musl"
    assemble "linux-x64" \
      "$BIN_DIR/subspace-linux-x64" \
      "$REPO_ROOT/packages/engine/target/x86_64-unknown-linux-musl/release/subspace-engine"
    ;;

  all)
    "$0" macos-arm64 || echo "WARNING: macos-arm64 build failed"
    "$0" macos-x64   || echo "WARNING: macos-x64 build failed"
    "$0" linux-x64   || echo "WARNING: linux-x64 build failed"
    echo ""
    echo "==> Release bundles:"
    ls -lh "$RELEASE_DIR"/*/
    ;;

  *)
    echo "Usage: $0 [macos-arm64|macos-x64|linux-x64|all]"
    exit 1
    ;;
esac

echo ""
echo "==> Build complete."

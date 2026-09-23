#!/usr/bin/env bash
#
# Build the `epic` binary for local execution on macOS and package it into a
# distributable tarball under dist/.
#
# The host is Apple Silicon (aarch64-apple-darwin), so this is a native release
# build. On an Intel Mac it will build for x86_64-apple-darwin instead.
#
# Usage:
#   build/package-macos.sh            # native build for this Mac
#   VERSION=0.1.0 build/package-macos.sh
#
set -euo pipefail

# --- locate repo + load cargo ------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$REPO_ROOT/rust"
DIST_DIR="$REPO_ROOT/dist"

# shellcheck disable=SC1090
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
command -v cargo >/dev/null 2>&1 || { echo "error: cargo not found (install Rust: https://rustup.rs)"; exit 1; }

# Corporate TLS interception (e.g. Zscaler): if a vendored root CA is present,
# point cargo at it so crates.io downloads don't fail with
# "unable to get local issuer certificate". Honors a pre-set CARGO_HTTP_CAINFO.
CA_CERT="${CARGO_HTTP_CAINFO:-$REPO_ROOT/build/certs/zscaler-root-ca.crt}"
if [ -f "$CA_CERT" ]; then
  export CARGO_HTTP_CAINFO="$CA_CERT"
  export SSL_CERT_FILE="${SSL_CERT_FILE:-$CA_CERT}"
  echo "[macos] using CA bundle: $CA_CERT"
fi

# --- determine target triple for this Mac ------------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TARGET="aarch64-apple-darwin" ;;
  x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "error: unsupported macOS arch: $ARCH"; exit 1 ;;
esac

VERSION="${VERSION:-$(grep -m1 '^version' "$RUST_DIR/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')}"
PKG="epic-${VERSION}-${TARGET}"

echo "[macos] building epic $VERSION for $TARGET"
rustup target add "$TARGET" >/dev/null 2>&1 || true
( cd "$RUST_DIR" && cargo build --release --target "$TARGET" )

BIN="$RUST_DIR/target/$TARGET/release/epic"
[ -x "$BIN" ] || { echo "error: expected binary not found at $BIN"; exit 1; }

# --- package -----------------------------------------------------------------
mkdir -p "$DIST_DIR/$PKG"
cp "$BIN" "$DIST_DIR/$PKG/epic"
cp "$REPO_ROOT/README.md" "$DIST_DIR/$PKG/README.md" 2>/dev/null || true
cp "$RUST_DIR/README.md" "$DIST_DIR/$PKG/USAGE.md" 2>/dev/null || true

( cd "$DIST_DIR" && tar -czf "$PKG.tar.gz" "$PKG" && shasum -a 256 "$PKG.tar.gz" > "$PKG.tar.gz.sha256" )

echo "[macos] packaged:"
echo "   $DIST_DIR/$PKG.tar.gz"
echo "   $DIST_DIR/$PKG.tar.gz.sha256"
echo
echo "[macos] quick check:"
"$BIN" --version 2>/dev/null || "$BIN" baseline --help | head -3

#!/usr/bin/env bash
#
# Cross-compile the `epic` binary for AWS Graviton (Linux ARM64,
# aarch64-unknown-linux-gnu) and package it under dist/.
#
# Graviton (r7g/r6g/g5g/c7g ...) instances run 64-bit ARM Linux. This produces
# a binary you can scp straight onto such an instance and run — no runtime setup.
#
# Two build methods, chosen automatically (override with METHOD=docker|native):
#
#   docker  (default, most reliable on macOS): builds inside a linux/arm64
#           container using the official rust image. Needs Docker with
#           buildx/QEMU for cross-arch emulation (Docker Desktop has this).
#
#   native: uses a locally-installed aarch64-unknown-linux-gnu Rust target +
#           cross-linker. Fast, but requires a GNU cross toolchain
#           (e.g. `brew install aarch64-elf-gcc` is NOT enough; you need a
#           full linux-gnu cross-linker such as messense/homebrew-macos-cross
#           toolchains). Prefer docker unless you have this set up.
#
# Usage:
#   build/build-graviton.sh
#   METHOD=native build/build-graviton.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$REPO_ROOT/rust"
DIST_DIR="$REPO_ROOT/dist"
TARGET="aarch64-unknown-linux-gnu"

# shellcheck disable=SC1090
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

VERSION="${VERSION:-$(grep -m1 '^version' "$RUST_DIR/Cargo.toml" | sed -E 's/.*"([^"]+)".*/\1/')}"
PKG="epic-${VERSION}-${TARGET}"
METHOD="${METHOD:-docker}"

# Corporate TLS interception (e.g. Zscaler): a vendored root CA that both build
# methods will trust so crates.io downloads work behind the proxy.
CA_CERT="${CARGO_HTTP_CAINFO:-$REPO_ROOT/build/certs/zscaler-root-ca.crt}"

package() {
  local bin="$1"
  mkdir -p "$DIST_DIR/$PKG"
  cp "$bin" "$DIST_DIR/$PKG/epic"
  cp "$RUST_DIR/README.md" "$DIST_DIR/$PKG/USAGE.md" 2>/dev/null || true
  ( cd "$DIST_DIR" && tar -czf "$PKG.tar.gz" "$PKG" && shasum -a 256 "$PKG.tar.gz" > "$PKG.tar.gz.sha256" )
  echo "[graviton] packaged:"
  echo "   $DIST_DIR/$PKG.tar.gz"
  echo "   $DIST_DIR/$PKG.tar.gz.sha256"
}

build_docker() {
  command -v docker >/dev/null 2>&1 || { echo "error: docker not found"; exit 1; }
  echo "[graviton] cross-compiling via Docker (linux/arm64)"
  # Build inside an arm64 rust container; mount the crate, emit the binary to a
  # dedicated target dir so it doesn't clash with host-native artifacts.
  # If a corporate root CA is vendored, mount it in and register it before the
  # build so crates.io downloads work behind Zscaler-style TLS interception.
  local ca_args=()
  local ca_cmd=""
  if [ -f "$CA_CERT" ]; then
    ca_args=(-v "$CA_CERT":/usr/local/share/ca-certificates/corp-root-ca.crt:ro)
    ca_cmd="apt-get update >/dev/null && apt-get install -y --no-install-recommends ca-certificates >/dev/null && update-ca-certificates >/dev/null && export CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt && "
    echo "[graviton] injecting CA into build container: $CA_CERT"
  fi
  docker run --rm --platform linux/arm64 \
    "${ca_args[@]}" \
    -v "$RUST_DIR":/src \
    -w /src \
    -e CARGO_TARGET_DIR=/src/target/graviton \
    rust:1-slim \
    bash -c "${ca_cmd}cargo build --release --target $TARGET"
  local bin="$RUST_DIR/target/graviton/$TARGET/release/epic"
  [ -x "$bin" ] || { echo "error: binary not produced at $bin"; exit 1; }
  file "$bin" || true
  package "$bin"
}

build_native() {
  command -v cargo >/dev/null 2>&1 || { echo "error: cargo not found"; exit 1; }
  echo "[graviton] cross-compiling via native rust target $TARGET"
  if [ -f "$CA_CERT" ]; then
    export CARGO_HTTP_CAINFO="$CA_CERT"
    export SSL_CERT_FILE="${SSL_CERT_FILE:-$CA_CERT}"
    echo "[graviton] using CA bundle: $CA_CERT"
  fi
  rustup target add "$TARGET"
  # Requires a working aarch64-linux-gnu linker on PATH and cargo config
  # pointing at it (see build/README.md). Fails clearly if missing.
  ( cd "$RUST_DIR" && cargo build --release --target "$TARGET" ) || {
    echo
    echo "error: native cross build failed — usually a missing linux-gnu cross-linker."
    echo "       Use the default Docker method instead:  METHOD=docker $0"
    exit 1
  }
  local bin="$RUST_DIR/target/$TARGET/release/epic"
  package "$bin"
}

case "$METHOD" in
  docker) build_docker ;;
  native) build_native ;;
  *) echo "error: unknown METHOD=$METHOD (use docker|native)"; exit 1 ;;
esac

echo "[graviton] done. Copy to a Graviton EC2 box and run, e.g.:"
echo "   scp $DIST_DIR/$PKG.tar.gz ec2-user@<host>:~/"
echo "   ssh ec2-user@<host> 'tar xzf $PKG.tar.gz && ./$PKG/epic baseline --help'"

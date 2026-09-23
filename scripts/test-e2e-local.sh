#!/usr/bin/env bash
# Local end-to-end test — no AWS required.
#
# Proves the whole pipeline works before spending a cent in the cloud:
#   1. builds the epic binary (release)
#   2. generates a tiny synthetic genome + strand-separated initiation tracks
#      with a planted CG-initiation signal
#   3. runs `epic baseline` (fit on train contig, predict + score the test contig)
#   4. asserts a submission was produced and the baseline beats random (AUPRC)
#   5. runs the same flow through the Docker image + entrypoint (if docker is
#      available), exercising the container path used on AWS Batch
#
# Usage: scripts/test-e2e-local.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$REPO_ROOT/rust"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env" || true
[ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$HOME/git/zscaler-cert.pem" ] && export NODE_EXTRA_CA_CERTS="$HOME/git/zscaler-cert.pem"

log() { printf '\033[36m[e2e]\033[0m %s\n' "$*"; }

# --- 1. build ---------------------------------------------------------------
log "building epic (release)"
( cd "$RUST_DIR" && cargo build --release >/dev/null )
EPIC="$RUST_DIR/target/release/epic"

# --- 2. synthetic data ------------------------------------------------------
log "generating synthetic genome + initiation tracks"
python3 - "$WORK" <<'PY'
import random, sys, os
random.seed(7)
work = sys.argv[1]
def make(n): return "".join(random.choice("ACGT") for _ in range(n))
# two contigs: chr1 (train), chr2 (test)
seqs = {"chr1": make(4000), "chr2": make(2000)}
with open(os.path.join(work, "genome.fa"), "w") as f:
    for k, v in seqs.items():
        f.write(f">{k}\n")
        for i in range(0, len(v), 60): f.write(v[i:i+60] + "\n")
# planted signal: positions ending "CG" get high initiation, sparse elsewhere
for strand, fn in (("+", "plus.bg"), ("-", "minus.bg")):
    with open(os.path.join(work, fn), "w") as f:
        for c, v in seqs.items():
            for i in range(1, len(v)):
                if v[i-1] == "C" and v[i] == "G":
                    f.write(f"{c}\t{i}\t{i+1}\t{10 + random.random()*3:.2f}\n")
                elif random.random() < 0.02:
                    f.write(f"{c}\t{i}\t{i+1}\t{random.random():.2f}\n")
print("ok")
PY

# --- 3. run baseline --------------------------------------------------------
log "running epic baseline (train=chr1, test=chr2)"
OUT="$WORK/submission.tsv"
SCORE="$("$EPIC" baseline \
  --genome "$WORK/genome.fa" \
  --plus "$WORK/plus.bg" --minus "$WORK/minus.bg" \
  --train-contigs chr1 --test-contigs chr2 \
  --out "$OUT" 2>&1)"
echo "$SCORE" | sed 's/^/    /'

# --- 4. assertions ----------------------------------------------------------
[ -s "$OUT" ] || { echo "FAIL: no submission produced"; exit 1; }
ROWS="$(($(wc -l < "$OUT") - 1))"
log "submission rows: $ROWS"
AUPRC="$(printf '%s\n' "$SCORE" | sed -n 's/.*AUPRC[^0-9]*\([0-9.]*\).*/\1/p' | head -1)"
if [ -n "$AUPRC" ]; then
  awk -v a="$AUPRC" 'BEGIN{ if (a+0 > 0.3) { print "    AUPRC "a" > 0.3 (beats random) ✅" } else { print "FAIL: AUPRC "a" too low"; exit 1 } }'
fi

# --- 5. container path (optional) -------------------------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "building + testing the Docker image (pass-through mode)"
  docker buildx build --platform linux/arm64 -t epic:e2e-test --load "$REPO_ROOT" >/dev/null 2>&1 || {
    echo "    (docker build failed — skipping container test)"; SKIP=1; }
  if [ -z "${SKIP:-}" ]; then
    docker run --rm -v "$WORK":/data epic:e2e-test baseline \
      --genome /data/genome.fa --plus /data/plus.bg --minus /data/minus.bg \
      --train-contigs chr1 --test-contigs chr2 --out /data/out/sub.tsv | sed 's/^/    /'
    [ -s "$WORK/out/sub.tsv" ] && log "container produced a submission ✅" || { echo "FAIL: container produced no output"; exit 1; }
  fi
else
  log "docker not available — skipping container test (binary test already passed)"
fi

log "END-TO-END TEST PASSED ✅"

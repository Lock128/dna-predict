#!/usr/bin/env bash
# Container entrypoint for the `epic` image.
#
# Two modes:
#
#  1. Pass-through (default): if no S3 sync is requested, just exec `epic` with
#     whatever args were given. So `docker run epic baseline --help` and the
#     Batch job command behave exactly like the bare binary.
#
#  2. S3-synced run: when EPIC_INPUT_PREFIX (and DATA_BUCKET) are set, the
#     wrapper pulls the input data from S3 to a local scratch dir, runs `epic`,
#     then pushes any produced outputs back to S3. This makes a Batch job
#     self-contained: give it a species + command and it handles data movement.
#
# Environment (mode 2):
#   DATA_BUCKET         S3 bucket name (set on the job by CDK)
#   EPIC_INPUT_PREFIX   S3 key prefix to sync down, e.g. raw/22285753/oyster
#   EPIC_OUTPUT_PREFIX  S3 key prefix to sync the output dir up to,
#                       e.g. submissions/oyster   (default: submissions/<species>)
#   EPIC_SPECIES        species label (used for default paths / logging)
#   EPIC_DATA_DIR       local mount for data (default: /data)
#
# The epic command is taken from the container args ($@). Any path under
# $EPIC_DATA_DIR that the command writes (e.g. --out /data/out/oyster.tsv) is
# uploaded from $EPIC_DATA_DIR/out afterwards.
set -euo pipefail

log() { printf '\033[36m[entrypoint]\033[0m %s\n' "$*" >&2; }

DATA_DIR="${EPIC_DATA_DIR:-/data}"

# --- Mode 1: no S3 input requested -> just run epic --------------------------
if [ -z "${EPIC_INPUT_PREFIX:-}" ]; then
  exec epic "$@"
fi

# --- Mode 2: sync from S3, run, sync back ------------------------------------
: "${DATA_BUCKET:?DATA_BUCKET must be set for an S3-synced run}"
command -v aws >/dev/null 2>&1 || { echo "aws CLI not found in image" >&2; exit 1; }

species="${EPIC_SPECIES:-run}"
in_dir="$DATA_DIR"
out_dir="$DATA_DIR/out"
mkdir -p "$in_dir" "$out_dir"

log "syncing s3://$DATA_BUCKET/$EPIC_INPUT_PREFIX -> $in_dir"
aws s3 sync "s3://$DATA_BUCKET/$EPIC_INPUT_PREFIX" "$in_dir" --only-show-errors

log "running: epic $*"
set +e
epic "$@"
status=$?
set -e

out_prefix="${EPIC_OUTPUT_PREFIX:-submissions/$species}"
if [ -n "$(ls -A "$out_dir" 2>/dev/null || true)" ]; then
  log "syncing $out_dir -> s3://$DATA_BUCKET/$out_prefix"
  aws s3 sync "$out_dir" "s3://$DATA_BUCKET/$out_prefix" --only-show-errors
else
  log "no outputs in $out_dir to upload (did the command write under $out_dir?)"
fi

log "epic exited with status $status"
exit $status

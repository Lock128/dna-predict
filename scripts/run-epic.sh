#!/usr/bin/env bash
# Launch an `epic` job on AWS Batch via the launcher Lambda.
#
# Everything after `--` is passed as the container command (the epic CLI args).
# The container reads/writes the S3 data bucket (env DATA_BUCKET is set on the
# job); see infra/README.md for the S3 access pattern.
#
# Usage:
#   scripts/run-epic.sh [--species NAME] -- <epic args...>
#
# Examples:
#   scripts/run-epic.sh -- baseline --help
#   scripts/run-epic.sh --species nematostella -- baseline \
#       --genome /data/... --plus /data/... --minus /data/... --out /data/sub.tsv
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require_stack

SPECIES="unknown"
CMD=()
seen_dd=0
while [ $# -gt 0 ]; do
  case "$1" in
    --species) SPECIES="$2"; shift 2 ;;
    --) seen_dd=1; shift; CMD=("$@"); break ;;
    *) err "unexpected arg '$1' (put epic args after --)"; exit 1 ;;
  esac
done
[ "$seen_dd" = "1" ] || { err "missing '--' separator before the epic command"; exit 1; }
[ "${#CMD[@]}" -gt 0 ] || { err "no epic command given after --"; exit 1; }

FN="$(stack_output LaunchJobFunctionName)"
[ -n "$FN" ] || { err "could not resolve LaunchJobFunctionName from stack outputs"; exit 1; }

# Build the JSON payload safely: {"species": "...", "command": ["...", ...]}
# Pass species as argv[1] and each command token as argv[2:].
PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"species": sys.argv[1], "command": sys.argv[2:]}))' "$SPECIES" "${CMD[@]}")"

info "submitting epic job (species=$SPECIES): ${CMD[*]}"
aws lambda invoke \
  --function-name "$FN" \
  --region "$REGION" \
  --payload "$PAYLOAD" \
  --cli-binary-format raw-in-base64-out \
  /dev/stdout | { cat; echo; }

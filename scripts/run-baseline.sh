#!/usr/bin/env bash
# Run the dinucleotide baseline reproducibly by starting the baseline
# Step Functions state machine. This is the "just start a Step Function" entry
# point: give it a species and it builds the command from config/<species>.json,
# runs the epic job on Batch, scores, verifies, and records the result to
# DynamoDB — no local shell logic, no hand-built command.
#
# Usage:
#   scripts/run-baseline.sh --species nematostella      # one species
#   scripts/run-baseline.sh --species oyster --k 3       # override k-mer size
#   scripts/run-baseline.sh --species all                # every configured species
#   scripts/run-baseline.sh --species nematostella --wait  # poll until done
#
# Results land in the DynamoDB table (stack output ResultsTableName), keyed by
# species; submissions land in s3://<bucket>/submissions/<species>/.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require_stack

SPECIES=""
K=""
WAIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --species) SPECIES="$2"; shift 2 ;;
    --k) K="$2"; shift 2 ;;
    --wait) WAIT=1; shift ;;
    *) err "unexpected arg '$1'"; exit 1 ;;
  esac
done

[ -n "$SPECIES" ] || { err "give --species NAME (config/NAME.json) or --species all"; exit 1; }

SM_ARN="$(stack_output BaselineStateMachineArn)"
[ -n "$SM_ARN" ] || { err "could not resolve BaselineStateMachineArn from stack outputs"; exit 1; }

# Build the execution input. `k` is optional; the builder Lambda treats a
# missing/empty k as the default (2).
if [ -n "$K" ]; then
  INPUT="{\"species\":\"$SPECIES\",\"k\":$K}"
else
  INPUT="{\"species\":\"$SPECIES\"}"
fi

info "starting baseline for species='$SPECIES'${K:+ (k=$K)}"
EXEC_ARN="$(aws stepfunctions start-execution \
  --state-machine-arn "$SM_ARN" \
  --region "$REGION" \
  --input "$INPUT" \
  --query executionArn --output text)"
info "execution: $EXEC_ARN"

if [ "$WAIT" = "1" ]; then
  info "waiting for completion..."
  while true; do
    STATUS="$(aws stepfunctions describe-execution --execution-arn "$EXEC_ARN" --region "$REGION" --query status --output text)"
    case "$STATUS" in
      RUNNING) sleep 15 ;;
      SUCCEEDED) info "baseline SUCCEEDED — query results in table '$(stack_output ResultsTableName)'"; break ;;
      *) err "baseline ended with status: $STATUS"; exit 1 ;;
    esac
  done
fi

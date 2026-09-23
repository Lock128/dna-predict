#!/usr/bin/env bash
# Start the Zenodo -> S3 ingestion (Step Functions state machine).
#
# Downloads the given Zenodo record's files into s3://<bucket>/raw/<record>/
# via a Batch download job. The heavy transfer runs in Batch, not here.
#
# Usage:
#   scripts/ingest.sh [record]     # default record: 22285753 (EPIC dataset)
#   scripts/ingest.sh --wait       # also poll until the execution finishes
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require_stack

RECORD="22285753"
WAIT=0
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=1 ;;
    *) RECORD="$arg" ;;
  esac
done

SM_ARN="$(stack_output IngestionStateMachineArn)"
[ -n "$SM_ARN" ] || { err "could not resolve IngestionStateMachineArn from stack outputs"; exit 1; }

info "starting ingestion of Zenodo record $RECORD"
EXEC_ARN="$(aws stepfunctions start-execution \
  --state-machine-arn "$SM_ARN" \
  --region "$REGION" \
  --input "{\"record\":\"$RECORD\"}" \
  --query executionArn --output text)"
info "execution: $EXEC_ARN"

if [ "$WAIT" = "1" ]; then
  info "waiting for completion (this can take a while for large datasets)..."
  while true; do
    STATUS="$(aws stepfunctions describe-execution --execution-arn "$EXEC_ARN" --region "$REGION" --query status --output text)"
    case "$STATUS" in
      RUNNING) sleep 15 ;;
      SUCCEEDED) info "ingestion SUCCEEDED"; break ;;
      *) err "ingestion ended with status: $STATUS"; exit 1 ;;
    esac
  done
fi

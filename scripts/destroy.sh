#!/usr/bin/env bash
# Tear down the EPIC stack to guarantee zero cost when idle.
#
# The S3 data bucket has a RETAIN policy, so your downloaded data survives a
# destroy (you'll see it left behind in the console). Everything else — Batch,
# VPC, Lambdas, Step Functions, logs — is removed.
#
# Usage: scripts/destroy.sh [--yes]   (--yes skips the confirmation prompt)
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require npm
require_stack

if [ "${1:-}" != "--yes" ]; then
  printf '\033[33m[epic]\033[0m This destroys stack "%s" in %s (S3 data bucket is retained). Continue? [y/N] ' "$STACK" "$REGION" >&2
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) info "aborted"; exit 0 ;;
  esac
fi

info "destroying stack '$STACK' in $REGION"
export CDK_DEPLOY_REGION="$REGION"
( cd "$INFRA_DIR" && npm ci && npm run build && npx cdk destroy --force )
info "destroyed. Note: the S3 data bucket is retained — delete it manually if you want it gone."

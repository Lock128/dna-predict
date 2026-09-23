#!/usr/bin/env bash
# Shared helpers for the EPIC operational scripts.
#
# Sourced by the other scripts in this folder. Provides:
#   - consistent region / stack-name config
#   - a helper to read CloudFormation stack outputs by key
#   - small logging helpers
#
# Config via environment:
#   AWS_REGION   target region (default: eu-central-1)
#   EPIC_STACK   CloudFormation stack name (default: epic-app)
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
STACK="${EPIC_STACK:-epic-app}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$REPO_ROOT/infra"

# Behind Zscaler: let node/CDK trust the corporate CA if present.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$HOME/git/zscaler-cert.pem" ]; then
  export NODE_EXTRA_CA_CERTS="$HOME/git/zscaler-cert.pem"
fi

info() { printf '\033[36m[epic]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[epic] error:\033[0m %s\n' "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "'$1' is required but not installed"; exit 1; }
}

# Read a single CloudFormation stack output value by its OutputKey.
stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null
}

# Fail with a clear message if the stack isn't deployed yet.
require_stack() {
  if ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
    err "stack '$STACK' not found in $REGION. Deploy it first: scripts/deploy.sh"
    exit 1
  fi
}

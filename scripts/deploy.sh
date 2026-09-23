#!/usr/bin/env bash
# Deploy (or update) the EPIC infrastructure with CDK.
#
# Builds the arm64 image and deploys the epic-app stack to the current
# account/region. This is the same thing GitHub Actions does on push to main;
# use it for local/manual deploys.
#
# Usage: scripts/deploy.sh [extra cdk args...]
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require npm

info "deploying stack '$STACK' to $REGION"
export CDK_DEPLOY_REGION="$REGION"

( cd "$INFRA_DIR" && npm ci && npm run build && npx cdk deploy --require-approval never "$@" )

info "done. outputs:"
"$(dirname "${BASH_SOURCE[0]}")/outputs.sh" || true

#!/usr/bin/env bash
# One-time CDK bootstrap of the current account/region.
#
# Creates the CDKToolkit stack (assets bucket, ECR repo, cdk-* roles) that
# `cdk deploy` needs. Run once per account/region.
#
# Usage: scripts/bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require npm

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
info "bootstrapping aws://${ACCOUNT_ID}/${REGION}"
export CDK_DEPLOY_REGION="$REGION"

( cd "$INFRA_DIR" && npm ci && npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}" )
info "bootstrap complete"

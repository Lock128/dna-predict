#!/usr/bin/env bash
# Print the EPIC stack outputs (bucket name, queue/job ARNs, state machine, etc.)
#
# Usage: scripts/outputs.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require_stack

aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}" \
  --output table

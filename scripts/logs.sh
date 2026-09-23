#!/usr/bin/env bash
# Tail the EPIC Batch/job CloudWatch logs.
#
# Follows the /aws/batch/<prefix> log group where both the epic and download
# jobs write (streamPrefix "epic" / "download").
#
# Usage:
#   scripts/logs.sh                 # follow the last 10 min
#   scripts/logs.sh --since 1h      # follow from 1 hour ago
#   EPIC_PREFIX=epic scripts/logs.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws

PREFIX="${EPIC_PREFIX:-epic}"
GROUP="/aws/batch/${PREFIX}"
SINCE="10m"
[ "${1:-}" = "--since" ] && SINCE="$2"

info "tailing $GROUP (region $REGION, since $SINCE). Ctrl-C to stop."
aws logs tail "$GROUP" --region "$REGION" --since "$SINCE" --follow

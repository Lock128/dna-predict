#!/usr/bin/env bash
# Launch an `epic` job on AWS Batch via the launcher Lambda.
#
# Two ways to use it:
#
#  A. Config-driven (recommended): give a species that has a config file at
#     config/<species>.json. The script builds the baseline command and the S3
#     sync prefixes from it, so the container pulls the data, runs, and pushes
#     the submission automatically.
#
#       scripts/run-epic.sh --species oyster
#       scripts/run-epic.sh --species oyster --k 3        # override k-mer size
#
#  B. Explicit: pass the raw epic command after `--` (paths are inside the
#     container; add --input-prefix to enable S3 sync).
#
#       scripts/run-epic.sh -- baseline --help
#       scripts/run-epic.sh --species oyster --input-prefix raw/22285753/oyster \
#           -- baseline --genome /data/genome.fa --out /data/out/oyster.tsv
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require aws
require python3
require_stack

SPECIES=""
INPUT_PREFIX=""
OUTPUT_PREFIX=""
K=""
CMD=()
seen_dd=0
while [ $# -gt 0 ]; do
  case "$1" in
    --species) SPECIES="$2"; shift 2 ;;
    --input-prefix) INPUT_PREFIX="$2"; shift 2 ;;
    --output-prefix) OUTPUT_PREFIX="$2"; shift 2 ;;
    --k) K="$2"; shift 2 ;;
    --) seen_dd=1; shift; CMD=("$@"); break ;;
    *) err "unexpected arg '$1'"; exit 1 ;;
  esac
done

CONFIG="$REPO_ROOT/config/${SPECIES}.json"

# --- Config-driven mode: build the baseline command from config/<species>.json
if [ "$seen_dd" = "0" ]; then
  [ -n "$SPECIES" ] || { err "give --species NAME (with config/NAME.json) or an explicit '-- <epic args>'"; exit 1; }
  [ -f "$CONFIG" ] || { err "no config file at $CONFIG"; exit 1; }

  # Read config with python3 and emit the epic argv + prefixes as a JSON payload.
  PAYLOAD="$(K="$K" python3 - "$CONFIG" "$SPECIES" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1]))
species = sys.argv[2]
inp = cfg["inputPrefix"].rstrip("/")
data = "/data"
def p(name): return f"{data}/{cfg[name]}"
cmd = ["baseline",
       "--genome", p("genome"),
       "--plus", p("plus"),
       "--minus", p("minus")]
train = cfg.get("trainContigs") or []
test = cfg.get("testContigs") or []
if train:
    cmd += ["--train-contigs", ",".join(train)]
if test:
    cmd += ["--test-contigs", ",".join(test)]
k = os.environ.get("K", "")
if k:
    cmd += ["--k", k]
if cfg.get("blindTest") or not test:
    cmd += ["--no-score"]           # real test set: no local labels
cmd += ["--out", f"{data}/out/{species}.baseline.tsv"]
print(json.dumps({
    "species": species,
    "command": cmd,
    "inputPrefix": inp,
    "outputPrefix": f"submissions/{species}",
}))
PY
)"
else
  # --- Explicit mode ---------------------------------------------------------
  [ "${#CMD[@]}" -gt 0 ] || { err "no epic command after --"; exit 1; }
  [ -n "$SPECIES" ] || SPECIES="run"
  PAYLOAD="$(SPECIES="$SPECIES" INPUT_PREFIX="$INPUT_PREFIX" OUTPUT_PREFIX="$OUTPUT_PREFIX" \
    python3 -c 'import json,os,sys
d={"species":os.environ["SPECIES"],"command":sys.argv[1:]}
if os.environ.get("INPUT_PREFIX"): d["inputPrefix"]=os.environ["INPUT_PREFIX"]
if os.environ.get("OUTPUT_PREFIX"): d["outputPrefix"]=os.environ["OUTPUT_PREFIX"]
print(json.dumps(d))' "${CMD[@]}")"
fi

FN="$(stack_output LaunchJobFunctionName)"
[ -n "$FN" ] || { err "could not resolve LaunchJobFunctionName from stack outputs"; exit 1; }

info "submitting epic job (species=${SPECIES:-run})"
printf '%s\n' "$PAYLOAD" | sed 's/^/  payload: /' >&2
aws lambda invoke \
  --function-name "$FN" \
  --region "$REGION" \
  --payload "$PAYLOAD" \
  --cli-binary-format raw-in-base64-out \
  /dev/stdout | { cat; echo; }

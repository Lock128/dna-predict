#!/usr/bin/env bash
# Validate every mermaid diagram in the repo's markdown.
#
# Extracts each ```mermaid``` fenced block and renders it with the mermaid CLI
# (mmdc). Rendering fails on syntax errors, so this catches broken diagrams in
# CI before they reach a reader. Nothing is committed — output goes to a temp
# dir that is deleted afterwards.
#
# Usage: scripts/check-diagrams.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v npx >/dev/null 2>&1 || { echo "error: npx (Node.js) is required" >&2; exit 1; }

# A minimal puppeteer config so mmdc's headless Chrome runs in CI sandboxes.
cat > "$TMP/puppeteer.json" <<'JSON'
{ "args": ["--no-sandbox", "--disable-setuid-sandbox"] }
JSON

# Find markdown files (skip node_modules, cdk.out, target, dist).
MD_FILES=()
while IFS= read -r line; do
  MD_FILES+=("$line")
done < <(find "$REPO_ROOT" \
  -type d \( -name node_modules -o -name cdk.out -o -name target -o -name dist -o -name .git \) -prune -false \
  -o -type f -name '*.md' -print)

total=0
fail=0
for md in "${MD_FILES[@]}"; do
  # Split the file into mermaid blocks with awk; each block -> its own .mmd file.
  awk -v outdir="$TMP" -v base="$(basename "$md")" '
    /^```mermaid[[:space:]]*$/ { inblk=1; n++; f=sprintf("%s/%s.%d.mmd", outdir, base, n); next }
    /^```[[:space:]]*$/ && inblk { inblk=0; next }
    inblk { print > f }
  ' "$md"

  for mmd in "$TMP/$(basename "$md")".*.mmd; do
    [ -e "$mmd" ] || continue
    total=$((total+1))
    if npx -y -p @mermaid-js/mermaid-cli mmdc \
        -i "$mmd" -o "$mmd.svg" -p "$TMP/puppeteer.json" >/dev/null 2>"$mmd.err"; then
      echo "  ok   $md  (diagram $(basename "$mmd" | sed -E 's/.*\.([0-9]+)\.mmd/#\1/'))"
    else
      echo "  FAIL $md  ($(basename "$mmd"))"
      sed 's/^/       /' "$mmd.err" | tail -5
      fail=$((fail+1))
    fi
  done
done

echo
if [ "$total" -eq 0 ]; then
  echo "no mermaid diagrams found."
elif [ "$fail" -eq 0 ]; then
  echo "all $total mermaid diagram(s) valid ✅"
else
  echo "$fail of $total mermaid diagram(s) failed ❌"
  exit 1
fi

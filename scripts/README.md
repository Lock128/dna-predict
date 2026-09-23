# Operational scripts

Thin wrappers around the deployed EPIC infrastructure so you don't have to copy
ARNs around. Each script resolves what it needs from the CloudFormation stack
outputs and reads the region from `AWS_REGION` (default `eu-central-1`). They
assume your shell has AWS credentials (SSO or an assumed role).

Every script is also exposed as an npm command from the repo root.

| Script | npm | What it does |
|---|---|---|
| `scripts/bootstrap.sh` | `npm run aws:bootstrap` | One-time CDK bootstrap of the account/region |
| `scripts/deploy.sh` | `npm run aws:deploy` | Build the image + `cdk deploy` the stack |
| `scripts/ingest.sh [record] [--wait]` | `npm run aws:ingest` | Start the Zenodo → S3 ingestion (Step Functions) |
| `scripts/run-epic.sh [--species N] -- <args>` | `npm run aws:run` | Launch an `epic` Batch job via the launcher Lambda |
| `scripts/logs.sh [--since 1h]` | `npm run aws:logs` | Tail the Batch job logs |
| `scripts/outputs.sh` | `npm run aws:outputs` | Print the stack outputs |
| `scripts/destroy.sh [--yes]` | `npm run aws:destroy` | Tear down the stack (S3 data bucket retained) |
| `scripts/check-diagrams.sh` | `npm run check:diagrams` | Validate all mermaid diagrams in the repo |

## Config

| Env var | Default | Purpose |
|---|---|---|
| `AWS_REGION` | `eu-central-1` | target region |
| `EPIC_STACK` | `epic-app` | CloudFormation stack name |
| `EPIC_PREFIX` | `epic` | resource name prefix (used by `logs.sh`) |

## Typical flow

```bash
# once per account/region
npm run aws:bootstrap

# deploy (or just push to main and let GitHub Actions do it)
npm run aws:deploy

# load the data (defaults to the EPIC Zenodo record), wait for it to finish
scripts/ingest.sh --wait

# run the baseline (everything after -- is the epic CLI command)
scripts/run-epic.sh --species nematostella -- baseline --help

# watch what it does
npm run aws:logs

# tear it all down when idle (S3 data is kept)
npm run aws:destroy
```

> **Passing args via npm:** npm forwards everything after `--` to the script, so
> the epic command needs its own `--` too:
> `npm run aws:run -- --species nematostella -- baseline --help`.
> Calling the script directly (`scripts/run-epic.sh -- baseline --help`) is
> simpler.

## Notes

- `check-diagrams.sh` uses `npx @mermaid-js/mermaid-cli` (headless Chrome) and
  runs in CI via `.github/workflows/diagrams.yml`.
- Teardown is also available as a manual GitHub Actions workflow
  (`.github/workflows/destroy.yml`) requiring a typed confirmation.

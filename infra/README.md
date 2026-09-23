# EPIC infrastructure (AWS CDK)

TypeScript CDK app that deploys everything needed to run the `epic` pipeline on
AWS: object storage, the container image, an AWS Batch (Graviton/Fargate)
compute stack, an automated Zenodo → S3 data-ingestion workflow, and a launcher
to trigger container runs. It can be deployed locally or via GitHub Actions
(OIDC) on push to `main`.

## What gets created

```
AppStack (epic-app)
├── VPC (2 AZs, 1 NAT) — Fargate tasks run in private subnets
├── S3 DataBucket — raw/ processed/ submissions/ models/ (versioned, RETAINed)
├── Batch
│   ├── DockerImageAsset — builds ../Dockerfile for linux/arm64, pushes to ECR
│   ├── Fargate ARM64 (Graviton) compute environment (Spot)
│   ├── JobQueue
│   ├── EcsJobDefinition "epic-epic"     — runs the pipeline binary
│   └── EcsJobDefinition "epic-download" — streams Zenodo files to S3 (aws-cli)
├── Ingestion — Step Functions state machine:
│       PrepareDownload (Lambda) → RunDownloadJob (Batch .sync) → VerifyDownload (Lambda)
├── Launcher — Lambda that submits epic Batch jobs on demand
└── GitHubDeploy — OIDC provider + deploy role for GitHub Actions CI/CD
```

Key stack outputs: `DataBucketName`, `JobQueueArn`, `EpicJobDefinitionArn`,
`IngestionStateMachineArn`, `LaunchJobFunctionName`, `ImageUri`.

## Prerequisites

- Node.js 18+ and npm.
- Docker running locally (CDK builds the ARM64 image asset during deploy).
- AWS credentials for the target account (`aws configure` / SSO).
- Behind Zscaler: export the CA so npm/CDK trust the proxy —
  `export NODE_EXTRA_CA_CERTS=/path/to/zscaler-root-ca.pem`.

## Install & build

```bash
cd infra
npm ci
npm run build      # tsc
```

## Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `CDK_DEPLOY_ACCOUNT` | — | target AWS account id |
| `CDK_DEPLOY_REGION` | `eu-central-1` | target region |
| `EPIC_PREFIX` | `epic` | name prefix for resources |
| `EPIC_ZENODO_RECORD` | `22285753` | Zenodo record id to ingest |
| `EPIC_JOB_VCPU` / `EPIC_JOB_MEMORY_MIB` | `4` / `16384` | epic job size |
| `EPIC_DOWNLOAD_VCPU` / `EPIC_DOWNLOAD_MEMORY_MIB` | `2` / `8192` | download job size |
| `EPIC_GITHUB_REPO` | `Lock128/dna-predict` | repo allowed to deploy via OIDC |
| `EPIC_GITHUB_BRANCH` | `main` | branch allowed to deploy |
| `EPIC_CREATE_DEPLOY_ROLE` | `true` | create the GitHub OIDC provider + deploy role |

## Deploy — locally (also the one-time bootstrap for CI/CD)

```bash
# one-time per account/region
npx cdk bootstrap aws://<account>/<region>

export CDK_DEPLOY_ACCOUNT=<account> CDK_DEPLOY_REGION=eu-central-1
npx cdk deploy        # builds the image, creates all resources
```

This first deploy also creates the **GitHub OIDC provider** and the
**deploy role** used by CI/CD. Grab the `DeployRoleArn` from the stack outputs.

## Deploy — CI/CD via GitHub Actions

CI/CD is a GitHub Actions workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):

- **Pull requests** → build + `cdk synth` (validation only).
- **Push to `main`** → build + `cdk deploy`, authenticating to AWS through
  **OIDC** (no stored AWS keys). The deploy role trusts only
  `repo:Lock128/dna-predict:ref:refs/heads/main`.

One-time setup:

1. Deploy once locally (above) so the OIDC provider + deploy role exist. Note
   the `DeployRoleArn` output.
2. In the GitHub repo (Settings → Secrets and variables → Actions →
   **Variables**), set:
   - `AWS_REGION` — e.g. `eu-central-1`
   - `AWS_ACCOUNT_ID` — the target account id
   - `AWS_DEPLOY_ROLE_ARN` — the `DeployRoleArn` output
3. (Recommended) Add a `production` **Environment** in GitHub with required
   reviewers to gate deploys.

After that, every push to `main` deploys automatically.

> **Note — one OIDC provider per account.** An AWS account can have only one
> GitHub OIDC provider. If the account already has one (e.g. shared with other
> repos), deploy with `EPIC_CREATE_DEPLOY_ROLE=false` and create/point the role
> at the existing provider, or import it. The stack creates provider + role by
> default for a fresh account.

## Run it

### 1. Ingest the data (Zenodo → S3)

Start the ingestion state machine (arn from the `IngestionStateMachineArn`
output). It downloads the record's files into `s3://<bucket>/raw/<record>/`:

```bash
aws stepfunctions start-execution \
  --state-machine-arn <IngestionStateMachineArn> \
  --input '{"record":"22285753"}'
```

### 2. Launch an epic job on Batch

Invoke the launcher Lambda (name from the `LaunchJobFunctionName` output) with
the container command. Data is mounted/read via S3 (see the job's `DATA_BUCKET`
env and `docs/AWS.md` for the S3 access pattern):

```bash
aws lambda invoke \
  --function-name <LaunchJobFunctionName> \
  --payload '{"species":"nematostella","command":["baseline","--help"]}' \
  --cli-binary-format raw-in-base64-out \
  /dev/stdout
```

Or submit to Batch directly:

```bash
aws batch submit-job \
  --job-name epic-nematostella \
  --job-queue <JobQueueArn> \
  --job-definition <EpicJobDefinitionArn> \
  --container-overrides '{"command":["baseline","--help"]}'
```

## Useful commands

```bash
npm run build       # compile TypeScript
npx cdk synth       # emit CloudFormation
npx cdk diff        # compare against deployed stack
npx cdk deploy      # deploy
npx cdk destroy     # tear down (the S3 bucket is RETAINed — delete manually)
```

## Notes & follow-ups

- **Data access from the epic job:** the job role has read/write on the bucket.
  How the container reads inputs (sync to local scratch vs. stream) depends on
  the final Zenodo file layout — wire the exact `baseline` command (S3 paths /
  local paths) once the data layout is confirmed. See `docs/AWS.md`.
- **Download command:** `prepare-download` builds a `curl | aws s3 cp -` script
  per file from the Zenodo API. Confirm large files stream acceptably; if not,
  switch to download-to-scratch-then-upload (the download job already has 200 GB
  ephemeral storage).
- **Cost:** Fargate Spot + on-demand ingestion; the bucket is versioned with a
  raw/→IA lifecycle rule. Tear down compute when idle.

# EPIC infrastructure (AWS CDK)

TypeScript CDK app that deploys everything needed to run the `epic` pipeline on
AWS: object storage, the container image, an AWS Batch (Graviton/Fargate)
compute stack, an automated Zenodo → S3 data-ingestion workflow, and a launcher
to trigger container runs. It can be deployed locally or via GitHub Actions
(OIDC) on push to `main`.

See the [architecture diagram](../docs/AWS.md#architecture) for the big picture.

## What gets created

```
AppStack (epic-app)
├── VPC (2 AZs) — NO NAT gateway; public subnets + free S3 gateway endpoint
├── S3 DataBucket — raw/ processed/ submissions/ models/ (versioned, RETAINed)
├── Batch
│   ├── DockerImageAsset — builds ../Dockerfile for linux/arm64, pushes to ECR
│   ├── SecurityGroup — egress-only, ZERO ingress rules
│   ├── Fargate ARM64 (Graviton) compute environment (Spot), in public subnets
│   ├── JobQueue
│   ├── EcsJobDefinition "epic-epic"     — runs the pipeline binary (public IP)
│   └── EcsJobDefinition "epic-download" — streams Zenodo files to S3 (public IP)
├── Ingestion — Step Functions state machine:
│       PrepareDownload (Lambda) → RunDownloadJob (Batch .sync) → VerifyDownload (Lambda)
└── Launcher — Lambda that submits epic Batch jobs on demand
```

CI/CD (GitHub Actions) assumes an **existing** AWS IAM role via OIDC; the role
and GitHub↔AWS OIDC connection are managed outside this stack.

Key stack outputs: `DataBucketName`, `JobQueueArn`, `EpicJobDefinitionArn`,
`IngestionStateMachineArn`, `LaunchJobFunctionName`, `ImageUri`.

## How the application works

The infrastructure exists to do two things: **get the data into S3**, and **run
the `epic` container against it**. Here's the end-to-end flow.

### Build & deploy (CI/CD)

1. A push to `main` triggers the GitHub Actions **deploy** workflow.
2. It authenticates to AWS via **OIDC** (assumes an existing role — no stored
   keys) and runs `cdk deploy` on an **ARM runner**.
3. CDK builds the `epic` image from the repo `Dockerfile` **natively for
   linux/arm64** and pushes it to the CDK assets **ECR** repo, then creates/updates
   the CloudFormation stack.

### Data ingestion (Zenodo → S3)

Triggered by starting the **ingestion Step Functions** state machine with a
Zenodo record id. Three steps:

1. **PrepareDownload** (Lambda) — calls the Zenodo API for the record and builds
   a shell script that streams each file into `s3://<bucket>/raw/<record>/`
   (`curl … | aws s3 cp -`).
2. **RunDownloadJob** (Batch, `.sync`) — runs that script on a Fargate task. The
   heavy multi-GB transfer runs here, not in Lambda, to avoid the 15-minute and
   ephemeral-storage limits. The task has 200 GB scratch as a fallback.
3. **VerifyDownload** (Lambda) — lists the S3 prefix and fails the run if no
   objects/bytes landed.

### Running the pipeline

The **launcher Lambda** (`launch-epic-job`) submits an `epic` job to the Batch
**queue** with a container command (e.g. `baseline --genome … --out …`). Batch
places it on the Fargate **compute environment**; the task pulls the image from
ECR, reads inputs and writes submissions to S3 through the **S3 gateway
endpoint**, and logs to CloudWatch. You can also `aws batch submit-job` directly.

### Networking & security

To avoid the only 24/7 cost (a NAT gateway), tasks run in **public subnets with
public IPs** (`assignPublicIp: ENABLED`, required for image pulls without NAT).
They're locked down at the network layer by a **dedicated security group that
allows all egress but has zero ingress rules** — nothing is reachable from the
internet despite the public IP. S3 traffic uses a **free gateway endpoint**
instead of the internet. Net idle cost: ~$0.

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
## Deploy — locally

```bash
# one-time per account/region
npx cdk bootstrap aws://<account>/<region>

export CDK_DEPLOY_ACCOUNT=<account> CDK_DEPLOY_REGION=eu-central-1
npx cdk deploy        # builds the image, creates all resources
```

> Prefer to bootstrap from CI? Run the **CDK bootstrap** workflow
> ([`.github/workflows/bootstrap.yml`](../.github/workflows/bootstrap.yml))
> manually from the Actions tab — it bootstraps the target account/region using
> the same OIDC role and secrets.

## Deploy — CI/CD via GitHub Actions

CI/CD is a GitHub Actions workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)):

- **Pull requests** → build + `cdk synth` (validation only).
- **Push to `main`** → build + `cdk deploy`, authenticating to AWS through
  **OIDC** by assuming an existing IAM role (no stored AWS keys).

The GitHub↔AWS OIDC connection and the deploy role are assumed to **already
exist** (managed outside this repo). Configure (Settings → Secrets and variables
→ Actions):

- **Secret** `AWS_ROLE_ARN` — ARN of the role GitHub Actions assumes via OIDC
- **Variable** `AWS_REGION` — target region (defaults to `eu-central-1` if unset)

The account id is derived from the assumed role (via STS), so there's no
`AWS_ACCOUNT_ID` to set.

The deploy job runs in a `production` GitHub **Environment**, which you can gate
with required reviewers. Every push to `main` then deploys automatically.

> The deploy role must be able to assume the CDK bootstrap roles
> (`arn:aws:iam::<account>:role/cdk-*`) in the target account so `cdk deploy`
> can create resources.

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
- **Cost:** no NAT gateway and everything else is pay-per-use, so a
  deployed-but-idle stack costs ~$0 (only S3 storage + the ECR image + logs).
  Fargate is billed only while a job runs; the bucket is versioned with a
  raw/→IA lifecycle rule.

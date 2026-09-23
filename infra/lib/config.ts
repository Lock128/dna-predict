/**
 * Central configuration for the EPIC (dna-predict) infrastructure.
 *
 * Values are resolved from environment variables / CDK context so the same app
 * can be deployed directly (developer runs `cdk deploy`) or through the CI/CD
 * pipeline to a target account.
 */

export interface EpicEnv {
  readonly account?: string;
  readonly region: string;
}

export interface EpicConfig {
  /** Prefix applied to resource names/exports so multiple deployments coexist. */
  readonly prefix: string;

  /** Where the application stack (buckets, Batch, ingestion) is deployed. */
  readonly target: EpicEnv;

  /**
   * Zenodo dataset DOI/record used by the ingestion workflow. The challenge
   * data lives at doi:10.5281/zenodo.22285753.
   */
  readonly zenodoRecord: string;

  /** vCPU / memory (MiB) for the epic Batch job (Fargate ARM64). */
  readonly epicJobVcpu: number;
  readonly epicJobMemoryMiB: number;

  /** vCPU / memory (MiB) for the data-download Batch job. */
  readonly downloadJobVcpu: number;
  readonly downloadJobMemoryMiB: number;

  /** Optional CI/CD (CDK Pipelines) configuration; omitted for direct deploys. */
  readonly pipeline?: PipelineConfig;
}

export interface PipelineConfig {
  /** Account/region the pipeline itself lives in (usually a tooling account). */
  readonly env: EpicEnv;
  /** Source repository connection (CodeStar connection to GitHub). */
  readonly connectionArn: string;
  /** "owner/repo" on GitHub. */
  readonly repo: string;
  /** Branch that triggers the pipeline. */
  readonly branch: string;
}

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

/** Build the config from environment, with sensible defaults for the challenge. */
export function loadConfig(): EpicConfig {
  const region = env("CDK_DEPLOY_REGION", env("CDK_DEFAULT_REGION", "eu-central-1"))!;
  const account = env("CDK_DEPLOY_ACCOUNT", env("CDK_DEFAULT_ACCOUNT"));

  const connectionArn = env("EPIC_PIPELINE_CONNECTION_ARN");
  const repo = env("EPIC_PIPELINE_REPO", "your-org/dna-predict")!;
  const branch = env("EPIC_PIPELINE_BRANCH", "main")!;
  const pipelineAccount = env("EPIC_PIPELINE_ACCOUNT", account);
  const pipelineRegion = env("EPIC_PIPELINE_REGION", region)!;

  // The pipeline is only wired up when a CodeStar connection ARN is supplied,
  // otherwise we assume a direct `cdk deploy` of the application stack.
  const pipeline: PipelineConfig | undefined = connectionArn
    ? {
        env: { account: pipelineAccount, region: pipelineRegion },
        connectionArn,
        repo,
        branch,
      }
    : undefined;

  return {
    prefix: env("EPIC_PREFIX", "epic")!,
    target: { account, region },
    zenodoRecord: env("EPIC_ZENODO_RECORD", "22285753")!,
    epicJobVcpu: Number(env("EPIC_JOB_VCPU", "4")),
    epicJobMemoryMiB: Number(env("EPIC_JOB_MEMORY_MIB", "16384")),
    downloadJobVcpu: Number(env("EPIC_DOWNLOAD_VCPU", "2")),
    downloadJobMemoryMiB: Number(env("EPIC_DOWNLOAD_MEMORY_MIB", "8192")),
    pipeline,
  };
}

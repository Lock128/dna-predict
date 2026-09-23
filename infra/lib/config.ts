/**
 * Central configuration for the EPIC (dna-predict) infrastructure.
 *
 * Values are resolved from environment variables / CDK context so the same app
 * can be deployed by a developer (`cdk deploy`) or by the GitHub Actions
 * workflow (which assumes an OIDC deploy role and runs the same command).
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

  /** GitHub OIDC configuration for the CI/CD deploy role. */
  readonly github: GitHubConfig;
}

export interface GitHubConfig {
  /** "owner/repo" — the GitHub repository allowed to deploy. */
  readonly repo: string;
  /** Branch allowed to deploy (deployments only run from here). */
  readonly branch: string;
  /**
   * Whether this stack should create the GitHub OIDC provider + deploy role.
   * Set false if the account already has a GitHub OIDC provider (only one is
   * allowed per account) or the role is managed elsewhere.
   */
  readonly createDeployRole: boolean;
}

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/** Build the config from environment, with sensible defaults for the challenge. */
export function loadConfig(): EpicConfig {
  const region = env("CDK_DEPLOY_REGION", env("CDK_DEFAULT_REGION", "eu-central-1"))!;
  const account = env("CDK_DEPLOY_ACCOUNT", env("CDK_DEFAULT_ACCOUNT"));

  return {
    prefix: env("EPIC_PREFIX", "epic")!,
    target: { account, region },
    zenodoRecord: env("EPIC_ZENODO_RECORD", "22285753")!,
    epicJobVcpu: Number(env("EPIC_JOB_VCPU", "4")),
    epicJobMemoryMiB: Number(env("EPIC_JOB_MEMORY_MIB", "16384")),
    downloadJobVcpu: Number(env("EPIC_DOWNLOAD_VCPU", "2")),
    downloadJobMemoryMiB: Number(env("EPIC_DOWNLOAD_MEMORY_MIB", "8192")),
    github: {
      repo: env("EPIC_GITHUB_REPO", "Lock128/dna-predict")!,
      branch: env("EPIC_GITHUB_BRANCH", "main")!,
      createDeployRole: bool("EPIC_CREATE_DEPLOY_ROLE", true),
    },
  };
}

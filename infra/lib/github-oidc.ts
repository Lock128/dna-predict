/**
 * GitHub Actions OIDC deploy role.
 *
 * Lets the GitHub Actions workflow assume an IAM role via OpenID Connect — no
 * long-lived AWS access keys stored in GitHub. The trust policy is scoped to a
 * single repository and branch, so only pushes to `main` of our repo can
 * deploy.
 *
 * One GitHub OIDC provider is allowed per AWS account. If the account already
 * has one, set `createProvider: false` and pass the existing provider ARN.
 */
import { CfnOutput } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_AUD = "sts.amazonaws.com";

export interface GitHubDeployRoleProps {
  readonly prefix: string;
  /** "owner/repo". */
  readonly repo: string;
  /** Branch permitted to assume the role (e.g. "main"). */
  readonly branch: string;
  /** Create the account-level OIDC provider (only one allowed per account). */
  readonly createProvider: boolean;
  /** Existing provider ARN, required when createProvider is false. */
  readonly existingProviderArn?: string;
}

export class GitHubDeployRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubDeployRoleProps) {
    super(scope, id);

    const provider: iam.IOpenIdConnectProvider = props.createProvider
      ? new iam.OpenIdConnectProvider(this, "Provider", {
          url: GITHUB_OIDC_URL,
          clientIds: [GITHUB_OIDC_AUD],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          "Provider",
          props.existingProviderArn!
        );

    // Trust: only the given repo + branch, only for the sts.amazonaws.com aud.
    const principal = new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": GITHUB_OIDC_AUD,
      },
      StringLike: {
        "token.actions.githubusercontent.com:sub": `repo:${props.repo}:ref:refs/heads/${props.branch}`,
      },
    });

    this.role = new iam.Role(this, "DeployRole", {
      roleName: `${props.prefix}-github-deploy`,
      assumedBy: principal,
      description: `Deploy role for GitHub Actions (${props.repo}@${props.branch})`,
      maxSessionDuration: undefined,
    });

    // Permissions to run `cdk deploy`: assume the CDK bootstrap roles, which in
    // turn hold the actual resource-creation permissions. This keeps the deploy
    // role minimal and delegates to CDK's bootstrap trust model.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/cdk-*"],
      })
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: this.role.roleArn,
      description: "Set as AWS_DEPLOY_ROLE_ARN (or a GitHub secret) for the workflow",
    });
  }
}

#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * Deploys the EPIC application stack to the target account/region. CI/CD is
 * handled by GitHub Actions (see .github/workflows/deploy.yml), which assumes
 * an OIDC deploy role and runs `cdk deploy` — the same command a developer runs
 * locally.
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";

import { loadConfig } from "../lib/config";
import { AppStack } from "../lib/app-stack";

const app = new cdk.App();
const config = loadConfig();

// Only pin the CloudFormation environment when we actually know the account.
// This lets `cdk synth` run environment-agnostically in CI (e.g. PR validation
// without AWS credentials) instead of producing an invalid assets-bucket name
// from an empty account id. On deploy, CDK_DEPLOY_ACCOUNT is set and the stack
// is environment-specific.
const env =
  config.target.account && config.target.account.length > 0
    ? { account: config.target.account, region: config.target.region }
    : undefined;

new AppStack(app, `${config.prefix}-app`, { config, env });

app.synth();

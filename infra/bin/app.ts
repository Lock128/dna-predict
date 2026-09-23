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

new AppStack(app, `${config.prefix}-app`, {
  config,
  env: {
    account: config.target.account,
    region: config.target.region,
  },
});

app.synth();

#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * Two modes, chosen automatically from config:
 *   - Pipeline mode (EPIC_PIPELINE_CONNECTION_ARN set): deploy the CI/CD
 *     pipeline, which in turn deploys the application stage.
 *   - Direct mode (default): deploy the application stack straight to the
 *     current account/region (good for a dev/sandbox account).
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";

import { loadConfig } from "../lib/config";
import { AppStack } from "../lib/app-stack";
import { PipelineStack } from "../lib/pipeline-stack";

const app = new cdk.App();
const config = loadConfig();

if (config.pipeline) {
  new PipelineStack(app, `${config.prefix}-pipeline`, {
    config,
    env: {
      account: config.pipeline.env.account,
      region: config.pipeline.env.region,
    },
  });
} else {
  new AppStack(app, `${config.prefix}-app`, {
    config,
    env: {
      account: config.target.account,
      region: config.target.region,
    },
  });
}

app.synth();

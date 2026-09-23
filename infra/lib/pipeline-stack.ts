/**
 * CI/CD pipeline (CDK Pipelines) that builds the app and deploys it to a target
 * account.
 *
 * The pipeline is self-mutating: pushing to the configured branch updates the
 * pipeline itself and then deploys the application stage. The synth step builds
 * the TypeScript app; Docker image assets (the epic container) are built by the
 * pipeline using a privileged CodeBuild environment.
 *
 * Requires a CodeStar (GitHub) connection ARN — see infra/README.md for setup.
 */
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import { LinuxArmBuildImage, BuildEnvironment } from "aws-cdk-lib/aws-codebuild";

import { EpicConfig } from "./config";
import { AppStage } from "./app-stage";

export interface PipelineStackProps extends StackProps {
  readonly config: EpicConfig;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config } = props;
    if (!config.pipeline) {
      throw new Error("PipelineStack requires config.pipeline (set EPIC_PIPELINE_CONNECTION_ARN)");
    }

    const source = CodePipelineSource.connection(
      config.pipeline.repo,
      config.pipeline.branch,
      { connectionArn: config.pipeline.connectionArn }
    );

    // ARM build image so Docker image assets build natively for Graviton.
    const buildEnvironment: BuildEnvironment = {
      buildImage: LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
      privileged: true, // needed to build Docker images
    };

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: `${config.prefix}-pipeline`,
      dockerEnabledForSynth: true,
      dockerEnabledForSelfMutation: true,
      codeBuildDefaults: { buildEnvironment },
      synth: new ShellStep("Synth", {
        input: source,
        // The CDK app lives in infra/; install deps and synth from there.
        commands: [
          "cd infra",
          "npm ci",
          "npm run build",
          "npx cdk synth",
        ],
        primaryOutputDirectory: "infra/cdk.out",
      }),
    });

    pipeline.addStage(
      new AppStage(this, "Deploy", {
        config,
        env: {
          account: config.target.account,
          region: config.target.region,
        },
      })
    );
  }
}

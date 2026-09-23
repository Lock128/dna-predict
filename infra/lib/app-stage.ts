/**
 * Deployable unit for CDK Pipelines: wraps the application stack so the pipeline
 * can deploy it to a target environment as a single stage.
 */
import { Stage, StageProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { AppStack } from "./app-stack";
import { EpicConfig } from "./config";

export interface AppStageProps extends StageProps {
  readonly config: EpicConfig;
}

export class AppStage extends Stage {
  constructor(scope: Construct, id: string, props: AppStageProps) {
    super(scope, id, props);
    new AppStack(this, "App", { config: props.config });
  }
}

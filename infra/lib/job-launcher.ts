/**
 * Job launcher: a Lambda that submits `epic` jobs to AWS Batch.
 *
 * This is the trigger for running the container on Batch — invoke it (console,
 * CLI, EventBridge, API) with a species/command payload and it submits the job.
 */
import * as path from "path";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as batch from "aws-cdk-lib/aws-batch";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface JobLauncherProps {
  readonly prefix: string;
  readonly jobQueue: batch.IJobQueue;
  readonly epicJobDefinition: batch.IJobDefinition;
  readonly dataBucket: s3.IBucket;
}

const LAMBDA_DIR = path.resolve(__dirname, "..", "lambda");

export class JobLauncher extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: JobLauncherProps) {
    super(scope, id);

    this.function = new lambda.Function(this, "LaunchEpicJob", {
      functionName: `${props.prefix}-launch-epic-job`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, "launch-epic-job")),
      timeout: Duration.seconds(30),
      environment: {
        JOB_QUEUE: props.jobQueue.jobQueueArn,
        JOB_DEFINITION: props.epicJobDefinition.jobDefinitionArn,
        DATA_BUCKET: props.dataBucket.bucketName,
      },
    });

    // Allow submitting jobs to our queue/definition.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["batch:SubmitJob"],
        resources: [
          props.jobQueue.jobQueueArn,
          props.epicJobDefinition.jobDefinitionArn,
        ],
      })
    );
  }
}

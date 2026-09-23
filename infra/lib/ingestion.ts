/**
 * Data ingestion: a Step Functions state machine that downloads the EPIC
 * dataset from Zenodo into S3.
 *
 * Flow:
 *   PrepareDownload (Lambda)  -> builds the per-file download command
 *   RunDownloadJob (Batch)    -> streams Zenodo files into s3://.../raw/<record>/
 *   VerifyDownload (Lambda)   -> confirms objects/bytes landed in S3
 *
 * The heavy transfer runs in Batch (not Lambda) to avoid the 15-minute and
 * ephemeral-storage limits on multi-GB downloads.
 */
import * as path from "path";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as batch from "aws-cdk-lib/aws-batch";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface IngestionProps {
  readonly prefix: string;
  readonly dataBucket: s3.IBucket;
  readonly jobQueue: batch.IJobQueue;
  readonly downloadJobDefinition: batch.IJobDefinition;
  readonly zenodoRecord: string;
}

const LAMBDA_DIR = path.resolve(__dirname, "..", "lambda");

export class Ingestion extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: IngestionProps) {
    super(scope, id);

    const commonEnv = {
      DATA_BUCKET: props.dataBucket.bucketName,
      ZENODO_RECORD: props.zenodoRecord,
    };

    const prepareFn = new lambda.Function(this, "PrepareDownload", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, "prepare-download")),
      timeout: Duration.minutes(1),
      environment: commonEnv,
    });

    const verifyFn = new lambda.Function(this, "VerifyDownload", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, "verify-download")),
      timeout: Duration.minutes(2),
      environment: commonEnv,
    });
    props.dataBucket.grantRead(verifyFn);

    // --- state machine tasks ------------------------------------------------
    const prepare = new tasks.LambdaInvoke(this, "PrepareDownloadTask", {
      lambdaFunction: prepareFn,
      payload: sfn.TaskInput.fromObject({ "record.$": "$.record" }),
      resultSelector: {
        "command.$": "$.Payload.command",
        "record.$": "$.Payload.record",
        "fileCount.$": "$.Payload.fileCount",
      },
      resultPath: "$.prepared",
    });

    const runDownload = new tasks.BatchSubmitJob(this, "RunDownloadJob", {
      jobName: `${props.prefix}-download`,
      jobQueueArn: props.jobQueue.jobQueueArn,
      jobDefinitionArn: props.downloadJobDefinition.jobDefinitionArn,
      containerOverrides: {
        command: sfn.JsonPath.listAt("$.prepared.command"),
      },
      resultPath: "$.download",
      // Step Functions waits for the Batch job to finish (.sync integration).
    });

    const verify = new tasks.LambdaInvoke(this, "VerifyDownloadTask", {
      lambdaFunction: verifyFn,
      payload: sfn.TaskInput.fromObject({ "record.$": "$.prepared.record" }),
      resultPath: "$.verify",
    });

    const definition = prepare.next(runDownload).next(verify);

    this.stateMachine = new sfn.StateMachine(this, "IngestionStateMachine", {
      stateMachineName: `${props.prefix}-ingestion`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(8),
      logs: {
        destination: new logs.LogGroup(this, "IngestionLogs", {
          logGroupName: `/aws/vendedlogs/states/${props.prefix}-ingestion`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ALL,
      },
      tracingEnabled: true,
    });
  }
}

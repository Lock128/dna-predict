/**
 * Execute runner: the inner, reusable, parametrizable Step Functions state
 * machine that runs ONE epic job end to end and records the outcome.
 *
 * It is deliberately decoupled from "how the run was chosen": you hand it a
 * fully-formed run object and it does the work. Today the outer baseline
 * machine builds that object from a species config, but anything (a future CNN
 * launcher, a manual invocation, an API) can start this machine with the same
 * shape — that's the parametrization surface we want going forward.
 *
 * Input (one run object):
 *   {
 *     "species": "oyster",
 *     "jobName": "epic-baseline-oyster",
 *     "command": ["baseline", "--species", "oyster", ...],
 *     "inputPrefix": "raw/22285753/oyster",
 *     "outputPrefix": "submissions/oyster",
 *     "model": "dinucleotide",   // optional; recorded (default "dinucleotide")
 *     "k": 2                       // optional; recorded
 *   }
 *
 * Flow:
 *   RunJob (Batch .sync)  — runs the container (syncs S3 in, epic, S3 out).
 *   ReadScores (Lambda)   — pulls submissions/<species>/scores.json from S3.
 *   Verify (Lambda)       — submission present + metrics sane -> PASSED/FAILED.
 *   RecordResult (DynamoDB PutItem) — one queryable item per run.
 * A failure in RunJob is caught and still recorded (verificationStatus FAILED),
 * so every attempt leaves a row in the table.
 */
import * as path from "path";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as batch from "aws-cdk-lib/aws-batch";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { RESULTS_TABLE, RESULTS_RECORD_TYPE } from "./storage";

export interface ExecuteProps {
  readonly prefix: string;
  readonly dataBucket: s3.IBucket;
  readonly jobQueue: batch.IJobQueue;
  readonly epicJobDefinition: batch.IJobDefinition;
  readonly resultsTable: dynamodb.ITable;
}

const LAMBDA_DIR = path.resolve(__dirname, "..", "lambda");

export class Execute extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ExecuteProps) {
    super(scope, id);

    const commonEnv = { DATA_BUCKET: props.dataBucket.bucketName };

    const readScoresFn = new lambda.Function(this, "ReadScores", {
      functionName: `${props.prefix}-read-scores`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, "read-scores")),
      timeout: Duration.seconds(30),
      environment: commonEnv,
    });
    props.dataBucket.grantRead(readScoresFn);

    const verifyFn = new lambda.Function(this, "VerifyRun", {
      functionName: `${props.prefix}-verify-run`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(LAMBDA_DIR, "verify-run")),
      timeout: Duration.seconds(30),
      environment: commonEnv,
    });
    props.dataBucket.grantRead(verifyFn);

    // --- run the container on Batch and wait -------------------------------
    // The command + S3 sync env come from the run object. EPIC_INPUT_PREFIX
    // switches the entrypoint into sync-down/run/sync-up mode. DATA_BUCKET is
    // already baked into the job definition.
    const runJob = new tasks.BatchSubmitJob(this, "RunJob", {
      jobName: sfn.JsonPath.stringAt("$.jobName"),
      jobQueueArn: props.jobQueue.jobQueueArn,
      jobDefinitionArn: props.epicJobDefinition.jobDefinitionArn,
      containerOverrides: {
        command: sfn.JsonPath.listAt("$.command"),
        environment: {
          EPIC_SPECIES: sfn.JsonPath.stringAt("$.species"),
          EPIC_INPUT_PREFIX: sfn.JsonPath.stringAt("$.inputPrefix"),
          EPIC_OUTPUT_PREFIX: sfn.JsonPath.stringAt("$.outputPrefix"),
        },
      },
      resultPath: "$.batch",
    });

    const readScores = new tasks.LambdaInvoke(this, "ReadScoresTask", {
      lambdaFunction: readScoresFn,
      payload: sfn.TaskInput.fromObject({
        "outputPrefix.$": "$.outputPrefix",
        "species.$": "$.species",
      }),
      resultSelector: {
        "found.$": "$.Payload.found",
        "scoresKey.$": "$.Payload.scoresKey",
        "scores.$": "$.Payload.scores",
      },
      resultPath: "$.read",
    });

    const verify = new tasks.LambdaInvoke(this, "VerifyTask", {
      lambdaFunction: verifyFn,
      payload: sfn.TaskInput.fromObject({
        "run.$": "$",
        "read.$": "$.read",
      }),
      resultSelector: {
        "verificationStatus.$": "$.Payload.verificationStatus",
        "verificationDetail.$": "$.Payload.verificationDetail",
        "submissionKey.$": "$.Payload.submissionKey",
        "submissionBytes.$": "$.Payload.submissionBytes",
      },
      resultPath: "$.verify",
    });

    // --- record the successful (verified) run to DynamoDB ------------------
    const recordSuccess = this.recordResultState(
      "RecordResult",
      props.resultsTable
    );

    // --- failure path: the Batch job failed; record a FAILED row -----------
    // We still want a queryable trace of the attempt.
    const recordFailure = this.recordFailureState(
      "RecordFailure",
      props.resultsTable
    );

    const happyPath = runJob.next(readScores).next(verify).next(recordSuccess);

    // If the Batch job errors, jump to recording a failure instead of aborting
    // with nothing written.
    runJob.addCatch(recordFailure, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    this.stateMachine = new sfn.StateMachine(this, "ExecuteStateMachine", {
      stateMachineName: `${props.prefix}-execute`,
      definitionBody: sfn.DefinitionBody.fromChainable(happyPath),
      timeout: Duration.hours(24),
      logs: {
        destination: new logs.LogGroup(this, "ExecuteLogs", {
          logGroupName: `/aws/vendedlogs/states/${props.prefix}-execute`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ALL,
      },
      tracingEnabled: true,
    });
  }

  /**
   * PutItem for a run that reached verification. Numbers/booleans are written
   * with typed DynamoDB attribute values; contig lists are stored as JSON
   * strings to keep the item flat and easy to query.
   *
   * runId (SK) sorts newest-first when paired with a reverse scan: we use
   * `<finishedAt>#<executionName>` so items are unique and time-ordered.
   */
  private recordResultState(
    id: string,
    table: dynamodb.ITable
  ): tasks.DynamoPutItem {
    return new tasks.DynamoPutItem(this, id, {
      table,
      item: {
        [RESULTS_TABLE.partitionKey]: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.species")
        ),
        [RESULTS_TABLE.sortKey]: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format(
            "{}#{}",
            sfn.JsonPath.stringAt("$$.State.EnteredTime"),
            sfn.JsonPath.stringAt("$$.Execution.Name")
          )
        ),
        recordType: tasks.DynamoAttributeValue.fromString(RESULTS_RECORD_TYPE),
        model: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.read.scores.model")
        ),
        // k / scored / auprc / spearman are stored as their JSON string form.
        // Metrics can be null (blind runs), so a string is the robust,
        // always-valid representation; the byModel/byStatus GSIs cover the
        // query paths we actually need (numeric range queries are not required).
        k: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("States.JsonToString($.read.scores.k)")
        ),
        scored: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("States.JsonToString($.read.scores.scored)")
        ),
        auprc: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("States.JsonToString($.read.scores.auprc)")
        ),
        spearman: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("States.JsonToString($.read.scores.spearman)")
        ),
        trainContigs: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt(
            "States.JsonToString($.read.scores.trainContigs)"
          )
        ),
        testContigs: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("States.JsonToString($.read.scores.testContigs)")
        ),
        verificationStatus: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.verify.verificationStatus")
        ),
        verificationDetail: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.verify.verificationDetail")
        ),
        submissionKey: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.verify.submissionKey")
        ),
        outputPrefix: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.outputPrefix")
        ),
        finishedAt: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$$.State.EnteredTime")
        ),
        executionArn: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$$.Execution.Id")
        ),
      },
      resultPath: "$.record",
    });
  }

  /**
   * PutItem for a run whose Batch job failed before we could score it. We store
   * the error and a FAILED status so it shows up in the byStatus GSI.
   */
  private recordFailureState(
    id: string,
    table: dynamodb.ITable
  ): tasks.DynamoPutItem {
    return new tasks.DynamoPutItem(this, id, {
      table,
      item: {
        [RESULTS_TABLE.partitionKey]: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.species")
        ),
        [RESULTS_TABLE.sortKey]: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format(
            "{}#{}",
            sfn.JsonPath.stringAt("$$.State.EnteredTime"),
            sfn.JsonPath.stringAt("$$.Execution.Name")
          )
        ),
        recordType: tasks.DynamoAttributeValue.fromString(RESULTS_RECORD_TYPE),
        model: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.model")
        ),
        verificationStatus: tasks.DynamoAttributeValue.fromString("FAILED"),
        verificationDetail: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("States.JsonToString($.error)")
        ),
        outputPrefix: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$.outputPrefix")
        ),
        finishedAt: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$$.State.EnteredTime")
        ),
        executionArn: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.stringAt("$$.Execution.Id")
        ),
      },
      resultPath: "$.record",
    });
  }
}

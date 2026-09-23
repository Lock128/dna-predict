/**
 * Baseline runner: a Step Functions state machine that runs the `epic`
 * dinucleotide baseline end-to-end, reproducibly, from a single trigger.
 *
 * You start it with just a species:
 *
 *     { "species": "nematostella" }      // one species
 *     { "species": "oyster", "k": 3 }    // override the k-mer size
 *     { "species": "all" }               // fan out over every configured species
 *
 * This is the OUTER orchestration machine — the one you trigger. It builds the
 * run(s) from config and then delegates the actual work to the reusable inner
 * "execute" machine (see execute.ts), one execution per run. Keeping the two
 * separate means the trigger surface stays "just a species" while the worker
 * can be extended/parametrized (new models, new commands) independently.
 *
 * Flow:
 *   BuildBaselineCommand (Lambda) — reads the bundled config/<species>.json and
 *       emits the exact `epic baseline` argv + S3 input/output prefixes. Always
 *       returns a `runs[]` array (length 1 for a single species) so the rest of
 *       the machine treats one species and "all" identically.
 *   RunBaselineJobs (Map → StartExecution.sync) — for each run, starts the inner
 *       execute machine with that run object and waits for it to finish. The
 *       inner machine runs the Batch job, reads scores, verifies, and records
 *       the result to DynamoDB.
 *
 * The species configs are versioned into the Lambda asset (see BUILD below), so
 * a run is fully reproducible from the deployed artifact — no local shell, no
 * hand-built command.
 */
import * as path from "path";
import * as fs from "fs";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { repoRoot } from "./storage";

export interface BaselineProps {
  readonly prefix: string;
  readonly dataBucket: s3.IBucket;
  /** The inner, reusable per-run worker this machine fans out to. */
  readonly executeStateMachine: sfn.IStateMachine;
  /** How many species to run in parallel when species = "all". */
  readonly maxConcurrency?: number;
}

const LAMBDA_DIR = path.resolve(__dirname, "..", "lambda");

/**
 * Stage the handler plus the repo `config/*.json` into a single asset directory
 * so the Lambda can read the species configs at runtime and the deployment is
 * self-contained. Copying happens at synth time via CDK local bundling (no
 * Docker required).
 */
function bundledCommandBuilderCode(): lambda.Code {
  const handlerDir = path.join(LAMBDA_DIR, "build-baseline-command");
  const configDir = path.join(repoRoot(), "config");
  return lambda.Code.fromAsset(handlerDir, {
    // Deterministic asset hash: rehash when the handler or any config changes.
    assetHashType: undefined,
    bundling: {
      // `image` is required by the type but only used as the Docker fallback;
      // local bundling below handles everything, so this is never invoked.
      image: lambda.Runtime.NODEJS_22_X.bundlingImage,
      local: {
        tryBundle(outputDir: string): boolean {
          // Copy the handler sources.
          for (const entry of fs.readdirSync(handlerDir)) {
            fs.copyFileSync(
              path.join(handlerDir, entry),
              path.join(outputDir, entry)
            );
          }
          // Copy the species configs under ./config next to the handler.
          const outConfig = path.join(outputDir, "config");
          fs.mkdirSync(outConfig, { recursive: true });
          for (const entry of fs.readdirSync(configDir)) {
            if (entry.endsWith(".json")) {
              fs.copyFileSync(
                path.join(configDir, entry),
                path.join(outConfig, entry)
              );
            }
          }
          return true;
        },
      },
    },
  });
}

export class Baseline extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BaselineProps) {
    super(scope, id);

    // --- Lambda: turn a species into a reproducible epic command -----------
    const buildFn = new lambda.Function(this, "BuildBaselineCommand", {
      functionName: `${props.prefix}-build-baseline-command`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: bundledCommandBuilderCode(),
      timeout: Duration.seconds(30),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
      },
    });

    // --- state machine tasks -----------------------------------------------
    const build = new tasks.LambdaInvoke(this, "BuildBaselineCommandTask", {
      lambdaFunction: buildFn,
      payload: sfn.TaskInput.fromObject({
        "species.$": "$.species",
        "k.$": "$.k",
      }),
      // Unwrap the Lambda result so $.runs / $.species are at the top level.
      resultSelector: {
        "species.$": "$.Payload.species",
        "runs.$": "$.Payload.runs",
      },
      resultPath: "$",
    });

    // For each run, start the inner execute machine and wait (.sync). The run
    // object (command, prefixes, species, model, k) is passed through verbatim
    // as the child execution input — that object IS the parametrization surface
    // the inner machine accepts.
    const runOne = new tasks.StepFunctionsStartExecution(this, "RunBaselineJob", {
      stateMachine: props.executeStateMachine,
      integrationPattern: sfn.IntegrationPattern.RUN_JOB, // .sync: wait for it
      input: sfn.TaskInput.fromJsonPathAt("$"),
      // Name each child execution after the job for easy tracing (kept unique
      // by Step Functions per-name-per-day; collisions just reuse the run).
      name: sfn.JsonPath.stringAt("$.jobName"),
    });

    const runMap = new sfn.Map(this, "RunBaselineJobs", {
      itemsPath: sfn.JsonPath.stringAt("$.runs"),
      maxConcurrency: props.maxConcurrency ?? 5,
      resultPath: "$.results",
    });
    runMap.itemProcessor(runOne);

    const definition = build.next(runMap);

    this.stateMachine = new sfn.StateMachine(this, "BaselineStateMachine", {
      stateMachineName: `${props.prefix}-baseline`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(24),
      logs: {
        destination: new logs.LogGroup(this, "BaselineLogs", {
          logGroupName: `/aws/vendedlogs/states/${props.prefix}-baseline`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ALL,
      },
      tracingEnabled: true,
    });
  }
}

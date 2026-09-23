/**
 * AWS Batch compute for running the `epic` container on Graviton (ARM64).
 *
 * We use Fargate (ARM64) so there are no EC2 instances to manage or patch and
 * we only pay while a job runs — a good fit for the bursty
 * fit/predict/score workloads. Two job definitions are created:
 *
 *   - `epic` job: runs the pipeline binary (baseline etc.) against data in S3.
 *   - `download` job: fetches the Zenodo dataset into S3 (multi-GB, so it runs
 *     here rather than in a 15-minute Lambda).
 *
 * The container image is built from the repo Dockerfile as a CDK asset and
 * pushed to ECR automatically on deploy.
 */
import * as path from "path";
import { Duration, Size } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as batch from "aws-cdk-lib/aws-batch";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { repoRoot } from "./storage";

export interface BatchComputeProps {
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
  readonly dataBucket: s3.IBucket;

  readonly epicJobVcpu: number;
  readonly epicJobMemoryMiB: number;
  readonly downloadJobVcpu: number;
  readonly downloadJobMemoryMiB: number;
}

export class BatchCompute extends Construct {
  readonly jobQueue: batch.JobQueue;
  readonly epicJobDefinition: batch.EcsJobDefinition;
  readonly downloadJobDefinition: batch.EcsJobDefinition;
  readonly image: ecrAssets.DockerImageAsset;

  constructor(scope: Construct, id: string, props: BatchComputeProps) {
    super(scope, id);

    // --- container image (built from the repo Dockerfile, ARM64) ------------
    this.image = new ecrAssets.DockerImageAsset(this, "EpicImage", {
      directory: repoRoot(),
      file: "Dockerfile",
      platform: ecrAssets.Platform.LINUX_ARM64,
      // The build context is the repo root; .dockerignore keeps it small.
    });

    // --- Fargate ARM64 (Graviton) compute environment -----------------------
    const computeEnv = new batch.FargateComputeEnvironment(this, "FargateArm", {
      vpc: props.vpc,
      spot: true, // cheaper; the baseline is restartable
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      maxvCpus: 64,
    });

    this.jobQueue = new batch.JobQueue(this, "JobQueue", {
      jobQueueName: `${props.prefix}-queue`,
      priority: 1,
    });
    this.jobQueue.addComputeEnvironment(computeEnv, 1);

    // --- shared execution/job roles -----------------------------------------
    // Job role: what the container itself may do (read/write our data bucket).
    const jobRole = new iam.Role(this, "JobRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Permissions granted to the epic Batch container",
    });
    props.dataBucket.grantReadWrite(jobRole);

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/aws/batch/${props.prefix}`,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // --- epic pipeline job definition ---------------------------------------
    const epicContainer = new batch.EcsFargateContainerDefinition(this, "EpicContainer", {
      image: ecs.ContainerImage.fromDockerImageAsset(this.image),
      cpu: props.epicJobVcpu,
      memory: Size.mebibytes(props.epicJobMemoryMiB),
      fargateCpuArchitecture: ecs.CpuArchitecture.ARM64,
      fargateOperatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      jobRole,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "epic", logGroup }),
      // Default command; overridden per job submission by the launcher Lambda.
      command: ["--help"],
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
      },
    });

    this.epicJobDefinition = new batch.EcsJobDefinition(this, "EpicJob", {
      jobDefinitionName: `${props.prefix}-epic`,
      container: epicContainer,
      retryAttempts: 2,
      timeout: Duration.hours(12),
    });

    // --- data-download job definition ---------------------------------------
    // Reuses the same image; the container entrypoint is `epic`, so we point it
    // at a small shell that streams Zenodo files into S3. See infra/README.md
    // for how the download job command is supplied by the ingestion workflow.
    const downloadContainer = new batch.EcsFargateContainerDefinition(this, "DownloadContainer", {
      image: ecs.ContainerImage.fromRegistry("public.ecr.aws/aws-cli/aws-cli:latest"),
      cpu: props.downloadJobVcpu,
      memory: Size.mebibytes(props.downloadJobMemoryMiB),
      fargateCpuArchitecture: ecs.CpuArchitecture.ARM64,
      fargateOperatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      jobRole,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "download", logGroup }),
      command: ["--version"],
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
      },
      // Zenodo downloads need scratch space before uploading to S3.
      ephemeralStorageSize: Size.gibibytes(200),
    });

    this.downloadJobDefinition = new batch.EcsJobDefinition(this, "DownloadJob", {
      jobDefinitionName: `${props.prefix}-download`,
      container: downloadContainer,
      retryAttempts: 3,
      timeout: Duration.hours(6),
    });
  }
}

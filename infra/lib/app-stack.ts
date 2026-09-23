/**
 * The EPIC application stack: everything needed to store the data, run the
 * `epic` container on AWS Batch, and ingest the dataset from Zenodo.
 */
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

import { EpicConfig } from "./config";
import { Storage } from "./storage";
import { BatchCompute } from "./batch-compute";
import { Ingestion } from "./ingestion";
import { JobLauncher } from "./job-launcher";
import { GitHubDeployRole } from "./github-oidc";

export interface AppStackProps extends StackProps {
  readonly config: EpicConfig;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config } = props;

    // A small VPC with public + private-with-egress subnets. Fargate tasks run
    // in the private subnets and reach S3/Zenodo via NAT.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
    });

    const storage = new Storage(this, "Storage", { prefix: config.prefix });

    const compute = new BatchCompute(this, "Batch", {
      prefix: config.prefix,
      vpc,
      dataBucket: storage.dataBucket,
      epicJobVcpu: config.epicJobVcpu,
      epicJobMemoryMiB: config.epicJobMemoryMiB,
      downloadJobVcpu: config.downloadJobVcpu,
      downloadJobMemoryMiB: config.downloadJobMemoryMiB,
    });

    const ingestion = new Ingestion(this, "Ingestion", {
      prefix: config.prefix,
      dataBucket: storage.dataBucket,
      jobQueue: compute.jobQueue,
      downloadJobDefinition: compute.downloadJobDefinition,
      zenodoRecord: config.zenodoRecord,
    });

    const launcher = new JobLauncher(this, "Launcher", {
      prefix: config.prefix,
      jobQueue: compute.jobQueue,
      epicJobDefinition: compute.epicJobDefinition,
      dataBucket: storage.dataBucket,
    });

    // GitHub Actions OIDC deploy role (only pushes to the configured repo/branch
    // can assume it). Optional so the account's single OIDC provider isn't
    // duplicated if it already exists.
    if (config.github.createDeployRole) {
      new GitHubDeployRole(this, "GitHubDeploy", {
        prefix: config.prefix,
        repo: config.github.repo,
        branch: config.github.branch,
        createProvider: true,
      });
    }

    // --- handy outputs ------------------------------------------------------
    new CfnOutput(this, "DataBucketName", { value: storage.dataBucket.bucketName });
    new CfnOutput(this, "JobQueueArn", { value: compute.jobQueue.jobQueueArn });
    new CfnOutput(this, "EpicJobDefinitionArn", {
      value: compute.epicJobDefinition.jobDefinitionArn,
    });
    new CfnOutput(this, "IngestionStateMachineArn", {
      value: ingestion.stateMachine.stateMachineArn,
    });
    new CfnOutput(this, "LaunchJobFunctionName", {
      value: launcher.function.functionName,
    });
    new CfnOutput(this, "ImageUri", { value: compute.image.imageUri });
  }
}

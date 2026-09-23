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

export interface AppStackProps extends StackProps {
  readonly config: EpicConfig;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Cost-optimized VPC: no NAT gateway (the only 24/7 cost). Fargate tasks
    // run in PUBLIC subnets with a public IP so they can pull the image and
    // reach Zenodo directly; S3 traffic goes through a free gateway endpoint.
    // Ingress is blocked at the security-group level (see BatchCompute).
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          // Do not hand out public IPs by default; the Batch compute env
          // assigns them only to task ENIs that need egress.
          mapPublicIpOnLaunch: false,
        },
      ],
      gatewayEndpoints: {
        // Free S3 access without traversing the internet (no NAT needed).
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
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

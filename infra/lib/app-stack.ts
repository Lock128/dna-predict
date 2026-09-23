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
import { Execute } from "./execute";
import { Baseline } from "./baseline";

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
    // Logical id is "VpcV2" (not "Vpc") on purpose: switching from the original
    // NAT-based layout to this NAT-free public-subnet layout can't be done as an
    // in-place subnet re-CIDR (CloudFormation tries to create new subnets whose
    // CIDRs collide with the old ones in the same VPC). A new logical id creates
    // a fresh VPC and retires the old one cleanly.
    const vpc = new ec2.Vpc(this, "VpcV2", {
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

    // Inner, reusable worker: run one epic job, score, verify, record.
    const execute = new Execute(this, "Execute", {
      prefix: config.prefix,
      dataBucket: storage.dataBucket,
      jobQueue: compute.jobQueue,
      epicJobDefinition: compute.epicJobDefinition,
      resultsTable: storage.resultsTable,
    });

    // Outer, triggered machine: turn a species into run(s) and fan out to the
    // execute machine. This is the "just start a Step Function" entry point.
    const baseline = new Baseline(this, "Baseline", {
      prefix: config.prefix,
      dataBucket: storage.dataBucket,
      executeStateMachine: execute.stateMachine,
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
    new CfnOutput(this, "BaselineStateMachineArn", {
      value: baseline.stateMachine.stateMachineArn,
    });
    new CfnOutput(this, "ExecuteStateMachineArn", {
      value: execute.stateMachine.stateMachineArn,
    });
    new CfnOutput(this, "ResultsTableName", {
      value: storage.resultsTable.tableName,
    });
  }
}

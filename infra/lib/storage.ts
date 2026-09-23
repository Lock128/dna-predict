/**
 * Storage: the S3 data bucket that is the hub for genomes, tracks, and
 * submissions (mirrors the layout in docs/AWS.md).
 */
import * as path from "path";
import { RemovalPolicy, Duration } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface StorageProps {
  readonly prefix: string;
}

export class Storage extends Construct {
  /** Data hub: raw/ processed/ submissions/ models/ (see docs/AWS.md). */
  readonly dataBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    this.dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: undefined, // let CloudFormation assign a unique name
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      // Keep data on stack deletion — the download is expensive to re-fetch.
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Move pristine raw data to cheaper storage after we've processed it.
          id: "raw-to-ia",
          prefix: "raw/",
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
        },
        {
          // Expire old noncurrent versions to control cost.
          id: "expire-old-versions",
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
    });
  }
}

/** Absolute path to the repo root (one level above infra/). */
export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

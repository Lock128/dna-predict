/**
 * Storage: the S3 data bucket that is the hub for genomes, tracks, and
 * submissions (mirrors the layout in docs/AWS.md).
 */
import * as path from "path";
import { RemovalPolicy, Duration } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface StorageProps {
  readonly prefix: string;
}

/**
 * Attribute names for the results table, shared with the recorder Lambda so the
 * item shape and the GSI key names stay in one place.
 */
export const RESULTS_TABLE = {
  partitionKey: "species", // PK
  sortKey: "runId", // SK: sortable id (finishedAt#executionName)
  // GSI: all runs of a given model over time (dinucleotide, cnn, ...).
  byModel: { name: "byModel", partitionKey: "model", sortKey: "finishedAt" },
  // GSI: triage by verification outcome (PASSED / FAILED / ...).
  byStatus: {
    name: "byStatus",
    partitionKey: "verificationStatus",
    sortKey: "finishedAt",
  },
  // GSI: list every run newest-first across all species. Uses a constant
  // partition value so a single query returns the global timeline.
  byDate: { name: "byDate", partitionKey: "recordType", sortKey: "finishedAt" },
} as const;

/** The constant value stored in `recordType` so the byDate GSI has one partition. */
export const RESULTS_RECORD_TYPE = "run";

export class Storage extends Construct {
  /** Data hub: raw/ processed/ submissions/ models/ (see docs/AWS.md). */
  readonly dataBucket: s3.Bucket;

  /** Query-able history of run scores + verification outcomes. */
  readonly resultsTable: dynamodb.Table;

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

    // --- results table ------------------------------------------------------
    // One item per run: the scores (AUPRC/Spearman) plus the verification
    // outcome, keyed by species + a sortable runId. On-demand billing (zero
    // idle cost) and RETAIN so results outlive a stack teardown.
    this.resultsTable = new dynamodb.Table(this, "ResultsTable", {
      tableName: `${props.prefix}-results`,
      partitionKey: {
        name: RESULTS_TABLE.partitionKey,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: RESULTS_TABLE.sortKey,
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.resultsTable.addGlobalSecondaryIndex({
      indexName: RESULTS_TABLE.byModel.name,
      partitionKey: {
        name: RESULTS_TABLE.byModel.partitionKey,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: RESULTS_TABLE.byModel.sortKey,
        type: dynamodb.AttributeType.STRING,
      },
    });
    this.resultsTable.addGlobalSecondaryIndex({
      indexName: RESULTS_TABLE.byStatus.name,
      partitionKey: {
        name: RESULTS_TABLE.byStatus.partitionKey,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: RESULTS_TABLE.byStatus.sortKey,
        type: dynamodb.AttributeType.STRING,
      },
    });
    this.resultsTable.addGlobalSecondaryIndex({
      indexName: RESULTS_TABLE.byDate.name,
      partitionKey: {
        name: RESULTS_TABLE.byDate.partitionKey,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: RESULTS_TABLE.byDate.sortKey,
        type: dynamodb.AttributeType.STRING,
      },
    });
  }
}

/** Absolute path to the repo root (one level above infra/). */
export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

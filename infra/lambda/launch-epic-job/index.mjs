/**
 * Lambda: submit an `epic` job to AWS Batch.
 *
 * Invoked directly (console/CLI/API) or by other services with an event like:
 *   {
 *     "species": "nematostella",
 *     "command": ["baseline", "--genome", "/data/...", ...],   // optional; overrides container command
 *     "inputPrefix": "raw/22285753/oyster",                     // optional; enables S3 sync-in
 *     "outputPrefix": "submissions/oyster",                     // optional; S3 sync-out target
 *     "jobName": "epic-nematostella-baseline"                   // optional
 *   }
 *
 * When inputPrefix is set, the container entrypoint syncs
 * s3://$DATA_BUCKET/<inputPrefix> -> /data, runs epic, and syncs /data/out ->
 * s3://$DATA_BUCKET/<outputPrefix> (default submissions/<species>).
 *
 * Environment:
 *   JOB_QUEUE       - Batch job queue ARN/name
 *   JOB_DEFINITION  - epic Batch job definition ARN/name
 *   DATA_BUCKET     - S3 data bucket name (passed through to the container)
 */
import { BatchClient, SubmitJobCommand } from "@aws-sdk/client-batch";

const batch = new BatchClient({});

export const handler = async (event = {}) => {
  const queue = process.env.JOB_QUEUE;
  const jobDefinition = process.env.JOB_DEFINITION;
  if (!queue || !jobDefinition) {
    throw new Error("JOB_QUEUE and JOB_DEFINITION must be set");
  }

  const species = event.species ?? "unknown";
  const jobName =
    (event.jobName ?? `epic-${species}-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "-");

  // Allow the caller to override the container command (fit/predict/score args).
  const containerOverrides = {};
  if (Array.isArray(event.command) && event.command.length > 0) {
    containerOverrides.command = event.command;
  }
  containerOverrides.environment = [
    { name: "EPIC_SPECIES", value: String(species) },
    ...(process.env.DATA_BUCKET
      ? [{ name: "DATA_BUCKET", value: process.env.DATA_BUCKET }]
      : []),
    // Setting EPIC_INPUT_PREFIX switches the entrypoint into S3-synced mode.
    ...(event.inputPrefix
      ? [{ name: "EPIC_INPUT_PREFIX", value: String(event.inputPrefix) }]
      : []),
    ...(event.outputPrefix
      ? [{ name: "EPIC_OUTPUT_PREFIX", value: String(event.outputPrefix) }]
      : []),
  ];

  const res = await batch.send(
    new SubmitJobCommand({
      jobName,
      jobQueue: queue,
      jobDefinition,
      containerOverrides,
      parameters: event.parameters ?? undefined,
    })
  );

  return {
    jobName,
    jobId: res.jobId,
    jobArn: res.jobArn,
    species,
  };
};

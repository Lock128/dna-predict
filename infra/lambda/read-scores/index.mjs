/**
 * Lambda: read the run's scores.json from S3.
 *
 * The epic baseline writes a small scores.json into its output dir, which the
 * container entrypoint syncs to s3://<bucket>/<outputPrefix>/scores.json. This
 * step fetches and parses it so the rest of the state machine (verify + record)
 * works with structured scores instead of scraping CloudWatch logs.
 *
 * Event (the per-run object built by build-baseline-command):
 *   { "species": "oyster", "outputPrefix": "submissions/oyster", ... }
 *
 * Output:
 *   {
 *     "found": true,
 *     "scoresKey": "submissions/oyster/scores.json",
 *     "scores": { species, model, k, scored, auprc, spearman, ... }
 *   }
 * or { "found": false, "scoresKey": "..." } if the object is missing.
 *
 * Environment:
 *   DATA_BUCKET - S3 data bucket name
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const handler = async (event = {}) => {
  const bucket = process.env.DATA_BUCKET;
  if (!bucket) throw new Error("DATA_BUCKET must be set");

  const outputPrefix = String(event.outputPrefix ?? "").replace(/\/+$/, "");
  if (!outputPrefix) throw new Error("event.outputPrefix is required");
  const scoresKey = `${outputPrefix}/scores.json`;

  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: scoresKey })
    );
    const body = await res.Body.transformToString();
    const scores = JSON.parse(body);
    return { found: true, scoresKey, scores };
  } catch (err) {
    // Missing object -> report not found so verify can fail cleanly.
    const name = err?.name || "";
    if (name === "NoSuchKey" || name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
      return { found: false, scoresKey };
    }
    throw err;
  }
};

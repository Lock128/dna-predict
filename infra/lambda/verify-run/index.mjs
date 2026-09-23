/**
 * Lambda: verify a baseline run before recording it.
 *
 * Checks, in order:
 *   1. scores.json was found (read-scores succeeded).
 *   2. The submission TSV exists in S3 and is non-empty.
 *   3. If the run was scored (labeled test set), the metrics are real numbers
 *      (not null/NaN) and AUPRC clears a floor (default 0 -> "a score exists").
 *      For a blind run (scored=false) there are no local labels, so we only
 *      require the submission to exist.
 *
 * The result is a status + human-readable detail that the next state writes to
 * DynamoDB, so failures are queryable rather than just red in the console.
 *
 * Event:
 *   {
 *     "run":    { species, outputPrefix, ... },   // the per-run object
 *     "read":   { found, scoresKey, scores },      // read-scores output
 *   }
 *
 * Output:
 *   { "verificationStatus": "PASSED"|"FAILED", "verificationDetail": "...",
 *     "submissionKey": "...", "submissionBytes": N }
 *
 * Environment:
 *   DATA_BUCKET       - S3 data bucket name
 *   MIN_AUPRC         - optional floor for a scored run's AUPRC (default "0")
 */
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const handler = async (event = {}) => {
  const bucket = process.env.DATA_BUCKET;
  if (!bucket) throw new Error("DATA_BUCKET must be set");
  const minAuprc = Number(process.env.MIN_AUPRC ?? "0");

  const run = event.run ?? {};
  const read = event.read ?? {};
  const species = String(run.species ?? "unknown");
  const outputPrefix = String(run.outputPrefix ?? "").replace(/\/+$/, "");

  const fail = (detail, extra = {}) => ({
    verificationStatus: "FAILED",
    verificationDetail: detail,
    ...extra,
  });

  if (!read.found || !read.scores) {
    return fail(`scores.json not found at ${read.scoresKey ?? "(unknown key)"}`);
  }
  const scores = read.scores;

  // Locate + size the submission. Prefer the path recorded in scores.json,
  // mapped into the output prefix; fall back to the conventional name.
  const submissionName =
    (scores.submission && String(scores.submission).split("/").pop()) ||
    `${species}.baseline.tsv`;
  const submissionKey = `${outputPrefix}/${submissionName}`;

  let submissionBytes = 0;
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: submissionKey })
    );
    submissionBytes = Number(head.ContentLength ?? 0);
  } catch (err) {
    return fail(`submission missing in S3: s3://${bucket}/${submissionKey}`, {
      submissionKey,
      submissionBytes: 0,
    });
  }
  if (submissionBytes <= 0) {
    return fail(`submission is empty: s3://${bucket}/${submissionKey}`, {
      submissionKey,
      submissionBytes,
    });
  }

  // Blind run: no local labels, submission existence is the whole check.
  if (!scores.scored) {
    return {
      verificationStatus: "PASSED",
      verificationDetail: `blind run: submission present (${submissionBytes} bytes)`,
      submissionKey,
      submissionBytes,
    };
  }

  // Scored run: metrics must be real numbers and AUPRC must clear the floor.
  const auprc = scores.auprc;
  const spearman = scores.spearman;
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  if (!isNum(auprc) || !isNum(spearman)) {
    return fail(
      `scored run but metrics are not finite (auprc=${auprc}, spearman=${spearman})`,
      { submissionKey, submissionBytes }
    );
  }
  if (auprc < minAuprc) {
    return fail(`AUPRC ${auprc} below floor ${minAuprc}`, {
      submissionKey,
      submissionBytes,
    });
  }

  return {
    verificationStatus: "PASSED",
    verificationDetail: `scored run ok (auprc=${auprc}, spearman=${spearman})`,
    submissionKey,
    submissionBytes,
  };
};

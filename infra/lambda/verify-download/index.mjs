/**
 * Lambda: verify that the Zenodo download landed in S3.
 *
 * Lists objects under raw/<record>/ and returns a summary. The Step Functions
 * workflow uses this to confirm the ingestion job actually produced data before
 * marking the run successful.
 *
 * Event:  { "record": "22285753" }
 * Output: { "record": "...", "objectCount": N, "totalBytes": B, "ok": bool }
 *
 * Environment:
 *   DATA_BUCKET - S3 bucket to inspect
 */
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export const handler = async (event = {}) => {
  const record = String(event.record ?? process.env.ZENODO_RECORD ?? "").trim();
  const bucket = process.env.DATA_BUCKET;
  if (!bucket) throw new Error("DATA_BUCKET must be set");

  const prefix = `raw/${record}/`;
  let objectCount = 0;
  let totalBytes = 0;
  let token;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of res.Contents ?? []) {
      objectCount += 1;
      totalBytes += obj.Size ?? 0;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  const ok = objectCount > 0 && totalBytes > 0;
  if (!ok) {
    throw new Error(`no data found under s3://${bucket}/${prefix}`);
  }

  return { record, bucket, prefix, objectCount, totalBytes, ok };
};

/**
 * Lambda: build the shell command for the Batch download job.
 *
 * The Zenodo record is a set of files; this fetches the record metadata and
 * emits a command that downloads each file and streams it into S3 under raw/.
 * Running the actual transfer in Batch (not here) keeps us clear of the Lambda
 * 15-minute / ephemeral-storage limits for multi-GB data.
 *
 * Event:  { "record": "22285753" }  (falls back to ZENODO_RECORD env)
 * Output: { "command": ["bash","-c","..."], "record": "...", "fileCount": N }
 *
 * Environment:
 *   DATA_BUCKET    - target S3 bucket
 *   ZENODO_RECORD  - default Zenodo record id
 */
const ZENODO_API = "https://zenodo.org/api/records";

export const handler = async (event = {}) => {
  const record = String(event.record ?? process.env.ZENODO_RECORD ?? "").trim();
  const bucket = process.env.DATA_BUCKET;
  if (!record) throw new Error("no Zenodo record id provided");
  if (!bucket) throw new Error("DATA_BUCKET must be set");

  const res = await fetch(`${ZENODO_API}/${record}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Zenodo API ${res.status} for record ${record}`);
  }
  const data = await res.json();
  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length === 0) {
    throw new Error(`Zenodo record ${record} has no files`);
  }

  // Build a robust download-and-upload command. Each file is streamed to S3
  // (curl -> aws s3 cp -) so we don't need the whole file on local disk.
  // Files already present in S3 (same size) could be skipped in a future rev.
  const lines = files.map((f) => {
    const url = f.links?.self ?? f.links?.download;
    const key = `raw/${record}/${f.key}`;
    // Quote for the shell; keys/urls from Zenodo are simple but be safe.
    return `echo "downloading ${f.key}"; curl -fsSL ${shellQuote(url)} | aws s3 cp - ${shellQuote(
      `s3://${bucket}/${key}`
    )}`;
  });

  const script = ["set -euo pipefail", ...lines, 'echo "done"'].join("\n");

  return {
    record,
    fileCount: files.length,
    bucket,
    command: ["bash", "-c", script],
  };
};

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

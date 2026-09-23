/**
 * Lambda: build the `epic baseline` job parameters from a species config.
 *
 * This is the first step of the baseline Step Functions state machine. Given a
 * species, it reads the bundled `config/<species>.json` and produces the exact
 * container command (argv) plus the S3 input/output prefixes, so the run is
 * fully reproducible from a single `{ "species": "..." }` input — no laptop, no
 * shell script. It mirrors the config-driven logic in scripts/run-epic.sh so
 * the local and cloud paths build identical commands.
 *
 * The per-species config files are bundled next to this handler (see
 * infra/lib/baseline.ts, which stages repo `config/*.json` into `./config/`),
 * so the state machine is self-contained and versioned with the deployment.
 *
 * Event:
 *   {
 *     "species": "oyster",   // required (single species), or "all" to fan out
 *     "k": 3                 // optional; overrides the k-mer size (default 2)
 *   }
 *
 * Output (always a `runs[]` array so the state machine treats one species and
 * "all" the same way — a Map fans out over `runs`):
 *   {
 *     "species": "oyster",   // or "all"
 *     "runs": [
 *       {
 *         "species": "oyster",
 *         "jobName": "epic-baseline-oyster",
 *         "command": ["baseline", "--genome", "/data/genome.fa", ...],
 *         "inputPrefix": "raw/22285753/oyster",
 *         "outputPrefix": "submissions/oyster",
 *         "environment": [ {name, value}, ... ]  // container env for the job
 *       }
 *     ]
 *   }
 *
 * Environment:
 *   DATA_BUCKET   - S3 data bucket name (passed through to the container)
 *   DATA_DIR      - container mount for data (default: /data)
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, "config");
const DATA_DIR = process.env.DATA_DIR || "/data";

/** Read and parse config/<species>.json. */
async function loadConfig(species) {
  const file = path.join(CONFIG_DIR, `${species}.json`);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    const available = await listSpecies();
    throw new Error(
      `no config for species '${species}' (looked for ${species}.json). ` +
        `Available: ${available.join(", ") || "(none bundled)"}`
    );
  }
  return JSON.parse(raw);
}

/** All species that have a bundled config file. */
async function listSpecies() {
  let entries = [];
  try {
    entries = await readdir(CONFIG_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/**
 * Build the epic argv + S3 prefixes for one species.
 * Kept in lock-step with the config-driven branch of scripts/run-epic.sh.
 */
function buildRun(cfg, species, k) {
  const p = (name) => `${DATA_DIR}/${cfg[name]}`;
  const command = [
    "baseline",
    "--species",
    species,
    "--genome",
    p("genome"),
    "--plus",
    p("plus"),
    "--minus",
    p("minus"),
  ];

  const train = cfg.trainContigs ?? [];
  const test = cfg.testContigs ?? [];
  if (train.length > 0) command.push("--train-contigs", train.join(","));
  if (test.length > 0) command.push("--test-contigs", test.join(","));
  if (k !== undefined && k !== null && `${k}` !== "") {
    command.push("--k", String(k));
  }
  // Real (unlabeled) test set: no local labels to score against.
  if (cfg.blindTest || test.length === 0) command.push("--no-score");
  command.push("--out", `${DATA_DIR}/out/${species}.baseline.tsv`);

  const inputPrefix = String(cfg.inputPrefix).replace(/\/+$/, "");
  const outputPrefix = `submissions/${species}`;

  const environment = [
    { name: "EPIC_SPECIES", value: species },
    { name: "EPIC_INPUT_PREFIX", value: inputPrefix },
    { name: "EPIC_OUTPUT_PREFIX", value: outputPrefix },
  ];
  if (process.env.DATA_BUCKET) {
    environment.push({ name: "DATA_BUCKET", value: process.env.DATA_BUCKET });
  }

  return {
    species,
    // model + k are echoed onto the run so the execute machine can record them
    // even on the failure path (before scores.json is read).
    model: "dinucleotide",
    k: k === undefined || k === null || `${k}` === "" ? 2 : Number(k),
    jobName: `epic-baseline-${species}`.replace(/[^A-Za-z0-9_-]/g, "-"),
    command,
    inputPrefix,
    outputPrefix,
    environment,
  };
}

export const handler = async (event = {}) => {
  const species = String(event.species ?? "").trim();
  if (!species) {
    const available = await listSpecies();
    throw new Error(
      `no species provided. Pass {"species":"<name>"} or {"species":"all"}. ` +
        `Available: ${available.join(", ")}`
    );
  }
  const k = event.k;

  if (species === "all") {
    const names = await listSpecies();
    if (names.length === 0) throw new Error("no species configs bundled");
    const runs = [];
    for (const name of names) {
      runs.push(buildRun(await loadConfig(name), name, k));
    }
    return { species: "all", runs };
  }

  const cfg = await loadConfig(species);
  return { species, runs: [buildRun(cfg, species, k)] };
};

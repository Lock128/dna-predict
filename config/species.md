# Per-species configuration

Each species has a `<species>.json` file describing where its data lives in S3
and which contigs are train vs. test. `scripts/run-epic.sh` reads these so a run
is just `--species <name>` instead of a long argument list.

## Format

```json
{
  "species": "oyster",
  "inputPrefix": "raw/22285753/oyster",
  "genome": "genome.fa",
  "plus": "initiation.plus.bedgraph",
  "minus": "initiation.minus.bedgraph",
  "trainContigs": ["chr1", "chr2", "chr3"],
  "testContigs": ["chr4"]
}
```

- `inputPrefix` — S3 key prefix under the data bucket that the container syncs
  to `/data` (so `genome`/`plus`/`minus` are then at `/data/<file>`).
- `trainContigs` / `testContigs` — the split the challenge defines. Leave
  `testContigs` empty and set `blindTest: true` for the real (unlabeled) test
  contigs, where we run with `--no-score` and just produce a submission.

## Filling these in

The exact contig names and file names come from the Zenodo download. The
committed files are **placeholders** using the challenge's Zenodo record id
(`22285753`) and generic contig names — update them once the real dataset layout
is confirmed. `nematostella.json` mirrors the published dataset we use for
end-to-end validation.

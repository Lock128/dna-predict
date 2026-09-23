# `epic` — Rust pipeline for the EPIC challenge

Fast implementation of the EPIC transcription-initiation pipeline: streaming
data loading, the dinucleotide baseline (the bar to beat), and an offline
scoring replica, behind a single CLI.

Rust is used because the real work — streaming multi-GB genome FASTA, parsing
huge strand-separated bedGraph tracks, k-mer counting over billions of
positions, and writing genome-wide submissions — is IO- and memory-bound, where
Rust gives large speedups and low memory over a scripting language, with easy
parallelism.

## Layout

```
rust/
├── Cargo.toml
└── src/
    ├── lib.rs       # crate root + Strand enum
    ├── data.rs      # streaming FASTA + bedGraph readers, sequence encoding
    ├── baseline.rs  # DinucleotideBaseline (fit / predict)
    ├── scoring.rs   # AUPRC + Spearman + log-rank aggregation
    └── main.rs      # `epic` CLI (clap)
```

## Build

```bash
cargo build --release        # -> target/release/epic
cargo test                   # unit tests for data, baseline, scoring
```

## Usage

```bash
epic baseline \
  --genome data/<species>/genome.fa \       # optionally .gz
  --plus   data/<species>/initiation.plus.bedgraph \
  --minus  data/<species>/initiation.minus.bedgraph \
  --train-contigs chr1,chr2,chr3 \           # optional; defaults derive from --test-contigs
  --test-contigs  chr4 \
  --k 2 \                                    # 2 = dinucleotide baseline
  --out submission.tsv
```

- Omit `--train-contigs` and everything not in `--test-contigs` is used for training.
- Omit both and the last contig is held out (quick sanity split).
- `--no-score` skips scoring (use for the real blind test set, where truth is withheld).
- The submission is long-format TSV: `contig  position(0-based)  strand  value`.

## Notes

- Readers assume 4-column bedGraph (`chrom start end value`, 0-based half-open),
  one file per strand, and transparently handle `.gz`. Confirm the exact layout
  against the Zenodo release and adjust `data.rs` if it differs.
- The in-crate scoring is our replica for fast iteration; the official EPIC
  scoring scripts are authoritative — cross-check against them before trusting
  leaderboard-relative numbers.

## Cross-compiling for AWS Graviton (ARM)

```bash
rustup target add aarch64-unknown-linux-gnu
cargo build --release --target aarch64-unknown-linux-gnu
# copy the single static-ish binary to the EC2 box; no runtime setup needed
```

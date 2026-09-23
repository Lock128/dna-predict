# Local scoring replica

This directory is where we validate our submission pipeline **offline**, before
touching the live leaderboard.

The EPIC organizers provide a published **_Nematostella vectensis_** (sea
anemone) dataset plus the official scoring scripts as an offline replica of the
real evaluation. Use it to confirm that:

1. we can read the genome + initiation tracks,
2. we can produce a valid submission, and
3. our scores line up with the official scoring scripts.

## What lives here

- `README.md` — this file.
- (add) the official EPIC scoring scripts, once downloaded, so we score exactly
  as the leaderboard does. Our in-repo `dna_predict.scoring` module is a
  *replica* for fast iteration — the official scripts are authoritative.

## Quick start

Download the Nematostella data + genomes from Zenodo
([doi:10.5281/zenodo.22285753](https://doi.org/10.5281/zenodo.22285753)) into
`data/nematostella/`, then run the dinucleotide baseline end to end:

```bash
pip install -e .

dna-predict baseline \
  --genome data/nematostella/genome.fa \
  --plus   data/nematostella/initiation.plus.bedgraph \
  --minus  data/nematostella/initiation.minus.bedgraph \
  --test-contigs <held_out_contig> \
  --out submission.tsv
```

It prints AUPRC (presence) and Spearman (efficiency) for the held-out contig.
Then cross-check `submission.tsv` against the **official** scoring scripts to
make sure our numbers match before trusting anything.

> Note: the exact track file names, columns, and contig split come from the
> Zenodo release — confirm them and adjust the `--plus/--minus` inputs and
> `data.read_bedgraph` accordingly.

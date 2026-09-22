# dna-predict

Our team's working repository for the **EPIC** challenge — the **E**ukaryotic **P**romoter and transcription **I**nitiation prediction **C**hallenge.

> 🧬 Can we predict *where transcription starts*, from DNA sequence alone?

EPIC is an open, blind community benchmark for sequence-to-function models, run by the [Duttke lab](https://autosome.org) and hosted at **[epic.autosome.org](https://epic.autosome.org)**. This repo is where we build and track our submission.

---

## The one-paragraph version

Given only the genome sequence of an animal, predict the genome-wide signal of **transcription initiation** — i.e. where and how strongly RNA Polymerase II starts transcribing — at single-nucleotide, strand-specific resolution. Organizers hand out the experimental initiation profile for 80–95% of each genome as training data; we predict the held-out remainder. Scoring is genome-wide and blind, against unpublished measurements, with a live leaderboard.

See [`PROBLEM.md`](./PROBLEM.md) for the full explanation of the biology and the ML problem, and [`docs/CHALLENGE.md`](./docs/CHALLENGE.md) for the challenge logistics.

---

## The data

Unpublished, strand-specific, single-nucleotide-resolution transcription initiation data (**csRNA-seq**) from the Duttke lab, across five understudied metazoans spanning **three phyla and ~675 million years of evolution**:

| Species | Common name | Phylum |
|---|---|---|
| *Magallana gigas* | Pacific oyster 🦪 | Mollusca |
| *Octopus bimaculoides* | California two-spot octopus 🐙 | Mollusca |
| *Plodia interpunctella* | Indianmeal moth 🦋 | Arthropoda |
| *Oncopeltus fasciatus* | Large milkweed bug 🪲 | Arthropoda |
| *Squalus suckleyi* | Pacific spiny dogfish 🦈 | Chordata |

- Matched **sRNA-seq** is provided as a background control, but is **excluded from scoring**.
- Training and test data are **per-chromosome/contig BED tracks** (strand-separated, two replicates).
- The **test set is GC-matched** to the training set (GC content computed on repeat-free sequence).
- A published *Nematostella vectensis* (sea anemone) dataset + the official scoring scripts are provided as an **offline replica** of the evaluation, so we can validate our pipeline before submitting.

**Download:** genomes & data from Zenodo — [doi:10.5281/zenodo.22285753](https://doi.org/10.5281/zenodo.22285753).

---

## Scoring

We submit **one value per position-and-strand** for the held-out contigs. Submissions are scored on two tasks:

1. **Binary presence of initiation** — is there initiation at this position/strand? → **AUPRC**
2. **Quantitative initiation efficiency** at true positives → **Spearman correlation**

Results are aggregated by **log-ranks** (as in the IBIS challenge) to award **gold / silver / bronze** medals. Half the test labels drive a live leaderboard; the other half are held back for the final evaluation. Ground-truth read-count profiles stay closed until winners are announced.

**Baseline to beat:** a dinucleotide-frequency baseline. Beating it (plus a method write-up) is the bar for consortium authorship.

---

## Rules that shape our approach

- **Only the provided genome sequence may be used** as input.
- The sole exception: **pretrained genomic models** (e.g. **AlphaGenome**, **Evo 2**) are allowed.
- Teams register via GitHub (1–10 members, one spokesperson).
- All teams must supply a **method write-up**.
- Medalists must also supply **reproducible training + scoring code**.
- Everyone who clears the baseline is invited to join the **EPIC Consortium** as authors on the post-challenge paper.

## Key dates

- **Submission deadline:** December 31, 2026

---

## Repo layout (planned)

```
dna-predict/
├── README.md            # this file
├── PROBLEM.md           # the biology + ML problem, explained
├── docs/
│   └── CHALLENGE.md      # challenge logistics, data, scoring, rules
├── data/                 # (gitignored) downloaded genomes & csRNA-seq tracks
├── src/                  # data loading, models, training
├── notebooks/            # exploration
└── scoring/              # local replica of the official scoring (Nematostella)
```

## Getting started

1. Register the team on the EPIC GitHub and read the full rules at [epic.autosome.org](https://epic.autosome.org).
2. Download the data from [Zenodo](https://doi.org/10.5281/zenodo.22285753) into `data/` (kept out of git).
3. Stand up the local scoring replica using the *Nematostella* dataset to validate the pipeline end-to-end.
4. Start with the dinucleotide baseline, then iterate.

---

*Sources: the [EPIC challenge site](https://epic.autosome.org), the challenge announcement, and the official EPIC info letter. Content was rephrased for compliance with licensing restrictions.*

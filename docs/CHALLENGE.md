# EPIC Challenge — Logistics Reference

A condensed reference for the **Eukaryotic Promoter and transcription Initiation prediction Challenge (EPIC)**. Authoritative source: **[epic.autosome.org](https://epic.autosome.org)** and the official EPIC info letter.

## What it is

An open, blind community benchmark for sequence-to-function models, run by the Duttke lab. Teams predict **genome-wide Pol II transcription initiation from DNA sequence alone**, to establish a rigorous benchmark for promoter/initiation prediction in understudied species and to test how well sequence-based models learn real regulatory principles (vs. memorize) and generalize beyond humans.

## The task

Predict TSS / initiation counts at **single-base, strand-specific resolution** from genome sequence. Participants receive initiation profiles for the **training chromosomes/contigs (~80–95% of each genome)** and submit **one value per position-and-strand** for the held-out **test chromosomes/contigs**.

## Species (5 non-model metazoans, 3 phyla, ~675 My of evolution)

| Species | Common name | Phylum |
|---|---|---|
| *Magallana gigas* | Pacific oyster | Mollusca |
| *Octopus bimaculoides* | California two-spot octopus | Mollusca |
| *Plodia interpunctella* | Indianmeal moth | Arthropoda |
| *Oncopeltus fasciatus* | Large milkweed bug | Arthropoda |
| *Squalus suckleyi* | Pacific spiny dogfish | Chordata |

## Data

- **Assay:** unpublished **csRNA-seq** (captures active Pol II initiation: promoters, enhancers, antisense).
- **Control:** matched **sRNA-seq** provided as background — **excluded from scoring**.
- **Format:** per-chromosome/contig **BED tracks**, **strand-separated**, **two replicates**.
- **Test design:** **GC-matched** to training (GC computed on repeat-free sequence) to prevent trivial GC-based shortcuts.
- **Offline replica:** published *Nematostella vectensis* dataset + official scoring scripts to validate the pipeline locally.
- **Download:** Zenodo [doi:10.5281/zenodo.22285753](https://doi.org/10.5281/zenodo.22285753).

## Scoring

Two tasks, aggregated by **log-ranks** (as in IBIS) → **gold / silver / bronze** medals:

1. **Binary presence of initiation** → **AUPRC**
2. **Quantitative initiation efficiency at true positives** → **Spearman correlation**

- **Live leaderboard** on half the test labels; the **other half reserved** for final evaluation.
- **Ground-truth read-count profiles remain closed** until winners are announced.
- **Baseline:** a **dinucleotide** model — beating it is the entry bar.

## Rules

- **Input restriction:** only the provided genome sequence may be used.
- **Exception:** pretrained genomic models (**AlphaGenome**, **Evo 2**) are permitted.
- **Registration:** via GitHub; teams of **1–10**, one spokesperson.
- **Deliverables:** all teams supply a **method write-up**; **medalists** additionally supply **reproducible training + scoring code**.
- **Authorship:** everyone clearing the baseline is invited to join the **EPIC Consortium** on the post-challenge publication.

## Dates

- **Submission deadline:** December 31, 2026.

## Links

- Challenge site: https://epic.autosome.org
- Data (Zenodo): https://doi.org/10.5281/zenodo.22285753
- Announcement (LinkedIn): https://www.linkedin.com/posts/sascha-duttke-1b365675_genomics-machinelearning-deeplearning-share-7508200071763734528-SmV1

---

*Compiled from the EPIC challenge site and official info letter. Content was rephrased for compliance with licensing restrictions.*

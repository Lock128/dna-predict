# The Problem We're Trying to Solve

## In plain terms

DNA is the same in (almost) every cell, but not all of it is "read" equally. To use a gene, the cell first has to **start transcribing** it — an enzyme called **RNA Polymerase II (Pol II)** lands on the DNA and begins copying it into RNA. The exact spot where copying starts is the **transcription start site (TSS)**.

The question EPIC asks is simple to state and hard to answer:

> **Given only the raw DNA sequence, can we predict where — and how strongly — transcription initiates?**

If a model can do this well, it means the "rules" for *where genes turn on* are, to a meaningful degree, written directly in the sequence — and that a model has actually learned those rules rather than memorizing a handful of well-studied genomes.

---

## Why this is scientifically interesting

Sequence-to-function models (deep learning models that map DNA → some measured biological signal) have improved fast. But two big questions remain open:

1. **Are they learning real principles of transcription initiation, or just memorizing?**
   Most models are trained and tested on humans and a few classic model organisms. High scores there can hide memorization.

2. **Do they generalize across evolution?**
   If a model learned genuine regulatory grammar, it should transfer to animals it has never seen — including species separated from us and from each other by hundreds of millions of years.

EPIC is designed to probe exactly these questions by moving to **five understudied, non-model animals** where **nobody has a head start**. Because no one has studied these species for this purpose, memorization isn't an option — a model has to actually generalize.

---

## The measurement: csRNA-seq

The ground truth comes from **csRNA-seq** (capped small RNA sequencing), an assay that captures the 5′ ends of nascent, capped RNAs — i.e. the precise positions where Pol II *initiated* transcription. It broadly captures active Pol II, including:

- classic gene promoters,
- **enhancer** transcription (eRNAs), and
- **antisense** transcripts.

The signal is:

- **strand-specific** (initiation on the plus strand is distinct from the minus strand),
- at **single-nucleotide resolution**, and
- provided with **two replicates**.

A matched **sRNA-seq** track is provided as a background/control signal but is **not scored**.

---

## The machine learning problem

**Input:** a genome sequence (the four bases A, C, G, T along each chromosome/contig).
**Output:** for every genomic position *and* strand, a predicted transcription-initiation value.

Concretely, the challenge frames this as **two coupled sub-tasks**:

1. **Where does initiation happen? (classification)**
   For each position/strand, predict the *presence* of initiation. Scored with **AUPRC** — well suited to this problem because true initiation sites are rare relative to the whole genome (a heavily imbalanced signal).

2. **How strong is it? (regression / ranking)**
   At the true initiation sites, predict the *relative efficiency* (how much initiation). Scored with **Spearman correlation**, which rewards getting the *rank ordering* right rather than exact counts.

The two are combined via **log-rank aggregation** (as used in the IBIS challenge) into a single ranking that determines gold/silver/bronze.

### What makes it hard

- **Extreme class imbalance:** the vast majority of the genome does *not* initiate transcription.
- **Strand-specificity:** the model must distinguish plus- vs minus-strand initiation, not just "activity here."
- **Cross-species generalization:** train on some contigs, predict others — in genomes with unfamiliar composition, repeat content, and regulatory grammar.
- **GC-matched test set:** the easy shortcut of keying off GC content is deliberately neutralized, since the test set is GC-matched to train (on repeat-free sequence). Models must find *real* signal.
- **Sequence-only:** no conservation tracks, no annotations, no epigenomics — just the bases. (Pretrained genomic foundation models like AlphaGenome and Evo 2 are the one allowed exception.)

---

## How we'll know we're making progress

- **Baseline:** beat a **dinucleotide-frequency** model. That's the entry bar and the first milestone.
- **Local validation:** the organizers provide a published *Nematostella vectensis* dataset plus the official scoring scripts. We use this as an **offline replica** to confirm our pipeline produces valid, well-scored submissions before touching the real leaderboard.
- **Live leaderboard:** half of the test labels give ongoing feedback; the other half are reserved for the final, blind evaluation.

---

## Our angle (to refine as a team)

Some directions worth exploring, in rough order of effort:

1. **Reproduce the dinucleotide baseline** and get the full data → predict → score loop working on *Nematostella*.
2. **Classic sequence CNN** (à la Basset/Basenji-style) predicting strand-specific initiation from a sequence window.
3. **Leverage pretrained genomic models** (AlphaGenome, Evo 2) as frozen feature extractors or fine-tuning targets — the one permitted shortcut.
4. **Cross-species training** strategy: pool the five species vs. train per-species vs. train-on-four / test-on-one, to directly measure generalization.
5. **Handle imbalance** explicitly (focal loss, negative sampling, calibrated thresholds) since AUPRC rewards it.

---

*This document summarizes the problem as described on the [EPIC challenge site](https://epic.autosome.org) and in the official EPIC info letter. Content was rephrased for compliance with licensing restrictions.*

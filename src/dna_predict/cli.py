"""Command-line entry point for dna-predict.

Subcommands:
    baseline  -- fit the dinucleotide baseline on train contigs, predict test
                 contigs, write a submission, and (optionally) score it.

Example (offline replica on the Nematostella dataset):

    dna-predict baseline \\
        --genome data/nematostella/genome.fa \\
        --plus   data/nematostella/initiation.plus.bedgraph \\
        --minus  data/nematostella/initiation.minus.bedgraph \\
        --train-contigs chr1,chr2,chr3 \\
        --test-contigs  chr4 \\
        --out submission.tsv

The exact file formats of the official release should be confirmed against the
Zenodo download; --plus/--minus default to bedGraph (see data.read_bedgraph).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict

import numpy as np

from .baseline import DinucleotideBaseline
from .data import (
    InitiationTrack,
    contig_lengths_from_fasta,
    load_initiation,
    read_fasta,
)
from .scoring import score_species


def _split_contigs(all_contigs: list[str], train_arg: str | None, test_arg: str | None):
    if train_arg and test_arg:
        train = [c.strip() for c in train_arg.split(",") if c.strip()]
        test = [c.strip() for c in test_arg.split(",") if c.strip()]
    elif test_arg:
        test = [c.strip() for c in test_arg.split(",") if c.strip()]
        train = [c for c in all_contigs if c not in set(test)]
    else:
        # default: hold out the last contig as a quick sanity split
        train, test = all_contigs[:-1], all_contigs[-1:]
    return train, test


def _subset(seqs: Dict[str, str], contigs: list[str]) -> Dict[str, str]:
    return {c: seqs[c] for c in contigs if c in seqs}


def _write_submission(path: str | Path, pred: InitiationTrack) -> int:
    """Write a long-format submission: contig, position(0-based), strand, value."""
    n = 0
    with open(path, "w") as fh:
        fh.write("contig\tposition\tstrand\tvalue\n")
        for strand, table in (("+", pred.plus), ("-", pred.minus)):
            for contig in sorted(table):
                values = table[contig]
                for pos, val in enumerate(values):
                    fh.write(f"{contig}\t{pos}\t{strand}\t{val:.6g}\n")
                    n += 1
    return n


def cmd_baseline(args: argparse.Namespace) -> int:
    print(f"[baseline] reading genome: {args.genome}", file=sys.stderr)
    seqs = read_fasta(args.genome)
    lengths = {name: len(seq) for name, seq in seqs.items()}
    all_contigs = sorted(seqs)

    print(f"[baseline] reading initiation tracks (+/-)", file=sys.stderr)
    truth = load_initiation(args.plus, args.minus, lengths)

    train_contigs, test_contigs = _split_contigs(all_contigs, args.train_contigs, args.test_contigs)
    print(f"[baseline] train contigs: {train_contigs}", file=sys.stderr)
    print(f"[baseline] test  contigs: {test_contigs}", file=sys.stderr)

    train_seqs = _subset(seqs, train_contigs)
    test_seqs = _subset(seqs, test_contigs)
    train_truth = InitiationTrack(
        plus={c: truth.plus[c] for c in train_contigs if c in truth.plus},
        minus={c: truth.minus[c] for c in train_contigs if c in truth.minus},
    )

    model = DinucleotideBaseline(k=args.k).fit(train_seqs, train_truth)
    print(f"[baseline] fitted k={args.k} ({model.n_kmers} k-mers per strand)", file=sys.stderr)

    pred = model.predict(test_seqs)

    if args.out:
        n = _write_submission(args.out, pred)
        print(f"[baseline] wrote {n} rows -> {args.out}", file=sys.stderr)

    if not args.no_score:
        test_truth = InitiationTrack(
            plus={c: truth.plus[c] for c in test_contigs if c in truth.plus},
            minus={c: truth.minus[c] for c in test_contigs if c in truth.minus},
        )
        scores = score_species(pred, test_truth, contigs=test_contigs, presence_threshold=args.presence_threshold)
        print(f"[baseline] AUPRC (presence):    {scores.auprc:.4f}")
        print(f"[baseline] Spearman (efficiency): {scores.spearman:.4f}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dna-predict", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("baseline", help="fit + predict + score the dinucleotide baseline")
    b.add_argument("--genome", required=True, help="genome FASTA (optionally .gz)")
    b.add_argument("--plus", required=True, help="plus-strand initiation bedGraph")
    b.add_argument("--minus", required=True, help="minus-strand initiation bedGraph")
    b.add_argument("--train-contigs", help="comma-separated train contigs")
    b.add_argument("--test-contigs", help="comma-separated test contigs")
    b.add_argument("--k", type=int, default=2, help="k-mer length (2 = dinucleotide baseline)")
    b.add_argument("--out", help="write a long-format submission TSV")
    b.add_argument("--presence-threshold", type=float, default=0.0, help="signal > threshold counts as initiation")
    b.add_argument("--no-score", action="store_true", help="skip scoring (e.g. real blind test set)")
    b.set_defaults(func=cmd_baseline)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

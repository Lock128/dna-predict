"""The dinucleotide baseline model.

EPIC's entry bar is beating a *dinucleotide* baseline: a model whose only
knowledge of the sequence is short-range base composition. Clearing it (plus a
method write-up) is what qualifies a team for consortium authorship, so we want
a faithful, honest implementation of it to measure ourselves against.

Design
------
For each strand we build a predictor keyed on the k-mer of length `k` ending at
(or centered on) a position. For k=2 this is the dinucleotide context. During
`fit` we accumulate, per k-mer, the mean observed initiation signal at all
positions sharing that context on the training contigs. At `predict` time we
emit, for every position, the learned mean for its local k-mer.

This captures exactly what a composition-only model can: some contexts (e.g.
around canonical initiator / TATA-like motifs) carry more initiation on
average than others. It has no notion of position, distance, or long-range
grammar -- which is the point.

The default k=2 is the literal dinucleotide baseline. `k` is exposed so we can
sanity-check how much pure short-range composition buys (k=1..4) without
turning this into a "real" model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict

import numpy as np

from .data import InitiationTrack, encode_bases

Strand = str

# reverse-complement base index mapping: A<->T (0<->3), C<->G (1<->2)
_RC_IDX = np.array([3, 2, 1, 0], dtype=np.int8)


def _kmer_ids(base_idx: np.ndarray, k: int) -> np.ndarray:
    """Map each position to the integer id of the k-mer ending there.

    base_idx: int8 array of base indices in {0,1,2,3}, -1 for non-ACGT.
    Returns an int32 array of the same length; positions whose k-mer window
    contains a non-ACGT base or falls off the start get id -1 (unknown).
    """
    n = base_idx.shape[0]
    ids = np.full(n, -1, dtype=np.int32)
    if n < k:
        return ids
    # sliding window over the last k bases
    valid = np.ones(n, dtype=bool)
    acc = np.zeros(n, dtype=np.int64)
    for offset in range(k):
        shifted = np.full(n, -1, dtype=np.int64)
        if offset == 0:
            shifted[:] = base_idx
        else:
            shifted[offset:] = base_idx[:-offset]
        valid &= shifted >= 0
        acc = acc * 4 + np.where(shifted >= 0, shifted, 0)
    valid[: k - 1] = False  # no full window at the very start
    ids[valid] = acc[valid].astype(np.int32)
    return ids


@dataclass
class DinucleotideBaseline:
    """Composition-only initiation predictor (default: dinucleotide, k=2)."""

    k: int = 2
    # learned mean signal per k-mer id, per strand
    table_plus: np.ndarray = field(default_factory=lambda: np.zeros(0))
    table_minus: np.ndarray = field(default_factory=lambda: np.zeros(0))
    global_mean_plus: float = 0.0
    global_mean_minus: float = 0.0

    @property
    def n_kmers(self) -> int:
        return 4 ** self.k

    def _fit_one_strand(
        self, sequences: Dict[str, str], signal: Dict[str, np.ndarray]
    ) -> tuple[np.ndarray, float]:
        sums = np.zeros(self.n_kmers, dtype=np.float64)
        counts = np.zeros(self.n_kmers, dtype=np.float64)
        total = 0.0
        n_pos = 0
        for contig, seq in sequences.items():
            if contig not in signal:
                continue
            y = signal[contig]
            ids = _kmer_ids(encode_bases(seq), self.k)
            m = min(ids.shape[0], y.shape[0])
            ids, yv = ids[:m], y[:m]
            known = ids >= 0
            np.add.at(sums, ids[known], yv[known])
            np.add.at(counts, ids[known], 1.0)
            total += float(yv[known].sum())
            n_pos += int(known.sum())
        global_mean = total / n_pos if n_pos else 0.0
        # unseen k-mers fall back to the global mean
        table = np.divide(
            sums, counts, out=np.full(self.n_kmers, global_mean), where=counts > 0
        )
        return table.astype(np.float32), global_mean

    def fit(self, sequences: Dict[str, str], track: InitiationTrack) -> "DinucleotideBaseline":
        """Learn per-kmer mean initiation on the training contigs, per strand."""
        self.table_plus, self.global_mean_plus = self._fit_one_strand(sequences, track.plus)
        self.table_minus, self.global_mean_minus = self._fit_one_strand(sequences, track.minus)
        return self

    def predict_contig(self, seq: str, strand: Strand) -> np.ndarray:
        """Predict per-position initiation for one contig and strand."""
        if strand == "+":
            table, fallback = self.table_plus, self.global_mean_plus
        else:
            table, fallback = self.table_minus, self.global_mean_minus
        ids = _kmer_ids(encode_bases(seq), self.k)
        out = np.full(ids.shape[0], fallback, dtype=np.float32)
        known = ids >= 0
        out[known] = table[ids[known]]
        return out

    def predict(self, sequences: Dict[str, str]) -> InitiationTrack:
        """Predict a full strand-separated InitiationTrack for given contigs."""
        return InitiationTrack(
            plus={c: self.predict_contig(s, "+") for c, s in sequences.items()},
            minus={c: self.predict_contig(s, "-") for c, s in sequences.items()},
        )

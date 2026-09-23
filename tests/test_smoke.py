"""End-to-end smoke test on tiny synthetic data.

Verifies the fit -> predict -> score loop runs and that the dinucleotide
baseline recovers a planted composition signal well enough to beat random.
"""

from __future__ import annotations

import numpy as np

from dna_predict.baseline import DinucleotideBaseline
from dna_predict.data import InitiationTrack, encode_bases
from dna_predict.scoring import (
    auprc_presence,
    log_rank_aggregate,
    score_species,
    spearman_efficiency,
)


def _make_synthetic(seed: int = 0, n: int = 5000):
    """A genome where 'CG' dinucleotides carry high initiation signal."""
    rng = np.random.default_rng(seed)
    bases = np.array(list("ACGT"))
    seq = "".join(rng.choice(bases, size=n))
    signal = np.zeros(n, dtype=np.float32)
    # plant signal: positions ending a 'CG' get high counts + noise
    for i in range(1, n):
        if seq[i - 1] == "C" and seq[i] == "G":
            signal[i] = 10.0 + rng.normal(0, 1)
        elif rng.random() < 0.02:
            signal[i] = rng.exponential(1.0)  # sparse background
    return seq, signal


def test_encode_bases():
    idx = encode_bases("ACGTN")
    assert list(idx) == [0, 1, 2, 3, -1]


def test_baseline_beats_random_auprc():
    seq, signal = _make_synthetic()
    # split into train/test halves
    half = len(seq) // 2
    train_seqs = {"chr1": seq[:half]}
    test_seqs = {"chr1": seq[half:]}
    train_track = InitiationTrack(plus={"chr1": signal[:half]}, minus={"chr1": signal[:half]})
    test_track = InitiationTrack(plus={"chr1": signal[half:]}, minus={"chr1": signal[half:]})

    model = DinucleotideBaseline(k=2).fit(train_seqs, train_track)
    pred = model.predict(test_seqs)

    scores = score_species(pred, test_track, contigs=["chr1"])
    # random AUPRC ~ positive prevalence; planted CG signal should beat it clearly
    assert not np.isnan(scores.auprc)
    assert scores.auprc > 0.3
    assert scores.spearman > 0.0


def test_scoring_edge_cases():
    # no positives -> nan
    assert np.isnan(auprc_presence(np.array([0.1, 0.2]), np.array([0.0, 0.0])))
    # fewer than 2 positives -> nan spearman
    assert np.isnan(spearman_efficiency(np.array([0.1, 0.2]), np.array([1.0, 0.0])))


def test_log_rank_aggregate_orders_teams():
    scores = {
        "strong": [0.9, 0.8],
        "weak": [0.1, 0.2],
        "mid": [0.5, 0.5],
    }
    agg = log_rank_aggregate(scores)
    # lower mean log-rank = better; strong should rank best
    assert agg["strong"] < agg["mid"] < agg["weak"]

"""Scoring harness mirroring the EPIC evaluation.

EPIC scores submissions on two tasks, per the challenge description:

  1. Binary *presence* of initiation  -> AUPRC (area under precision-recall).
     Initiation sites are rare relative to the whole genome, so AUPRC is the
     natural imbalance-aware metric.

  2. Quantitative initiation *efficiency* at the true positives -> Spearman
     correlation between predicted and observed signal, restricted to
     positions that actually initiate.

Per-species / per-task scores are combined across the leaderboard using a
*log-rank* aggregation (as in the IBIS challenge) to award medals.

IMPORTANT: this is our offline replica for validating the pipeline against the
published Nematostella dataset. The official scoring scripts shipped with the
challenge are authoritative; confirm exact definitions (e.g. how "presence" is
thresholded, whether positions are pooled across strands) against them before
trusting leaderboard-relative numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List

import numpy as np
from scipy.stats import rankdata, spearmanr
from sklearn.metrics import average_precision_score

from .data import InitiationTrack

Strand = str
STRANDS: tuple[Strand, Strand] = ("+", "-")


def _flatten_pair(
    pred: InitiationTrack, truth: InitiationTrack, contigs: Iterable[str]
) -> tuple[np.ndarray, np.ndarray]:
    """Concatenate predictions and truth across contigs and both strands.

    Only positions present in both tracks (by contig+strand) are used, aligned
    to the shorter length as a defensive measure.
    """
    preds: List[np.ndarray] = []
    truths: List[np.ndarray] = []
    for contig in contigs:
        for strand in STRANDS:
            table_p = pred.plus if strand == "+" else pred.minus
            table_t = truth.plus if strand == "+" else truth.minus
            if contig not in table_p or contig not in table_t:
                continue
            p, t = table_p[contig], table_t[contig]
            m = min(p.shape[0], t.shape[0])
            preds.append(np.asarray(p[:m], dtype=np.float64))
            truths.append(np.asarray(t[:m], dtype=np.float64))
    if not preds:
        return np.zeros(0), np.zeros(0)
    return np.concatenate(preds), np.concatenate(truths)


def auprc_presence(pred_values: np.ndarray, truth_values: np.ndarray, presence_threshold: float = 0.0) -> float:
    """AUPRC for the binary presence-of-initiation task.

    A position is a positive if its observed signal is strictly greater than
    `presence_threshold` (default 0, i.e. any observed initiation).
    """
    if pred_values.size == 0:
        return float("nan")
    labels = (truth_values > presence_threshold).astype(np.int8)
    if labels.sum() == 0 or labels.sum() == labels.size:
        # degenerate: no positives (or all positives) -> undefined
        return float("nan")
    return float(average_precision_score(labels, pred_values))


def spearman_efficiency(
    pred_values: np.ndarray, truth_values: np.ndarray, presence_threshold: float = 0.0
) -> float:
    """Spearman correlation of efficiency, restricted to true-positive sites."""
    if pred_values.size == 0:
        return float("nan")
    mask = truth_values > presence_threshold
    if mask.sum() < 2:
        return float("nan")
    rho, _ = spearmanr(pred_values[mask], truth_values[mask])
    return float(rho)


@dataclass
class TaskScores:
    auprc: float
    spearman: float

    def as_dict(self) -> Dict[str, float]:
        return {"auprc": self.auprc, "spearman": self.spearman}


def score_species(
    pred: InitiationTrack,
    truth: InitiationTrack,
    contigs: Iterable[str] | None = None,
    presence_threshold: float = 0.0,
) -> TaskScores:
    """Score one species' predictions against truth on the given contigs."""
    if contigs is None:
        contigs = sorted(set(truth.plus) | set(truth.minus))
    contigs = list(contigs)
    pv, tv = _flatten_pair(pred, truth, contigs)
    return TaskScores(
        auprc=auprc_presence(pv, tv, presence_threshold),
        spearman=spearman_efficiency(pv, tv, presence_threshold),
    )


def log_rank_aggregate(scores_per_team: Dict[str, List[float]]) -> Dict[str, float]:
    """Aggregate multiple per-(species,task) scores per team via log-ranks.

    Mirrors the IBIS-style aggregation: for each metric column, rank teams
    (higher score = better = rank 1), take the natural log of the rank, and
    average the log-ranks across columns. Lower aggregate = better.

    Args:
        scores_per_team: {team_name: [score_col_0, score_col_1, ...]} with the
            same column order for every team. NaNs are treated as worst.

    Returns:
        {team_name: mean_log_rank}. Sort ascending for the leaderboard.
    """
    teams = list(scores_per_team)
    if not teams:
        return {}
    matrix = np.array([scores_per_team[t] for t in teams], dtype=np.float64)  # [teams, cols]
    n_cols = matrix.shape[1]
    log_ranks = np.zeros_like(matrix)
    for c in range(n_cols):
        col = matrix[:, c].copy()
        # NaN -> worst possible so it ranks last
        col = np.where(np.isnan(col), -np.inf, col)
        # rank so that the largest value gets rank 1
        ranks = rankdata(-col, method="average")
        log_ranks[:, c] = np.log(ranks)
    mean_log_rank = log_ranks.mean(axis=1)
    return {team: float(v) for team, v in zip(teams, mean_log_rank)}

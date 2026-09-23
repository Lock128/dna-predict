//! Scoring harness mirroring the EPIC evaluation.
//!
//! EPIC scores submissions on two tasks:
//!   1. Binary *presence* of initiation -> AUPRC (area under precision-recall).
//!      Initiation sites are rare, so AUPRC is the natural imbalance-aware metric.
//!   2. Quantitative initiation *efficiency* at true positives -> Spearman
//!      correlation between predicted and observed signal, restricted to
//!      positions that actually initiate.
//!
//! Per-(species, task) scores are combined across the leaderboard using a
//! log-rank aggregation (as in the IBIS challenge) to award medals.
//!
//! IMPORTANT: this is our offline replica for validating the pipeline against
//! the published Nematostella dataset. The official scoring scripts shipped with
//! the challenge are authoritative; confirm exact metric definitions against
//! them before trusting leaderboard-relative numbers.

use crate::data::InitiationTrack;
use crate::Strand;

const STRANDS: [Strand; 2] = [Strand::Plus, Strand::Minus];

/// Concatenate predictions and truth across contigs and both strands.
/// Aligns each contig/strand pair to the shorter length defensively.
fn flatten_pair(
    pred: &InitiationTrack,
    truth: &InitiationTrack,
    contigs: &[String],
) -> (Vec<f64>, Vec<f64>) {
    let mut preds = Vec::new();
    let mut truths = Vec::new();
    for contig in contigs {
        for &strand in &STRANDS {
            if let (Some(p), Some(t)) = (pred.get(contig, strand), truth.get(contig, strand)) {
                let m = p.len().min(t.len());
                for i in 0..m {
                    preds.push(p[i] as f64);
                    truths.push(t[i] as f64);
                }
            }
        }
    }
    (preds, truths)
}

/// AUPRC (average precision) for the binary presence-of-initiation task.
///
/// A position is positive if its observed signal is strictly greater than
/// `presence_threshold`. Returns `NaN` for degenerate cases (no positives or
/// all positives). Ties in the score are handled by processing in descending
/// score order and only recording precision at the points where recall
/// increases (standard average-precision definition).
pub fn auprc_presence(preds: &[f64], truth: &[f64], presence_threshold: f64) -> f64 {
    if preds.is_empty() {
        return f64::NAN;
    }
    let labels: Vec<bool> = truth.iter().map(|&t| t > presence_threshold).collect();
    let n_pos = labels.iter().filter(|&&l| l).count();
    if n_pos == 0 || n_pos == labels.len() {
        return f64::NAN;
    }

    // Sort indices by predicted score, descending.
    let mut order: Vec<usize> = (0..preds.len()).collect();
    order.sort_by(|&a, &b| preds[b].partial_cmp(&preds[a]).unwrap_or(std::cmp::Ordering::Equal));

    // Average precision = sum over thresholds of (recall_k - recall_{k-1}) * precision_k,
    // handling tied scores as a single group.
    let mut ap = 0.0f64;
    let mut tp = 0usize;
    let mut fp = 0usize;
    let mut prev_recall = 0.0f64;
    let total_pos = n_pos as f64;

    let mut i = 0usize;
    while i < order.len() {
        let score = preds[order[i]];
        // consume the whole tie group at this score
        let mut j = i;
        while j < order.len() && preds[order[j]] == score {
            if labels[order[j]] {
                tp += 1;
            } else {
                fp += 1;
            }
            j += 1;
        }
        let recall = tp as f64 / total_pos;
        let precision = tp as f64 / (tp + fp) as f64;
        ap += (recall - prev_recall) * precision;
        prev_recall = recall;
        i = j;
    }
    ap
}

/// Spearman rank correlation of efficiency, restricted to true-positive sites.
/// Returns `NaN` if fewer than 2 positives or if either ranked vector is constant.
pub fn spearman_efficiency(preds: &[f64], truth: &[f64], presence_threshold: f64) -> f64 {
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    for i in 0..preds.len().min(truth.len()) {
        if truth[i] > presence_threshold {
            xs.push(preds[i]);
            ys.push(truth[i]);
        }
    }
    if xs.len() < 2 {
        return f64::NAN;
    }
    let rx = average_ranks(&xs);
    let ry = average_ranks(&ys);
    pearson(&rx, &ry)
}

/// Average (fractional) ranks with tie handling, as used by Spearman.
fn average_ranks(values: &[f64]) -> Vec<f64> {
    let n = values.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| values[a].partial_cmp(&values[b]).unwrap_or(std::cmp::Ordering::Equal));
    let mut ranks = vec![0.0f64; n];
    let mut i = 0usize;
    while i < n {
        let mut j = i;
        while j + 1 < n && values[order[j + 1]] == values[order[i]] {
            j += 1;
        }
        // ranks are 1-based; average rank of the tie group [i, j]
        let avg = ((i + j) as f64) / 2.0 + 1.0;
        for k in i..=j {
            ranks[order[k]] = avg;
        }
        i = j + 1;
    }
    ranks
}

/// Pearson correlation; returns `NaN` if either input has zero variance.
fn pearson(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len() as f64;
    let mx = x.iter().sum::<f64>() / n;
    let my = y.iter().sum::<f64>() / n;
    let mut cov = 0.0;
    let mut vx = 0.0;
    let mut vy = 0.0;
    for i in 0..x.len() {
        let dx = x[i] - mx;
        let dy = y[i] - my;
        cov += dx * dy;
        vx += dx * dx;
        vy += dy * dy;
    }
    if vx == 0.0 || vy == 0.0 {
        return f64::NAN;
    }
    cov / (vx.sqrt() * vy.sqrt())
}

/// The two per-species task scores.
#[derive(Debug, Clone, Copy)]
pub struct TaskScores {
    pub auprc: f64,
    pub spearman: f64,
}

/// Score one species' predictions against truth on the given contigs.
pub fn score_species(
    pred: &InitiationTrack,
    truth: &InitiationTrack,
    contigs: &[String],
    presence_threshold: f64,
) -> TaskScores {
    let (pv, tv) = flatten_pair(pred, truth, contigs);
    TaskScores {
        auprc: auprc_presence(&pv, &tv, presence_threshold),
        spearman: spearman_efficiency(&pv, &tv, presence_threshold),
    }
}

/// Aggregate per-(species, task) scores per team via log-ranks (IBIS-style).
///
/// For each metric column, rank teams (higher score = better = rank 1), take
/// `ln(rank)`, and average across columns. NaN is treated as worst. Lower
/// aggregate = better; sort ascending for the leaderboard.
///
/// `scores_per_team[i]` is the score vector for team `names[i]`; all vectors
/// must share the same column order and length.
pub fn log_rank_aggregate(names: &[String], scores_per_team: &[Vec<f64>]) -> Vec<(String, f64)> {
    if names.is_empty() {
        return Vec::new();
    }
    let n_teams = names.len();
    let n_cols = scores_per_team[0].len();
    let mut log_rank_sum = vec![0.0f64; n_teams];

    for c in 0..n_cols {
        // NaN -> worst (treated as -inf so it ranks last)
        let col: Vec<f64> = (0..n_teams)
            .map(|t| {
                let v = scores_per_team[t][c];
                if v.is_nan() {
                    f64::NEG_INFINITY
                } else {
                    v
                }
            })
            .collect();
        // rank descending with average ties -> rank 1 is the best
        let ranks = descending_average_ranks(&col);
        for t in 0..n_teams {
            log_rank_sum[t] += ranks[t].ln();
        }
    }
    names
        .iter()
        .enumerate()
        .map(|(t, name)| (name.clone(), log_rank_sum[t] / n_cols as f64))
        .collect()
}

/// 1-based average ranks where the largest value gets rank 1.
fn descending_average_ranks(values: &[f64]) -> Vec<f64> {
    // ascending average ranks of the negated values gives descending ranks
    let neg: Vec<f64> = values.iter().map(|&v| -v).collect();
    average_ranks(&neg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auprc_perfect_separation() {
        // scores perfectly separate positives (truth>0) from negatives
        let preds = vec![0.9, 0.8, 0.2, 0.1];
        let truth = vec![1.0, 1.0, 0.0, 0.0];
        let ap = auprc_presence(&preds, &truth, 0.0);
        assert!((ap - 1.0).abs() < 1e-9, "expected AP 1.0, got {ap}");
    }

    #[test]
    fn auprc_no_positives_is_nan() {
        let ap = auprc_presence(&[0.1, 0.2], &[0.0, 0.0], 0.0);
        assert!(ap.is_nan());
    }

    #[test]
    fn spearman_monotonic_is_one() {
        let preds = vec![1.0, 2.0, 3.0, 4.0];
        let truth = vec![10.0, 20.0, 30.0, 40.0];
        let r = spearman_efficiency(&preds, &truth, 0.0);
        assert!((r - 1.0).abs() < 1e-9, "expected 1.0, got {r}");
    }

    #[test]
    fn spearman_too_few_positives_is_nan() {
        let r = spearman_efficiency(&[0.1, 0.2], &[1.0, 0.0], 0.0);
        assert!(r.is_nan());
    }

    #[test]
    fn log_rank_orders_teams() {
        let names = vec!["strong".to_string(), "mid".to_string(), "weak".to_string()];
        let scores = vec![vec![0.9, 0.8], vec![0.5, 0.5], vec![0.1, 0.2]];
        let agg = log_rank_aggregate(&names, &scores);
        let map: std::collections::HashMap<_, _> = agg.into_iter().collect();
        assert!(map["strong"] < map["mid"]);
        assert!(map["mid"] < map["weak"]);
    }
}

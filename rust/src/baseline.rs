//! The dinucleotide baseline model.
//!
//! EPIC's entry bar is beating a *dinucleotide* baseline: a model whose only
//! knowledge of the sequence is short-range base composition. Clearing it (plus
//! a method write-up) is what qualifies a team for consortium authorship, so we
//! want a faithful implementation to measure ourselves against.
//!
//! For each strand we learn, per k-mer of length `k` ending at a position, the
//! mean observed initiation signal across all training positions sharing that
//! context. At predict time we emit, for every position, the learned mean for
//! its local k-mer. `k = 2` is the literal dinucleotide baseline; `k` is exposed
//! only to sanity-check how much pure composition buys (k = 1..=4).

use std::collections::HashMap;

use crate::data::{encode_bases, InitiationTrack};
use crate::Strand;

/// Map each position to the integer id of the k-mer ending there.
///
/// `base_idx` holds base indices in 0..=3 with -1 for non-ACGT. Positions whose
/// k-mer window contains a non-ACGT base, or that fall within the first `k-1`
/// bases, get id -1 (unknown).
fn kmer_ids(base_idx: &[i8], k: usize) -> Vec<i32> {
    let n = base_idx.len();
    let mut ids = vec![-1i32; n];
    if n < k || k == 0 {
        return ids;
    }
    for i in (k - 1)..n {
        let mut acc: i32 = 0;
        let mut ok = true;
        for j in 0..k {
            let b = base_idx[i - (k - 1) + j];
            if b < 0 {
                ok = false;
                break;
            }
            acc = acc * 4 + b as i32;
        }
        if ok {
            ids[i] = acc;
        }
    }
    ids
}

/// Composition-only initiation predictor (default: dinucleotide, k = 2).
#[derive(Debug, Clone)]
pub struct DinucleotideBaseline {
    pub k: usize,
    table_plus: Vec<f32>,
    table_minus: Vec<f32>,
    global_mean_plus: f32,
    global_mean_minus: f32,
}

impl DinucleotideBaseline {
    pub fn new(k: usize) -> Self {
        let n_kmers = 4usize.pow(k as u32);
        Self {
            k,
            table_plus: vec![0.0; n_kmers],
            table_minus: vec![0.0; n_kmers],
            global_mean_plus: 0.0,
            global_mean_minus: 0.0,
        }
    }

    pub fn n_kmers(&self) -> usize {
        4usize.pow(self.k as u32)
    }

    fn fit_one_strand(
        &self,
        sequences: &HashMap<String, Vec<u8>>,
        signal: &HashMap<String, Vec<f32>>,
    ) -> (Vec<f32>, f32) {
        let n_kmers = self.n_kmers();
        let mut sums = vec![0.0f64; n_kmers];
        let mut counts = vec![0.0f64; n_kmers];
        let mut total = 0.0f64;
        let mut n_pos = 0usize;

        for (contig, seq) in sequences {
            let y = match signal.get(contig) {
                Some(y) => y,
                None => continue,
            };
            let ids = kmer_ids(&encode_bases(seq), self.k);
            let m = ids.len().min(y.len());
            for i in 0..m {
                let id = ids[i];
                if id >= 0 {
                    let id = id as usize;
                    let v = y[i] as f64;
                    sums[id] += v;
                    counts[id] += 1.0;
                    total += v;
                    n_pos += 1;
                }
            }
        }

        let global_mean = if n_pos > 0 {
            (total / n_pos as f64) as f32
        } else {
            0.0
        };
        // Unseen k-mers fall back to the global mean.
        let table: Vec<f32> = (0..n_kmers)
            .map(|i| {
                if counts[i] > 0.0 {
                    (sums[i] / counts[i]) as f32
                } else {
                    global_mean
                }
            })
            .collect();
        (table, global_mean)
    }

    /// Learn per-kmer mean initiation on the training contigs, per strand.
    pub fn fit(
        &mut self,
        sequences: &HashMap<String, Vec<u8>>,
        track: &InitiationTrack,
    ) -> &mut Self {
        let (tp, gp) = self.fit_one_strand(sequences, &track.plus);
        let (tm, gm) = self.fit_one_strand(sequences, &track.minus);
        self.table_plus = tp;
        self.global_mean_plus = gp;
        self.table_minus = tm;
        self.global_mean_minus = gm;
        self
    }

    /// Predict per-position initiation for one contig and strand.
    pub fn predict_contig(&self, seq: &[u8], strand: Strand) -> Vec<f32> {
        let (table, fallback) = match strand {
            Strand::Plus => (&self.table_plus, self.global_mean_plus),
            Strand::Minus => (&self.table_minus, self.global_mean_minus),
        };
        let ids = kmer_ids(&encode_bases(seq), self.k);
        ids.iter()
            .map(|&id| {
                if id >= 0 {
                    table[id as usize]
                } else {
                    fallback
                }
            })
            .collect()
    }

    /// Predict a full strand-separated track for the given contigs.
    pub fn predict(&self, sequences: &HashMap<String, Vec<u8>>) -> InitiationTrack {
        let mut out = InitiationTrack::new();
        for (contig, seq) in sequences {
            out.plus
                .insert(contig.clone(), self.predict_contig(seq, Strand::Plus));
            out.minus
                .insert(contig.clone(), self.predict_contig(seq, Strand::Minus));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kmer_ids_dinucleotide() {
        // sequence AC -> at pos1 the dinuc "AC" = 0*4 + 1 = 1
        let ids = kmer_ids(&[0, 1, 2, 3], 2);
        // pos0 has no full window -> -1; pos1 "AC"=1; pos2 "CG"=1*4+2=6; pos3 "GT"=2*4+3=11
        assert_eq!(ids, vec![-1, 1, 6, 11]);
    }

    #[test]
    fn unknown_base_yields_unknown_id() {
        let ids = kmer_ids(&[0, -1, 2], 2);
        assert_eq!(ids, vec![-1, -1, -1]);
    }
}

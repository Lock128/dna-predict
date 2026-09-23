//! `epic`: fast pipeline for the EPIC transcription-initiation challenge.
//!
//! EPIC asks us to predict genome-wide, strand-specific RNA Pol II transcription
//! initiation at single-nucleotide resolution from DNA sequence alone. This crate
//! is the fast (Rust) implementation of the data loading, the dinucleotide
//! baseline (the bar we must beat), and the offline scoring replica.
//!
//! Modules:
//! - [`data`]    — streaming FASTA and bedGraph readers, sequence encoding
//! - [`baseline`] — the dinucleotide-frequency baseline model
//! - [`scoring`]  — AUPRC + Spearman metrics and log-rank aggregation

pub mod baseline;
pub mod data;
pub mod scoring;

/// A DNA strand: plus or minus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strand {
    Plus,
    Minus,
}

impl Strand {
    pub fn as_str(self) -> &'static str {
        match self {
            Strand::Plus => "+",
            Strand::Minus => "-",
        }
    }
}

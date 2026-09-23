"""dna-predict: team pipeline for the EPIC transcription-initiation challenge.

EPIC asks us to predict genome-wide, strand-specific Pol II transcription
initiation at single-nucleotide resolution from DNA sequence alone.

Modules:
    data    -- load genome FASTA and strand-specific initiation BED tracks
    baseline -- the dinucleotide-frequency baseline model (the bar to beat)
    scoring  -- AUPRC + Spearman metrics and log-rank aggregation
    cli      -- command-line entry point
"""

__version__ = "0.1.0"

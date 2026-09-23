"""Data loading for the EPIC challenge.

The challenge distributes, per species:
  - a genome as FASTA (one record per chromosome/contig), and
  - transcription-initiation signal as strand-separated BED tracks
    (two replicates), giving a read count per genomic position and strand.

This module keeps dependencies light (pure-Python FASTA parsing + numpy) so
the baseline can run without pysam/pyBigWig. Swap in indexed readers later if
memory becomes a concern on large genomes.

NOTE: The exact BED column layout of the official release should be confirmed
against the Zenodo download (doi:10.5281/zenodo.22285753). The reader below
assumes the common BedGraph-style 4-column form:

    chrom    start    end    value

with 0-based, half-open coordinates, one file per strand. Adjust
`read_bedgraph` if the release differs.
"""

from __future__ import annotations

import gzip
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterator, Tuple

import numpy as np

Strand = str  # "+" or "-"


def _open_text(path: str | Path):
    """Open a file transparently, whether or not it is gzip-compressed."""
    path = Path(path)
    if path.suffix == ".gz":
        return gzip.open(path, "rt")
    return open(path, "rt")


# --------------------------------------------------------------------------- #
# Genome (FASTA)
# --------------------------------------------------------------------------- #

def read_fasta(path: str | Path) -> Dict[str, str]:
    """Parse a (optionally gzipped) FASTA file into {contig_name: sequence}.

    The contig name is the first whitespace-delimited token of the header.
    Sequence is upper-cased; non-ACGT characters (N, softmasked lowercase,
    etc.) are preserved as upper-case letters so callers can decide how to
    treat them.
    """
    sequences: Dict[str, list[str]] = {}
    name: str | None = None
    with _open_text(path) as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                continue
            if line.startswith(">"):
                name = line[1:].split()[0]
                sequences[name] = []
            else:
                if name is None:
                    raise ValueError(f"FASTA {path} has sequence before any header")
                sequences[name].append(line.strip())
    return {name: "".join(chunks).upper() for name, chunks in sequences.items()}


def iter_fasta(path: str | Path) -> Iterator[Tuple[str, str]]:
    """Stream (contig_name, sequence) pairs without holding the whole genome."""
    name: str | None = None
    chunks: list[str] = []
    with _open_text(path) as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                continue
            if line.startswith(">"):
                if name is not None:
                    yield name, "".join(chunks).upper()
                name = line[1:].split()[0]
                chunks = []
            else:
                chunks.append(line.strip())
    if name is not None:
        yield name, "".join(chunks).upper()


# --------------------------------------------------------------------------- #
# Initiation signal (BED / bedGraph)
# --------------------------------------------------------------------------- #

def read_bedgraph(path: str | Path, contig_lengths: Dict[str, int]) -> Dict[str, np.ndarray]:
    """Read a bedGraph-style track into per-contig dense float arrays.

    Args:
        path: bedGraph file (chrom, start, end, value), 0-based half-open.
        contig_lengths: length of each contig, used to allocate arrays.

    Returns:
        {contig: np.ndarray[length] of float32 signal}, zero where unobserved.
    """
    signal: Dict[str, np.ndarray] = {
        name: np.zeros(length, dtype=np.float32) for name, length in contig_lengths.items()
    }
    with _open_text(path) as handle:
        for line in handle:
            if not line or line.startswith(("#", "track", "browser")):
                continue
            fields = line.split()
            if len(fields) < 4:
                continue
            chrom, start, end, value = fields[0], int(fields[1]), int(fields[2]), float(fields[3])
            if chrom not in signal:
                continue
            arr = signal[chrom]
            end = min(end, arr.shape[0])
            if start < end:
                arr[start:end] = value
    return signal


@dataclass
class InitiationTrack:
    """Strand-separated initiation signal for one species.

    plus[contig] / minus[contig] are dense per-position arrays of read counts
    (or a summary across replicates). Missing positions are 0.
    """

    plus: Dict[str, np.ndarray] = field(default_factory=dict)
    minus: Dict[str, np.ndarray] = field(default_factory=dict)

    def contigs(self) -> list[str]:
        return sorted(set(self.plus) | set(self.minus))

    def get(self, contig: str, strand: Strand) -> np.ndarray:
        table = self.plus if strand == "+" else self.minus
        return table[contig]


def load_initiation(
    plus_bedgraph: str | Path,
    minus_bedgraph: str | Path,
    contig_lengths: Dict[str, int],
) -> InitiationTrack:
    """Load a strand pair of bedGraph tracks into an InitiationTrack."""
    return InitiationTrack(
        plus=read_bedgraph(plus_bedgraph, contig_lengths),
        minus=read_bedgraph(minus_bedgraph, contig_lengths),
    )


def contig_lengths_from_fasta(path: str | Path) -> Dict[str, int]:
    """Compute contig lengths by streaming the FASTA once."""
    return {name: len(seq) for name, seq in iter_fasta(path)}


# --------------------------------------------------------------------------- #
# Sequence encoding helpers
# --------------------------------------------------------------------------- #

_BASE_TO_IDX = {"A": 0, "C": 1, "G": 2, "T": 3}


def encode_bases(seq: str) -> np.ndarray:
    """Encode a sequence into int8 base indices; non-ACGT -> -1."""
    out = np.full(len(seq), -1, dtype=np.int8)
    for base, idx in _BASE_TO_IDX.items():
        out[np.frombuffer(seq.encode("ascii"), dtype=np.uint8) == ord(base)] = idx
    return out

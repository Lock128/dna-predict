//! Data loading for the EPIC challenge.
//!
//! Per species, the challenge distributes:
//!   - a genome as FASTA (one record per chromosome/contig), and
//!   - transcription-initiation signal as strand-separated bedGraph tracks
//!     (two replicates) giving a read count per genomic position and strand.
//!
//! Readers stream line-by-line and transparently handle gzip (`.gz`) so we can
//! process multi-GB genomes without loading whole files into memory at once.
//!
//! NOTE: the exact bedGraph column layout of the official release should be
//! confirmed against the Zenodo download (doi:10.5281/zenodo.22285753). We
//! assume the common 4-column bedGraph form `chrom start end value`, 0-based
//! half-open coordinates, one file per strand.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use flate2::read::MultiGzDecoder;

use crate::Strand;

/// Open a file as a buffered reader, transparently decompressing `.gz`.
fn open_reader(path: &Path) -> io::Result<Box<dyn BufRead>> {
    let file = File::open(path)?;
    let is_gz = path.extension().map(|e| e == "gz").unwrap_or(false);
    let inner: Box<dyn Read> = if is_gz {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    Ok(Box::new(BufReader::with_capacity(1 << 20, inner)))
}

// --------------------------------------------------------------------------- //
// Genome (FASTA)
// --------------------------------------------------------------------------- //

/// Parse a (optionally gzipped) FASTA into `{contig_name: sequence}`.
///
/// The contig name is the first whitespace-delimited token of the header.
/// Sequence is upper-cased; non-ACGT characters are preserved (upper-cased) so
/// callers decide how to treat them.
pub fn read_fasta(path: &Path) -> io::Result<HashMap<String, Vec<u8>>> {
    let mut sequences: HashMap<String, Vec<u8>> = HashMap::new();
    let mut current: Option<String> = None;
    let reader = open_reader(path)?;
    for line in reader.lines() {
        let line = line?;
        let bytes = line.as_bytes();
        if bytes.is_empty() {
            continue;
        }
        if bytes[0] == b'>' {
            let name = line[1..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
            sequences.entry(name.clone()).or_default();
            current = Some(name);
        } else {
            match &current {
                Some(name) => {
                    let seq = sequences.get_mut(name).unwrap();
                    seq.extend(line.trim().bytes().map(|b| b.to_ascii_uppercase()));
                }
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "FASTA has sequence before any header",
                    ))
                }
            }
        }
    }
    Ok(sequences)
}

/// Contig lengths keyed by name, computed from the FASTA.
pub fn contig_lengths(sequences: &HashMap<String, Vec<u8>>) -> HashMap<String, usize> {
    sequences.iter().map(|(k, v)| (k.clone(), v.len())).collect()
}

// --------------------------------------------------------------------------- //
// Initiation signal (bedGraph)
// --------------------------------------------------------------------------- //

/// Read a bedGraph-style track into per-contig dense `f32` arrays.
///
/// `contig_lengths` is used to allocate one array per contig; positions not
/// covered by the file remain 0. Coordinates are 0-based half-open.
pub fn read_bedgraph(
    path: &Path,
    contig_lengths: &HashMap<String, usize>,
) -> io::Result<HashMap<String, Vec<f32>>> {
    let mut signal: HashMap<String, Vec<f32>> = contig_lengths
        .iter()
        .map(|(name, &len)| (name.clone(), vec![0.0f32; len]))
        .collect();

    let reader = open_reader(path)?;
    for line in reader.lines() {
        let line = line?;
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with("track")
            || line.starts_with("browser")
        {
            continue;
        }
        let mut it = line.split_whitespace();
        let (chrom, start, end, value) =
            match (it.next(), it.next(), it.next(), it.next()) {
                (Some(c), Some(s), Some(e), Some(v)) => (c, s, e, v),
                _ => continue,
            };
        let arr = match signal.get_mut(chrom) {
            Some(a) => a,
            None => continue,
        };
        let start: usize = match start.parse() {
            Ok(x) => x,
            Err(_) => continue,
        };
        let mut end: usize = match end.parse() {
            Ok(x) => x,
            Err(_) => continue,
        };
        let value: f32 = match value.parse() {
            Ok(x) => x,
            Err(_) => continue,
        };
        if end > arr.len() {
            end = arr.len();
        }
        if start < end {
            for slot in &mut arr[start..end] {
                *slot = value;
            }
        }
    }
    Ok(signal)
}

/// Strand-separated initiation signal for one species.
///
/// `plus`/`minus` map contig name to a dense per-position array of read counts
/// (or a per-position summary across replicates). Missing positions are 0.
#[derive(Debug, Default, Clone)]
pub struct InitiationTrack {
    pub plus: HashMap<String, Vec<f32>>,
    pub minus: HashMap<String, Vec<f32>>,
}

impl InitiationTrack {
    pub fn new() -> Self {
        Self::default()
    }

    /// Load a strand pair of bedGraph tracks.
    pub fn load(
        plus_path: &Path,
        minus_path: &Path,
        contig_lengths: &HashMap<String, usize>,
    ) -> io::Result<Self> {
        Ok(Self {
            plus: read_bedgraph(plus_path, contig_lengths)?,
            minus: read_bedgraph(minus_path, contig_lengths)?,
        })
    }

    pub fn get(&self, contig: &str, strand: Strand) -> Option<&Vec<f32>> {
        match strand {
            Strand::Plus => self.plus.get(contig),
            Strand::Minus => self.minus.get(contig),
        }
    }

    /// Sorted union of contig names across both strands.
    pub fn contigs(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .plus
            .keys()
            .chain(self.minus.keys())
            .cloned()
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// A subset restricted to the given contigs (clones the arrays).
    pub fn subset(&self, contigs: &[String]) -> InitiationTrack {
        let pick = |src: &HashMap<String, Vec<f32>>| -> HashMap<String, Vec<f32>> {
            contigs
                .iter()
                .filter_map(|c| src.get(c).map(|v| (c.clone(), v.clone())))
                .collect()
        };
        InitiationTrack {
            plus: pick(&self.plus),
            minus: pick(&self.minus),
        }
    }
}

// --------------------------------------------------------------------------- //
// Sequence encoding
// --------------------------------------------------------------------------- //

/// Encode ASCII bases into indices: A=0, C=1, G=2, T=3, anything else = -1.
pub fn encode_bases(seq: &[u8]) -> Vec<i8> {
    seq.iter()
        .map(|&b| match b {
            b'A' | b'a' => 0,
            b'C' | b'c' => 1,
            b'G' | b'g' => 2,
            b'T' | b't' => 3,
            _ => -1,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_bases() {
        assert_eq!(encode_bases(b"ACGTN"), vec![0, 1, 2, 3, -1]);
    }
}

//! `epic` command-line entry point.
//!
//! Subcommands:
//!   baseline  — fit the dinucleotide baseline on train contigs, predict test
//!               contigs, write a submission, and (optionally) score it.
//!
//! Example (offline replica on the Nematostella dataset):
//!
//!   epic baseline \
//!       --genome data/nematostella/genome.fa \
//!       --plus   data/nematostella/initiation.plus.bedgraph \
//!       --minus  data/nematostella/initiation.minus.bedgraph \
//!       --train-contigs chr1,chr2,chr3 \
//!       --test-contigs  chr4 \
//!       --out submission.tsv

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use epic::baseline::DinucleotideBaseline;
use epic::data::{contig_lengths, read_fasta, InitiationTrack};
use epic::scoring::score_species;
use epic::Strand;

#[derive(Parser)]
#[command(name = "epic", about = "Fast pipeline for the EPIC transcription-initiation challenge")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Fit + predict + score the dinucleotide baseline.
    Baseline(BaselineArgs),
}

#[derive(Parser)]
struct BaselineArgs {
    /// Genome FASTA (optionally .gz).
    #[arg(long)]
    genome: PathBuf,
    /// Plus-strand initiation bedGraph.
    #[arg(long)]
    plus: PathBuf,
    /// Minus-strand initiation bedGraph.
    #[arg(long)]
    minus: PathBuf,
    /// Comma-separated train contigs.
    #[arg(long)]
    train_contigs: Option<String>,
    /// Comma-separated test contigs.
    #[arg(long)]
    test_contigs: Option<String>,
    /// k-mer length (2 = dinucleotide baseline).
    #[arg(long, default_value_t = 2)]
    k: usize,
    /// Write a long-format submission TSV.
    #[arg(long)]
    out: Option<PathBuf>,
    /// Signal strictly greater than this counts as initiation.
    #[arg(long, default_value_t = 0.0)]
    presence_threshold: f64,
    /// Skip scoring (e.g. for the real blind test set).
    #[arg(long, default_value_t = false)]
    no_score: bool,
}

fn parse_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect()
}

fn split_contigs(
    all_contigs: &[String],
    train_arg: &Option<String>,
    test_arg: &Option<String>,
) -> (Vec<String>, Vec<String>) {
    match (train_arg, test_arg) {
        (Some(tr), Some(te)) => (parse_list(tr), parse_list(te)),
        (None, Some(te)) => {
            let test = parse_list(te);
            let test_set: std::collections::HashSet<&String> = test.iter().collect();
            let train = all_contigs
                .iter()
                .filter(|c| !test_set.contains(*c))
                .cloned()
                .collect();
            (train, test)
        }
        // default: hold out the last contig as a quick sanity split
        _ => {
            if all_contigs.len() < 2 {
                (all_contigs.to_vec(), all_contigs.to_vec())
            } else {
                let split = all_contigs.len() - 1;
                (all_contigs[..split].to_vec(), all_contigs[split..].to_vec())
            }
        }
    }
}

fn subset_seqs(
    seqs: &HashMap<String, Vec<u8>>,
    contigs: &[String],
) -> HashMap<String, Vec<u8>> {
    contigs
        .iter()
        .filter_map(|c| seqs.get(c).map(|s| (c.clone(), s.clone())))
        .collect()
}

fn write_submission(path: &PathBuf, pred: &InitiationTrack) -> io::Result<usize> {
    // Create the parent directory if it doesn't exist (e.g. /data/out on a
    // fresh container volume) so callers can point --out into a new subdir.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let file = File::create(path)?;
    let mut w = BufWriter::with_capacity(1 << 20, file);
    writeln!(w, "contig\tposition\tstrand\tvalue")?;
    let mut n = 0usize;
    for (strand, table) in [(Strand::Plus, &pred.plus), (Strand::Minus, &pred.minus)] {
        let mut contigs: Vec<&String> = table.keys().collect();
        contigs.sort();
        for contig in contigs {
            let values = &table[contig];
            for (pos, val) in values.iter().enumerate() {
                writeln!(w, "{contig}\t{pos}\t{}\t{}", strand.as_str(), format_value(*val))?;
                n += 1;
            }
        }
    }
    w.flush()?;
    Ok(n)
}

/// Compact numeric formatting similar to Python's %g.
fn format_value(v: f32) -> String {
    if v == 0.0 {
        "0".to_string()
    } else {
        format!("{:.6}", v)
    }
}

fn run_baseline(args: BaselineArgs) -> io::Result<()> {
    eprintln!("[baseline] reading genome: {}", args.genome.display());
    let seqs = read_fasta(&args.genome)?;
    let lengths = contig_lengths(&seqs);
    let mut all_contigs: Vec<String> = seqs.keys().cloned().collect();
    all_contigs.sort();

    eprintln!("[baseline] reading initiation tracks (+/-)");
    let truth = InitiationTrack::load(&args.plus, &args.minus, &lengths)?;

    let (train_contigs, test_contigs) =
        split_contigs(&all_contigs, &args.train_contigs, &args.test_contigs);
    eprintln!("[baseline] train contigs: {train_contigs:?}");
    eprintln!("[baseline] test  contigs: {test_contigs:?}");

    let train_seqs = subset_seqs(&seqs, &train_contigs);
    let test_seqs = subset_seqs(&seqs, &test_contigs);
    let train_truth = truth.subset(&train_contigs);

    let mut model = DinucleotideBaseline::new(args.k);
    model.fit(&train_seqs, &train_truth);
    eprintln!(
        "[baseline] fitted k={} ({} k-mers per strand)",
        args.k,
        model.n_kmers()
    );

    let pred = model.predict(&test_seqs);

    if let Some(out) = &args.out {
        let n = write_submission(out, &pred)?;
        eprintln!("[baseline] wrote {n} rows -> {}", out.display());
    }

    if !args.no_score {
        let test_truth = truth.subset(&test_contigs);
        let scores = score_species(&pred, &test_truth, &test_contigs, args.presence_threshold);
        println!("[baseline] AUPRC (presence):      {:.4}", scores.auprc);
        println!("[baseline] Spearman (efficiency): {:.4}", scores.spearman);
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Baseline(args) => run_baseline(args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

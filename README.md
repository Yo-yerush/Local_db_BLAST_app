# Local BLAST Web App

This is a dependency-free Node.js web app for running local BLAST searches against FASTA files under `genome_sets/`.

## Requirements

1. Install Node.js 18 or newer.
2. Install NCBI BLAST+ locally, or place the NCBI BLAST+ folder under `tools/`.

BLAST+ is not included in this repository because it is large and platform-specific. Download it from the official NCBI BLAST+ release folder:

```text
https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/
```

Windows options:

- Easiest: double-click `tools/Install_BLAST_Plus.bat`. It downloads the portable Windows BLAST+ archive, extracts it under `tools/`, verifies `blastn.exe` and `makeblastdb.exe`, and removes the downloaded archive.
- Installer: download `ncbi-blast-2.17.0+-win64.exe`, run it, then restart the app.
- Portable local copy: download `ncbi-blast-2.17.0+-x64-win64.tar.gz` and extract it under `tools/`.

PowerShell portable install example:

```powershell
New-Item -ItemType Directory -Force tools
Invoke-WebRequest -UseBasicParsing -Uri "https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/ncbi-blast-2.17.0+-x64-win64.tar.gz" -OutFile "tools\ncbi-blast-2.17.0+-x64-win64.tar.gz"
tar -xzf "tools\ncbi-blast-2.17.0+-x64-win64.tar.gz" -C tools
Remove-Item "tools\ncbi-blast-2.17.0+-x64-win64.tar.gz"
```

After extraction, this path should exist:

```text
tools\ncbi-blast-2.17.0+\bin\blastn.exe
```

The app auto-detects BLAST+ from:

- `BLAST_BIN_DIR`
- `blast-bin-dir.txt`
- `tools/ncbi-blast-*/bin`
- common `C:\Program Files\NCBI\...` folders

If BLAST+ is installed somewhere else, set `BLAST_BIN_DIR` to the folder that contains the BLAST executables before starting the app.

PowerShell example:

```powershell
$env:BLAST_BIN_DIR = "C:\Program Files\NCBI\blast-2.16.0+\bin"
npm start
```

## Run

```powershell
npm.cmd start
```

Open the URL printed by the server, usually:

```text
http://127.0.0.1:3000
```

## Run By Double-Clicking On Windows

Double-click:

```text
Local_BLAST_app.bat
```

Keep the command window open while using the app. Close it, or press `Ctrl+C`, to stop the server.

If BLAST+ is installed but not on `PATH`, create a text file named `blast-bin-dir.txt` next to `Local_BLAST_app.bat` and put the BLAST `bin` folder path inside it, for example:

```text
C:\Program Files\NCBI\blast-2.16.0+\bin
```

## Add More Genome Sets

Put each genome/reference package in its own folder under `genome_sets/`. The top-level folder name is used as the annotation/reference name in the app.

Example:

```text
genome_sets/
  TAIR10.1/
    README.md
    GCF_000001735.4/
      genomic.gff
      genomic.gtf
      genomic.gbff
      GCF_000001735.4_TAIR10.1_genomic.fna
      cds_from_genomic.fna
      rna.fna
      protein.faa
      sequence_report.jsonl
  TAIR10_blastsets/
    TAIR10_cds_20101214_updated
    TAIR10_pep_20101214_updated
    upstream_sequences/
      TAIR10_upstream_1000_20101104
  TAIR10/
    TAIR10_chr_all.fas
    Araport11_GFF3_genes_transposons.Jul2022.gff
    TAIR10_TE.fas
    TAIR10_Transposable_Elements.txt
```

The app recursively scans these folders. It automatically uses FASTA files as BLAST databases, including TAIR files with no file extension if their content starts with `>`.

Files used as databases:

- `.fna`, `.fa`, `.fasta`, `.fas`, `.ffn`, `.frn`
- `.faa`
- gzip-compressed versions of those files
- extensionless FASTA files such as TAIR10 blastsets

Files kept as annotation/context:

- `.gff`, `.gtf`, `.gbff`
- `sequence_report.jsonl`
- TAIR10 transposable element description tables such as `TAIR10_Transposable_Elements.txt`
- `README` files
- mapping/description tables

The Details window can use FASTA headers plus matching `.gff`/`.gtf` files to show sequence context, overlapping features, gene names, products, and notes when those annotations are present.
For TAIR10 TE FASTA hits, the Details window also uses `TAIR10_Transposable_Elements.txt` to show the TE family and superfamily.

## Genome Metadata CSV

Edit `genome_sets/genomes.csv` to add display metadata for a whole folder. Folder-level rows are enough for most genome sets.

```csv
set,organism,assembly,source,tax_id,strain,description
TAIR10.1,Arabidopsis thaliana,TAIR10.1,NCBI Datasets RefSeq/GenBank,3702,Columbia,Arabidopsis reference genome package
```

Optional per-file rows are also supported. Use `file` with a path relative to `genome_sets/`:

```csv
set,file,name,type,category,description
TAIR10_blastsets,TAIR10_blastsets/TAIR10_cds_20101214_updated,TAIR10 CDS all models,nucl,CDS,TAIR10 coding sequences
```

`type` is `nucl` or `prot`. If omitted, the app infers it from the filename/category.

FASTA files are staged and BLAST databases are built in the work directory before running BLAST.

## Repository Data Policy

The app is flexible and does not require the example TAIR/NCBI datasets or BLAST+ binaries to be committed to GitHub.

Commit the app source files and keep only these small placeholder/helper files for local data and tools:

```text
genome_sets/genomes.csv
genome_sets/README.md
tools/Install_BLAST_Plus.bat
tools/README.md
```

Users can then add their own genome/reference folders under `genome_sets/`, update `genomes.csv` for display metadata, and run `tools/Install_BLAST_Plus.bat` if they want a local portable BLAST+ copy.

Large FASTA/GFF/GTF/GBFF datasets, BLAST+ binaries, generated BLAST databases, and annotation indexes should stay local and out of Git.

## Target Picker

The target picker is designed for flexible genome folders. It shows grouped targets by default so the list stays readable even when each organism has genome, transcript, CDS, protein, TE, and annotation files:

- `All genome sets: all nucleotide files`
- `TAIR10.1: all nucleotide files`
- `TAIR10_blastsets: all nucleotide files`
- protein equivalents when protein FASTA files exist

Use the `+` button beside a group to show the individual FASTA files inside it. Select the group when you want to search all compatible files in that genome/reference set, or select an inner file when you want one exact FASTA database.

For nucleotide queries pasted as short raw sequence text, leave E-value as `auto`. The app then uses `blastn-short`, disables dust masking, and uses an effective e-value of `1000`, which is appropriate for very short DNA such as 20 bp primers. Longer searches use `1e-5` unless you type a numeric cutoff.

By default on Windows, BLAST work files are staged under:

```text
C:\tmp\local-blast-web-work
```

This avoids BLAST+ path issues with spaces and synced OneDrive/Teams folders. Override it with `LOCAL_BLAST_WORK_DIR` if needed.

GFF/GTF annotation indexes are also cached under this work directory. The first `Details` lookup for a large genome annotation file may take longer while the index is built; later lookups reuse the cache. If you replace a GFF/GTF file, the app detects the changed file size/date and rebuilds the index automatically.

## Query Modes

- `Sequence`: paste FASTA or raw sequence text.
- `Local ID`: enter a FASTA header ID from one of the local databases. With `Auto-find ID in all local FASTA files`, the app searches local FASTA headers, extracts the first matching record, and then BLASTs that sequence against the selected target.

For local IDs, the app matches the first FASTA header token exactly, the same token without a version suffix, or the full header text containing the submitted ID.

To compare an ID against other organisms, keep the target set on `All genome sets: all nucleotide files` or the equivalent protein group. Choose a specific set/file only when you want to restrict the search.

## Result View

The results table has two view modes:

- `Compact by target`: groups repeated hits into one parent row and shows the best hit first. Use the `+` button to expand the raw hits inside that group.
- `Show all hits`: shows the original BLAST rows without grouping.

Compact grouping is general across genome sets. The app tries to group by parsed biological IDs from the subject/header, such as gene, locus, transcript, protein, or TE IDs. For chromosome/scaffold hits it groups nearby coordinates. If no biological ID or coordinate pattern is clear, it falls back to subject/database grouping.

The downloaded TSV keeps the full raw BLAST output, not only the compact screen view.

## Result Details

After a search, click `Details` beside any hit. The details view shows:

- BLAST hit metrics and target database metadata.
- The subject FASTA header.
- A FASTA context window around the hit, or the full record when it is small enough.
- The aligned subject segment, reverse-complemented for minus-strand nucleotide hits.
- Matching GFF/GTF annotations when the app can connect the hit by coordinates or by IDs such as `locus_tag`, `gene`, `transcript_id`, or `protein_id`.

## Test

The smoke test expects local FASTA files under `genome_sets/`. If you publish the app without large datasets, the test will only pass after the user adds compatible local genome files.

Run the smoke test:

```powershell
npm.cmd test
```

The test starts the server on a test port, discovers `genome_sets/`, checks grouped targets, runs a short sequence search with `auto` e-value, opens hit details, and tests local ID search with auto source lookup. It searches for:

```text
ATGGCCGTCTCATCATTCCA
```

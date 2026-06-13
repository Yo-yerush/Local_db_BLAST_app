# Tools

This folder is optional and is used for a local portable copy of NCBI BLAST+.

Do not commit BLAST+ binaries to GitHub. Download BLAST+ from:

```text
https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/
```

On Windows, you can double-click `Install_BLAST_Plus.bat` in this folder to download and extract the portable BLAST+ release automatically.

For a portable Windows setup, extract the BLAST+ archive so the executable path looks like:

```text
tools/ncbi-blast-2.17.0+/bin/blastn.exe
```

The app also works if BLAST+ is installed elsewhere and available through `PATH`, `BLAST_BIN_DIR`, or `blast-bin-dir.txt`.

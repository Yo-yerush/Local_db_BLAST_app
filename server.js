"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { pipeline } = require("node:stream/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const GENOME_ROOT = process.env.GENOME_ROOT
  ? path.resolve(process.env.GENOME_ROOT)
  : path.join(ROOT, "genome_sets");
const LEGACY_GENOMES_DIR = path.join(ROOT, "genomes");
const CSV_PATH = path.join(GENOME_ROOT, "genomes.csv");
const WORK_DIR = resolveWorkDir();
const FASTA_CACHE_DIR = path.join(WORK_DIR, "fasta");
const DB_DIR = path.join(WORK_DIR, "databases");
const QUERY_DIR = path.join(WORK_DIR, "queries");
const ANNOTATION_INDEX_DIR = path.join(WORK_DIR, "annotation-indexes");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const BLAST_BIN_DIR = findBlastBinDir();
const BLAST_THREADS = Number.parseInt(process.env.BLAST_THREADS || "2", 10);
const BLAST_TIMEOUT_MS = Number.parseInt(process.env.BLAST_TIMEOUT_MS || "120000", 10);
const BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const AUTO_SOURCE_ID = "__auto__";
const DEFAULT_EVALUE = "1e-5";
const SHORT_NUCL_EVALUE = "1000";
const HIT_DETAIL_FLANK = 120;
const HIT_SEQUENCE_LIMIT = 12000;
const ANNOTATION_LIMIT = 30;
const ANNOTATION_INDEX_VERSION = 1;
const ANNOTATION_BIN_SIZE = 100000;

const OUT_FIELDS = [
  "qseqid",
  "sseqid",
  "pident",
  "length",
  "mismatch",
  "gapopen",
  "qstart",
  "qend",
  "sstart",
  "send",
  "evalue",
  "bitscore",
  "qseq",
  "sseq",
  "stitle"
];

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"]
]);

const dbBuilds = new Map();
const annotationIndexBuilds = new Map();

function resolveWorkDir() {
  if (process.env.LOCAL_BLAST_WORK_DIR) {
    return path.resolve(process.env.LOCAL_BLAST_WORK_DIR);
  }

  if (process.platform === "win32" && fs.existsSync("C:\\tmp")) {
    return "C:\\tmp\\local-blast-web-work";
  }

  return path.join(os.tmpdir(), "local-blast-web-work");
}

function findBlastBinDir() {
  const candidates = [];

  if (process.env.BLAST_BIN_DIR) {
    candidates.push(process.env.BLAST_BIN_DIR);
  }

  const localConfig = path.join(ROOT, "blast-bin-dir.txt");
  try {
    const configured = fs.readFileSync(localConfig, "utf8").trim();
    if (configured) candidates.push(configured);
  } catch {
    // Optional local configuration file.
  }

  const toolsDir = path.join(ROOT, "tools");
  try {
    const localTools = fs.readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^ncbi-blast-/i.test(entry.name))
      .map((entry) => path.join(toolsDir, entry.name, "bin"));
    candidates.push(...localTools);
  } catch {
    // Optional local tools folder.
  }

  candidates.push(
    path.join("C:", "Program Files", "NCBI", "blast", "bin"),
    path.join("C:", "Program Files", "NCBI", "blast-2.17.0+", "bin"),
    path.join("C:", "Program Files", "NCBI", "blast-2.16.0+", "bin")
  );

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, process.platform === "win32" ? "makeblastdb.exe" : "makeblastdb"))) {
      return resolved;
    }
  }

  return "";
}

function toolPath(name) {
  if (!BLAST_BIN_DIR) return name;
  const exe = process.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;
  return path.join(BLAST_BIN_DIR, exe);
}

function stableId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function safeName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || "database";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function normalizeDbType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (["prot", "protein", "aa", "amino", "amino-acid", "amino_acid"].includes(value)) return "prot";
  if (["nucl", "nucleotide", "dna", "rna", "genome", "transcriptome"].includes(value)) return "nucl";
  return "nucl";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        i += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const filtered = rows.filter((items) => items.some((item) => item.trim().length > 0));
  if (filtered.length === 0) return [];

  const headers = filtered[0].map((header) => header.trim());
  return filtered.slice(1).map((items) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = (items[index] || "").trim();
    });
    return record;
  });
}

async function readDatabases() {
  const roots = [];
  if (fs.existsSync(GENOME_ROOT)) roots.push({ dir: GENOME_ROOT, label: "genome_sets" });
  if (fs.existsSync(LEGACY_GENOMES_DIR)) roots.push({ dir: LEGACY_GENOMES_DIR, label: "genomes" });
  if (roots.length === 0) {
    await fsp.mkdir(GENOME_ROOT, { recursive: true });
    return [];
  }

  const metadata = await readGenomeMetadata();
  const entries = [];
  for (const root of roots) {
    const files = await walkFiles(root.dir);
    const annotationFilesBySet = collectAnnotationFiles(files, root.dir);

    for (const resolved of files) {
      if (!(await isFastaCandidate(resolved))) continue;

      const relative = path.relative(root.dir, resolved);
      const normalizedRelative = relative.replace(/\\/g, "/");
      const escapedRoot = relative.startsWith("..") || path.isAbsolute(relative);
      if (escapedRoot) continue;

      const parts = splitRelative(normalizedRelative);
      const setName = parts[0] || root.label;
      const accession = parts.find((part) => /^(GC[AF]_\d+\.\d+)$/i.test(part)) || "";
      const setInfo = metadata.sets.get(normalizeKey(setName)) || {};
      const fileInfo = metadata.files.get(normalizeKey(normalizedRelative)) || {};
      const stat = await fsp.stat(resolved);
      const category = fileInfo.category || inferCategory(normalizedRelative);
      const type = normalizeDbType(fileInfo.type || inferFileType(normalizedRelative, category));
      const annotations = annotationFilesBySet.get(normalizeKey(setName)) || [];
      const id = stableId(`${root.label}/${normalizedRelative}`);

      entries.push({
        id,
        file: normalizedRelative,
        fileName: path.basename(normalizedRelative),
        name: fileInfo.name || fileInfo.display_name || fileInfo.displayName || buildDisplayName({ setName, accession, relative: normalizedRelative, category, type }),
        type,
        category,
        description: fileInfo.description || setInfo.description || "",
        organism: fileInfo.organism || setInfo.organism || "",
        assembly: fileInfo.assembly || setInfo.assembly || accession || "",
        source: fileInfo.source || setInfo.source || root.label,
        taxId: fileInfo.tax_id || fileInfo.taxId || setInfo.tax_id || setInfo.taxId || "",
        strain: fileInfo.strain || setInfo.strain || "",
        annotationName: setName,
        accession,
        root: root.label,
        path: resolved,
        exists: true,
        size: stat.size,
        sizeLabel: formatBytes(stat.size),
        mtimeMs: stat.mtimeMs,
        compressed: /\.gz$/i.test(normalizedRelative),
        escapedRoot: false,
        annotationFiles: annotations
      });
    }
  }

  return entries.sort((a, b) => (
    `${a.annotationName}\t${a.accession}\t${a.category}\t${a.file}`.localeCompare(`${b.annotationName}\t${b.accession}\t${b.category}\t${b.file}`)
  ));
}

function buildTargetGroups(databases) {
  const available = databases.filter((database) => database.exists && !database.escapedRoot);
  const bySet = new Map();
  const byType = new Map();

  for (const database of available) {
    const setKey = `${database.annotationName || "Other"}\t${database.type}`;
    if (!bySet.has(setKey)) bySet.set(setKey, []);
    bySet.get(setKey).push(database);

    if (!byType.has(database.type)) byType.set(database.type, []);
    byType.get(database.type).push(database);
  }

  const groups = [];
  for (const [key, members] of bySet) {
    if (members.length < 2) continue;
    const [annotationName, type] = key.split("\t");
    groups.push(createTargetGroup({
      scope: "set",
      annotationName,
      type,
      members,
      name: `${annotationName}: all ${type === "prot" ? "protein" : "nucleotide"} files`,
      category: type === "prot" ? "All protein files" : "All nucleotide files"
    }));
  }

  for (const [type, members] of byType) {
    if (members.length < 2) continue;
    groups.push(createTargetGroup({
      scope: "all",
      annotationName: "All genome sets",
      type,
      members,
      name: `All genome sets: all ${type === "prot" ? "protein" : "nucleotide"} files`,
      category: type === "prot" ? "All protein files" : "All nucleotide files"
    }));
  }

  return groups.sort((a, b) => (
    `${a.scope}\t${a.annotationName}\t${a.type}`.localeCompare(`${b.scope}\t${b.annotationName}\t${b.type}`)
  ));
}

function createTargetGroup({ scope, annotationName, type, members, name, category }) {
  const id = `group:${stableId(`${scope}/${annotationName}/${type}`)}`;
  const organisms = uniqueStrings(members.map((member) => member.organism));
  const assemblies = uniqueStrings(members.map((member) => member.assembly || member.accession));
  const categories = uniqueStrings(members.map((member) => member.category));
  const annotationFiles = uniqueAnnotationFiles(members.flatMap((member) => member.annotationFiles || []));
  const size = members.reduce((sum, member) => sum + (member.size || 0), 0);
  return {
    id,
    targetKind: "group",
    isGroup: true,
    scope,
    name,
    type,
    category,
    description: `Searches ${members.length} ${type === "prot" ? "protein" : "nucleotide"} FASTA databases as one target.`,
    organism: organisms.length === 1 ? organisms[0] : `${organisms.length || "Multiple"} organisms`,
    assembly: assemblies.length === 1 ? assemblies[0] : `${assemblies.length || "Multiple"} assemblies`,
    source: uniqueStrings(members.map((member) => member.source)).join(", "),
    taxId: uniqueStrings(members.map((member) => member.taxId)).join(", "),
    strain: uniqueStrings(members.map((member) => member.strain)).join(", "),
    annotationName,
    accession: "",
    root: "group",
    exists: true,
    escapedRoot: false,
    size,
    sizeLabel: formatBytes(size),
    databaseCount: members.length,
    memberIds: members.map((member) => member.id),
    memberCategories: categories,
    annotationFiles
  };
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueAnnotationFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files) {
    const key = file.file || file.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out.slice(0, 20);
}

async function readGenomeMetadata() {
  const rows = [];
  for (const csvPath of [CSV_PATH, path.join(LEGACY_GENOMES_DIR, "genomes.csv")]) {
    try {
      rows.push(...parseCsv(await fsp.readFile(csvPath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const sets = new Map();
  const files = new Map();
  for (const row of rows) {
    const file = row.file || row.filename || row.path;
    const setName = row.set || row.folder || row.annotation || row.annotation_name || row.annotationName || row.name;
    if (file) files.set(normalizeKey(file.replace(/\\/g, "/")), row);
    if (setName && !file) sets.set(normalizeKey(setName), row);
  }
  return { sets, files };
}

async function walkFiles(rootDir) {
  const out = [];
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const resolved = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(resolved));
    } else if (entry.isFile()) {
      out.push(resolved);
    }
  }
  return out;
}

function collectAnnotationFiles(files, rootDir) {
  const grouped = new Map();
  for (const resolved of files) {
    const relative = path.relative(rootDir, resolved).replace(/\\/g, "/");
    if (!isAnnotationFile(relative)) continue;
    const setName = splitRelative(relative)[0] || "";
    const key = normalizeKey(setName);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      file: relative,
      type: classifyAnnotationFile(relative),
      name: path.basename(relative)
    });
  }

  for (const [key, values] of grouped) {
    grouped.set(key, values.slice(0, 12));
  }
  return grouped;
}

async function isFastaCandidate(filePath) {
  const relative = filePath.replace(/\\/g, "/");
  if (isFastaExtension(relative)) return true;
  if (isAnnotationFile(relative) || /(^|\/)(README|readme|genomes\.csv)/i.test(relative)) return false;
  return looksLikeFasta(filePath);
}

function isFastaExtension(file) {
  return /\.(fa|fasta|fas|fna|faa|ffn|frn)(\.gz)?$/i.test(file);
}

function isAnnotationFile(file) {
  return /\.(gff|gff3|gtf|gbff|gbk|jsonl|json|txt|xlsx|csv)(\.gz)?$/i.test(file) || /README/i.test(path.basename(file));
}

function classifyAnnotationFile(file) {
  const lower = file.toLowerCase();
  if (/\.gff3?(\.gz)?$/.test(lower)) return "GFF";
  if (/\.gtf(\.gz)?$/.test(lower)) return "GTF";
  if (/\.gbff|\.gbk/.test(lower)) return "GenBank";
  if (/sequence_report\.jsonl$/.test(lower)) return "NCBI sequence report";
  if (/transposable|transposon|(^|[_/.-])te([_/.-]|$)/.test(lower) && /\.txt(\.gz)?$/.test(lower)) return "TE description";
  if (/readme/i.test(lower)) return "README";
  return "Annotation";
}

async function looksLikeFasta(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.slice(0, bytesRead).toString("utf8").trimStart();
    return text.startsWith(">");
  } finally {
    await handle.close();
  }
}

function splitRelative(relative) {
  return String(relative || "").split(/[\\/]+/).filter(Boolean);
}

function normalizeKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").toLowerCase();
}

function inferFileType(file, category = "") {
  const lower = `${file} ${category}`.toLowerCase();
  return /\.(faa)(\.gz)?$/i.test(file) || /(^|[_/.-])pep([_/.-]|$)|protein|proteome/.test(lower) ? "prot" : "nucl";
}

function inferCategory(file) {
  const lower = file.toLowerCase();
  if (/transposable|transposon|(^|[_/.-])te([_/.-]|$)/.test(lower)) return "Transposable elements";
  if (/protein|\.faa$|(^|[_/.-])pep([_/.-]|$)/.test(lower)) return "Proteome";
  if (/cds/.test(lower)) return "CDS";
  if (/rna|cdna|transcript/.test(lower)) return "Transcriptome";
  if (/upstream/.test(lower)) return "Upstream regions";
  if (/downstream/.test(lower)) return "Downstream regions";
  if (/intergenic/.test(lower)) return "Intergenic regions";
  if (/intron/.test(lower)) return "Introns";
  if (/exon/.test(lower)) return "Exons";
  if (/(^|[_/.-])3[_-]?utr|(^|[_/.-])5[_-]?utr/.test(lower)) return "UTR";
  if (/bac/.test(lower)) return "BAC";
  if (/genomic|genome|_seq_|chr|chromosome/.test(lower)) return "Genome";
  return "FASTA";
}

function buildDisplayName({ setName, accession, relative, category, type }) {
  const base = path.basename(relative).replace(/(\.gz|\.fasta|\.fa|\.fas|\.fna|\.faa|\.ffn|\.frn)$/ig, "");
  const readable = base.replace(/_/g, " ");
  const accessionPart = accession ? ` ${accession}` : "";
  const typePart = type === "prot" && category !== "Proteome" ? " protein" : "";
  return `${setName}${accessionPart} ${category || "FASTA"}${typePart}: ${readable}`;
}

function publicDatabase(database) {
  const {
    path: _path,
    mtimeMs: _mtimeMs,
    escapedRoot,
    ...publicFields
  } = database;
  return {
    ...publicFields,
    targetKind: "file",
    isGroup: false,
    escapedRoot
  };
}

function publicTargetGroup(group) {
  return group;
}

async function findDatabase(id) {
  const databases = await readDatabases();
  const database = databases.find((item) => item.id === id || item.file === id);
  if (!database) throw httpError(404, "Database not found in genome_sets.");
  if (database.escapedRoot) throw httpError(400, `Database path escapes genome root: ${database.file}`);
  if (!database.exists) throw httpError(404, `FASTA file is missing: ${database.file}`);
  return database;
}

async function resolveTargetSelection(targetId) {
  const databases = await readDatabases();
  const groups = buildTargetGroups(databases);
  const group = groups.find((item) => item.id === targetId);
  if (group) {
    const members = group.memberIds
      .map((id) => databases.find((database) => database.id === id))
      .filter(Boolean);
    if (!members.length) throw httpError(404, "Target group has no searchable FASTA files.");
    return {
      isGroup: true,
      group,
      targets: members
    };
  }

  const database = databases.find((item) => item.id === targetId || item.file === targetId);
  if (!database) throw httpError(404, "Target database was not found.");
  if (database.escapedRoot) throw httpError(400, `Database path escapes genome root: ${database.file}`);
  if (!database.exists) throw httpError(404, `FASTA file is missing: ${database.file}`);
  return {
    isGroup: false,
    group: null,
    targets: [database]
  };
}

async function ensureWorkDirs() {
  await Promise.all([
    fsp.mkdir(FASTA_CACHE_DIR, { recursive: true }),
    fsp.mkdir(DB_DIR, { recursive: true }),
    fsp.mkdir(QUERY_DIR, { recursive: true }),
    fsp.mkdir(ANNOTATION_INDEX_DIR, { recursive: true })
  ]);
}

async function ensurePreparedFasta(database) {
  await fsp.mkdir(FASTA_CACHE_DIR, { recursive: true });
  const sourceStat = await fsp.stat(database.path);
  const cacheStamp = `${sourceStat.size}-${Math.trunc(sourceStat.mtimeMs)}`;
  const stagedName = database.compressed ? database.fileName.replace(/\.gz$/i, "") : database.fileName;
  const cached = path.join(FASTA_CACHE_DIR, `${database.id}-${cacheStamp}-${safeName(stagedName)}`);
  const metaPath = `${cached}.json`;
  const metadata = {
    sourceFile: database.file,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs
  };

  await cleanupStaleFastaTemps(database.id);

  try {
    const [cacheStat, meta] = await Promise.all([
      fsp.stat(cached),
      fsp.readFile(metaPath, "utf8").then(JSON.parse)
    ]);
    if (
      cacheStat.isFile() &&
      meta.sourceFile === metadata.sourceFile &&
      meta.sourceSize === metadata.sourceSize &&
      meta.sourceMtimeMs === metadata.sourceMtimeMs
    ) {
      return cached;
    }
  } catch {
    try {
      const cacheStat = await fsp.stat(cached);
      if (cacheStat.isFile() && cacheStat.size > 0) {
        await fsp.writeFile(metaPath, JSON.stringify({ ...metadata, cachedAt: new Date().toISOString() }, null, 2));
        return cached;
      }
    } catch {
      // Cache miss; rebuild below.
    }
  }

  const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (database.compressed) {
      await pipeline(
        fs.createReadStream(database.path),
        zlib.createGunzip(),
        fs.createWriteStream(tmp)
      );
    } else {
      await fsp.copyFile(database.path, tmp);
    }
    await replaceGeneratedFile(tmp, cached);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  await fsp.writeFile(
    metaPath,
    JSON.stringify({
      ...metadata,
      cachedAt: new Date().toISOString()
    }, null, 2)
  );

  return cached;
}

async function cleanupStaleFastaTemps(databaseId) {
  let files = [];
  try {
    files = await fsp.readdir(FASTA_CACHE_DIR);
  } catch {
    return;
  }

  await Promise.all(
    files
      .filter((file) => file.startsWith(`${databaseId}-`) && file.endsWith(".tmp"))
      .map((file) => removeBestEffort(path.join(FASTA_CACHE_DIR, file)))
  );
}

async function replaceGeneratedFile(tmp, finalPath) {
  await removeBestEffort(finalPath);

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(tmp, finalPath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) break;
      await sleep(150 * (attempt + 1));
    }
  }

  try {
    await fsp.copyFile(tmp, finalPath);
    await removeBestEffort(tmp);
  } catch (copyError) {
    throw lastError || copyError;
  }
}

async function removeBestEffort(targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rm(targetPath, { force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) return;
      await sleep(150 * (attempt + 1));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function commandAvailable(name) {
  try {
    const command = toolPath(name);
    const { stdout, stderr } = await execFileAsync(command, ["-version"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return {
      name,
      command,
      available: true,
      version: String(stdout || stderr).split(/\r?\n/).find(Boolean) || "available"
    };
  } catch (error) {
    return {
      name,
      command: toolPath(name),
      available: false,
      error: error.code === "ENOENT" ? "not found" : error.message
    };
  }
}

async function ensureBlastDatabase(database) {
  await ensureWorkDirs();

  if (dbBuilds.has(database.id)) {
    return dbBuilds.get(database.id);
  }

  const build = (async () => {
    const fastaPath = await ensurePreparedFasta(database);
    const sourceStat = await fsp.stat(database.path);
    const databaseDir = path.join(DB_DIR, database.id);
    const dbPrefix = path.join(databaseDir, "blastdb");
    const markerPath = path.join(databaseDir, "manifest.json");
    await fsp.mkdir(databaseDir, { recursive: true });

    try {
      const [markerRaw, files] = await Promise.all([
        fsp.readFile(markerPath, "utf8"),
        fsp.readdir(databaseDir)
      ]);
      const marker = JSON.parse(markerRaw);
      const hasBlastFiles = files.some((file) => file.startsWith("blastdb.") || file === "blastdb");
      if (
        marker.sourceFile === database.file &&
        marker.sourceSize === sourceStat.size &&
        marker.sourceMtimeMs === sourceStat.mtimeMs &&
        marker.type === database.type &&
        hasBlastFiles
      ) {
        return { dbPrefix, reused: true, parseSeqids: marker.parseSeqids !== false };
      }
    } catch {
      // Missing or stale database; build below.
    }

    const title = database.name || database.fileName;
    const baseArgs = ["-in", fastaPath, "-dbtype", database.type, "-out", dbPrefix, "-title", title];
    let parseSeqids = true;
    try {
      await runTool("makeblastdb", [...baseArgs, "-parse_seqids"], 0, 20 * 1024 * 1024);
    } catch (error) {
      if (error.status === 503) throw error;
      parseSeqids = false;
      await runTool("makeblastdb", baseArgs, 0, 20 * 1024 * 1024);
    }

    await fsp.writeFile(
      markerPath,
      JSON.stringify({
        sourceFile: database.file,
        sourceSize: sourceStat.size,
        sourceMtimeMs: sourceStat.mtimeMs,
        type: database.type,
        title,
        parseSeqids,
        builtAt: new Date().toISOString()
      }, null, 2)
    );

    return { dbPrefix, reused: false, parseSeqids };
  })();

  dbBuilds.set(database.id, build);
  try {
    return await build;
  } finally {
    dbBuilds.delete(database.id);
  }
}

async function runTool(name, args, timeout = BLAST_TIMEOUT_MS, maxBuffer = 50 * 1024 * 1024) {
  const command = toolPath(name);
  try {
    return await execFileAsync(command, args, {
      cwd: ROOT,
      timeout,
      maxBuffer,
      windowsHide: true
    });
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim();
    if (error.code === "ENOENT" || (error.code === "EPERM" && /spawn EPERM/i.test(error.message || ""))) {
      throw httpError(503, `${name} was not found or is not executable. Install NCBI BLAST+ or set BLAST_BIN_DIR.`, detail);
    }
    if (error.killed && error.signal === "SIGTERM") {
      throw httpError(504, `${name} timed out after ${timeout} ms.`, detail);
    }
    throw httpError(500, `${name} failed.`, detail);
  }
}

function normalizeRawSequence(text) {
  const value = String(text || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!value) throw httpError(400, "Query sequence is empty.");
  if (value.startsWith(">")) {
    const lines = value.split(/\r?\n/);
    const cleaned = [];
    let sequenceLength = 0;
    for (const line of lines) {
      if (line.startsWith(">")) {
        cleaned.push(line.trim() || ">query");
      } else {
        const sequence = line.replace(/[^A-Za-z*]/g, "").toUpperCase();
        if (sequence) {
          cleaned.push(sequence);
          sequenceLength += sequence.length;
        }
      }
    }
    if (sequenceLength < 4) throw httpError(400, "Query sequence is too short.");
    return `${cleaned.join("\n")}\n`;
  }

  const sequence = value.replace(/[^A-Za-z*]/g, "").toUpperCase();
  if (sequence.length < 4) throw httpError(400, "Query sequence is too short.");
  return `>query\n${sequence.match(/.{1,80}/g).join("\n")}\n`;
}

function inferQueryTypeFromFasta(fasta) {
  const sequence = fasta
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(">"))
    .join("")
    .replace(/[^A-Za-z*]/g, "")
    .toUpperCase();

  if (!sequence) return "nucl";
  const nucleotideChars = sequence.replace(/[ACGTUN]/g, "").length;
  const nucleotideRatio = (sequence.length - nucleotideChars) / sequence.length;
  return nucleotideRatio >= 0.85 ? "nucl" : "prot";
}

async function findFastaRecord(database, queryId) {
  const record = await findFastaRecordDetailed(database, queryId);
  return `>${record.header}\n${wrapSequence(record.sequence)}\n`;
}

async function findFastaRecordDetailed(database, queryId) {
  const fastaPath = await ensurePreparedFasta(database);
  const wanted = String(queryId || "").trim().replace(/^>/, "").split(/\s+/)[0];
  if (!wanted) throw httpError(400, "Sequence ID is empty.");

  const wantedLower = wanted.toLowerCase();
  const stream = fs.createReadStream(fastaPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let collecting = false;
  let header = "";
  const sequenceLines = [];

  for await (const line of lines) {
    if (line.startsWith(">")) {
      if (collecting) break;
      const currentHeader = line.slice(1).trim();
      if (headerMatches(currentHeader, wanted, wantedLower)) {
        collecting = true;
        header = currentHeader;
      }
      continue;
    }

    if (collecting) {
      sequenceLines.push(line.trim());
    }
  }

  if (!collecting || sequenceLines.length === 0) {
    throw httpError(404, `Could not find sequence ID "${wanted}" in ${database.name}.`);
  }

  const sequence = sequenceLines.join("").replace(/\s/g, "").toUpperCase();
  return {
    id: wanted,
    header,
    title: header.replace(/^\S+\s*/, "").trim(),
    sequence,
    length: sequence.length
  };
}

function headerMatches(header, wanted, wantedLower) {
  const token = header.split(/\s+/)[0] || "";
  const tokenNoVersion = token.replace(/\.\d+$/, "");
  return (
    token === wanted ||
    tokenNoVersion === wanted ||
    token.toLowerCase() === wantedLower ||
    tokenNoVersion.toLowerCase() === wantedLower ||
    header.toLowerCase().includes(wantedLower)
  );
}

function wrapSequence(sequence, width = 80) {
  const text = String(sequence || "");
  if (!text) return "";
  return text.match(new RegExp(`.{1,${width}}`, "g")).join("\n");
}

function isAutoSourceId(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text || text === "auto" || text === AUTO_SOURCE_ID.toLowerCase();
}

async function findFastaRecordAuto(queryId, preferredType) {
  const wanted = String(queryId || "").trim().replace(/^>/, "").split(/\s+/)[0];
  if (!wanted) throw httpError(400, "Sequence ID is empty.");

  const databases = await readDatabases();
  const candidates = databases
    .filter((database) => database.exists && !database.escapedRoot)
    .sort((a, b) => sourceSearchPriority(a, preferredType) - sourceSearchPriority(b, preferredType)
      || `${a.annotationName}\t${a.category}\t${a.file}`.localeCompare(`${b.annotationName}\t${b.category}\t${b.file}`));

  for (const database of candidates) {
    try {
      const record = await findFastaRecordDetailed(database, wanted);
      return {
        database,
        record,
        fasta: `>${record.header}\n${wrapSequence(record.sequence)}\n`
      };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  throw httpError(404, `Could not find sequence ID "${wanted}" in any local FASTA file.`);
}

function sourceSearchPriority(database, preferredType) {
  let score = database.type === preferredType ? 0 : 1000;
  const category = String(database.category || "").toLowerCase();

  if (database.type === "prot") {
    if (/proteome|protein/.test(category)) score -= 60;
  } else {
    if (/cds/.test(category)) score -= 70;
    else if (/transcript|rna|cdna/.test(category)) score -= 60;
    else if (/exon|utr/.test(category)) score -= 35;
    else if (/genome/.test(category)) score -= 15;
    else if (/upstream|downstream|intergenic|intron/.test(category)) score += 20;
  }

  if (/tair10_blastsets/i.test(database.annotationName || "")) score -= 8;
  if (/representative/i.test(database.file || "")) score -= 4;
  return score;
}

function chooseProgram(queryType, targetType, requested) {
  if (requested && requested !== "auto") return requested;
  if (queryType === "nucl" && targetType === "nucl") return "blastn";
  if (queryType === "prot" && targetType === "prot") return "blastp";
  if (queryType === "prot" && targetType === "nucl") return "tblastn";
  if (queryType === "nucl" && targetType === "prot") return "blastx";
  return "blastn";
}

function normalizeEvalueSetting(value) {
  const text = String(value || "auto").trim();
  if (!text || /^auto$/i.test(text)) {
    return { auto: true, value: "" };
  }

  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    throw httpError(400, "E-value must be auto or a positive number, for example 1e-5.");
  }
  return { auto: false, value: text };
}

function chooseEvalue({ setting, program, queryType, targetType, queryLength }) {
  if (setting && !setting.auto) return setting.value;
  if (program === "blastn" && queryType === "nucl" && targetType === "nucl" && queryLength > 0 && queryLength <= 50) {
    return SHORT_NUCL_EVALUE;
  }
  return DEFAULT_EVALUE;
}

function fastaSequenceLength(fasta) {
  return String(fasta || "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(">"))
    .join("")
    .replace(/\s/g, "")
    .length;
}

async function writeQueryFile(fasta) {
  await fsp.mkdir(QUERY_DIR, { recursive: true });
  const token = crypto.randomBytes(8).toString("hex");
  const file = path.join(QUERY_DIR, `query-${Date.now()}-${token}.fasta`);
  await fsp.writeFile(file, fasta);
  return file;
}

function parseBlastRows(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed) return [];
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => {
    const values = line.split("\t");
    const row = {};
    OUT_FIELDS.forEach((field, index) => {
      row[field] = values[index] || "";
    });
    return row;
  });
}

async function runBlastJob(payload) {
  const selection = await resolveTargetSelection(payload.targetId);
  const selectedTargetType = selection.isGroup ? selection.group.type : selection.targets[0].type;

  let queryFasta;
  let source = null;
  let queryType = normalizeDbType(payload.queryType);

  if (payload.queryMode === "id") {
    if (isAutoSourceId(payload.sourceId)) {
      const match = await findFastaRecordAuto(payload.queryText, selectedTargetType);
      source = match.database;
      queryFasta = match.fasta;
    } else {
      source = await findDatabase(payload.sourceId || selection.targets[0].id);
      queryFasta = await findFastaRecord(source, payload.queryText);
    }
    queryType = source.type;
  } else {
    queryFasta = normalizeRawSequence(payload.queryText);
    queryType = payload.queryType === "prot" || payload.queryType === "nucl"
      ? normalizeDbType(payload.queryType)
      : inferQueryTypeFromFasta(queryFasta);
  }

  const maxTargets = clampInt(payload.maxTargets, 1, 500, 25);
  const evalueSetting = normalizeEvalueSetting(payload.evalue);
  const queryFile = await writeQueryFile(queryFasta);
  const queryLength = fastaSequenceLength(queryFasta);

  try {
    const startedAt = Date.now();
    const allRows = [];
    const programs = new Set();
    const evalues = new Set();
    const reuseStates = [];
    const parseSeqidStates = [];
    const shortQueryStates = [];
    let stderr = "";

    for (const target of selection.targets) {
      const single = await runBlastAgainstTarget({
        target,
        queryFile,
        queryType,
        requestedProgram: payload.program || "auto",
        maxTargets,
        evalueSetting,
        queryLength,
        includeDatabaseColumns: selection.isGroup
      });
      programs.add(single.program);
      evalues.add(single.evalue);
      reuseStates.push(single.databaseReused);
      parseSeqidStates.push(single.parseSeqids);
      shortQueryStates.push(single.shortQuerySettings);
      if (single.stderr) stderr += single.stderr;
      allRows.push(...single.rows);
    }

    allRows.sort(compareBlastRows);
    const rows = allRows.slice(0, maxTargets);
    const elapsedMs = Date.now() - startedAt;
    const fields = selection.isGroup ? ["database", "database_file", ...OUT_FIELDS] : OUT_FIELDS;
    return {
      program: [...programs].join(", "),
      queryType,
      targetType: selection.isGroup ? selection.group.type : selection.targets[0].type,
      target: selection.isGroup ? publicTargetGroup(selection.group) : publicDatabase(selection.targets[0]),
      source: source ? publicDatabase(source) : null,
      rows,
      rowCount: rows.length,
      fields,
      evalue: [...evalues].join(", "),
      evalueWasAuto: evalueSetting.auto,
      shortQuerySettings: shortQueryStates.some(Boolean),
      elapsedMs,
      databaseReused: reuseStates.every(Boolean),
      parseSeqids: parseSeqidStates.every(Boolean),
      targetsSearched: selection.targets.length,
      stderr
    };
  } finally {
    fsp.unlink(queryFile).catch(() => {});
  }
}

async function runBlastAgainstTarget({ target, queryFile, queryType, requestedProgram, maxTargets, evalueSetting, queryLength, includeDatabaseColumns }) {
  const { dbPrefix, reused, parseSeqids } = await ensureBlastDatabase(target);
  const program = chooseProgram(queryType, target.type, requestedProgram);
  const allowedPrograms = new Set(["blastn", "blastp", "blastx", "tblastn"]);
  if (!allowedPrograms.has(program)) throw httpError(400, `Unsupported BLAST program: ${program}`);

  const evalue = chooseEvalue({ setting: evalueSetting, program, queryType, targetType: target.type, queryLength });
  const args = [
    "-query", queryFile,
    "-db", dbPrefix,
    "-evalue", evalue,
    "-max_target_seqs", String(maxTargets),
    "-num_threads", String(Math.max(1, BLAST_THREADS)),
    "-outfmt", `6 ${OUT_FIELDS.join(" ")}`
  ];

  let shortQuerySettings = false;
  if (program === "blastn" && queryType === "nucl" && queryLength > 0 && queryLength <= 50) {
    args.push("-task", "blastn-short");
    args.push("-dust", "no");
    shortQuerySettings = true;
  }

  const result = await runTool(program, args, BLAST_TIMEOUT_MS, 100 * 1024 * 1024);
  const rows = parseBlastRows(result.stdout);
  rows.forEach((row) => {
    row.database_id = target.id;
  });
  if (includeDatabaseColumns) {
    rows.forEach((row) => {
      row.database = target.name;
      row.database_file = target.file;
    });
  }
  return {
    program,
    evalue,
    rows,
    databaseReused: reused,
    parseSeqids,
    shortQuerySettings,
    stderr: result.stderr || ""
  };
}

function compareBlastRows(a, b) {
  const eA = Number(a.evalue);
  const eB = Number(b.evalue);
  const safeEA = Number.isFinite(eA) ? eA : Number.POSITIVE_INFINITY;
  const safeEB = Number.isFinite(eB) ? eB : Number.POSITIVE_INFINITY;
  if (safeEA !== safeEB) return safeEA - safeEB;

  const bitA = Number(a.bitscore);
  const bitB = Number(b.bitscore);
  const safeBitA = Number.isFinite(bitA) ? bitA : 0;
  const safeBitB = Number.isFinite(bitB) ? bitB : 0;
  return safeBitB - safeBitA;
}

async function getHitDetail(payload) {
  const databaseId = payload.databaseId || payload.database_id;
  const subjectId = String(payload.subjectId || payload.sseqid || "").trim();
  if (!databaseId) throw httpError(400, "Hit detail request is missing a database ID.");
  if (!subjectId) throw httpError(400, "Hit detail request is missing a subject ID.");

  const database = await findDatabase(databaseId);
  const record = await findFastaRecordDetailed(database, subjectId);
  const sstart = parseCoordinate(payload.sstart || payload.start);
  const send = parseCoordinate(payload.send || payload.end);
  const sequenceWindow = buildSequenceWindow(record, {
    sstart,
    send,
    type: database.type,
    flank: clampInt(payload.flank, 0, 5000, HIT_DETAIL_FLANK)
  });
  const headerAnnotations = headerAnnotationForRecord(database, record);
  const teDescriptionAnnotations = await findTeDescriptionAnnotations(database, record, subjectId);
  const gffAnnotations = shouldScanCoordinateAnnotations(database, record, subjectId)
    ? await findHitAnnotations(database, {
      subjectId,
      header: record.header,
      start: sequenceWindow.hit.from,
      end: sequenceWindow.hit.to
    }, { allowAttributeMatch: false })
    : [];

  return {
    database: publicDatabase(database),
    subjectId,
    header: record.header,
    title: record.title,
    length: record.length,
    hit: sequenceWindow.hit,
    sequence: sequenceWindow.sequence,
    orientedHitSequence: sequenceWindow.orientedHitSequence,
    annotations: [...headerAnnotations, ...teDescriptionAnnotations, ...gffAnnotations].slice(0, ANNOTATION_LIMIT),
    annotationFiles: database.annotationFiles || []
  };
}

function parseCoordinate(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildSequenceWindow(record, { sstart, send, type, flank }) {
  const fullLength = record.sequence.length;
  const hasCoordinates = Number.isFinite(sstart) && Number.isFinite(send);
  const rawFrom = hasCoordinates ? Math.min(sstart, send) : 1;
  const rawTo = hasCoordinates ? Math.max(sstart, send) : Math.min(fullLength, HIT_SEQUENCE_LIMIT);
  const hitFrom = Math.max(1, Math.min(rawFrom, fullLength || 1));
  const hitTo = Math.max(hitFrom, Math.min(rawTo, fullLength || hitFrom));
  const strand = hasCoordinates && sstart > send ? "-" : "+";

  let rangeStart = 1;
  let rangeEnd = Math.min(fullLength, HIT_SEQUENCE_LIMIT);
  let label = `${record.header.split(/\s+/)[0] || "subject"}:1-${rangeEnd}`;
  let truncated = fullLength > HIT_SEQUENCE_LIMIT;

  if (hasCoordinates) {
    rangeStart = Math.max(1, hitFrom - flank);
    rangeEnd = Math.min(fullLength, hitTo + flank);
    label = `${record.header.split(/\s+/)[0] || "subject"}:${rangeStart}-${rangeEnd}`;
    truncated = rangeStart > 1 || rangeEnd < fullLength;
  }

  const shown = record.sequence.slice(rangeStart - 1, rangeEnd);
  const hitSequence = record.sequence.slice(hitFrom - 1, hitTo);
  const orientedHitSequence = type === "nucl" && strand === "-" ? reverseComplement(hitSequence) : hitSequence;

  return {
    hit: {
      from: hitFrom,
      to: hitTo,
      strand,
      length: hitTo - hitFrom + 1,
      originalStart: sstart,
      originalEnd: send
    },
    sequence: {
      label,
      rangeStart,
      rangeEnd,
      shownLength: shown.length,
      fullLength,
      truncated,
      fasta: `>${label} ${truncated ? "(context window)" : "(full record)"}\n${wrapSequence(shown)}\n`
    },
    orientedHitSequence: {
      label: `${record.header.split(/\s+/)[0] || "subject"}:${hitFrom}-${hitTo}${strand === "-" ? " reverse-complement" : ""}`,
      fasta: `>${record.header.split(/\s+/)[0] || "subject"}:${hitFrom}-${hitTo}${strand === "-" ? " reverse-complement" : ""}\n${wrapSequence(orientedHitSequence)}\n`
    }
  };
}

function reverseComplement(sequence) {
  const complements = {
    A: "T", C: "G", G: "C", T: "A", U: "A", R: "Y", Y: "R", S: "S", W: "W",
    K: "M", M: "K", B: "V", D: "H", H: "D", V: "B", N: "N"
  };
  return String(sequence || "")
    .toUpperCase()
    .split("")
    .reverse()
    .map((base) => complements[base] || base)
    .join("");
}

function shouldScanCoordinateAnnotations(database, record, subjectId) {
  const category = String(database.category || "").toLowerCase();
  if (/genome|chromosome|bac/.test(category)) return true;
  return record.length > 50000 && idVariants(subjectId).some((value) => /^[a-z]{1,3}_\d+(?:\.\d+)?$/i.test(value));
}

function headerAnnotationForRecord(database, record) {
  const attrs = parseFastaHeaderAttributes(record.header);
  const token = record.header.split(/\s+/)[0] || record.id || "";
  const product = attrs.product || attrs.protein || attrs.description || record.title || "";
  const gene = attrs.gene || attrs.gene_name || attrs.locus_tag || attrs.symbols || "";
  if (!product && !gene && !record.title) return [];

  return [{
    sourceFile: database.file,
    seqid: token,
    source: "FASTA",
    feature: "FASTA header",
    start: 1,
    end: record.length,
    strand: attrs.strand || "",
    phase: "",
    id: attrs.protein_id || attrs.transcript_id || token,
    name: attrs.name || gene,
    gene,
    product: truncateText(product, 420),
    note: truncateText(record.title, 420),
    parent: "",
    match: "header"
  }];
}

function parseFastaHeaderAttributes(header) {
  const attrs = {};
  const text = String(header || "");
  const bracketPattern = /\[([^\]=]+)=([^\]]*)\]/g;
  let match;
  while ((match = bracketPattern.exec(text)) !== null) {
    attrs[match[1].trim()] = match[2].trim();
  }

  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (/^AT[1-5MC]TE\d+/i.test(parts[0] || "") && parts.length >= 7) {
    attrs.name = parts[0];
    attrs.strand = parts[1] === "-" ? "-" : "+";
    attrs.start = parts[2];
    attrs.end = parts[3];
    attrs.te_family = parts[4];
    attrs.te_super_family = parts[5];
    attrs.description = `Transposable element ${parts[0]} ${parts[4]} ${parts[5]}`.trim();
    return attrs;
  }

  if (parts.length >= 3) {
    const symbols = parts.find((part) => /^Symbols:/i.test(part));
    if (symbols) attrs.symbols = symbols.replace(/^Symbols:\s*/i, "").trim();
    const description = parts.find((part, index) => index > 0 && !/^Symbols:/i.test(part) && !/^(chr|chromosome|[A-Z]{1,3}_\d+)/i.test(part) && !/LENGTH=/i.test(part));
    if (description) attrs.description = description;
    const coordinate = parts.find((part) => /(FORWARD|REVERSE)/i.test(part));
    if (coordinate) attrs.strand = /REVERSE/i.test(coordinate) ? "-" : "+";
  }
  return attrs;
}

async function findTeDescriptionAnnotations(database, record, subjectId) {
  const files = Array.isArray(database.annotationFiles) ? database.annotationFiles : [];
  const teFiles = files.filter((file) => /TE description/i.test(file.type || "") || /transposable|transposon/i.test(file.file || file.name || ""));
  if (!teFiles.length) return [];

  const aliases = idVariants(`${subjectId} ${record.header}`)
    .filter((value) => /^at[1-5mc]te\d+$/i.test(value));
  if (!aliases.length) return [];

  for (const file of teFiles) {
    const resolved = resolveAnnotationPath(database, file);
    if (!resolved) continue;
    const match = await findTeDescriptionRow(resolved, aliases);
    if (!match) continue;
    return [{
      sourceFile: file.file || file.name || path.basename(resolved),
      seqid: match.Transposon_Name || aliases[0],
      source: "TAIR10 TE description",
      feature: "transposable_element",
      start: match.Transposon_min_Start || "",
      end: match.Transposon_max_End || "",
      strand: parseBooleanText(match.orientation_is_5prime) ? "+" : "-",
      phase: "",
      id: match.Transposon_Name || aliases[0],
      name: match.Transposon_Family || "",
      gene: "",
      product: [match.Transposon_Family, match.Transposon_Super_Family].filter(Boolean).join(" / "),
      note: `Orientation is 5prime: ${match.orientation_is_5prime || "NA"}`,
      parent: "",
      match: "TE description"
    }];
  }

  return [];
}

async function findTeDescriptionRow(filePath, aliases) {
  let stream = fs.createReadStream(filePath);
  if (/\.gz$/i.test(filePath)) stream = stream.pipe(zlib.createGunzip());
  stream.setEncoding("utf8");

  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const values = line.split(/\t/);
    if (!headers) {
      headers = values.map((value) => value.trim());
      continue;
    }

    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || "").trim();
    });
    const name = String(row.Transposon_Name || "").toLowerCase();
    if (aliases.includes(name)) {
      lines.close();
      return row;
    }
  }
  return null;
}

function parseBooleanText(value) {
  return /^(true|1|yes)$/i.test(String(value || "").trim());
}

async function findHitAnnotations(database, hit, options = {}) {
  const files = annotationFileCandidates(database).slice(0, 8);
  if (!files.length) return [];

  const subjectAliases = idVariants(`${hit.subjectId} ${hit.header}`).filter((value) => value.length >= 2);
  const annotations = [];
  for (const annotation of files) {
    const resolved = resolveAnnotationPath(database, annotation);
    if (!resolved) continue;
    const matches = options.allowAttributeMatch === false
      ? await lookupIndexedAnnotations(resolved, annotation, subjectAliases, hit.start, hit.end)
      : await scanAnnotationFile(resolved, annotation, subjectAliases, hit.start, hit.end, options);
    annotations.push(...matches);
    if (annotations.length >= ANNOTATION_LIMIT) break;
  }

  return annotations.slice(0, ANNOTATION_LIMIT);
}

function annotationFileCandidates(database) {
  const files = Array.isArray(database.annotationFiles) ? database.annotationFiles : [];
  return files
    .filter((file) => /^(GFF|GTF)$/i.test(file.type || "") || /\.(gff|gff3|gtf)(\.gz)?$/i.test(file.file || file.name || ""))
    .sort((a, b) => annotationPriority(a, database) - annotationPriority(b, database));
}

function annotationPriority(file, database) {
  const text = `${file.file || ""} ${file.type || ""}`.toLowerCase();
  const filePath = String(file.file || file.name || "").replace(/\\/g, "/").toLowerCase();
  const dbDir = path.dirname(String(database.file || "").replace(/\\/g, "/")).toLowerCase();
  let score = 0;
  if (dbDir && filePath.startsWith(`${dbDir}/`)) score -= 100;
  if (database.accession && filePath.includes(String(database.accession).toLowerCase())) score -= 50;
  if (/\.gff3?$/.test(text) || /\bgff\b/.test(text)) score += 0;
  else if (/\.gtf/.test(text)) score += 10;
  else score += 20;
  return score;
}

function resolveAnnotationPath(database, annotation) {
  const rootDir = database.root === "genomes" ? LEGACY_GENOMES_DIR : GENOME_ROOT;
  const relative = annotation.file || annotation.name;
  if (!relative) return "";
  const resolved = path.resolve(rootDir, relative);
  const rootRelative = path.relative(rootDir, resolved);
  if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) return "";
  return resolved;
}

async function lookupIndexedAnnotations(filePath, annotation, subjectAliases, hitStart, hitEnd) {
  if (!Number.isFinite(hitStart) || !Number.isFinite(hitEnd)) return [];
  const index = await ensureAnnotationIndex(filePath, annotation);
  const seqidEntry = findIndexedSeqid(index.manifest, subjectAliases);
  if (!seqidEntry) return [];

  const fromBin = Math.floor(Math.min(hitStart, hitEnd) / ANNOTATION_BIN_SIZE);
  const toBin = Math.floor(Math.max(hitStart, hitEnd) / ANNOTATION_BIN_SIZE);
  const annotations = [];
  const seen = new Set();

  for (let bin = fromBin; bin <= toBin; bin += 1) {
    const fileName = seqidEntry.bins[String(bin)];
    if (!fileName) continue;
    const binPath = path.join(index.dir, fileName);
    let raw = "";
    try {
      raw = await fsp.readFile(binPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      const item = JSON.parse(line);
      if (!rangesOverlap(item.start, item.end, hitStart, hitEnd)) continue;
      const key = `${item.seqid}\t${item.feature}\t${item.start}\t${item.end}\t${item.id}\t${item.parent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      annotations.push(item);
      if (annotations.length >= ANNOTATION_LIMIT) break;
    }
    if (annotations.length >= ANNOTATION_LIMIT) break;
  }

  return annotations
    .sort((a, b) => annotationFeatureRank(a.feature) - annotationFeatureRank(b.feature) || a.start - b.start || a.end - b.end)
    .slice(0, ANNOTATION_LIMIT);
}

function findIndexedSeqid(manifest, subjectAliases) {
  const seqids = manifest.seqids || {};
  for (const [seqid, entry] of Object.entries(seqids)) {
    if (identifiersOverlap(seqid, subjectAliases)) return entry;
  }
  return null;
}

async function ensureAnnotationIndex(filePath, annotation) {
  await fsp.mkdir(ANNOTATION_INDEX_DIR, { recursive: true });
  const sourceStat = await fsp.stat(filePath);
  const indexId = stableId(filePath);
  const indexDir = path.join(ANNOTATION_INDEX_DIR, indexId);
  const manifestPath = path.join(indexDir, "manifest.json");
  const expected = {
    version: ANNOTATION_INDEX_VERSION,
    binSize: ANNOTATION_BIN_SIZE,
    sourceFile: filePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs
  };

  try {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    if (
      manifest.version === expected.version &&
      manifest.binSize === expected.binSize &&
      manifest.sourceFile === expected.sourceFile &&
      manifest.sourceSize === expected.sourceSize &&
      manifest.sourceMtimeMs === expected.sourceMtimeMs
    ) {
      return { dir: indexDir, manifest };
    }
  } catch {
    // Missing or stale annotation index; rebuild below.
  }

  if (annotationIndexBuilds.has(indexId)) {
    return annotationIndexBuilds.get(indexId);
  }

  const build = buildAnnotationIndex({ filePath, annotation, indexId, indexDir, expected });
  annotationIndexBuilds.set(indexId, build);
  try {
    return await build;
  } finally {
    annotationIndexBuilds.delete(indexId);
  }
}

async function buildAnnotationIndex({ filePath, annotation, indexId, indexDir, expected }) {
  const tmpDir = path.join(ANNOTATION_INDEX_DIR, `${indexId}.${process.pid}.${Date.now()}.tmp`);
  const manifest = {
    ...expected,
    annotationFile: annotation.file || annotation.name || path.basename(filePath),
    builtAt: new Date().toISOString(),
    seqids: {}
  };
  const buffers = new Map();
  let bufferedLines = 0;

  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    let stream = fs.createReadStream(filePath);
    if (/\.gz$/i.test(filePath)) stream = stream.pipe(zlib.createGunzip());
    stream.setEncoding("utf8");
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      const feature = parseIndexedAnnotationLine(line, annotation);
      if (!feature) continue;
      const fromBin = Math.floor(feature.start / ANNOTATION_BIN_SIZE);
      const toBin = Math.floor(feature.end / ANNOTATION_BIN_SIZE);
      const seqid = feature.seqid;
      if (!manifest.seqids[seqid]) {
        manifest.seqids[seqid] = { seqid, bins: {} };
      }

      for (let bin = fromBin; bin <= toBin; bin += 1) {
        const fileName = `${safeName(seqid)}-${bin}.jsonl`;
        manifest.seqids[seqid].bins[String(bin)] = fileName;
        if (!buffers.has(fileName)) buffers.set(fileName, []);
        buffers.get(fileName).push(`${JSON.stringify(feature)}\n`);
        bufferedLines += 1;
      }

      if (bufferedLines >= 10000) {
        await flushAnnotationIndexBuffers(tmpDir, buffers);
        bufferedLines = 0;
      }
    }

    await flushAnnotationIndexBuffers(tmpDir, buffers);
    await fsp.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await fsp.rm(indexDir, { recursive: true, force: true });
    await fsp.rename(tmpDir, indexDir);
    return { dir: indexDir, manifest };
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function flushAnnotationIndexBuffers(dir, buffers) {
  for (const [fileName, chunks] of buffers.entries()) {
    if (!chunks.length) continue;
    await fsp.appendFile(path.join(dir, fileName), chunks.join(""));
    chunks.length = 0;
  }
}

function parseIndexedAnnotationLine(line, annotation) {
  if (!line || line.startsWith("#")) return null;
  const fields = line.split("\t");
  if (fields.length < 9) return null;

  const feature = fields[2] || "";
  if (/^(chromosome|region)$/i.test(feature)) return null;

  const start = Number.parseInt(fields[3], 10);
  const end = Number.parseInt(fields[4], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const attributes = parseAnnotationAttributes(fields[8]);
  return {
    sourceFile: annotation.file || annotation.name || "",
    seqid: fields[0],
    source: fields[1],
    feature,
    start,
    end,
    strand: fields[6] || "",
    phase: fields[7] || "",
    id: firstAttribute(attributes, ["ID", "transcript_id", "protein_id", "locus_tag"]),
    name: firstAttribute(attributes, ["symbol", "Name", "gene_name", "gene", "locus_tag"]),
    gene: firstAttribute(attributes, ["symbol", "gene", "gene_name", "locus_tag"]),
    product: firstAttribute(attributes, ["product", "protein", "description", "full_name", "computational_description", "Note", "note"]),
    note: truncateText(firstAttribute(attributes, ["Note", "note", "curator_summary", "full_name", "computational_description"]), 420),
    parent: firstAttribute(attributes, ["Parent", "gene_id"]),
    match: "coordinate"
  };
}

function annotationFeatureRank(feature) {
  const value = String(feature || "").toLowerCase();
  if (value === "gene") return 0;
  if (value === "transposable_element" || value === "transposon") return 1;
  if (value === "mrna" || value === "transcript") return 2;
  if (value === "cds") return 3;
  if (value === "exon") return 4;
  if (/utr/.test(value)) return 5;
  return 10;
}

async function scanAnnotationFile(filePath, annotation, subjectAliases, hitStart, hitEnd, options = {}) {
  const allowAttributeMatch = options.allowAttributeMatch !== false;
  const annotations = [];
  let stream = fs.createReadStream(filePath);
  if (/\.gz$/i.test(filePath)) {
    stream = stream.pipe(zlib.createGunzip());
  }
  stream.setEncoding("utf8");

  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 9) continue;

    const seqid = fields[0];
    const feature = fields[2];
    const start = Number.parseInt(fields[3], 10);
    const end = Number.parseInt(fields[4], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const seqidMatch = identifiersOverlap(seqid, subjectAliases);
    if (seqidMatch && Number.isFinite(hitEnd) && start > hitEnd && !allowAttributeMatch) {
      lines.close();
      break;
    }

    const coordinateMatch = seqidMatch && rangesOverlap(start, end, hitStart, hitEnd);
    if (!coordinateMatch && !allowAttributeMatch) continue;

    const attributes = parseAnnotationAttributes(fields[8]);
    const attributeMatch = allowAttributeMatch && annotationAttributesMatch(attributes, subjectAliases);
    if (!coordinateMatch && !attributeMatch) continue;

    annotations.push({
      sourceFile: annotation.file || annotation.name || path.basename(filePath),
      seqid,
      source: fields[1],
      feature,
      start,
      end,
      strand: fields[6] || "",
      phase: fields[7] || "",
      id: firstAttribute(attributes, ["ID", "transcript_id", "protein_id", "locus_tag"]),
      name: firstAttribute(attributes, ["symbol", "Name", "gene_name", "gene", "locus_tag"]),
      gene: firstAttribute(attributes, ["symbol", "gene", "gene_name", "locus_tag"]),
      product: firstAttribute(attributes, ["product", "protein", "description", "full_name", "computational_description", "Note", "note"]),
      note: truncateText(firstAttribute(attributes, ["Note", "note", "curator_summary", "full_name", "computational_description"]), 420),
      parent: firstAttribute(attributes, ["Parent", "gene_id"]),
      match: coordinateMatch ? "coordinate" : "attribute"
    });

    if (annotations.length >= ANNOTATION_LIMIT) {
      lines.close();
      break;
    }
  }

  return annotations;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!Number.isFinite(bStart) || !Number.isFinite(bEnd)) return false;
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function parseAnnotationAttributes(text) {
  const attributes = {};
  const raw = String(text || "").trim();
  if (!raw) return attributes;

  if (raw.includes("=")) {
    for (const part of raw.split(";")) {
      const index = part.indexOf("=");
      if (index === -1) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) attributes[key] = decodeAttributeValue(value);
    }
    return attributes;
  }

  const gtfPattern = /(\S+)\s+"([^"]*)"/g;
  let match;
  while ((match = gtfPattern.exec(raw)) !== null) {
    attributes[match[1]] = decodeAttributeValue(match[2]);
  }
  return attributes;
}

function decodeAttributeValue(value) {
  const text = String(value || "").replace(/^"|"$/g, "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function firstAttribute(attributes, names) {
  for (const name of names) {
    if (attributes[name]) return truncateText(attributes[name], 180);
  }
  return "";
}

function annotationAttributesMatch(attributes, subjectAliases) {
  const values = [
    attributes.ID,
    attributes.Name,
    attributes.Parent,
    attributes.gene,
    attributes.gene_id,
    attributes.gene_name,
    attributes.locus_tag,
    attributes.transcript_id,
    attributes.protein_id,
    attributes.orig_protein_id,
    attributes.orig_transcript_id,
    attributes.Dbxref
  ].filter(Boolean);

  return values.some((value) => identifiersOverlap(value, subjectAliases));
}

function identifiersOverlap(value, aliases) {
  const variants = idVariants(value);
  return variants.some((variant) => aliases.includes(variant));
}

function idVariants(value) {
  const variants = new Set();
  const text = String(value || "").replace(/^>/, "").trim();
  if (!text) return [];

  const add = (candidate) => {
    const clean = String(candidate || "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/[,;]$/g, "");
    if (!clean) return;
    variants.add(clean.toLowerCase());
    variants.add(clean.replace(/\.\d+$/, "").toLowerCase());
  };

  add(text.split(/\s+/)[0]);
  for (const token of text.split(/[\s|,;:\[\]()]+/)) {
    add(token);
  }
  const tairMatch = text.match(/AT[1-5MC]G\d{5}(?:\.\d+)?/ig);
  if (tairMatch) tairMatch.forEach(add);
  const ncbiMatch = text.match(/[A-Z]{1,3}_\d+(?:\.\d+)?/g);
  if (ncbiMatch) ncbiMatch.forEach(add);
  return [...variants].filter(Boolean);
}

function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw httpError(413, "Request body is too large.");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Invalid JSON request body.");
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function httpError(status, message, detail = "") {
  const error = new Error(message);
  error.status = status;
  error.detail = detail;
  return error;
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  const relative = path.relative(PUBLIC_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(403, "Forbidden.");
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw httpError(404, "File not found.");
  }

  if (!stat.isFile()) throw httpError(404, "File not found.");

  const contentType = MIME_TYPES.get(path.extname(resolved).toLowerCase()) || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size
  });
  fs.createReadStream(resolved).pipe(response);
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/api/databases") {
    const databases = await readDatabases();
    const targetGroups = buildTargetGroups(databases).map(publicTargetGroup);
    sendJson(response, 200, { databases: databases.map(publicDatabase), targetGroups, csvPath: "genome_sets/genomes.csv" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    const tools = await Promise.all(["makeblastdb", "blastn", "blastp", "blastx", "tblastn"].map(commandAvailable));
    sendJson(response, 200, {
      ok: tools.every((tool) => tool.available),
      tools,
      blastBinDir: BLAST_BIN_DIR,
      workDir: WORK_DIR
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/blast") {
    const payload = await readJsonBody(request);
    const result = await runBlastJob(payload);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/hit-detail") {
    const payload = await readJsonBody(request);
    const result = await getHitDetail(payload);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(request, response, url.pathname);
    return;
  }

  throw httpError(405, "Method not allowed.");
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    const status = error.status || 500;
    sendJson(response, status, {
      error: error.message || "Internal server error.",
      detail: error.detail || ""
    });
  });
});

ensureWorkDirs()
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Local BLAST web app running at http://127.0.0.1:${PORT}`);
      if (BLAST_BIN_DIR) console.log(`Using BLAST_BIN_DIR=${BLAST_BIN_DIR}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

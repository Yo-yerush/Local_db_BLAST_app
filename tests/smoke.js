"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.TEST_PORT || "3297";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function main() {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT,
      BLAST_THREADS: process.env.BLAST_THREADS || "2"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(server);

    const status = await getJson("/api/status");
    assert(status.ok, `BLAST tools are not ready: ${JSON.stringify(status.tools, null, 2)}`);

    const dbData = await getJson("/api/databases");
    assert(dbData.databases.length >= 20, `Expected recursive genome discovery to find many FASTA files, found ${dbData.databases.length}.`);
    assert(dbData.targetGroups && dbData.targetGroups.length > 0, "Expected grouped targets to be returned.");
    assert(
      dbData.targetGroups.some((group) => group.scope === "all" && group.type === "nucl"),
      "Expected an all-genome nucleotide target group."
    );
    assert(
      dbData.targetGroups.every((group) => Array.isArray(group.memberIds) && group.memberIds.length === group.databaseCount),
      "Expected grouped targets to include memberIds for the expandable target picker."
    );
    const target = dbData.targetGroups.find((group) => group.annotationName === "TAIR10.1" && group.type === "nucl")
      || dbData.targetGroups.find((group) => group.type === "nucl");
    assert(target, "A nucleotide target group was not found.");
    assert(target.exists, "The nucleotide target group is listed but unavailable.");

    const result = await postJson("/api/blast", {
      targetId: target.id,
      queryMode: "sequence",
      queryText: "\"ATGGCCGTCTCATCATTCCA\"",
      program: "auto",
      queryType: "auto",
      evalue: "auto",
      maxTargets: 10
    });

    assert(result.program === "blastn", `Expected blastn, got ${result.program}.`);
    assert(result.evalue === "1000", `Expected short query auto e-value 1000, got ${result.evalue}.`);
    assert(result.shortQuerySettings, "Expected short-query BLAST settings to be applied.");
    assert(result.targetsSearched >= 2, `Expected a grouped search across multiple files, searched ${result.targetsSearched}.`);
    assert(result.rowCount > 0, "Expected at least one BLAST hit.");
    assert(result.rows[0].database_id, "Expected grouped hit rows to include a hidden database_id for details.");
    assert(result.rows[0].qseq && result.rows[0].sseq, "Expected BLAST rows to include aligned query and subject sequence strings.");
    assert(
      result.rows.some((row) => Number(row.length) >= 20 && Number(row.pident) >= 95),
      `Expected a high-confidence hit for the 20 bp test sequence, got ${JSON.stringify(result.rows, null, 2)}`
    );

    const detail = await postJson("/api/hit-detail", {
      databaseId: result.rows[0].database_id,
      subjectId: result.rows[0].sseqid,
      sstart: result.rows[0].sstart,
      send: result.rows[0].send
    });
    assert(detail.sequence && detail.sequence.fasta.includes(">"), "Expected hit detail to return FASTA sequence context.");
    assert(detail.database && detail.database.id === result.rows[0].database_id, "Expected hit detail to return the matching database metadata.");

    const idResult = await postJson("/api/blast", {
      targetId: target.id,
      sourceId: "__auto__",
      queryMode: "id",
      queryText: "AT1G01010.1",
      program: "auto",
      queryType: "auto",
      evalue: "auto",
      maxTargets: 5
    });
    assert(idResult.source, "Expected ID mode with auto source to resolve a local source database.");
    assert(idResult.rowCount > 0, "Expected ID mode with auto source to return BLAST hits.");

    console.log(`Smoke test passed: ${dbData.databases.length} databases discovered; ${result.rowCount} sequence hits and ${idResult.rowCount} ID hits from ${result.program} in ${result.elapsedMs} ms.`);
  } finally {
    server.kill();
  }

  if (stdout && process.env.VERBOSE_TESTS) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function waitForServer(server) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      if (server.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`Server exited early with code ${server.exitCode}.`));
        return;
      }

      try {
        const response = await fetch(`${BASE_URL}/api/databases`);
        if (response.ok) {
          clearInterval(timer);
          resolve();
          return;
        }
      } catch {
        // Server is still starting.
      }

      if (Date.now() - started > 15000) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for server to start."));
      }
    }, 250);
  });
}

async function getJson(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  return parseJson(response);
}

async function postJson(pathname, payload) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseJson(response);
}

async function parseJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${data.error || response.statusText}\n${data.detail || ""}`.trim());
  }
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

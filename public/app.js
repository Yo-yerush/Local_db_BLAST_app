"use strict";

const AUTO_SOURCE_ID = "__auto__";
const SPLIT_STORAGE_KEY = "localBlast.queryPanelWidth";
const MIN_QUERY_PANEL_WIDTH = 320;
const MIN_RESULTS_PANEL_WIDTH = 360;

const state = {
  databases: [],
  targets: [],
  fields: [],
  rows: [],
  lastResult: null,
  resultView: "compact",
  expandedResultGroups: new Set(),
  expandedTargetGroups: new Set(),
  selectedTargetId: "",
  targetFilters: {
    search: "",
    group: "",
    type: "",
    category: ""
  }
};

const elements = {
  workspace: document.querySelector("#workspace"),
  splitHandle: document.querySelector("#splitHandle"),
  statusBadge: document.querySelector("#statusBadge"),
  targetSelect: document.querySelector("#targetSelect"),
  targetSearch: document.querySelector("#targetSearch"),
  targetGroupFilter: document.querySelector("#targetGroupFilter"),
  targetTypeFilter: document.querySelector("#targetTypeFilter"),
  targetCategoryFilter: document.querySelector("#targetCategoryFilter"),
  targetList: document.querySelector("#targetList"),
  selectedTarget: document.querySelector("#selectedTarget"),
  targetCount: document.querySelector("#targetCount"),
  sourceSelect: document.querySelector("#sourceSelect"),
  sourceField: document.querySelector("#sourceField"),
  queryText: document.querySelector("#queryText"),
  queryLabel: document.querySelector("#queryLabel"),
  programSelect: document.querySelector("#programSelect"),
  queryTypeSelect: document.querySelector("#queryTypeSelect"),
  evalueInput: document.querySelector("#evalueInput"),
  maxTargetsInput: document.querySelector("#maxTargetsInput"),
  blastForm: document.querySelector("#blastForm"),
  runButton: document.querySelector("#runButton"),
  downloadButton: document.querySelector("#downloadButton"),
  reloadButton: document.querySelector("#reloadButton"),
  exampleButton: document.querySelector("#exampleButton"),
  message: document.querySelector("#message"),
  resultMeta: document.querySelector("#resultMeta"),
  resultViewSelect: document.querySelector("#resultViewSelect"),
  resultCount: document.querySelector("#resultCount"),
  blastLoading: document.querySelector("#blastLoading"),
  resultsTable: document.querySelector("#resultsTable"),
  hitDialog: document.querySelector("#hitDialog"),
  hitDialogClose: document.querySelector("#hitDialogClose"),
  hitDetails: document.querySelector("#hitDetails"),
  databaseMeta: document.querySelector("#databaseMeta"),
  databaseList: document.querySelector("#databaseList")
};

const labels = {
  database: "Database",
  database_file: "Database file",
  qseqid: "Query",
  sseqid: "Subject",
  pident: "% identity",
  length: "Length",
  mismatch: "Mismatch",
  gapopen: "Gaps",
  qstart: "Q start",
  qend: "Q end",
  sstart: "S start",
  send: "S end",
  subject_range: "Subject range",
  evalue: "E-value",
  bitscore: "Bit score",
  qseq: "Aligned query",
  sseq: "Aligned subject",
  stitle: "Subject title",
  details: ""
};

document.addEventListener("DOMContentLoaded", () => {
  elements.blastForm.addEventListener("submit", runBlast);
  elements.reloadButton.addEventListener("click", loadDatabases);
  elements.exampleButton.addEventListener("click", loadExample);
  elements.downloadButton.addEventListener("click", downloadTsv);
  elements.targetSearch.addEventListener("input", updateTargetFilters);
  elements.targetGroupFilter.addEventListener("change", updateTargetFilters);
  elements.targetTypeFilter.addEventListener("change", updateTargetFilters);
  elements.targetCategoryFilter.addEventListener("change", updateTargetFilters);
  elements.targetList.addEventListener("click", handleTargetListClick);
  elements.sourceSelect.addEventListener("change", handleSourceChange);
  elements.resultViewSelect.addEventListener("change", updateResultView);
  elements.resultsTable.addEventListener("click", handleResultsClick);
  elements.hitDialogClose.addEventListener("click", closeHitDialog);
  elements.hitDialog.addEventListener("click", (event) => {
    if (event.target === elements.hitDialog) closeHitDialog();
  });
  setupSplitPane();
  document.querySelectorAll("input[name='queryMode']").forEach((input) => {
    input.addEventListener("change", updateQueryMode);
  });

  loadStatus();
  loadDatabases();
  updateQueryMode();
});

function setupSplitPane() {
  if (!elements.workspace || !elements.splitHandle) return;

  const savedWidth = Number.parseInt(localStorage.getItem(SPLIT_STORAGE_KEY), 10);
  if (Number.isFinite(savedWidth)) {
    setQueryPanelWidth(savedWidth, { persist: false });
  } else {
    setQueryPanelWidth(500, { persist: false });
  }

  elements.splitHandle.addEventListener("pointerdown", startPanelResize);
  elements.splitHandle.addEventListener("keydown", handleSplitKeydown);
  window.addEventListener("resize", () => {
    const current = getCurrentQueryPanelWidth();
    setQueryPanelWidth(current, { persist: false });
  });
}

function startPanelResize(event) {
  if (!elements.workspace || window.matchMedia("(max-width: 980px)").matches) return;
  event.preventDefault();
  elements.splitHandle.setPointerCapture(event.pointerId);
  document.body.classList.add("is-resizing");

  const onMove = (moveEvent) => {
    const rect = elements.workspace.getBoundingClientRect();
    setQueryPanelWidth(moveEvent.clientX - rect.left, { persist: false });
  };

  const onEnd = (endEvent) => {
    elements.splitHandle.releasePointerCapture(endEvent.pointerId);
    document.body.classList.remove("is-resizing");
    localStorage.setItem(SPLIT_STORAGE_KEY, String(getCurrentQueryPanelWidth()));
    elements.splitHandle.removeEventListener("pointermove", onMove);
    elements.splitHandle.removeEventListener("pointerup", onEnd);
    elements.splitHandle.removeEventListener("pointercancel", onEnd);
  };

  elements.splitHandle.addEventListener("pointermove", onMove);
  elements.splitHandle.addEventListener("pointerup", onEnd);
  elements.splitHandle.addEventListener("pointercancel", onEnd);
}

function handleSplitKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 60 : 20;
  let next = getCurrentQueryPanelWidth();
  if (event.key === "ArrowLeft") next -= step;
  if (event.key === "ArrowRight") next += step;
  if (event.key === "Home") next = MIN_QUERY_PANEL_WIDTH;
  if (event.key === "End") next = getMaxQueryPanelWidth();
  setQueryPanelWidth(next, { persist: true });
}

function setQueryPanelWidth(width, options = {}) {
  if (!elements.workspace) return;
  const maxWidth = getMaxQueryPanelWidth();
  const clamped = clampNumber(width, MIN_QUERY_PANEL_WIDTH, maxWidth);
  elements.workspace.style.setProperty("--query-panel-width", `${Math.round(clamped)}px`);
  elements.splitHandle.setAttribute("aria-valuenow", String(Math.round(clamped)));
  elements.splitHandle.setAttribute("aria-valuemax", String(Math.round(maxWidth)));
  if (options.persist) {
    localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(clamped)));
  }
}

function getCurrentQueryPanelWidth() {
  const value = getComputedStyle(elements.workspace).getPropertyValue("--query-panel-width");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 500;
}

function getMaxQueryPanelWidth() {
  if (!elements.workspace) return 760;
  const total = elements.workspace.clientWidth;
  const handleAndGaps = 34;
  return Math.max(MIN_QUERY_PANEL_WIDTH, Math.min(860, total - MIN_RESULTS_PANEL_WIDTH - handleAndGaps));
}

function clampNumber(value, min, max) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

async function loadStatus() {
  try {
    const status = await getJson("/api/status");
    if (status.ok) {
      const blastn = status.tools.find((tool) => tool.name === "blastn");
      const version = blastn && blastn.version ? blastn.version.replace(/^blastn:\s*/i, "") : "ready";
      setStatus(`BLAST+ ${version}`, "ready");
      elements.statusBadge.title = `Using ${status.blastBinDir || "system PATH"}; work files: ${status.workDir}`;
      return;
    }

    const missing = status.tools.filter((tool) => !tool.available).map((tool) => tool.name).join(", ");
    setStatus(`Missing ${missing}`, "missing");
    showMessage(`NCBI BLAST+ is not available on PATH. Install BLAST+ or set BLAST_BIN_DIR, then restart the server.`, "warn");
  } catch (error) {
    setStatus("Status failed", "missing");
    showMessage(error.message, "error");
  }
}

async function loadDatabases() {
  elements.reloadButton.disabled = true;
  try {
    const data = await getJson("/api/databases");
    state.databases = data.databases || [];
    state.targets = [...(data.targetGroups || []), ...state.databases];
    renderDatabaseOptions();
    renderDatabaseList(data.csvPath || "genome_sets/genomes.csv");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    elements.reloadButton.disabled = false;
  }
}

function renderDatabaseOptions() {
  const available = state.targets.filter((target) => target.exists && !target.escapedRoot);
  const fileDatabases = state.databases.filter((database) => database.exists && !database.escapedRoot);
  const options = groupedOptions(available);

  elements.targetSelect.innerHTML = options;
  elements.sourceSelect.innerHTML = `<option value="${AUTO_SOURCE_ID}">Auto-find ID in all local FASTA files</option>${groupedOptions(fileDatabases)}`;
  renderTargetFilters(available);
  if (!available.some((target) => target.id === state.selectedTargetId)) {
    const preferred = available.find((target) => target.isGroup && target.scope === "all" && target.type === "nucl")
      || available.find((target) => target.isGroup && target.annotationName === "TAIR10_blastsets" && target.type === "nucl")
      || available.find((target) => target.isGroup && target.type === "nucl")
      || available.find((target) => target.file && target.file.endsWith("TAIR10_cds_20101214_updated"))
      || available[0];
    state.selectedTargetId = preferred ? preferred.id : "";
  }
  if (state.selectedTargetId) {
    elements.targetSelect.value = state.selectedTargetId;
  }
  renderTargetPicker();
  elements.runButton.disabled = available.length === 0;
  elements.exampleButton.disabled = !available.some((target) => target.type === "nucl");
}

function groupedOptions(databases) {
  const groups = new Map();
  for (const database of databases) {
    const key = database.annotationName || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(database);
  }

  return [...groups.entries()].map(([group, items]) => {
    const options = items.map((target) => {
      const organism = target.organism ? `${target.organism} - ` : "";
      const category = target.category ? ` - ${target.category}` : "";
      const accession = target.accession ? ` - ${target.accession}` : "";
      const count = target.isGroup ? ` - ${target.databaseCount} files` : "";
      return `<option value="${escapeHtml(target.id)}">${escapeHtml(organism + target.name)} (${target.type}${category}${accession}${count})</option>`;
    }).join("");
    return `<optgroup label="${escapeHtml(group)}">${options}</optgroup>`;
  }).join("");
}

function renderTargetFilters(targets) {
  state.targetFilters.group = renderFilterOptions(elements.targetGroupFilter, "All sets", uniqueValues(targets, "annotationName"), state.targetFilters.group);
  state.targetFilters.type = renderFilterOptions(elements.targetTypeFilter, "All types", uniqueValues(targets, "type"), state.targetFilters.type);
  state.targetFilters.category = renderFilterOptions(elements.targetCategoryFilter, "All kinds", uniqueValues(targets, "category"), state.targetFilters.category);
  elements.targetSearch.value = state.targetFilters.search;
}

function renderFilterOptions(select, allLabel, values, selected) {
  select.innerHTML = [
    `<option value="">${escapeHtml(allLabel)}</option>`,
    ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
  ].join("");
  const value = values.includes(selected) ? selected : "";
  select.value = value;
  return value;
}

function uniqueValues(databases, field) {
  return [...new Set(databases.map((database) => database[field]).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function updateTargetFilters() {
  state.targetFilters.search = elements.targetSearch.value.trim().toLowerCase();
  state.targetFilters.group = elements.targetGroupFilter.value;
  state.targetFilters.type = elements.targetTypeFilter.value;
  state.targetFilters.category = elements.targetCategoryFilter.value;
  renderTargetPicker();
}

function handleTargetListClick(event) {
  const toggle = event.target.closest("[data-target-toggle]");
  if (toggle) {
    const id = toggle.dataset.targetToggle;
    if (state.expandedTargetGroups.has(id)) {
      state.expandedTargetGroups.delete(id);
    } else {
      state.expandedTargetGroups.add(id);
    }
    renderTargetPicker();
    return;
  }

  const item = event.target.closest("[data-target-id]");
  if (!item) return;
  selectTarget(item.dataset.targetId);
}

function selectTarget(id) {
  const target = state.targets.find((item) => item.id === id && item.exists && !item.escapedRoot);
  if (!target) return;
  state.selectedTargetId = id;
  elements.targetSelect.value = id;
  if (!elements.sourceSelect.value) {
    elements.sourceSelect.value = AUTO_SOURCE_ID;
  }
  renderTargetPicker();
}

function handleSourceChange() {
  if (getQueryMode() !== "id") return;
  const source = state.databases.find((database) => database.id === elements.sourceSelect.value);
  if (!source) return;
  const current = state.targets.find((target) => target.id === state.selectedTargetId);
  if (current && current.scope !== "all") return;

  const allCompatible = state.targets.find((target) => target.isGroup && target.scope === "all" && target.type === source.type);
  if (allCompatible) selectTarget(allCompatible.id);
}

function renderTargetPicker() {
  const available = state.targets.filter((target) => target.exists && !target.escapedRoot);
  const entries = buildTargetTree(available);
  const groupCount = entries.filter((entry) => entry.kind === "group").length;
  const visibleFileCount = entries.reduce((sum, entry) => (
    sum + (entry.kind === "group" ? entry.visibleMembers.length : 1)
  ), 0);
  const totalFileCount = state.databases.filter((database) => database.exists && !database.escapedRoot).length;
  elements.targetCount.textContent = `${groupCount} groups / ${visibleFileCount} files shown / ${totalFileCount} files available`;
  renderSelectedTarget(available.find((target) => target.id === state.selectedTargetId));

  if (!entries.length) {
    elements.targetList.innerHTML = `<div class="empty-targets">No targets match the current filters.</div>`;
    return;
  }

  elements.targetList.innerHTML = entries.map(renderTargetTreeEntry).join("");
}

function buildTargetTree(targets) {
  const groups = targets
    .filter((target) => target.isGroup)
    .filter(targetMatchesFilters)
    .map((group) => {
      const members = getGroupMembers(group).filter(targetMatchesFilters);
      const groupMatches = targetMatchesSearch(group);
      const visibleMembers = state.targetFilters.search && !groupMatches
        ? members.filter(targetMatchesSearch)
        : members;
      return {
        kind: "group",
        group,
        visibleMembers,
        totalMembers: getGroupMembers(group).length,
        forceExpanded: Boolean(state.targetFilters.search && visibleMembers.length)
      };
    })
    .filter((item) => targetMatchesSearch(item.group) || item.visibleMembers.length);

  return groups.sort((a, b) => (
    groupSortRank(a.group) - groupSortRank(b.group)
    || String(a.group.annotationName || "").localeCompare(String(b.group.annotationName || ""))
    || String(a.group.type || "").localeCompare(String(b.group.type || ""))
  ));

  const groupedFileIds = new Set();
  for (const entry of groups) {
    getGroupMembers(entry.group).forEach((member) => groupedFileIds.add(member.id));
  }

  const standaloneFiles = state.databases
    .filter((database) => database.exists && !database.escapedRoot)
    .filter((database) => !groupedFileIds.has(database.id))
    .filter(targetMatchesFilters)
    .filter(targetMatchesSearch)
    .sort((a, b) => String(a.name || a.file || "").localeCompare(String(b.name || b.file || "")))
    .map((target) => ({ kind: "file", target }));

  return [...groups, ...standaloneFiles];
}

function targetMatchesFilters(target) {
  const filters = state.targetFilters;
  if (filters.group && target.annotationName !== filters.group) return false;
  if (filters.type && target.type !== filters.type) return false;
  if (filters.category && !targetHasCategory(target, filters.category)) return false;
  return true;
}

function targetHasCategory(target, category) {
  if (target.category === category) return true;
  return Array.isArray(target.memberCategories) && target.memberCategories.includes(category);
}

function targetMatchesSearch(target) {
  const search = state.targetFilters.search;
  if (!search) return true;
  const haystack = [
    target.name,
    target.file,
    target.fileName,
    target.organism,
    target.assembly,
    target.annotationName,
    target.category,
    target.source,
    target.description,
    target.accession,
    target.type,
    target.isGroup ? "group all files" : "file"
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search);
}

function getGroupMembers(group) {
  if (!Array.isArray(group.memberIds)) return [];
  const memberIds = new Set(group.memberIds);
  return state.databases
    .filter((database) => database.exists && !database.escapedRoot && memberIds.has(database.id))
    .sort((a, b) => (
      String(a.category || "").localeCompare(String(b.category || ""))
      || String(a.name || a.file || "").localeCompare(String(b.name || b.file || ""))
    ));
}

function groupSortRank(group) {
  if (group.scope === "all") return 0;
  return 1;
}

function renderTargetTreeEntry(item) {
  if (item.kind === "file") return renderStandaloneTargetFile(item.target);
  return renderTargetTreeGroup(item);
}

function renderTargetTreeGroup(item) {
  const { group, visibleMembers, totalMembers, forceExpanded } = item;
  const expanded = forceExpanded || state.expandedTargetGroups.has(group.id);
  const selected = group.id === state.selectedTargetId;
  const organism = group.organism || group.annotationName || "";
  const accession = group.accession || group.assembly || "";
  const annotationCount = Array.isArray(group.annotationFiles) ? group.annotationFiles.length : 0;
  const countLabel = `${group.databaseCount || totalMembers} files`;
  const toggleDisabled = visibleMembers.length === 0;
  const children = expanded && visibleMembers.length
    ? `<div class="target-children">${visibleMembers.map(renderTargetTreeFile).join("")}</div>`
    : "";

  return `
    <div class="target-tree-group">
      <div class="target-row-shell">
        <button
          class="target-expand"
          type="button"
          data-target-toggle="${escapeHtml(group.id)}"
          aria-expanded="${expanded}"
          aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(shortTargetName(group))}"
          ${toggleDisabled ? "disabled" : ""}
        >${expanded ? "-" : "+"}</button>
        <button class="target-item ${selected ? "selected" : ""} group" type="button" data-target-id="${escapeHtml(group.id)}" role="option" aria-selected="${selected}">
          <span class="target-main">
            <span class="target-name">${escapeHtml(shortTargetName(group))}</span>
            <span class="target-file">${escapeHtml(groupSubtitle(group))}</span>
          </span>
          <span class="target-meta">
            ${organism ? `<span>${escapeHtml(organism)}</span>` : ""}
            ${accession ? `<span>${escapeHtml(accession)}</span>` : ""}
            <span>${escapeHtml(countLabel)}</span>
          </span>
          <span class="target-badges">
            <span class="target-badge group">group</span>
            <span class="target-badge ${group.type === "prot" ? "prot" : "nucl"}">${escapeHtml(group.type)}</span>
            <span class="target-badge">${escapeHtml(group.category || "FASTA")}</span>
            ${annotationCount ? `<span class="target-badge">${annotationCount} ann.</span>` : ""}
          </span>
        </button>
      </div>
      ${children}
    </div>
  `;
}

function renderStandaloneTargetFile(target) {
  return `<div class="target-tree-group standalone">${renderTargetTreeFile(target)}</div>`;
}

function renderTargetTreeFile(target) {
  const selected = target.id === state.selectedTargetId;
  const organism = target.organism || target.annotationName || "";
  const accession = target.accession || target.assembly || "";
  const annotationCount = Array.isArray(target.annotationFiles) ? target.annotationFiles.length : 0;
  return `
    <button class="target-item ${selected ? "selected" : ""} file child" type="button" data-target-id="${escapeHtml(target.id)}" role="option" aria-selected="${selected}">
      <span class="target-main">
        <span class="target-name">${escapeHtml(shortTargetName(target))}</span>
        <span class="target-file">${escapeHtml(target.file)}</span>
      </span>
      <span class="target-meta">
        ${organism ? `<span>${escapeHtml(organism)}</span>` : ""}
        ${accession ? `<span>${escapeHtml(accession)}</span>` : ""}
        <span>${escapeHtml(target.sizeLabel || "0 B")}</span>
      </span>
      <span class="target-badges">
        <span class="target-badge file">file</span>
        <span class="target-badge ${target.type === "prot" ? "prot" : "nucl"}">${escapeHtml(target.type)}</span>
        <span class="target-badge">${escapeHtml(target.category || "FASTA")}</span>
        ${annotationCount ? `<span class="target-badge">${annotationCount} ann.</span>` : ""}
      </span>
    </button>
  `;
}

function renderSelectedTarget(target) {
  if (!target) {
    elements.selectedTarget.innerHTML = `<span class="selected-label">Selected</span><strong>No target selected</strong>`;
    return;
  }

  const organism = target.organism || "Unknown organism";
  const assembly = target.assembly || target.accession || "No assembly metadata";
  const count = target.isGroup ? `Searches ${target.databaseCount} files` : "Single FASTA file";
  elements.selectedTarget.innerHTML = `
    <span class="selected-label">Selected target</span>
    <strong>${escapeHtml(shortTargetName(target))}</strong>
    <span>${escapeHtml(organism)} &middot; ${escapeHtml(assembly)} &middot; ${escapeHtml(target.category || "FASTA")} &middot; ${escapeHtml(target.type)} &middot; ${escapeHtml(count)}</span>
  `;
}

function shortTargetName(target) {
  const set = target.annotationName ? `${target.annotationName} ` : "";
  const category = target.category || "FASTA";
  const base = target.fileName || target.name || target.file;
  if (target.name && target.name.length <= 90) return target.name;
  return `${set}${category}: ${base}`;
}

function groupSubtitle(target) {
  const categories = Array.isArray(target.memberCategories) && target.memberCategories.length
    ? target.memberCategories.join(", ")
    : target.category;
  return `${target.databaseCount || 0} files: ${categories}`;
}

function renderDatabaseList(csvPath) {
  const summaries = summarizeReferenceSets();
  elements.databaseMeta.textContent = `${summaries.length} reference sets, ${state.databases.length} FASTA files from ${csvPath}`;
  elements.databaseList.innerHTML = summaries.map((summary) => {
    const categories = summary.categories.slice(0, 6).map((category) => `<span class="chip">${escapeHtml(category)}</span>`).join("");
    const moreCategories = summary.categories.length > 6 ? `<span class="chip">+${summary.categories.length - 6} kinds</span>` : "";
    const organism = summary.organism ? `<span class="chip">${escapeHtml(summary.organism)}</span>` : "";
    const assembly = summary.assembly ? `<span class="chip">${escapeHtml(summary.assembly)}</span>` : "";
    const source = summary.source ? `<span class="chip">${escapeHtml(summary.source)}</span>` : "";
    const description = summary.description ? `<span class="chip">${escapeHtml(summary.description)}</span>` : "";
    return `
      <article class="database-item">
        <strong>${escapeHtml(summary.name)}</strong>
        <code>${summary.fileCount} FASTA files / ${summary.nuclCount} nucleotide / ${summary.protCount} protein</code>
        <div class="chips">
          <span class="chip ok">available</span>
          <span class="chip">${escapeHtml(summary.sizeLabel)}</span>
          ${organism}
          ${assembly}
          ${source}
          ${summary.annotationCount ? `<span class="chip">${summary.annotationCount} annotation files</span>` : ""}
          ${categories}
          ${moreCategories}
          ${description}
        </div>
      </article>
    `;
  }).join("");
}

function summarizeReferenceSets() {
  const groups = new Map();
  for (const database of state.databases) {
    const key = database.annotationName || "Other";
    if (!groups.has(key)) {
      groups.set(key, {
        name: key,
        organism: database.organism || "",
        assembly: database.assembly || "",
        source: database.source || "",
        description: database.description || "",
        fileCount: 0,
        nuclCount: 0,
        protCount: 0,
        size: 0,
        categories: new Set(),
        annotations: new Set()
      });
    }
    const group = groups.get(key);
    group.fileCount += 1;
    group.nuclCount += database.type === "nucl" ? 1 : 0;
    group.protCount += database.type === "prot" ? 1 : 0;
    group.size += database.size || 0;
    if (database.category) group.categories.add(database.category);
    if (Array.isArray(database.annotationFiles)) {
      database.annotationFiles.forEach((file) => group.annotations.add(file.file || file.name));
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    sizeLabel: formatBytesClient(group.size),
    categories: [...group.categories].sort((a, b) => a.localeCompare(b)),
    annotationCount: group.annotations.size
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function formatBytesClient(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function updateQueryMode() {
  const mode = getQueryMode();
  const isId = mode === "id";
  elements.sourceField.classList.toggle("is-hidden", !isId);
  elements.queryLabel.textContent = isId ? "Sequence ID" : "Sequence";
  elements.queryText.placeholder = isId ? "AT1G01010.1" : ">query\nATGGCG...";
  if (isId) {
    if (!elements.sourceSelect.value) elements.sourceSelect.value = AUTO_SOURCE_ID;
    const current = state.targets.find((target) => target.id === state.selectedTargetId);
    if (!current || current.scope === "all") {
      const allNucl = state.targets.find((target) => target.isGroup && target.scope === "all" && target.type === "nucl");
      if (allNucl) selectTarget(allNucl.id);
    }
  }
}

function loadExample() {
  const target = state.targets.find((item) => item.isGroup && item.scope === "all" && item.type === "nucl")
    || state.targets.find((item) => item.isGroup && item.annotationName === "TAIR10_blastsets" && item.type === "nucl")
    || state.targets.find((item) => item.file && item.file.endsWith("TAIR10_cds_20101214_updated") && item.exists && !item.escapedRoot);
  if (!target) {
    showMessage("TAIR10 nucleotide targets are not available, so the built-in example cannot be loaded.", "warn");
    return;
  }

  selectTarget(target.id);
  document.querySelector("input[name='queryMode'][value='sequence']").checked = true;
  updateQueryMode();
  elements.queryText.value = "ATGGCCGTCTCATCATTCCA";
  elements.programSelect.value = "auto";
  elements.queryTypeSelect.value = "auto";
  elements.evalueInput.value = "auto";
  elements.maxTargetsInput.value = "10";
  clearMessage();
  elements.resultMeta.textContent = "DNA example loaded.";
}

async function runBlast(event) {
  event.preventDefault();
  clearMessage();
  state.rows = [];
  state.fields = [];
  state.lastResult = null;
  state.expandedResultGroups.clear();
  elements.downloadButton.disabled = true;
  renderTable([], []);

  const payload = {
    targetId: elements.targetSelect.value,
    sourceId: elements.sourceSelect.value,
    queryMode: getQueryMode(),
    queryText: elements.queryText.value,
    program: elements.programSelect.value,
    queryType: elements.queryTypeSelect.value,
    evalue: elements.evalueInput.value,
    maxTargets: elements.maxTargetsInput.value
  };

  setBlastRunning(true);
  elements.resultMeta.textContent = "BLAST job running.";

  try {
    const result = await postJson("/api/blast", payload);
    state.rows = result.rows || [];
    state.fields = result.fields || [];
    state.lastResult = result;
    renderTable(state.fields, state.rows);
    const targetName = result.target ? result.target.name : "target";
    const sourceText = result.source ? ` Query from ${result.source.name}.` : "";
    const evalueText = result.evalue ? ` E-value ${result.evalue}${result.evalueWasAuto ? " (auto)" : ""}.` : "";
    const shortText = result.shortQuerySettings ? " Short-query settings applied." : "";
    elements.resultMeta.textContent = `${result.program} against ${targetName}: ${result.rowCount} hits in ${(result.elapsedMs / 1000).toFixed(2)} s.${sourceText}${evalueText}${shortText}`;
    elements.downloadButton.disabled = state.rows.length === 0;
    if (result.rowCount === 0) {
      showMessage("No hits returned. Try the all-genome nucleotide group, keep E-value on auto for short DNA, or confirm the query type matches the selected target.", "warn");
    } else if (result.stderr) {
      showMessage(result.stderr, "warn");
    }
  } catch (error) {
    elements.resultMeta.textContent = "Search failed.";
    showMessage(error.message, "error");
  } finally {
    setBlastRunning(false);
  }
}

function updateResultView() {
  state.resultView = elements.resultViewSelect.value;
  state.expandedResultGroups.clear();
  renderTable(state.fields, state.rows);
}

function setBlastRunning(isRunning) {
  const hasTargets = state.targets.some((target) => target.exists && !target.escapedRoot);
  elements.runButton.disabled = isRunning || !hasTargets;
  elements.runButton.classList.toggle("is-running", isRunning);
  elements.runButton.innerHTML = isRunning
    ? `<span class="button-spinner" aria-hidden="true"></span><span>Running BLAST</span>`
    : "Run BLAST";
  elements.blastLoading.classList.toggle("is-hidden", !isRunning);
}

function renderTable(fields, rows) {
  const thead = elements.resultsTable.querySelector("thead");
  const tbody = elements.resultsTable.querySelector("tbody");

  if (!fields.length) {
    thead.innerHTML = "";
    tbody.innerHTML = "";
    elements.resultViewSelect.disabled = true;
    elements.resultCount.classList.add("is-hidden");
    elements.resultCount.textContent = "";
    return;
  }

  const displayFields = displayResultFields(fields);
  thead.innerHTML = `<tr>${displayFields.map((field) => `<th>${escapeHtml(labels[field] || field)}</th>`).join("")}</tr>`;
  elements.resultViewSelect.disabled = rows.length === 0;

  if (state.resultView === "compact") {
    const groups = groupResultRows(rows);
    elements.resultCount.classList.toggle("is-hidden", rows.length === 0);
    elements.resultCount.textContent = groups.length === rows.length
      ? `${rows.length} hits`
      : `${groups.length} compact targets from ${rows.length} raw hits`;
    tbody.innerHTML = groups.map((group) => renderResultGroup(group, displayFields)).join("");
    return;
  }

  elements.resultCount.classList.toggle("is-hidden", rows.length === 0);
  elements.resultCount.textContent = `${rows.length} raw hits`;
  tbody.innerHTML = rows.map((row, index) => {
    return `<tr>${displayFields.map((field) => renderResultCell(field, row, index)).join("")}</tr>`;
  }).join("");
}

function displayResultFields(fields) {
  const hasDatabase = fields.includes("database");
  return [
    "details",
    ...(hasDatabase ? ["database"] : []),
    "qseqid",
    "sseqid",
    "pident",
    "length",
    "evalue",
    "bitscore",
    "subject_range",
    "stitle"
  ];
}

function groupResultRows(rows) {
  const groups = new Map();

  rows.forEach((row, index) => {
    const info = inferResultGroup(row);
    if (!groups.has(info.key)) {
      groups.set(info.key, {
        ...info,
        rows: [],
        databases: new Set(),
        best: null
      });
    }
    const group = groups.get(info.key);
    const item = { row, index };
    group.rows.push(item);
    if (row.database) group.databases.add(row.database);
    if (!group.best || compareResultHits(item.row, group.best.row) < 0) {
      group.best = item;
    }
  });

  return [...groups.values()]
    .map((group) => {
      group.rows.sort((a, b) => compareResultHits(a.row, b.row));
      return group;
    })
    .sort((a, b) => compareResultHits(a.best.row, b.best.row));
}

function inferResultGroup(row) {
  const database = state.databases.find((item) => item.id === row.database_id) || {};
  const scope = [
    database.annotationName || row.database || "",
    database.organism || ""
  ].filter(Boolean).join(" | ") || "Unknown set";
  const subject = firstToken(row.sseqid || "");
  const title = String(row.stitle || "");
  const stableTarget = parseStableBiologicalId(subject, title);

  if (stableTarget) {
    return {
      key: `id:${normalizeGroupPart(scope)}:${normalizeGroupPart(stableTarget)}`,
      label: stableTarget,
      subtitle: scope,
      kind: "biological ID"
    };
  }

  if (isGenomeCoordinateSubject(subject, title)) {
    const start = Number.parseInt(row.sstart, 10);
    const end = Number.parseInt(row.send, 10);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      const binSize = 10000;
      const bin = Math.floor(((from + to) / 2) / binSize);
      return {
        key: `region:${normalizeGroupPart(scope)}:${normalizeGroupPart(subject)}:${bin}`,
        label: `${subject}:${(bin * binSize) + 1}-${(bin + 1) * binSize}`,
        subtitle: `${scope} | genomic neighborhood`,
        kind: "region"
      };
    }
  }

  const fallback = subject || title || row.database || "Unknown target";
  return {
    key: `subject:${normalizeGroupPart(scope)}:${normalizeGroupPart(fallback)}`,
    label: fallback,
    subtitle: scope,
    kind: "subject"
  };
}

function parseStableBiologicalId(subject, title) {
  const combined = `${subject} ${title}`;
  const attributeMatch = combined.match(/\b(?:gene|locus_tag|gene_id|protein_id|transcript_id)=([A-Za-z0-9_.:-]+)/i)
    || combined.match(/\[(?:gene|locus_tag|gene_id|protein_id|transcript_id)=([A-Za-z0-9_.:-]+)\]/i);
  if (attributeMatch) return stripIsoformSuffix(attributeMatch[1]);

  const tairMatch = combined.match(/\bAT[1-5CM]G\d{5}(?:\.\d+)?\b/i);
  if (tairMatch) return stripIsoformSuffix(tairMatch[0].toUpperCase());

  const token = bestSubjectToken(subject);
  if (!token || isGenomeCoordinateSubject(token, title)) return "";
  return stripIsoformSuffix(token);
}

function bestSubjectToken(subject) {
  const tokens = String(subject || "").split("|").map((token) => token.trim()).filter(Boolean);
  const ignored = new Set(["gb", "emb", "dbj", "ref", "sp", "tr", "lcl", "gnl", "gi"]);
  return tokens.find((token) => !ignored.has(token.toLowerCase())) || firstToken(subject);
}

function stripIsoformSuffix(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .replace(/\.\d+$/, "")
    .replace(/[-_.](?:t|mrna|rna|transcript|p|protein)\d+$/i, "");
}

function isGenomeCoordinateSubject(subject, title) {
  const text = `${subject || ""} ${title || ""}`.toLowerCase();
  return /(^|\b)(chr|chromosome|scaffold|contig|genome|supercontig|plasmid)\b/.test(text)
    || /^(nc_|nw_|nt_|nz_|cm_|cp_)/i.test(String(subject || ""));
}

function firstToken(value) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

function normalizeGroupPart(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function compareResultHits(a, b) {
  const evalueA = parseBlastNumber(a.evalue, Number.POSITIVE_INFINITY);
  const evalueB = parseBlastNumber(b.evalue, Number.POSITIVE_INFINITY);
  if (evalueA !== evalueB) return evalueA - evalueB;

  const bitsA = parseBlastNumber(a.bitscore, Number.NEGATIVE_INFINITY);
  const bitsB = parseBlastNumber(b.bitscore, Number.NEGATIVE_INFINITY);
  if (bitsA !== bitsB) return bitsB - bitsA;

  const identityA = parseBlastNumber(a.pident, Number.NEGATIVE_INFINITY);
  const identityB = parseBlastNumber(b.pident, Number.NEGATIVE_INFINITY);
  if (identityA !== identityB) return identityB - identityA;

  const lengthA = parseBlastNumber(a.length, Number.NEGATIVE_INFINITY);
  const lengthB = parseBlastNumber(b.length, Number.NEGATIVE_INFINITY);
  return lengthB - lengthA;
}

function parseBlastNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value || "").replace(/^e/i, "1e"));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function renderResultGroup(group, displayFields) {
  const best = group.best;
  const expanded = state.expandedResultGroups.has(group.key);
  const parent = `<tr class="result-group-row ${group.rows.length > 1 ? "has-children" : ""}">
    ${displayFields.map((field) => renderGroupResultCell(field, group, best, expanded)).join("")}
  </tr>`;

  if (!expanded || group.rows.length <= 1) return parent;

  const children = group.rows
    .filter((item) => item.index !== best.index)
    .map((item) => `<tr class="result-child-row">${displayFields.map((field) => renderResultCell(field, item.row, item.index)).join("")}</tr>`)
    .join("");
  return `${parent}${children}`;
}

function renderGroupResultCell(field, group, best, expanded) {
  const row = best.row;
  if (field === "details") {
    const toggle = group.rows.length > 1
      ? `<button class="mini-button icon-button" type="button" data-result-group="${escapeHtml(group.key)}" aria-label="${expanded ? "Collapse" : "Expand"} grouped hits">${expanded ? "-" : "+"}</button>`
      : `<span class="result-spacer" aria-hidden="true"></span>`;
    return `<td class="details-cell"><div class="result-actions">${toggle}<button class="mini-button" type="button" data-hit-index="${best.index}">Details</button></div></td>`;
  }

  if (field === "sseqid") {
    return `<td class="target-cell">
      <strong>${escapeHtml(group.label)}</strong>
      <span>${escapeHtml(group.kind)} | ${escapeHtml(group.subtitle)}</span>
    </td>`;
  }

  if (field === "database") {
    const databaseCount = group.databases.size;
    const hitCount = group.rows.length;
    return `<td>
      <div class="compact-summary">
        <span>${escapeHtml(row.database || "")}</span>
        ${hitCount > 1 ? `<strong>${hitCount} hits</strong>` : ""}
        ${databaseCount > 1 ? `<strong>${databaseCount} files</strong>` : ""}
      </div>
    </td>`;
  }

  if (field === "stitle") {
    const extra = group.rows.length > 1 ? `Best hit shown; expand to inspect ${group.rows.length - 1} additional raw hit${group.rows.length === 2 ? "" : "s"}.` : "";
    return `<td class="title-cell">
      <div class="compact-title">${escapeHtml(row.stitle || "")}</div>
      ${extra ? `<div class="compact-note">${escapeHtml(extra)}</div>` : ""}
    </td>`;
  }

  return renderResultCell(field, row, best.index);
}

function renderResultCell(field, row, index) {
  if (field === "details") {
    return `<td class="details-cell"><button class="mini-button" type="button" data-hit-index="${index}">Details</button></td>`;
  }
  if (field === "subject_range") {
    const start = row.sstart || "";
    const end = row.send || "";
    const strand = Number(start) > Number(end) ? " -" : "";
    return `<td>${escapeHtml(start && end ? `${start}-${end}${strand}` : "")}</td>`;
  }
  const className = field === "stitle" ? "title-cell" : "";
  return `<td class="${className}">${escapeHtml(row[field] || "")}</td>`;
}

function handleResultsClick(event) {
  const toggle = event.target.closest("[data-result-group]");
  if (toggle) {
    const key = toggle.dataset.resultGroup;
    if (state.expandedResultGroups.has(key)) {
      state.expandedResultGroups.delete(key);
    } else {
      state.expandedResultGroups.add(key);
    }
    renderTable(state.fields, state.rows);
    return;
  }

  const button = event.target.closest("[data-hit-index]");
  if (!button) return;
  const index = Number.parseInt(button.dataset.hitIndex, 10);
  if (!Number.isFinite(index)) return;
  openHitDetails(index);
}

async function openHitDetails(index) {
  const row = state.rows[index];
  if (!row) return;

  const databaseId = row.database_id || (state.lastResult && state.lastResult.target && state.lastResult.target.id);
  if (!databaseId) {
    showMessage("This hit is missing its database ID, so details cannot be loaded.", "warn");
    return;
  }

  elements.hitDetails.innerHTML = `<div class="detail-loading">Loading hit details. First lookup for a large genome annotation may build a local index.</div>`;
  showHitDialog();

  try {
    const detail = await postJson("/api/hit-detail", {
      databaseId,
      subjectId: row.sseqid,
      sstart: row.sstart,
      send: row.send
    });
    elements.hitDetails.innerHTML = renderHitDetails(detail, row);
  } catch (error) {
    elements.hitDetails.innerHTML = `<div class="message error">${escapeHtml(error.message)}</div>`;
  }
}

function showHitDialog() {
  if (typeof elements.hitDialog.showModal === "function") {
    elements.hitDialog.showModal();
  } else {
    elements.hitDialog.classList.add("open");
  }
}

function closeHitDialog() {
  if (typeof elements.hitDialog.close === "function") {
    elements.hitDialog.close();
  } else {
    elements.hitDialog.classList.remove("open");
  }
}

function renderHitDetails(detail, row) {
  const annotationHtml = renderAnnotationSections(detail.annotations || []);
  const title = detail.title || row.stitle || "";
  const database = detail.database || {};
  const sequenceNote = detail.sequence && detail.sequence.truncated ? "Context window shown" : "Full record shown";
  const alignmentHtml = renderAlignmentBlock(row);

  return `
    <section class="detail-section">
      <div class="detail-grid">
        ${detailItem("Subject", detail.subjectId)}
        ${detailItem("Database", database.name || row.database || "")}
        ${detailItem("Organism", database.organism || "")}
        ${detailItem("Assembly", database.assembly || database.accession || "")}
        ${detailItem("Identity", `${row.pident || ""}% over ${row.length || ""} bp/aa`)}
        ${detailItem("E-value", row.evalue || "")}
        ${detailItem("Bit score", row.bitscore || "")}
        ${detailItem("Subject range", detail.hit ? `${detail.hit.originalStart || ""}-${detail.hit.originalEnd || ""} (${detail.hit.strand || "+"})` : "")}
      </div>
      ${title ? `<p class="detail-title">${escapeHtml(title)}</p>` : ""}
      <p class="detail-header">${escapeHtml(detail.header || "")}</p>
    </section>

    <section class="detail-section">
      <div class="detail-section-title">
        <h3>BLAST Alignment</h3>
        <span>${escapeHtml(row.length ? `${row.length} aligned positions` : "")}</span>
      </div>
      ${alignmentHtml}
    </section>

    <section class="detail-section">
      <div class="detail-section-title">
        <h3>FASTA ${escapeHtml(sequenceNote)}</h3>
        <span>${escapeHtml(detail.sequence ? `${detail.sequence.rangeStart}-${detail.sequence.rangeEnd} of ${detail.sequence.fullLength}` : "")}</span>
      </div>
      <pre class="sequence-block">${escapeHtml(detail.sequence ? detail.sequence.fasta : "")}</pre>
    </section>

    <section class="detail-section">
      <div class="detail-section-title">
        <h3>Aligned Subject Segment</h3>
        <span>${escapeHtml(detail.hit ? `${detail.hit.length} bases/amino acids` : "")}</span>
      </div>
      <pre class="sequence-block small">${escapeHtml(detail.orientedHitSequence ? detail.orientedHitSequence.fasta : "")}</pre>
    </section>

    <section class="detail-section">
      <div class="detail-section-title">
        <h3>Annotations</h3>
        <span>${escapeHtml(detail.annotations ? `${detail.annotations.length} records` : "0 records")}</span>
      </div>
      ${annotationHtml}
    </section>
  `;
}

function renderAnnotationSections(annotations) {
  if (!annotations.length) {
    return `<div class="detail-empty">No matching annotations were found for this hit.</div>`;
  }

  const geneDescriptions = annotations.filter(isGeneDescriptionAnnotation);
  const gffAnnotations = annotations.filter((annotation) => !isGeneDescriptionAnnotation(annotation) && isGffAnnotation(annotation));
  const otherAnnotations = annotations.filter((annotation) => (
    !isGeneDescriptionAnnotation(annotation) && !isGffAnnotation(annotation)
  ));

  return `
    <div class="annotation-groups">
      ${renderAnnotationGroup("FASTA and other notes", otherAnnotations, "Header details, TE descriptions, and other supporting annotation records.", true)}
      ${renderAnnotationGroup("Gene description", geneDescriptions, "Descriptions from matching gene description tables.")}
      ${renderAnnotationGroup("GFF3 annotations", gffAnnotations, "Overlapping gene, transcript, CDS, exon, UTR, and related GFF/GTF features.")}
    </div>
  `;
}

function renderAnnotationGroup(title, annotations, emptyText, openByDefault = false) {
  const count = annotations.length;
  const content = count
    ? `<div class="annotation-list">${annotations.map(renderAnnotation).join("")}</div>`
    : `<div class="detail-empty compact">${escapeHtml(emptyText)}</div>`;
  return `
    <details class="annotation-group" ${openByDefault ? "open" : ""}>
      <summary>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(`${count} record${count === 1 ? "" : "s"}`)}</span>
      </summary>
      ${content}
    </details>
  `;
}

function isGeneDescriptionAnnotation(annotation) {
  return annotation.match === "description table"
    || annotation.source === "Description table"
    || annotation.feature === "gene_description";
}

function isGffAnnotation(annotation) {
  const file = String(annotation.sourceFile || "");
  return /\.(gff|gff3|gtf)(\.gz)?$/i.test(file)
    || annotation.match === "coordinate"
    || annotation.match === "attribute";
}

function renderAlignmentBlock(row) {
  const query = String(row.qseq || "");
  const subject = String(row.sseq || "");
  if (!query || !subject) {
    return `<div class="detail-empty">Alignment strings are not available for this hit. Re-run BLAST after refreshing the page.</div>`;
  }

  const qStart = Number.parseInt(row.qstart, 10);
  const sStart = Number.parseInt(row.sstart, 10);
  const sEnd = Number.parseInt(row.send, 10);
  const qStep = 1;
  const sStep = Number.isFinite(sStart) && Number.isFinite(sEnd) && sStart > sEnd ? -1 : 1;
  const blocks = buildAlignmentBlocks(query, subject, {
    qStart: Number.isFinite(qStart) ? qStart : 1,
    sStart: Number.isFinite(sStart) ? sStart : 1,
    qStep,
    sStep,
    width: 60
  });

  return `<pre class="alignment-block">${escapeHtml(blocks.join("\n\n"))}</pre>`;
}

function buildAlignmentBlocks(query, subject, options) {
  const width = options.width || 60;
  const blocks = [];
  let qPos = options.qStart;
  let sPos = options.sStart;

  for (let index = 0; index < Math.max(query.length, subject.length); index += width) {
    const qPart = query.slice(index, index + width);
    const sPart = subject.slice(index, index + width);
    const qFrom = qPos;
    const sFrom = sPos;
    const qTo = advancePosition(qPos, qPart, options.qStep);
    const sTo = advancePosition(sPos, sPart, options.sStep);
    const marker = alignmentMarkers(qPart, sPart);

    blocks.push([
      formatAlignmentLine("Query", qFrom, qPart, qTo),
      formatAlignmentLine("", "", marker, ""),
      formatAlignmentLine("Target", sFrom, sPart, sTo)
    ].join("\n"));

    qPos = nextPosition(qTo, options.qStep);
    sPos = nextPosition(sTo, options.sStep);
  }

  return blocks;
}

function advancePosition(start, text, step) {
  const residues = String(text || "").replace(/-/g, "").length;
  if (residues === 0) return start;
  return start + ((residues - 1) * step);
}

function nextPosition(position, step) {
  return position + step;
}

function alignmentMarkers(query, subject) {
  let out = "";
  const max = Math.max(query.length, subject.length);
  for (let i = 0; i < max; i += 1) {
    const q = query[i] || " ";
    const s = subject[i] || " ";
    if (q === "-" || s === "-") out += " ";
    else if (q.toUpperCase() === s.toUpperCase()) out += "|";
    else out += ".";
  }
  return out;
}

function formatAlignmentLine(label, start, text, end) {
  const left = String(label || "").padEnd(6, " ");
  const from = String(start || "").padStart(8, " ");
  const sequence = String(text || "");
  const to = String(end || "").padStart(8, " ");
  return `${left} ${from}  ${sequence}  ${to}`;
}

function detailItem(label, value) {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "NA")}</strong>
    </div>
  `;
}

function renderAnnotation(annotation) {
  const title = isGeneDescriptionAnnotation(annotation) ? "Gene description" : (annotation.feature || "feature");
  const descriptionHtml = renderAnnotationDescription(annotation);
  return `
    <article class="annotation-item">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(annotationLocation(annotation))}</span>
      </div>
      <div class="annotation-meta">
        ${annotation.source ? `<span>${escapeHtml(annotation.source)}</span>` : ""}
        ${annotation.name ? `<span>${escapeHtml(annotation.name)}</span>` : ""}
        ${annotation.gene ? `<span>${escapeHtml(annotation.gene)}</span>` : ""}
        ${annotation.id ? `<span>${escapeHtml(annotation.id)}</span>` : ""}
        ${annotation.parent ? `<span>Parent ${escapeHtml(annotation.parent)}</span>` : ""}
        <span>${escapeHtml(annotation.sourceFile || "")}</span>
      </div>
      ${descriptionHtml}
    </article>
  `;
}

function annotationLocation(annotation) {
  const start = annotation.start || "";
  const end = annotation.end || "";
  if (annotation.seqid && start && end) {
    return `${annotation.seqid}:${start}-${end}${annotation.strand ? ` ${annotation.strand}` : ""}`;
  }
  return annotation.seqid || annotation.match || annotation.source || "";
}

function renderAnnotationDescription(annotation) {
  const parts = [];
  if (annotation.product) parts.push({ label: "Description", value: annotation.product });
  if (annotation.note && annotation.note !== annotation.product) {
    if (isGeneDescriptionAnnotation(annotation)) {
      parts.push(...annotation.note.split(/\r?\n/).map(parseDescriptionLine));
    } else {
      parts.push({ label: "Details", value: annotation.note });
    }
  }
  return parts.map((part) => `
    <p>
      <strong>${escapeHtml(part.label)}:</strong>
      ${escapeHtml(part.value)}
    </p>
  `).join("");
}

function parseDescriptionLine(line) {
  const text = String(line || "").trim();
  const index = text.indexOf(":");
  if (index === -1) return { label: "Details", value: text };
  return {
    label: text.slice(0, index).trim() || "Details",
    value: text.slice(index + 1).trim()
  };
}

function downloadTsv() {
  if (!state.rows.length || !state.fields.length) return;
  const lines = [
    state.fields.join("\t"),
    ...state.rows.map((row) => state.fields.map((field) => String(row[field] || "").replace(/\t/g, " ")).join("\t"))
  ];
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/tab-separated-values" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `blast-results-${new Date().toISOString().replace(/[:.]/g, "-")}.tsv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getQueryMode() {
  return document.querySelector("input[name='queryMode']:checked").value;
}

async function getJson(url) {
  const response = await fetch(url);
  return parseResponse(response);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    const detail = data.detail ? `\n${data.detail}` : "";
    throw new Error(`${data.error || "Request failed."}${detail}`);
  }
  return data;
}

function setStatus(text, status) {
  elements.statusBadge.textContent = text;
  elements.statusBadge.className = `status-badge status-${status}`;
}

function showMessage(text, type) {
  elements.message.textContent = text;
  elements.message.className = `message ${type || ""}`;
}

function clearMessage() {
  elements.message.textContent = "";
  elements.message.className = "message is-hidden";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

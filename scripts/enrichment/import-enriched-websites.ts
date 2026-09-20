import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const DEFAULT_INPUT_DIR = path.join(REPOSITORY_ROOT, "data", "enrichments", "completed");
const DEFAULT_OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "audits");
const DEFAULT_UPDATE_BATCH_SIZE = 100;
const QUERY_BATCH_SIZE = 500;
const EXPECTED_HEADERS = ["id", "name", "category", "city", "state", "country", "website"] as const;

type Target = "local" | "remote";
type Mode = "dry-run" | "apply";

type Options = {
  target: Target;
  mode: Mode;
  inputDir: string;
  outputDir: string;
  updateBatchSize: number;
};

type CsvRecord = Record<(typeof EXPECTED_HEADERS)[number], string>;

type EnrichedRecord = {
  fileName: string;
  rowNumber: number;
  id: string;
  name: string;
  category: string;
  city: string;
  state: string;
  country: string;
  submittedWebsite: string;
  website: string | null;
  source: string | null;
  sourceId: string | null;
  outcome: string;
  detail: string | null;
};

type Institution = {
  id: string;
  source: string;
  source_id: string;
  name: string;
  category: string;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
};

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\enrichment\\import-enriched-websites.ts --dry-run
  .\\node_modules\\.bin\\tsx.cmd scripts\\enrichment\\import-enriched-websites.ts --apply
  .\\node_modules\\.bin\\tsx.cmd scripts\\enrichment\\import-enriched-websites.ts --remote --dry-run
  .\\node_modules\\.bin\\tsx.cmd scripts\\enrichment\\import-enriched-websites.ts --remote --apply

Options:
  --dry-run                    Validate and report only (default)
  --apply                      Apply updates to the selected database target
  --remote                     Select remote D1; local D1 is the default
  --input <path>               Completed CSV directory (default: data/enrichments/completed)
  --output <path>              Report directory (default: data/audits)
  --update-batch-size <count>  Updates per D1 command; 1-250 (default: 100)

Local mode imports valid nonblank website values only into local D1. Remote mode
requires local D1 to already contain the same URL, and updates remote rows only
when their current website is blank. It never creates tables or rows.
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let target: Target = "local";
  let mode: Mode = "dry-run";
  let inputDir = DEFAULT_INPUT_DIR;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let updateBatchSize = DEFAULT_UPDATE_BATCH_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (mode === "apply") throw new Error("Choose only one of --dry-run or --apply.");
      continue;
    }
    if (argument === "--apply") {
      if (mode === "apply") throw new Error("--apply may only be specified once.");
      mode = "apply";
      continue;
    }
    if (argument === "--remote") {
      target = "remote";
      continue;
    }
    if (["--input", "--output", "--update-batch-size"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--input") inputDir = path.resolve(REPOSITORY_ROOT, value);
      if (argument === "--output") outputDir = path.resolve(REPOSITORY_ROOT, value);
      if (argument === "--update-batch-size") updateBatchSize = Number(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isInteger(updateBatchSize) || updateBatchSize < 1 || updateBatchSize > 250) {
    throw new Error("--update-batch-size must be an integer between 1 and 250.");
  }
  return { target, mode, inputDir, outputDir, updateBatchSize };
}

function csvValue(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value).replaceAll("\u0000", " ");
  return /[\",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function equalExportValue(csvValue: string, databaseValue: string | null): boolean {
  return csvValue === (databaseValue ?? "");
}

function normalizeWebsite(value: string): { website: string | null; detail: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { website: null, detail: null };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { website: null, detail: "Website must use http or https." };
    }
    if (!url.hostname || url.username || url.password) {
      return { website: null, detail: "Website must include a hostname and cannot include credentials." };
    }
    url.hash = "";
    return { website: url.toString(), detail: null };
  } catch {
    return { website: null, detail: "Website is not a valid absolute URL." };
  }
}

function hasWebsite(value: string | null): boolean {
  return Boolean(value?.trim());
}

async function runWrangler(args: string[]): Promise<string> {
  const wranglerScript = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  try {
    const result = await execFileAsync(process.execPath, [wranglerScript, ...args], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 30 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const commandError = error as Error & { stderr?: string };
    const stderr = commandError.stderr?.trim();
    throw new Error(stderr ? `${commandError.message}\n${stderr}` : commandError.message);
  }
}

async function queryD1<T>(target: Target, sql: string): Promise<T[]> {
  const locationFlag = target === "remote" ? "--remote" : "--local";
  const output = await runWrangler([
    "d1", "execute", DATABASE_NAME, locationFlag, "--json", "--command", sql,
  ]);
  const payload = JSON.parse(output) as Array<{ results?: T[]; success?: boolean }>;
  if (!payload[0]?.success || !payload[0].results) {
    throw new Error(`Wrangler returned an unsuccessful ${target} D1 query.`);
  }
  return payload[0].results;
}

function sourceKey(source: string, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}

async function loadInstitutionsById(target: Target, ids: string[]): Promise<Map<string, Institution>> {
  const rows = new Map<string, Institution>();
  for (let offset = 0; offset < ids.length; offset += QUERY_BATCH_SIZE) {
    const idsInBatch = ids.slice(offset, offset + QUERY_BATCH_SIZE);
    const records = await queryD1<Institution>(target, `SELECT
  id, source, source_id, name, category, city, state, country, website
FROM educational_institutions
WHERE id IN (${idsInBatch.map(sqlValue).join(", ")});`);
    for (const record of records) rows.set(record.id, record);
  }
  return rows;
}

async function loadInstitutionsBySourceKey(references: Array<{ source: string; sourceId: string }>): Promise<Map<string, Institution>> {
  const rows = new Map<string, Institution>();
  const uniqueReferences = [...new Map(references.map((reference) => [sourceKey(reference.source, reference.sourceId), reference])).values()];
  for (let offset = 0; offset < uniqueReferences.length; offset += QUERY_BATCH_SIZE) {
    const referencesInBatch = uniqueReferences.slice(offset, offset + QUERY_BATCH_SIZE);
    const records = await queryD1<Institution>("remote", `SELECT
  id, source, source_id, name, category, city, state, country, website
FROM educational_institutions
WHERE (source, source_id) IN (${referencesInBatch
  .map((reference) => `(${sqlValue(reference.source)}, ${sqlValue(reference.sourceId)})`)
  .join(", ")});`);
    for (const record of records) rows.set(sourceKey(record.source, record.source_id), record);
  }
  return rows;
}

async function readCompletedRecords(inputDir: string): Promise<EnrichedRecord[]> {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`No CSV files found in ${inputDir}.`);

  const records: EnrichedRecord[] = [];
  for (const fileName of files) {
    const filePath = path.join(inputDir, fileName);
    const content = await readFile(filePath, "utf8");
    const [header] = parse(content, { bom: true, to_line: 1, record_delimiter: ["\r\n", "\n"] }) as string[][];
    if (!header || header.length !== EXPECTED_HEADERS.length || header.some((value, index) => value !== EXPECTED_HEADERS[index])) {
      throw new Error(`${fileName} must use exactly this header: ${EXPECTED_HEADERS.join(",")}`);
    }
    const csvRows = parse(content, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      record_delimiter: ["\r\n", "\n"],
    }) as CsvRecord[];
    for (const [index, row] of csvRows.entries()) {
      const values = EXPECTED_HEADERS.map((header) => row[header] ?? "");
      if (values.every((value) => !value.trim())) continue;
      const normalized = normalizeWebsite(row.website ?? "");
      records.push({
        fileName,
        rowNumber: index + 2,
        id: (row.id ?? "").trim(),
        name: row.name ?? "",
        category: row.category ?? "",
        city: row.city ?? "",
        state: row.state ?? "",
        country: row.country ?? "",
        submittedWebsite: row.website ?? "",
        website: normalized.website,
        source: null,
        sourceId: null,
        outcome: normalized.detail ? "invalid_website" : normalized.website ? "pending" : "unresolved",
        detail: normalized.detail,
      });
    }
  }
  return records;
}

function findDuplicateIds(records: EnrichedRecord[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    if (!record.id || seen.has(record.id)) duplicates.add(record.id || "<blank id>");
    seen.add(record.id);
  }
  return duplicates;
}

function verifyStaticFields(records: EnrichedRecord[], institutions: Map<string, Institution>): string[] {
  const errors: string[] = [];
  for (const record of records) {
    const institution = institutions.get(record.id);
    if (!institution) {
      record.outcome = "unknown_local_id";
      record.detail = "No matching local D1 institution was found.";
      errors.push(`${record.fileName} row ${record.rowNumber}: unknown id ${record.id || "<blank>"}.`);
      continue;
    }
    record.source = institution.source;
    record.sourceId = institution.source_id;
    const fieldsMatch = equalExportValue(record.name, institution.name)
      && equalExportValue(record.category, institution.category)
      && equalExportValue(record.city, institution.city)
      && equalExportValue(record.state, institution.state)
      && equalExportValue(record.country, institution.country);
    if (!fieldsMatch) {
      record.outcome = "modified_reference_fields";
      record.detail = "Only website may differ from the exported CSV.";
      errors.push(`${record.fileName} row ${record.rowNumber}: name, category, city, state, or country differs from local D1.`);
    }
  }
  return errors;
}

function setLocalOutcomes(records: EnrichedRecord[], institutions: Map<string, Institution>): EnrichedRecord[] {
  const updates: EnrichedRecord[] = [];
  for (const record of records) {
    if (record.outcome !== "pending") continue;
    const institution = institutions.get(record.id);
    if (!institution) continue;
    if (hasWebsite(institution.website)) {
      record.outcome = institution.website === record.website ? "already_current_local" : "local_website_conflict";
      record.detail = institution.website === record.website
        ? "Local D1 already has this website."
        : "Local D1 already has a different nonblank website.";
      continue;
    }
    record.outcome = "would_update_local";
    record.detail = null;
    updates.push(record);
  }
  return updates;
}

function setRemoteOutcomes(records: EnrichedRecord[], localInstitutions: Map<string, Institution>, remoteInstitutions: Map<string, Institution>): EnrichedRecord[] {
  const updates: EnrichedRecord[] = [];
  for (const record of records) {
    if (record.outcome !== "pending") continue;
    const localInstitution = localInstitutions.get(record.id);
    if (!localInstitution || localInstitution.website !== record.website) {
      record.outcome = "local_not_synced";
      record.detail = "Run the local --apply step before remote synchronization.";
      continue;
    }
    const remoteInstitution = remoteInstitutions.get(sourceKey(localInstitution.source, localInstitution.source_id));
    if (!remoteInstitution) {
      record.outcome = "remote_id_not_found";
      record.detail = "No matching remote D1 institution was found.";
      continue;
    }
    if (!hasWebsite(remoteInstitution.website)) {
      record.outcome = "would_update_remote";
      record.detail = null;
      updates.push(record);
      continue;
    }
    record.outcome = remoteInstitution.website === record.website ? "already_current_remote" : "remote_website_conflict";
    record.detail = remoteInstitution.website === record.website
      ? "Remote D1 already has this website."
      : "Remote D1 already has a different nonblank website.";
  }
  return updates;
}

async function applyUpdates(target: Target, updates: EnrichedRecord[], updateBatchSize: number): Promise<void> {
  if (updates.length === 0) return;
  const tempParent = path.join(REPOSITORY_ROOT, "data", "tmp");
  await mkdir(tempParent, { recursive: true });
  const tempDir = await mkdtemp(path.join(tempParent, "enriched-website-import-"));
  const locationFlag = target === "remote" ? "--remote" : "--local";
  try {
    for (let offset = 0; offset < updates.length; offset += updateBatchSize) {
      const batch = updates.slice(offset, offset + updateBatchSize);
      const batchNumber = Math.floor(offset / updateBatchSize) + 1;
      const websiteCase = target === "remote"
        ? batch.map((record) => `WHEN source = ${sqlValue(record.source as string)} AND source_id = ${sqlValue(record.sourceId as string)} THEN ${sqlValue(record.website as string)}`).join("\n    ")
        : batch.map((record) => `WHEN ${sqlValue(record.id)} THEN ${sqlValue(record.website as string)}`).join("\n    ");
      const whereClause = target === "remote"
        ? `(source, source_id) IN (${batch.map((record) => `(${sqlValue(record.source as string)}, ${sqlValue(record.sourceId as string)})`).join(", ")})`
        : `id IN (${batch.map((record) => sqlValue(record.id)).join(", ")})`;
      const sql = `UPDATE educational_institutions
SET website = CASE${target === "remote" ? "" : " id"}
    ${websiteCase}
    ELSE website
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE ${whereClause}
  AND (website IS NULL OR TRIM(website) = '');`;
      const sqlPath = path.join(tempDir, `website-update-${String(batchNumber).padStart(4, "0")}.sql`);
      await writeFile(sqlPath, sql, "utf8");
      await runWrangler(["d1", "execute", DATABASE_NAME, locationFlag, "--file", sqlPath, "--yes"]);
      console.log(`Applied ${Math.min(offset + batch.length, updates.length)}/${updates.length} ${target} website updates.`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeReport(records: EnrichedRecord[], options: Options): Promise<string> {
  await mkdir(options.outputDir, { recursive: true });
  const reportPath = path.join(options.outputDir, `enriched-website-${options.target}-import-report.csv`);
  const lines = [[
    "file_name", "row_number", "id", "name", "category", "city", "state", "country",
    "submitted_website", "normalized_website", "outcome", "detail",
  ].join(",")];
  for (const record of records) {
    lines.push([
      record.fileName,
      record.rowNumber,
      record.id,
      record.name,
      record.category,
      record.city,
      record.state,
      record.country,
      record.submittedWebsite,
      record.website,
      record.outcome,
      record.detail,
    ].map(csvValue).join(","));
  }
  await writeFile(reportPath, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  return reportPath;
}

function printSummary(records: EnrichedRecord[], fileCount: number, options: Options, reportPath: string): void {
  const outcomes = new Map<string, number>();
  for (const record of records) outcomes.set(record.outcome, (outcomes.get(record.outcome) ?? 0) + 1);
  console.log("Enriched website import summary");
  console.log(`Target: ${options.target}`);
  console.log(`Mode: ${options.mode}`);
  console.log(`Completed CSV files: ${fileCount}`);
  console.log(`CSV rows read: ${records.length}`);
  for (const [outcome, count] of [...outcomes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${outcome}: ${count}`);
  }
  console.log(`Report: ${reportPath}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const records = await readCompletedRecords(options.inputDir);
  const files = await readdir(options.inputDir, { withFileTypes: true });
  const fileCount = files.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv")).length;
  const duplicateIds = findDuplicateIds(records);
  const validationErrors: string[] = [];
  if (duplicateIds.size > 0) {
    validationErrors.push(`Duplicate or blank IDs found: ${[...duplicateIds].slice(0, 10).join(", ")}${duplicateIds.size > 10 ? "..." : ""}`);
    for (const record of records) {
      if (duplicateIds.has(record.id || "<blank id>")) {
        record.outcome = "duplicate_or_blank_id";
        record.detail = "Each CSV row must have one unique nonblank id.";
      }
    }
  }

  const uniqueIds = [...new Set(records.map((record) => record.id).filter(Boolean))];
  const localInstitutions = await loadInstitutionsById("local", uniqueIds);
  validationErrors.push(...verifyStaticFields(records, localInstitutions));

  let updates: EnrichedRecord[] = [];
  if (validationErrors.length === 0) {
    if (options.target === "local") {
      updates = setLocalOutcomes(records, localInstitutions);
    } else {
      const references = records
        .filter((record) => record.outcome === "pending" && record.source && record.sourceId)
        .map((record) => ({ source: record.source as string, sourceId: record.sourceId as string }));
      const remoteInstitutions = await loadInstitutionsBySourceKey(references);
      updates = setRemoteOutcomes(records, localInstitutions, remoteInstitutions);
    }
  }

  if (validationErrors.length > 0) {
    console.error(`Validation failed with ${validationErrors.length} structural issue${validationErrors.length === 1 ? "" : "s"}. No updates were applied.`);
    for (const error of validationErrors.slice(0, 20)) console.error(`  ${error}`);
    if (validationErrors.length > 20) console.error(`  ...and ${validationErrors.length - 20} more.`);
  } else if (options.mode === "apply") {
    await applyUpdates(options.target, updates, options.updateBatchSize);
    for (const record of updates) {
      record.outcome = options.target === "local" ? "updated_local" : "updated_remote";
    }
  }

  const reportPath = await writeReport(records, options);
  printSummary(records, fileCount, options, reportPath);
  if (options.mode === "dry-run") console.log("Dry run: no D1 rows were changed.");
  if (validationErrors.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

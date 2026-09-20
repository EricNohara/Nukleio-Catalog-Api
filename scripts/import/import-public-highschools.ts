import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import path from "node:path";
import { parse } from "csv-parse";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_INPUT = path.join(REPOSITORY_ROOT, "data", "public_highschools.csv");
const DEFAULT_SOURCE_YEAR = 2025;
const DEFAULT_BATCH_SIZE = 200;
const DATABASE_NAME = "nukleio-catalog";
const SOURCE = "CCD";
const CATEGORY = "high_school";
const SOURCE_URL = "https://nces.ed.gov/ccd/psu_rev.asp";
const ACTIVE_STATUS_TEXT = new Set([
  "Open",
  "New",
  "Added",
  "Reopened",
  "Changed Boundary/Agency",
]);
const HIGH_SCHOOL_GRADE_COLUMNS = [
  "G_9_OFFERED",
  "G_10_OFFERED",
  "G_11_OFFERED",
  "G_12_OFFERED",
];
const ALLOWED_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

const REQUIRED_COLUMNS = [
  "NCESSCH",
  "SCH_NAME",
  "LCITY",
  "LSTATE",
  "WEBSITE",
  "SY_STATUS_TEXT",
  ...HIGH_SCHOOL_GRADE_COLUMNS,
];

type Mode = "dry-run" | "local" | "remote";

type Options = {
  inputPath: string;
  sourceYear: number;
  batchSize: number;
  mode: Mode;
};

type HighSchoolRecord = {
  id: string;
  source: string;
  sourceId: string;
  name: string;
  normalizedName: string;
  category: typeof CATEGORY;
  city: string | null;
  state: string;
  country: "US";
  website: string | null;
  logoKey: null;
  sourceYear: number;
  isActive: 1;
  importedAt: string;
};

type ImportStats = {
  totalRows: number;
  selectedRows: number;
  invalidRows: number;
  duplicateSourceIds: number;
  invalidWebsites: number;
  skippedByReason: Record<string, number>;
  examples: Array<{ row: number; sourceId: string | null; reasons: string[] }>;
};

function usage(): never {
  console.log(`Usage:
  npm run import:public-highschools -- --dry-run
  npm run import:public-highschools -- --import
  npm run import:public-highschools -- --remote

Options:
  --input <path>          Input CSV (default: data/public_highschools.csv)
  --source-year <year>    CCD source year (default: 2025)
  --batch-size <count>    D1 rows per operation, max 250 (default: 200)
  --dry-run               Validate and report only (default)
  --import                Import into local D1
  --remote                Import into remote D1
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let mode: Mode = "dry-run";
  let inputPath = DEFAULT_INPUT;
  let sourceYear = DEFAULT_SOURCE_YEAR;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      if (mode !== "dry-run") throw new Error("Choose only one of --dry-run, --import, or --remote.");
      mode = "dry-run";
      continue;
    }
    if (argument === "--import") {
      if (mode !== "dry-run") throw new Error("Choose only one of --dry-run, --import, or --remote.");
      mode = "local";
      continue;
    }
    if (argument === "--remote") {
      if (mode !== "dry-run") throw new Error("Choose only one of --dry-run, --import, or --remote.");
      mode = "remote";
      continue;
    }
    if (argument === "--input" || argument === "--source-year" || argument === "--batch-size") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--input") inputPath = path.resolve(REPOSITORY_ROOT, value);
      if (argument === "--source-year") sourceYear = Number(value);
      if (argument === "--batch-size") batchSize = Number(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isInteger(sourceYear) || sourceYear < 2000 || sourceYear > 2100) {
    throw new Error("--source-year must be a four-digit year.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 250) {
    throw new Error("--batch-size must be an integer between 1 and 250.");
  }

  return { inputPath, sourceYear, batchSize, mode };
}

function clean(value: unknown): string {
  const text = String(value ?? "").replace(/^\uFEFF/, "").trim();
  return ["-1", "-2", "-3"].includes(text) ? "" : text;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWebsite(value: unknown): { value: string | null; invalid: boolean } {
  const raw = clean(value);
  if (!raw) return { value: null, invalid: false };

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) throw new Error("Missing hostname");
    return { value: candidate, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}

function incrementReason(stats: ImportStats, reason: string): void {
  stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1;
}

function rejectRow(
  stats: ImportStats,
  row: number,
  sourceId: string | null,
  reasons: string[],
): void {
  stats.invalidRows += 1;
  for (const reason of reasons) incrementReason(stats, reason);
  if (stats.examples.length < 10) stats.examples.push({ row, sourceId, reasons });
}

async function writeStageLine(stream: ReturnType<typeof createWriteStream>, value: string): Promise<void> {
  if (!stream.write(`${value}\n`)) await once(stream, "drain");
}

async function parseCsv(
  inputPath: string,
  sourceYear: number,
  stagePath: string | null,
): Promise<ImportStats> {
  const stats: ImportStats = {
    totalRows: 0,
    selectedRows: 0,
    invalidRows: 0,
    duplicateSourceIds: 0,
    invalidWebsites: 0,
    skippedByReason: {},
    examples: [],
  };
  const seenSourceIds = new Set<string>();
  const stageStream = stagePath ? createWriteStream(stagePath, { encoding: "utf8" }) : null;

  try {
    const parser = createReadStream(inputPath).pipe(parse({
      bom: true,
      columns: (header: string[]) => {
        const columns = header.map((column) => column.trim());
        const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
        if (missing.length > 0) throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);
        return columns;
      },
      skip_empty_lines: true,
      relax_column_count: false,
      trim: false,
    }));

    for await (const rawRecord of parser) {
      stats.totalRows += 1;
      const row = rawRecord as Record<string, string>;
      const sourceId = clean(row.NCESSCH) || null;
      const name = clean(row.SCH_NAME);
      const state = clean(row.LSTATE).toUpperCase();
      const status = clean(row.SY_STATUS_TEXT);
      const reasons: string[] = [];

      if (!sourceId) reasons.push("missing_source_id");
      else if (!/^\d+$/.test(sourceId) || Number(sourceId) <= 0) reasons.push("invalid_source_id");
      if (!name) reasons.push("missing_name");
      if (!ACTIVE_STATUS_TEXT.has(status)) reasons.push("inactive_or_noncurrent_status");
      if (!ALLOWED_STATES.has(state)) reasons.push("outside_50_states");
      if (!HIGH_SCHOOL_GRADE_COLUMNS.some((column) => clean(row[column]) === "Yes")) {
        reasons.push("no_grade_9_to_12_offered");
      }

      if (sourceId && seenSourceIds.has(sourceId)) {
        stats.duplicateSourceIds += 1;
        reasons.push("duplicate_source_id");
      } else if (sourceId) {
        seenSourceIds.add(sourceId);
      }

      if (reasons.length > 0) {
        rejectRow(stats, stats.totalRows, sourceId, reasons);
        continue;
      }

      if (!sourceId) throw new Error(`Internal validation error on source row ${stats.totalRows}: missing NCESSCH.`);

      const website = normalizeWebsite(row.WEBSITE);
      if (website.invalid) stats.invalidWebsites += 1;

      const record: HighSchoolRecord = {
        id: randomUUID(),
        source: SOURCE,
        sourceId,
        name,
        normalizedName: normalizeName(name),
        category: CATEGORY,
        city: clean(row.LCITY) || null,
        state,
        country: "US",
        website: website.value,
        logoKey: null,
        sourceYear,
        isActive: 1,
        importedAt: new Date().toISOString(),
      };

      stats.selectedRows += 1;
      if (stageStream) await writeStageLine(stageStream, JSON.stringify(record));
    }
  } finally {
    if (stageStream) {
      stageStream.end();
      await finished(stageStream);
    }
  }

  return stats;
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function buildBatchSql(records: HighSchoolRecord[]): string {
  const values = records.map((record) => `(
    ${sqlValue(record.id)},
    ${sqlValue(record.source)},
    ${sqlValue(record.sourceId)},
    ${sqlValue(record.name)},
    ${sqlValue(record.normalizedName)},
    ${sqlValue(record.category)},
    ${sqlValue(record.city)},
    ${sqlValue(record.state)},
    ${sqlValue(record.country)},
    ${sqlValue(record.website)},
    NULL,
    ${sqlValue(record.sourceYear)},
    ${record.isActive},
    ${sqlValue(record.importedAt)}
  )`).join(",\n");

  return `INSERT INTO educational_institutions (
  id, source, source_id, name, normalized_name, category, city, state,
  country, website, logo_key, source_year, is_active, imported_at
)
VALUES
${values}
ON CONFLICT (source, source_id) DO UPDATE SET
  name = excluded.name,
  normalized_name = excluded.normalized_name,
  category = excluded.category,
  city = excluded.city,
  state = excluded.state,
  country = excluded.country,
  website = excluded.website,
  source_year = excluded.source_year,
  is_active = excluded.is_active,
  imported_at = excluded.imported_at,
  updated_at = CURRENT_TIMESTAMP;\n`;
}

async function runWrangler(args: string[]): Promise<void> {
  const wranglerScript = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = await execFileAsync(process.execPath, [wranglerScript, ...args], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function importStage(
  stagePath: string,
  sourceYear: number,
  inputPath: string,
  selectedRows: number,
  batchSize: number,
  mode: Exclude<Mode, "dry-run">,
  tempDir: string,
): Promise<void> {
  const targetFlag = mode === "remote" ? "--remote" : "--local";
  const reader = createInterface({
    input: createReadStream(stagePath),
    crlfDelay: Infinity,
  });
  let batch: HighSchoolRecord[] = [];
  let batchNumber = 0;

  const executeBatch = async (records: HighSchoolRecord[]): Promise<void> => {
    batchNumber += 1;
    const sqlPath = path.join(tempDir, `batch-${String(batchNumber).padStart(5, "0")}.sql`);
    await writeFile(sqlPath, buildBatchSql(records), "utf8");
    console.log(`Applying batch ${batchNumber} (${records.length} rows)...`);
    await runWrangler(["d1", "execute", DATABASE_NAME, targetFlag, "--file", sqlPath, "--yes"]);
  };

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line) as HighSchoolRecord);
      if (batch.length >= batchSize) {
        await executeBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await executeBatch(batch);
  } finally {
    reader.close();
  }

  const importBatchSql = `INSERT INTO import_batches
  (source, source_year, source_url, file_name, row_count, status)
VALUES
  (${sqlValue(SOURCE)}, ${sourceYear}, ${sqlValue(SOURCE_URL)}, ${sqlValue(path.basename(inputPath))}, ${selectedRows}, 'completed');\n`;
  const importBatchPath = path.join(tempDir, "import-batch.sql");
  await writeFile(importBatchPath, importBatchSql, "utf8");
  await runWrangler(["d1", "execute", DATABASE_NAME, targetFlag, "--file", importBatchPath, "--yes"]);
}

function printSummary(stats: ImportStats, options: Options): void {
  console.log("\nCCD public high school import summary");
  console.log(`Input: ${options.inputPath}`);
  console.log(`Source year: ${options.sourceYear}`);
  console.log(`Mode: ${options.mode}`);
  console.log(`Total source rows: ${stats.totalRows}`);
  console.log(`Rows selected: ${stats.selectedRows}`);
  console.log(`Rows skipped: ${stats.invalidRows}`);
  console.log(`Duplicate source IDs: ${stats.duplicateSourceIds}`);
  console.log(`Invalid websites converted to NULL: ${stats.invalidWebsites}`);
  console.log("Skipped by reason:");
  for (const [reason, count] of Object.entries(stats.skippedByReason).sort()) {
    console.log(`  ${reason}: ${count}`);
  }
  if (stats.examples.length > 0) {
    console.log("Examples of skipped rows:");
    for (const example of stats.examples) {
      console.log(`  row ${example.row} (${example.sourceId ?? "no NCESSCH"}): ${example.reasons.join(", ")}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const tempParent = path.join(REPOSITORY_ROOT, "data", "tmp");
  const tempDir = options.mode === "dry-run" ? null : await (async () => {
    await mkdir(tempParent, { recursive: true });
    return mkdtemp(path.join(tempParent, "ccd-public-highschools-"));
  })();
  const stagePath = tempDir ? path.join(tempDir, "normalized.jsonl") : null;

  try {
    const stats = await parseCsv(options.inputPath, options.sourceYear, stagePath);
    printSummary(stats, options);

    if (options.mode !== "dry-run" && stats.selectedRows > 0 && stagePath && tempDir) {
      await importStage(
        stagePath,
        options.sourceYear,
        options.inputPath,
        stats.selectedRows,
        options.batchSize,
        options.mode,
        tempDir,
      );
      console.log(`\nImported ${stats.selectedRows} public high school rows into ${options.mode === "remote" ? "remote" : "local"} D1.`);
    }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

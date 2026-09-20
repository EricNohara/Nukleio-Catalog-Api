import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const DEFAULT_OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "audits");
const DEFAULT_BATCH_SIZE = 25;

type Mode = "dry-run" | "local" | "remote";

type Options = {
  mode: Mode;
  target: "local" | "remote";
  outputDir: string;
  batchSize: number;
};

type Institution = {
  id: string;
  source: string;
  source_id: string;
  name: string;
  normalized_name: string;
  category: "college" | "high_school";
  city: string | null;
  state: string | null;
  country: string;
  website: string | null;
  logo_key: string | null;
  source_year: number | null;
  is_active: number;
  created_at: string;
  imported_at: string;
  updated_at: string;
};

type MergePlan = {
  groupKey: string;
  category: Institution["category"];
  normalizedName: string;
  normalizedCity: string;
  state: string;
  canonical: Institution;
  merged: {
    name: string;
    normalized_name: string;
    city: string | null;
    state: string | null;
    country: string;
    website: string | null;
    logo_key: string | null;
    source_year: number | null;
    is_active: number;
  };
  rows: Institution[];
  conflicts: Record<string, string[]>;
};

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\audit\\consolidate-education-duplicates.ts --dry-run
  .\\node_modules\\.bin\\tsx.cmd scripts\\audit\\consolidate-education-duplicates.ts --apply
  .\\node_modules\\.bin\\tsx.cmd scripts\\audit\\consolidate-education-duplicates.ts --remote --dry-run
  .\\node_modules\\.bin\\tsx.cmd scripts\\audit\\consolidate-education-duplicates.ts --remote --apply

Options:
  --dry-run               Read and report only (default)
  --apply                 Apply consolidation to local D1
  --remote                Read/apply against remote D1 when combined with --apply
  --output <path>         Output directory (default: data/audits)
  --batch-size <count>    Merge groups per D1 SQL file (default: 25)
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let mode: Mode = "dry-run";
  let outputDir = DEFAULT_OUTPUT_DIR;
  let batchSize = DEFAULT_BATCH_SIZE;
  let applyRequested = false;
  let remoteRequested = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") continue;
    if (argument === "--apply") {
      applyRequested = true;
      continue;
    }
    if (argument === "--remote") {
      remoteRequested = true;
      continue;
    }
    if (argument === "--output" || argument === "--batch-size") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--output") outputDir = path.resolve(REPOSITORY_ROOT, value);
      else batchSize = Number(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  const target = remoteRequested ? "remote" : "local";
  if (applyRequested && remoteRequested) mode = "remote";
  else if (applyRequested) mode = "local";
  else mode = "dry-run";

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("--batch-size must be an integer between 1 and 100.");
  }

  return { mode, target, outputDir, batchSize };
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizePart(value: string | null): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasValue(value: string | number | null): boolean {
  return value !== null && String(value).trim() !== "";
}

function completeness(row: Institution): number {
  return [
    row.name,
    row.normalized_name,
    row.city,
    row.state,
    row.country,
    row.website,
    row.logo_key,
    row.source_year,
  ].filter((value) => hasValue(value)).length;
}

function rowSort(left: Institution, right: Institution): number {
  return completeness(right) - completeness(left)
    || Number(Boolean(right.website)) - Number(Boolean(left.website))
    || left.source.localeCompare(right.source)
    || left.source_id.localeCompare(right.source_id)
    || left.id.localeCompare(right.id);
}

function chooseValue<T extends string | number | null>(rows: Institution[], get: (row: Institution) => T): T {
  const ordered = [...rows].sort(rowSort);
  return ordered.find((row) => hasValue(get(row))) ? get(ordered.find((row) => hasValue(get(row))) as Institution) : null as T;
}

function distinctValues(rows: Institution[], get: (row: Institution) => string | number | null): string[] {
  return [...new Set(rows.map(get).filter((value) => hasValue(value)).map((value) => String(value)))].sort();
}

function buildPlan(rows: Institution[]): MergePlan {
  const ordered = [...rows].sort(rowSort);
  const canonical = ordered[0];
  const normalizedName = normalizePart(canonical.normalized_name || canonical.name);
  const normalizedCity = normalizePart(canonical.city);
  const state = (canonical.state ?? "").trim().toUpperCase();
  const conflicts: Record<string, string[]> = {};

  const fields: Array<[string, (row: Institution) => string | number | null]> = [
    ["name", (row) => row.name],
    ["city", (row) => row.city],
    ["state", (row) => row.state],
    ["country", (row) => row.country],
    ["website", (row) => row.website],
    ["logo_key", (row) => row.logo_key],
    ["source_year", (row) => row.source_year],
  ];
  for (const [field, get] of fields) {
    const values = distinctValues(rows, get);
    if (values.length > 1) conflicts[field] = values;
  }

  const mergedName = chooseValue(rows, (row) => row.name) ?? canonical.name;
  const mergedCity = chooseValue(rows, (row) => row.city);
  const mergedState = chooseValue(rows, (row) => row.state);
  const mergedCountry = chooseValue(rows, (row) => row.country) ?? "US";
  const mergedWebsite = chooseValue(rows, (row) => row.website);
  const mergedLogoKey = chooseValue(rows, (row) => row.logo_key);
  const sourceYears = rows.map((row) => row.source_year).filter((value): value is number => value !== null);

  return {
    groupKey: `${canonical.category} | ${state} | ${normalizedName} | ${normalizedCity}`,
    category: canonical.category,
    normalizedName,
    normalizedCity,
    state,
    canonical,
    merged: {
      name: mergedName,
      normalized_name: normalizedName,
      city: mergedCity,
      state: mergedState,
      country: mergedCountry,
      website: mergedWebsite,
      logo_key: mergedLogoKey,
      source_year: sourceYears.length > 0 ? Math.max(...sourceYears) : null,
      is_active: rows.some((row) => row.is_active === 1) ? 1 : 0,
    },
    rows,
    conflicts,
  };
}

function groupRows(rows: Institution[]): { plans: MergePlan[]; ungroupable: number } {
  const groups = new Map<string, Institution[]>();
  let ungroupable = 0;
  for (const row of rows) {
    const normalizedName = normalizePart(row.normalized_name || row.name);
    const normalizedCity = normalizePart(row.city);
    const state = (row.state ?? "").trim().toUpperCase();
    if (!normalizedName || !normalizedCity || !state) {
      ungroupable += 1;
      continue;
    }
    const key = `${row.category}\u0000${state}\u0000${normalizedName}\u0000${normalizedCity}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return {
    plans: [...groups.values()]
      .filter((group) => group.length > 1)
      .map(buildPlan)
      .sort((left, right) => right.rows.length - left.rows.length || left.groupKey.localeCompare(right.groupKey)),
    ungroupable,
  };
}

async function runWrangler(args: string[]): Promise<string> {
  const wranglerScript = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = await execFileAsync(process.execPath, [wranglerScript, ...args], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 60 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

async function queryD1<T>(mode: Mode, sql: string): Promise<T[]> {
  const target = mode === "remote" ? "--remote" : "--local";
  const output = await runWrangler([
    "d1", "execute", DATABASE_NAME, target, "--json", "--command", sql,
  ]);
  const payload = JSON.parse(output) as Array<{ results?: T[]; success?: boolean }>;
  if (!payload[0]?.success || !payload[0].results) throw new Error("Wrangler returned an unsuccessful D1 query.");
  return payload[0].results;
}

function csvValue(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value).replaceAll("\u0000", " ");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeReports(plans: MergePlan[], outputDir: string, mode: Mode): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    database: DATABASE_NAME,
    mode,
    groupCount: plans.length,
    rowCount: plans.reduce((sum, plan) => sum + plan.rows.length, 0),
    duplicateRowCount: plans.reduce((sum, plan) => sum + plan.rows.length - 1, 0),
    conflictGroupCount: plans.filter((plan) => Object.keys(plan.conflicts).length > 0).length,
    plans,
  };
  await writeFile(
    path.join(outputDir, "education-consolidation-plan.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  const header = [
    "group_key", "action", "canonical_id", "canonical_source", "canonical_source_id",
    "category", "name", "city", "state", "website", "source", "source_id",
    "source_year", "merged_website", "conflict_fields", "all_source_ids",
  ];
  const lines = [header.join(",")];
  for (const plan of plans) {
    const sourceIds = plan.rows.map((row) => `${row.source}:${row.source_id}`).join(" | ");
    for (const row of plan.rows) {
      lines.push([
        plan.groupKey,
        row.id === plan.canonical.id ? "keep" : "delete_after_merge",
        plan.canonical.id,
        plan.canonical.source,
        plan.canonical.source_id,
        row.category,
        row.name,
        row.city,
        row.state,
        row.website,
        row.source,
        row.source_id,
        row.source_year,
        plan.merged.website,
        Object.keys(plan.conflicts).join(" | "),
        sourceIds,
      ].map(csvValue).join(","));
    }
  }
  await writeFile(
    path.join(outputDir, "education-consolidation-plan.csv"),
    `\uFEFF${lines.join("\r\n")}\r\n`,
    "utf8",
  );
}

function buildPlanSql(plan: MergePlan): string {
  const canonical = plan.canonical;
  const merged = plan.merged;
  const duplicateIds = plan.rows.filter((row) => row.id !== canonical.id).map((row) => sqlValue(row.id));
  const deleteStatement = duplicateIds.length > 0
    ? `DELETE FROM educational_institutions WHERE id IN (${duplicateIds.join(", ")});`
    : "";

  return `UPDATE educational_institutions SET
  name = ${sqlValue(merged.name)},
  normalized_name = ${sqlValue(merged.normalized_name)},
  category = ${sqlValue(plan.category)},
  city = ${sqlValue(merged.city)},
  state = ${sqlValue(merged.state)},
  country = ${sqlValue(merged.country)},
  website = ${sqlValue(merged.website)},
  logo_key = ${sqlValue(merged.logo_key)},
  source_year = ${sqlValue(merged.source_year)},
  is_active = ${merged.is_active},
  updated_at = CURRENT_TIMESTAMP
WHERE id = ${sqlValue(canonical.id)};
${deleteStatement}
`;
}

async function applyPlans(plans: MergePlan[], options: Options): Promise<void> {
  const tempParent = path.join(REPOSITORY_ROOT, "data", "tmp");
  await mkdir(tempParent, { recursive: true });
  const tempDir = await mkdtemp(path.join(tempParent, "education-consolidation-"));
  const target = options.mode === "remote" ? "--remote" : "--local";
  try {
    for (let index = 0; index < plans.length; index += options.batchSize) {
      const batch = plans.slice(index, index + options.batchSize);
      const sqlPath = path.join(tempDir, `batch-${String(Math.floor(index / options.batchSize) + 1).padStart(5, "0")}.sql`);
      await writeFile(sqlPath, batch.map(buildPlanSql).join("\n"), "utf8");
      console.log(`Applying consolidation batch ${Math.floor(index / options.batchSize) + 1} (${batch.length} groups)...`);
      await runWrangler(["d1", "execute", DATABASE_NAME, target, "--file", sqlPath, "--yes"]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const institutions = await queryD1<Institution>(options.target === "remote" ? "remote" : "local", `SELECT
  id, source, source_id, name, normalized_name, category, city, state,
  country, website, logo_key, source_year, is_active,
  created_at, imported_at, updated_at
FROM educational_institutions
ORDER BY category, state, normalized_name, city, source, source_id;`);
  const { plans, ungroupable } = groupRows(institutions);

  await writeReports(plans, options.outputDir, options.mode);
  console.log("Education consolidation summary");
  console.log(`Database: ${DATABASE_NAME} (${options.target})`);
  console.log(`Institutions scanned: ${institutions.length}`);
  console.log(`Rows without a complete name/city/state key: ${ungroupable}`);
  console.log(`Duplicate groups: ${plans.length}`);
  console.log(`Rows in duplicate groups: ${plans.reduce((sum, plan) => sum + plan.rows.length, 0)}`);
  console.log(`Rows that would be removed: ${plans.reduce((sum, plan) => sum + plan.rows.length - 1, 0)}`);
  console.log(`Groups with field conflicts: ${plans.filter((plan) => Object.keys(plan.conflicts).length > 0).length}`);
  console.log(`JSON plan: ${path.join(options.outputDir, "education-consolidation-plan.json")}`);
  console.log(`CSV plan: ${path.join(options.outputDir, "education-consolidation-plan.csv")}`);

  if (options.mode === "dry-run") {
    console.log("No database rows were changed.");
    return;
  }

  if (plans.length === 0) {
    console.log("No duplicate groups found; nothing to apply.");
    return;
  }
  await applyPlans(plans, options);
  console.log(`Applied consolidation to ${options.target} D1.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

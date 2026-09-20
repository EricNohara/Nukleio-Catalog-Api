import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const DEFAULT_OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "audits");

type Institution = {
  id: string;
  source: string;
  source_id: string;
  name: string;
  normalized_name: string;
  category: string;
  city: string | null;
  state: string | null;
  country: string;
  source_year: number | null;
  is_active: number;
};

type CandidateGroup = {
  key: string;
  category: string;
  state: string | null;
  city: string | null;
  normalizedName: string;
  candidateType: "same_source_location" | "cross_source_location" | "same_name_state";
  rows: Institution[];
};

type AuditReport = {
  generatedAt: string;
  database: string;
  mode: "local-read-only";
  totals: {
    institutions: number;
    sourceKeyCollisionGroups: number;
    exactLocationCandidateGroups: number;
    exactLocationCandidateRows: number;
    sameNameStateCandidateGroups: number;
    sameNameStateCandidateRows: number;
  };
  sourceKeyCollisions: CandidateGroup[];
  exactLocationCandidates: CandidateGroup[];
  sameNameStateCandidates: CandidateGroup[];
};

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\audit\\audit-education-duplicates.ts

Options:
  --output <path>   Output directory (default: data/audits)
`);
  process.exit(0);
}

function parseOutputDir(argv: string[]): string {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a value.");
      outputDir = path.resolve(REPOSITORY_ROOT, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return outputDir;
}

async function queryLocal<T>(sql: string): Promise<T[]> {
  const wranglerScript = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = await execFileAsync(process.execPath, [
    wranglerScript,
    "d1",
    "execute",
    DATABASE_NAME,
    "--local",
    "--json",
    "--command",
    sql,
  ], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  });

  const payload = JSON.parse(result.stdout) as Array<{ results?: T[]; success?: boolean }>;
  if (!payload[0]?.success || !payload[0].results) {
    throw new Error("Wrangler returned an unsuccessful local D1 query.");
  }
  return payload[0].results;
}

function groupBy(rows: Institution[], keyFn: (row: Institution) => string): Map<string, Institution[]> {
  const groups = new Map<string, Institution[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function candidateGroup(
  key: string,
  rows: Institution[],
  candidateType: CandidateGroup["candidateType"],
): CandidateGroup {
  const first = rows[0];
  return {
    key: key.replaceAll("\u0000", " | "),
    category: first.category,
    state: first.state,
    city: first.city,
    normalizedName: first.normalized_name,
    candidateType,
    rows,
  };
}

function makeGroups(
  rows: Institution[],
  keyFn: (row: Institution) => string,
  candidateType: CandidateGroup["candidateType"],
): CandidateGroup[] {
  return [...groupBy(rows, keyFn).entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => candidateGroup(key, group, candidateType))
    .sort((left, right) => right.rows.length - left.rows.length || left.key.localeCompare(right.key));
}

function csvValue(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCandidateCsv(groups: CandidateGroup[]): string {
  const header = [
    "candidate_type",
    "group_key",
    "group_size",
    "category",
    "state",
    "city",
    "normalized_name",
    "id",
    "source",
    "source_id",
    "name",
    "source_year",
    "is_active",
  ];
  const lines = [header.join(",")];
  for (const group of groups) {
    for (const row of group.rows) {
      lines.push([
        group.candidateType,
        group.key,
        group.rows.length,
        row.category,
        row.state,
        row.city,
        row.normalized_name,
        row.id,
        row.source,
        row.source_id,
        row.name,
        row.source_year,
        row.is_active,
      ].map(csvValue).join(","));
    }
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

async function main(): Promise<void> {
  const outputDir = parseOutputDir(process.argv.slice(2));
  const institutions = await queryLocal<Institution>(`SELECT
  id, source, source_id, name, normalized_name, category, city, state,
  country, source_year, is_active
FROM educational_institutions
ORDER BY category, state, normalized_name, city, source, source_id;`);

  const sourceKeyCollisions = makeGroups(
    institutions,
    (row) => `${row.source}\u0000${row.source_id}`,
    "same_source_location",
  );
  const exactLocationCandidates = makeGroups(
    institutions.filter((row) => row.city !== null && row.city.trim() !== ""),
    (row) => `${row.category}\u0000${row.state ?? ""}\u0000${row.normalized_name}\u0000${row.city}`,
    "same_source_location",
  ).map((group) => ({
    ...group,
    candidateType: new Set(group.rows.map((row) => row.source)).size > 1
      ? "cross_source_location" as const
      : "same_source_location" as const,
  }));
  const sameNameStateCandidates = makeGroups(
    institutions,
    (row) => `${row.category}\u0000${row.state ?? ""}\u0000${row.normalized_name}`,
    "same_name_state",
  );

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    database: DATABASE_NAME,
    mode: "local-read-only",
    totals: {
      institutions: institutions.length,
      sourceKeyCollisionGroups: sourceKeyCollisions.length,
      exactLocationCandidateGroups: exactLocationCandidates.length,
      exactLocationCandidateRows: exactLocationCandidates.reduce((sum, group) => sum + group.rows.length, 0),
      sameNameStateCandidateGroups: sameNameStateCandidates.length,
      sameNameStateCandidateRows: sameNameStateCandidates.reduce((sum, group) => sum + group.rows.length, 0),
    },
    sourceKeyCollisions,
    exactLocationCandidates,
    sameNameStateCandidates,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "education-duplicate-candidates.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(outputDir, "education-duplicate-exact-location.csv"),
    buildCandidateCsv(exactLocationCandidates),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "education-duplicate-same-name-state.csv"),
    buildCandidateCsv(sameNameStateCandidates),
    "utf8",
  );

  console.log("Education duplicate audit summary");
  console.log(`Database: ${DATABASE_NAME} (local)`);
  console.log(`Institutions scanned: ${institutions.length}`);
  console.log(`Source-key collision groups: ${sourceKeyCollisions.length}`);
  console.log(`Exact name/state/city candidate groups: ${exactLocationCandidates.length}`);
  console.log(`Rows in exact-location groups: ${report.totals.exactLocationCandidateRows}`);
  console.log(`Same name/state candidate groups: ${sameNameStateCandidates.length}`);
  console.log(`Rows in same-name/state groups: ${report.totals.sameNameStateCandidateRows}`);
  console.log(`JSON report: ${path.join(outputDir, "education-duplicate-candidates.json")}`);
  console.log(`Exact-location CSV: ${path.join(outputDir, "education-duplicate-exact-location.csv")}`);
  console.log(`Same-name/state CSV: ${path.join(outputDir, "education-duplicate-same-name-state.csv")}`);
  console.log("No database rows were changed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

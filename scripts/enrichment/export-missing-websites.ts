import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "enrichments", "website-batches");
const BATCH_FILE_PATTERN = /^website-research-batch-\d+\.csv$/;

type Institution = {
  id: string;
  name: string;
  category: string;
  city: string | null;
  state: string | null;
  country: string | null;
  website: string | null;
};

type Options = {
  batchSize: number;
  outputDir: string;
  dryRun: boolean;
};

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\enrichment\\export-missing-websites.ts

Options:
  --batch-size <count>  Rows per CSV file; 1-500 (default: 100)
  --output <path>       Output directory (default: data/enrichments/website-batches)
  --dry-run             Report the number of batches without writing files

The script reads local D1 only. Each CSV contains id, name, category, city,
state, country, and a blank website column for ChatGPT enrichment.
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let batchSize = DEFAULT_BATCH_SIZE;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--batch-size" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--batch-size") batchSize = Number(value);
      if (argument === "--output") outputDir = path.resolve(REPOSITORY_ROOT, value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("--batch-size must be an integer between 1 and 500.");
  }
  return { batchSize, outputDir, dryRun };
}

function csvValue(value: string | null): string {
  if (value === null) return "";
  const text = value.replaceAll("\u0000", " ");
  return /[\",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(rows: Institution[]): string {
  const header = ["id", "name", "category", "city", "state", "country", "website"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.name,
      row.category,
      row.city,
      row.state,
      row.country,
      "",
    ].map(csvValue).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
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

async function removePreviousBatchFiles(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const entries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && BATCH_FILE_PATTERN.test(entry.name))
    .map((entry) => rm(path.join(outputDir, entry.name))));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const institutions = await queryLocal<Institution>(`SELECT
  id, name, category, city, state, country, website
FROM educational_institutions
WHERE website IS NULL
   OR TRIM(website) = ''
ORDER BY category, state, city, name, id;`);
  const batchCount = Math.ceil(institutions.length / options.batchSize);

  console.log("Missing website export summary");
  console.log(`Database: ${DATABASE_NAME} (local)`);
  console.log(`Institutions without a website: ${institutions.length}`);
  console.log(`Rows per CSV batch: ${options.batchSize}`);
  console.log(`CSV batches: ${batchCount}`);
  console.log(`Output directory: ${options.outputDir}`);

  if (options.dryRun) {
    console.log("Dry run: no CSV files were written.");
    return;
  }

  await removePreviousBatchFiles(options.outputDir);
  for (let offset = 0; offset < institutions.length; offset += options.batchSize) {
    const batchNumber = Math.floor(offset / options.batchSize) + 1;
    const fileName = `website-research-batch-${String(batchNumber).padStart(4, "0")}.csv`;
    await writeFile(
      path.join(options.outputDir, fileName),
      buildCsv(institutions.slice(offset, offset + options.batchSize)),
      "utf8",
    );
  }

  console.log(`Wrote ${batchCount} CSV batch file${batchCount === 1 ? "" : "s"}.`);
  console.log("No D1 rows were changed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

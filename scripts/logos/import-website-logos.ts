import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const R2_BUCKET = "nukleio-catalog-assets";
const LOGO_API_BASE_URL = "https://logos-api.apistemic.com";
const DEFAULT_OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "audits");
const DEFAULT_UPDATE_BATCH_SIZE = 25;
const DEFAULT_REQUEST_INTERVAL_MS = 1_000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100_000;

type Institution = {
  id: string;
  name: string;
  normalized_name: string;
  category: "college" | "high_school";
  city: string | null;
  state: string | null;
  website: string;
  logo_key: string | null;
};

type Mode = "dry-run" | "apply";

type Options = {
  mode: Mode;
  contactEmail: string | null;
  limit: number | null;
  force: boolean;
  outputDir: string;
  requestIntervalMs: number;
  updateBatchSize: number;
};

type Outcome =
  | "would_process"
  | "uploaded"
  | "skipped_existing_logo_key"
  | "missing_logo"
  | "invalid_website"
  | "invalid_image"
  | "oversize_after_compression"
  | "request_error"
  | "upload_error"
  | "database_error";

type ProcessResult = {
  institution: Institution;
  domain: string | null;
  outcome: Outcome;
  logoKey: string | null;
  sourceBytes: number | null;
  outputBytes: number | null;
  detail: string | null;
};

type DomainResult = {
  outcome: Exclude<Outcome, "would_process" | "skipped_existing_logo_key" | "invalid_website" | "database_error">;
  logoKey: string | null;
  sourceBytes: number | null;
  outputBytes: number | null;
  detail: string | null;
};

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\logos\\import-website-logos.ts --dry-run
  .\\node_modules\\.bin\\tsx.cmd scripts\\logos\\import-website-logos.ts --apply --contact-email you@example.com

Options:
  --dry-run                    Read local D1 and report only (default)
  --apply                      Download logos, upload to remote R2, and update local D1
  --contact-email <email>      Required with --apply for the provider User-Agent
  --limit <count>              Process at most this many local institutions this run
  --force                      Reprocess rows that already have a logo_key
  --request-interval-ms <ms>   Provider request spacing; minimum 1000 (default: 1000)
  --update-batch-size <count>  Local D1 updates per batch; 1-100 (default: 25)
  --output <path>              Output directory (default: data/audits)

The provider is called once per unique website domain with fallback=404, so
placeholder monograms are never stored. Successful assets are converted to
WebP at 100 KB or less and stored under education/colleges/ or
education/high-schools/ in R2.
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let mode: Mode = "dry-run";
  let contactEmail: string | null = null;
  let limit: number | null = null;
  let force = false;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS;
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
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (["--contact-email", "--limit", "--output", "--request-interval-ms", "--update-batch-size"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--contact-email") contactEmail = value.trim();
      if (argument === "--limit") limit = Number(value);
      if (argument === "--output") outputDir = path.resolve(REPOSITORY_ROOT, value);
      if (argument === "--request-interval-ms") requestIntervalMs = Number(value);
      if (argument === "--update-batch-size") updateBatchSize = Number(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (mode === "apply" && (!contactEmail || !/^\S+@\S+\.\S+$/.test(contactEmail))) {
    throw new Error("--apply requires a valid --contact-email for the logo provider User-Agent.");
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < DEFAULT_REQUEST_INTERVAL_MS) {
    throw new Error("--request-interval-ms must be an integer of at least 1000.");
  }
  if (!Number.isInteger(updateBatchSize) || updateBatchSize < 1 || updateBatchSize > 100) {
    throw new Error("--update-batch-size must be an integer between 1 and 100.");
  }
  return { mode, contactEmail, limit, force, outputDir, requestIntervalMs, updateBatchSize };
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function csvValue(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value).replaceAll("\u0000", " ");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function runWrangler(args: string[]): Promise<string> {
  const wranglerScript = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = await execFileAsync(process.execPath, [wranglerScript, ...args], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function queryLocal<T>(sql: string): Promise<T[]> {
  const output = await runWrangler([
    "d1", "execute", DATABASE_NAME, "--local", "--json", "--command", sql,
  ]);
  const payload = JSON.parse(output) as Array<{ results?: T[]; success?: boolean }>;
  if (!payload[0]?.success || !payload[0].results) {
    throw new Error("Wrangler returned an unsuccessful local D1 query.");
  }
  return payload[0].results;
}

function domainFromWebsite(website: string): string | null {
  try {
    const url = new URL(website);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    return hostname || null;
  } catch {
    return null;
  }
}

function logoKeyForDomain(category: Institution["category"], domain: string): string {
  const digest = createHash("sha256").update(domain).digest("hex").slice(0, 32);
  const directory = category === "college" ? "colleges" : "high-schools";
  return `education/${directory}/${digest}.webp`;
}

function logoApiUrl(domain: string): string {
  const url = new URL(`${LOGO_API_BASE_URL}/domain:${domain}`);
  url.searchParams.set("fallback", "404");
  return url.toString();
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchLogo(
  domain: string,
  contactEmail: string,
  lastRequestAt: { value: number },
  requestIntervalMs: number,
): Promise<{ bytes: Buffer | null; outcome: "missing_logo" | "request_error"; detail: string | null }> {
  const remainingWait = Math.max(0, requestIntervalMs - (Date.now() - lastRequestAt.value));
  if (remainingWait > 0) await wait(remainingWait);
  lastRequestAt.value = Date.now();

  try {
    const response = await fetch(logoApiUrl(domain), {
      headers: {
        "User-Agent": `Nukleio Catalog logo importer (${contactEmail})`,
        Accept: "image/webp,image/*;q=0.8",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return { bytes: null, outcome: "missing_logo", detail: null };
    if (!response.ok) return { bytes: null, outcome: "request_error", detail: `HTTP ${response.status}` };
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
      return { bytes: null, outcome: "request_error", detail: `Source image exceeds ${MAX_SOURCE_BYTES} bytes.` };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return { bytes: null, outcome: "request_error", detail: "Provider returned an empty image." };
    if (bytes.length > MAX_SOURCE_BYTES) {
      return { bytes: null, outcome: "request_error", detail: `Source image exceeds ${MAX_SOURCE_BYTES} bytes.` };
    }
    return { bytes, outcome: "request_error", detail: null };
  } catch (error) {
    return { bytes: null, outcome: "request_error", detail: shortError(error) };
  }
}

async function compressToWebp(input: Buffer): Promise<{ bytes: Buffer | null; outcome: "invalid_image" | "oversize_after_compression" }> {
  const attempts = [
    { width: 512, quality: 82 },
    { width: 384, quality: 76 },
    { width: 256, quality: 70 },
    { width: 192, quality: 62 },
    { width: 128, quality: 54 },
  ];
  try {
    for (const attempt of attempts) {
      const bytes = await sharp(input, { animated: false, limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: attempt.width, height: attempt.width, fit: "inside", withoutEnlargement: true })
        .webp({ quality: attempt.quality, effort: 4, smartSubsample: true })
        .toBuffer();
      if (bytes.length <= MAX_OUTPUT_BYTES) return { bytes, outcome: "invalid_image" };
    }
    return { bytes: null, outcome: "oversize_after_compression" };
  } catch {
    return { bytes: null, outcome: "invalid_image" };
  }
}

async function uploadToR2(key: string, filePath: string): Promise<void> {
  await runWrangler([
    "r2", "object", "put", `${R2_BUCKET}/${key}`,
    "--remote",
    "--file", filePath,
    "--content-type", "image/webp",
    "--cache-control", "public, max-age=31536000, immutable",
  ]);
}

async function flushLocalUpdates(updates: Array<{ id: string; logoKey: string }>, tempDir: string, batchNumber: number): Promise<void> {
  if (updates.length === 0) return;
  const sql = updates.map((update) => `UPDATE educational_institutions
SET logo_key = ${sqlValue(update.logoKey)}, updated_at = CURRENT_TIMESTAMP
WHERE id = ${sqlValue(update.id)};`).join("\n");
  const sqlPath = path.join(tempDir, `local-d1-update-${String(batchNumber).padStart(5, "0")}.sql`);
  await writeFile(sqlPath, sql, "utf8");
  await runWrangler(["d1", "execute", DATABASE_NAME, "--local", "--file", sqlPath, "--yes"]);
}

async function writeReports(
  results: ProcessResult[],
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const reportHeader = [
    "id", "name", "category", "city", "state", "website", "domain",
    "outcome", "logo_key", "source_bytes", "webp_bytes", "detail",
  ];
  const reportLines = [reportHeader.join(",")];
  for (const result of results) {
    reportLines.push([
      result.institution.id,
      result.institution.name,
      result.institution.category,
      result.institution.city,
      result.institution.state,
      result.institution.website,
      result.domain,
      result.outcome,
      result.logoKey,
      result.sourceBytes,
      result.outputBytes,
      result.detail,
    ].map(csvValue).join(","));
  }
  await writeFile(
    path.join(outputDir, "website-logo-processing-report.csv"),
    `\uFEFF${reportLines.join("\r\n")}\r\n`,
    "utf8",
  );

  const manifestRows = await queryLocal<Institution>(`SELECT
  id, name, normalized_name, category, city, state, website, logo_key
FROM educational_institutions
WHERE website IS NOT NULL
  AND TRIM(website) <> ''
  AND logo_key IS NOT NULL
  AND TRIM(logo_key) <> ''
ORDER BY category, state, normalized_name, city, id;`);
  const manifestHeader = [
    "local_id", "category", "normalized_name", "city", "state", "website", "logo_key",
  ];
  const manifestLines = [manifestHeader.join(",")];
  for (const row of manifestRows) {
    manifestLines.push([
      row.id,
      row.category,
      row.normalized_name,
      row.city,
      row.state,
      row.website,
      row.logo_key,
    ].map(csvValue).join(","));
  }
  await writeFile(
    path.join(outputDir, "education-logo-remote-updates.csv"),
    `\uFEFF${manifestLines.join("\r\n")}\r\n`,
    "utf8",
  );
}

function printSummary(
  institutionsWithWebsite: number,
  candidates: Institution[],
  results: ProcessResult[],
  options: Options,
): void {
  const counts = new Map<Outcome, number>();
  for (const result of results) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  console.log("Website logo import summary");
  console.log(`Mode: ${options.mode}`);
  console.log(`Rows with a website: ${institutionsWithWebsite}`);
  console.log(`Rows selected this run: ${candidates.length}`);
  console.log(`Unique domains selected: ${new Set(candidates.map((institution) => domainFromWebsite(institution.website)).filter(Boolean)).size}`);
  for (const [outcome, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${outcome}: ${count}`);
  }
  console.log(`Processing report: ${path.join(options.outputDir, "website-logo-processing-report.csv")}`);
  console.log(`Remote update manifest: ${path.join(options.outputDir, "education-logo-remote-updates.csv")}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const institutions = await queryLocal<Institution>(`SELECT
  id, name, normalized_name, category, city, state, website, logo_key
FROM educational_institutions
WHERE website IS NOT NULL
  AND TRIM(website) <> ''
ORDER BY category, state, normalized_name, city, id;`);
  const candidates = institutions
    .filter((institution) => options.force || !institution.logo_key?.trim())
    .slice(0, options.limit ?? institutions.length);

  if (options.mode === "dry-run") {
    const results = candidates.map<ProcessResult>((institution) => ({
      institution,
      domain: domainFromWebsite(institution.website),
      outcome: institution.logo_key?.trim() ? "skipped_existing_logo_key" : "would_process",
      logoKey: null,
      sourceBytes: null,
      outputBytes: null,
      detail: "Dry run: no logo API, R2, or D1 write was performed.",
    }));
    await writeReports(results, options.outputDir);
    printSummary(institutions.length, candidates, results, options);
    console.log("No logo API requests, R2 uploads, or local D1 rows were changed.");
    return;
  }

  const tempParent = path.join(REPOSITORY_ROOT, "data", "tmp");
  await mkdir(tempParent, { recursive: true });
  const tempDir = await mkdtemp(path.join(tempParent, "website-logo-import-"));
  const tempImagePath = path.join(tempDir, "logo.webp");
  const results: ProcessResult[] = [];
  const domainCache = new Map<string, DomainResult>();
  const lastRequestAt = { value: 0 };
  let pendingUpdates: Array<{ id: string; logoKey: string }> = [];
  let batchNumber = 0;

  try {
    for (const [index, institution] of candidates.entries()) {
      const domain = domainFromWebsite(institution.website);
      if (!domain) {
        results.push({ institution, domain: null, outcome: "invalid_website", logoKey: null, sourceBytes: null, outputBytes: null, detail: "Unable to parse hostname." });
        continue;
      }

      const domainCacheKey = `${institution.category}\u0000${domain}`;
      let domainResult = domainCache.get(domainCacheKey);
      if (!domainResult) {
        const fetched = await fetchLogo(domain, options.contactEmail as string, lastRequestAt, options.requestIntervalMs);
        if (!fetched.bytes) {
          domainResult = { outcome: fetched.outcome, logoKey: null, sourceBytes: null, outputBytes: null, detail: fetched.detail };
        } else {
          const compressed = await compressToWebp(fetched.bytes);
          if (!compressed.bytes) {
            domainResult = {
              outcome: compressed.outcome,
              logoKey: null,
              sourceBytes: fetched.bytes.length,
              outputBytes: null,
              detail: "Logo could not be converted to WebP within the 100 KB limit.",
            };
          } else {
            const key = logoKeyForDomain(institution.category, domain);
            try {
              await writeFile(tempImagePath, compressed.bytes);
              await uploadToR2(key, tempImagePath);
              domainResult = {
                outcome: "uploaded",
                logoKey: key,
                sourceBytes: fetched.bytes.length,
                outputBytes: compressed.bytes.length,
                detail: null,
              };
            } catch (error) {
              domainResult = {
                outcome: "upload_error",
                logoKey: null,
                sourceBytes: fetched.bytes.length,
                outputBytes: compressed.bytes.length,
                detail: shortError(error),
              };
            }
          }
        }
        domainCache.set(domainCacheKey, domainResult);
      }

      results.push({
        institution,
        domain,
        outcome: domainResult.outcome,
        logoKey: domainResult.logoKey,
        sourceBytes: domainResult.sourceBytes,
        outputBytes: domainResult.outputBytes,
        detail: domainResult.detail,
      });
      if (domainResult.outcome === "uploaded" && domainResult.logoKey) {
        pendingUpdates.push({ id: institution.id, logoKey: domainResult.logoKey });
      }

      if (pendingUpdates.length >= options.updateBatchSize) {
        batchNumber += 1;
        await flushLocalUpdates(pendingUpdates, tempDir, batchNumber);
        pendingUpdates = [];
      }
      if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
        console.log(`Processed ${index + 1}/${candidates.length} website rows.`);
      }
    }
    if (pendingUpdates.length > 0) {
      batchNumber += 1;
      await flushLocalUpdates(pendingUpdates, tempDir, batchNumber);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  await writeReports(results, options.outputDir);
  printSummary(institutions.length, candidates, results, options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

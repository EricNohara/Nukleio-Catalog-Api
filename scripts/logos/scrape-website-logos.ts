import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import sharp, { type Metadata } from "sharp";
import { OllamaLogoSelector, type LogoCandidateKind, type LogoSelection, type LogoSelector } from "./logo-selector.js";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const R2_BUCKET_NAME = "nukleio-catalog-assets";
const OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "logos");
const REVIEW_CSV = path.join(OUTPUT_DIR, "logo-review.csv");
const MANIFEST_CSV = path.join(OUTPUT_DIR, "logo-manifest.csv");
const REVIEW_HTML = path.join(OUTPUT_DIR, "logo-review.html");
const RETRIEVAL_CSV = path.join(OUTPUT_DIR, "logo-retrieval-review.csv");
const RETRIEVAL_HTML = path.join(OUTPUT_DIR, "logo-retrieval-review.html");
const PREVIEW_DIR = path.join(OUTPUT_DIR, "previews");

const DEFAULT_LIMIT = 20;
const DEFAULT_CONCURRENCY = 24;
const DEFAULT_PER_HOST_DELAY_MS = 750;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MIN_SCORE = 75;
const DEFAULT_AI_MODEL = "qwen3-vl:4b";
const DEFAULT_AI_THRESHOLD = 0.8;
const DEFAULT_AI_CONCURRENCY = 1;
const DEFAULT_AI_KEEP_ALIVE = "30m";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const MAX_DISCOVERY_CANDIDATES = 144;
const TEXT_RANK_BATCH_SIZE = 36;
const TEXT_RANK_RESULT_SIZE = 12;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_WEBP_BYTES = 100_000;

type Category = "college" | "high_school";

type Institution = {
  id: string;
  name: string;
  normalized_name: string;
  category: Category;
  city: string | null;
  state: string | null;
  website: string;
};

type Options = {
  limit: number;
  seed: string;
  concurrency: number;
  perHostDelayMs: number;
  timeoutMs: number;
  maxPages: number;
  maxCandidates: number;
  minScore: number;
  aiEnabled: boolean;
  aiModel: string;
  aiThreshold: number;
  aiConcurrency: number;
  ollamaUrl: string;
  aiKeepAlive: string;
  apply: boolean;
  refreshFailed: boolean;
  renderReview: boolean;
  resetReview: boolean;
  yes: boolean;
};

type Candidate = {
  institution: Institution;
  sourcePageUrl: string;
  key: string;
  url: string | null;
  inlineSvg: string | null;
  source: string;
  metadata: string;
  ancestry: string;
  pageRegion: string;
  qualification: "strong" | "fallback";
  initialScore: number;
  reasons: string[];
};

type ReviewRow = {
  institution_id: string;
  run_seed: string;
  institution_name: string;
  normalized_name: string;
  category: string;
  city: string;
  state: string;
  website: string;
  source_page_url: string;
  candidate_url: string;
  preview_path: string;
  candidate_rank: string;
  score: string;
  auto_selected: string;
  status: string;
  content_type: string;
  source_bytes: string;
  preview_bytes: string;
  width: string;
  height: string;
  reasons: string;
  candidate_metadata: string;
  candidate_ancestry: string;
  candidate_region: string;
  ai_choice: string;
  ai_confidence: string;
  ai_reason: string;
  ai_model: string;
  ai_status: string;
  ai_duration_ms: string;
  ai_kind: string;
  ai_eligible: string;
  error: string;
};

type CandidateResult = {
  candidate: Candidate;
  contentType: string;
  sourceBytes: number;
  preview: Buffer;
  previewBytes: number;
  width: number;
  height: number;
  score: number;
  reasons: string[];
  finalUrl: string;
};

type RetrievalReviewRow = {
  institution_id: string;
  run_seed: string;
  institution_name: string;
  category: string;
  website: string;
  inventory_index: string;
  batch_number: string;
  source: string;
  candidate_url: string;
  source_page_url: string;
  page_region: string;
  metadata: string;
  ancestry: string;
  batch_rank: string;
  final_rank: string;
  status: string;
  error: string;
};

type EvaluationResult = {
  reviewRows: ReviewRow[];
  retrievalRows: RetrievalReviewRow[];
};

const ACCEPTABLE_AI_KINDS = new Set<LogoCandidateKind>(["logo", "wordmark", "seal", "crest"]);

const MANIFEST_HEADER = [
  "institution_id", "run_seed", "institution_name", "normalized_name", "category", "city", "state", "website",
  "source_page_url", "candidate_url", "preview_path", "candidate_rank", "score", "auto_selected",
  "status", "content_type", "source_bytes", "preview_bytes", "width", "height", "reasons", "candidate_metadata", "candidate_ancestry", "candidate_region",
  "ai_choice", "ai_confidence", "ai_reason", "ai_model", "ai_status", "ai_duration_ms", "ai_kind", "ai_eligible", "error",
] as const;

const REVIEW_HEADER = [
  "institution_name", "category", "website", "candidate_rank", "score", "auto_selected", "ai_kind", "ai_eligible", "ai_choice", "ai_confidence", "ai_status", "candidate_url", "error",
] as const;

const RETRIEVAL_HEADER = [
  "institution_id", "run_seed", "institution_name", "category", "website", "inventory_index", "batch_number",
  "source", "candidate_url", "source_page_url", "page_region", "metadata", "ancestry", "batch_rank", "final_rank", "status", "error",
] as const;

const POSITIVE_TOKENS: Array<[string, number]> = [
  ["logo", 30], ["wordmark", 22], ["branding", 18], ["brand", 16], ["identity", 16],
  ["emblem", 15], ["crest", 15], ["seal", 12], ["mark", 12],
];
const NEGATIVE_TOKENS: Array<[string, number]> = [
  ["hero", -28], ["banner", -25], ["background", -20], ["cover", -18], ["social", -16],
  ["share", -16], ["thumbnail", -14], ["avatar", -12], ["advert", -25], ["recaptcha", -70],
  ["gstatic", -50], ["facebook", -30], ["twitter", -30], ["linkedin", -30], ["wordpress", -20],
];
const RELEVANT_PAGE_TOKENS = ["about", "branding", "brand", "identity", "media", "contact", "who-we-are", "who_we_are"];

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\logos\\scrape-website-logos.ts --limit 20
  npm run logos:scrape -- --limit 20

This evaluation script reads local D1 and writes only to data/logos. It never
changes D1 or R2.

Options:
  --limit <count>              Schools to evaluate; balanced across categories (default: ${DEFAULT_LIMIT})
  --seed <value>               Reproduce the random school sample; printed when omitted
  --concurrency <count>        Concurrent school evaluations (default: ${DEFAULT_CONCURRENCY})
  --per-host-delay-ms <ms>     Minimum delay between requests to one host (default: ${DEFAULT_PER_HOST_DELAY_MS})
  --timeout-ms <ms>            Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-pages <count>          Homepage plus relevant same-site pages; 1-4 (default: ${DEFAULT_MAX_PAGES})
  --max-candidates <count>     Downloaded WebP previews per school; 1-5 (default: ${DEFAULT_MAX_CANDIDATES})
  --min-score <score>          Score needed to mark rank 1 as auto-selected; 0-100 (default: ${DEFAULT_MIN_SCORE})
  --no-ai                      Skip local AI selection and retain deterministic rank-1 selection
  --ai-model <name>            Ollama vision model (default: ${DEFAULT_AI_MODEL})
  --ai-threshold <0..1>        Minimum AI confidence to auto-select (default: ${DEFAULT_AI_THRESHOLD})
  --ai-concurrency <count>     Concurrent AI requests; use 1 for a 6 GB GPU (default: ${DEFAULT_AI_CONCURRENCY})
  --ollama-url <url>           Local Ollama endpoint (default: ${DEFAULT_OLLAMA_URL})
  --ai-keep-alive <duration>   Keep the model warm, e.g. 30m (default: ${DEFAULT_AI_KEEP_ALIVE})
  --apply                      Upload accepted AI selections to R2 and set remote D1 logo_key
  --refresh-failed             Retry schools previously recorded only as errors or no-candidate results
  --render-review              Rebuild the compact CSV and visual HTML review from the local manifest
  --reset-review               Delete local manifests, review files, and previews under data/logos
  --yes                        Required with --reset-review or --apply
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let limit = DEFAULT_LIMIT;
  let seed: string = randomUUID();
  let concurrency = DEFAULT_CONCURRENCY;
  let perHostDelayMs = DEFAULT_PER_HOST_DELAY_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxPages = DEFAULT_MAX_PAGES;
  let maxCandidates = DEFAULT_MAX_CANDIDATES;
  let minScore = DEFAULT_MIN_SCORE;
  let aiEnabled = true;
  let aiModel = DEFAULT_AI_MODEL;
  let aiThreshold = DEFAULT_AI_THRESHOLD;
  let aiConcurrency = DEFAULT_AI_CONCURRENCY;
  let ollamaUrl = DEFAULT_OLLAMA_URL;
  let aiKeepAlive = DEFAULT_AI_KEEP_ALIVE;
  let apply = false;
  let refreshFailed = false;
  let renderReview = false;
  let resetReview = false;
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--refresh-failed") {
      refreshFailed = true;
      continue;
    }
    if (argument === "--render-review") {
      renderReview = true;
      continue;
    }
    if (argument === "--reset-review") {
      resetReview = true;
      continue;
    }
    if (argument === "--yes") {
      yes = true;
      continue;
    }
    if (argument === "--no-ai") {
      aiEnabled = false;
      continue;
    }
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (["--seed", "--ai-model", "--ollama-url", "--ai-keep-alive"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === "--seed") seed = value;
      if (argument === "--ai-model") aiModel = value;
      if (argument === "--ollama-url") ollamaUrl = value;
      if (argument === "--ai-keep-alive") aiKeepAlive = value;
      continue;
    }
    if (["--limit", "--concurrency", "--per-host-delay-ms", "--timeout-ms", "--max-pages", "--max-candidates", "--min-score", "--ai-threshold", "--ai-concurrency"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${argument} must be a number.`);
      if (argument !== "--ai-threshold" && !Number.isInteger(number)) throw new Error(`${argument} must be an integer.`);
      if (argument === "--limit") limit = number;
      if (argument === "--concurrency") concurrency = number;
      if (argument === "--per-host-delay-ms") perHostDelayMs = number;
      if (argument === "--timeout-ms") timeoutMs = number;
      if (argument === "--max-pages") maxPages = number;
      if (argument === "--max-candidates") maxCandidates = number;
      if (argument === "--min-score") minScore = number;
      if (argument === "--ai-threshold") aiThreshold = number;
      if (argument === "--ai-concurrency") aiConcurrency = number;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (limit < 1 || concurrency < 1 || perHostDelayMs < 0 || timeoutMs < 1) throw new Error("--limit, --concurrency, --per-host-delay-ms, and --timeout-ms must be positive.");
  if (maxPages < 1 || maxPages > 4) throw new Error("--max-pages must be between 1 and 4.");
  if (maxCandidates < 1 || maxCandidates > 5) throw new Error("--max-candidates must be between 1 and 5.");
  if (minScore < 0 || minScore > 100) throw new Error("--min-score must be between 0 and 100.");
  if (aiThreshold < 0 || aiThreshold > 1) throw new Error("--ai-threshold must be between 0 and 1.");
  if (aiConcurrency < 1) throw new Error("--ai-concurrency must be positive.");
  if (apply && !yes) throw new Error("--apply requires --yes because it uploads to remote R2 and updates remote D1.");
  if (apply && !aiEnabled) throw new Error("--apply requires AI selection; remove --no-ai.");
  if (apply && (renderReview || resetReview)) throw new Error("--apply cannot be combined with --render-review or --reset-review.");
  return { limit, seed, concurrency, perHostDelayMs, timeoutMs, maxPages, maxCandidates, minScore, aiEnabled, aiModel, aiThreshold, aiConcurrency, ollamaUrl, aiKeepAlive, apply, refreshFailed, renderReview, resetReview, yes };
}

function csvValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = String(value).replaceAll("\u0000", " ");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runWrangler(args: string[]): Promise<string> {
  const wranglerScript = path.join(REPOSITORY_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = await execFileAsync(process.execPath, [wranglerScript, ...args], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function queryLocal<T>(sql: string): Promise<T[]> {
  const output = await runWrangler(["d1", "execute", DATABASE_NAME, "--local", "--json", "--command", sql]);
  const payload = JSON.parse(output) as Array<{ results?: T[]; success?: boolean }>;
  if (!payload[0]?.success || !payload[0].results) throw new Error("Wrangler returned an unsuccessful local D1 query.");
  return payload[0].results;
}

async function queryRemote<T>(sql: string): Promise<T[]> {
  const output = await runWrangler(["d1", "execute", DATABASE_NAME, "--remote", "--json", "--command", sql]);
  const payload = JSON.parse(output) as Array<{ results?: T[]; success?: boolean }>;
  if (!payload[0]?.success || !payload[0].results) throw new Error("Wrangler returned an unsuccessful remote D1 query.");
  return payload[0].results;
}

function sqlValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function r2KeyFor(row: ReviewRow): string {
  const category = row.category === "college" ? "colleges" : "high-schools";
  return `education/${category}/${row.institution_id}.webp`;
}

async function applyAcceptedSelections(rows: ReviewRow[]): Promise<{ uploaded: number; skipped: number }> {
  const accepted = rows.filter((row) => isAutoSelected(row) && row.preview_path && row.ai_status === "accepted");
  let uploaded = 0;
  let skipped = rows.length - accepted.length;
  for (const row of accepted) {
    const current = await queryRemote<{ logo_key: string | null }>(`SELECT logo_key FROM educational_institutions WHERE id = ${sqlValue(row.institution_id)} LIMIT 1;`);
    if (current.length === 0 || current[0]?.logo_key?.trim()) {
      skipped += 1;
      console.log(`Skipped unavailable or already-enriched institution: ${row.institution_name}`);
      continue;
    }
    const previewPath = path.resolve(REPOSITORY_ROOT, row.preview_path);
    const objectKey = r2KeyFor(row);
    await runWrangler(["r2", "object", "put", `${R2_BUCKET_NAME}/${objectKey}`, "--file", previewPath, "--remote"]);
    await runWrangler([
      "d1", "execute", DATABASE_NAME, "--remote", "--command",
      `UPDATE educational_institutions SET logo_key = ${sqlValue(objectKey)} WHERE id = ${sqlValue(row.institution_id)} AND (logo_key IS NULL OR TRIM(logo_key) = '');`,
    ]);
    uploaded += 1;
    console.log(`Applied ${uploaded}/${accepted.length}: ${row.institution_name}`);
  }
  return { uploaded, skipped };
}

function normalizeUrl(value: string, base?: string): string | null {
  try {
    const trimmed = value.trim();
    if (!trimmed || /^(?:data|blob|javascript|mailto|tel):/i.test(trimmed)) return null;
    const normalized = base ? new URL(trimmed, base) : new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (normalized.protocol !== "http:" && normalized.protocol !== "https:") return null;
    normalized.hash = "";
    return normalized.toString();
  } catch {
    return null;
  }
}

function assetIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    // CDNs such as Finalsite put resize/quality transforms before a stable
    // versioned asset path. Treat each transformed rendition as one source
    // image so it cannot consume multiple text-ranking or preview slots.
    const versionedAsset = parsed.pathname.match(/\/v\d+\/(.+)$/i)?.[1];
    return `${parsed.origin.toLowerCase()}/${versionedAsset ?? parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return url;
  }
}

function isVideoAsset(url: string, context: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\.(?:mp4|webm|mov|m4v|avi|mkv|ogv|m3u8)$/i.test(pathname)) return true;
  } catch {
    // The URL is normalized before this check, so this is defensive only.
  }
  return /\b(?:video|audio)\/(?:mp4|webm|mpeg|ogg|quicktime)\b/i.test(context);
}

function hostWithoutWww(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

function sameSite(url: string, rootUrl: string): boolean {
  try {
    const host = hostWithoutWww(url);
    const root = hostWithoutWww(rootUrl);
    return host === root || host.endsWith(`.${root}`) || root.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of tag.matchAll(pattern)) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  return attributes;
}

function tokenScore(value: string): { score: number; reasons: string[] } {
  const text = value.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  for (const [token, points] of POSITIVE_TOKENS) {
    if (text.includes(token)) {
      score += points;
      reasons.push(`signal:${token}`);
    }
  }
  for (const [token, points] of NEGATIVE_TOKENS) {
    if (text.includes(token)) {
      score += points;
      reasons.push(`penalty:${token}`);
    }
  }
  return { score, reasons };
}

function parseSrcset(value: string): string[] {
  return value.split(",").map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
}

function jsonAssetUrls(value: string): string[] {
  const variants = [value.replaceAll("&quot;", '"')];
  try {
    variants.push(decodeURIComponent(value).replaceAll("&quot;", '"'));
  } catch {
    // An ordinary URL can contain a malformed percent escape; keep treating it as a URL.
  }
  for (const variant of variants) {
    try {
      const parsed: unknown = JSON.parse(variant);
      const urls: string[] = [];
      const collect = (item: unknown): void => {
        if (Array.isArray(item)) return void item.forEach(collect);
        if (!item || typeof item !== "object") return;
        for (const [key, nested] of Object.entries(item)) {
          if (typeof nested === "string" && ["url", "src", "href"].includes(key.toLowerCase())) urls.push(nested);
          else collect(nested);
        }
      };
      collect(parsed);
      if (urls.length > 0) return [...new Set(urls)];
    } catch {
      // Not a JSON asset descriptor.
    }
  }
  return [];
}

function hasPositiveLogoSignal(value: string): boolean {
  const text = value.toLowerCase();
  return POSITIVE_TOKENS.some(([token]) => text.includes(token));
}

function rejectedAsset(value: string): boolean {
  return /recaptcha|gstatic\.com|wp-includes\/images\/w-logo|(?:social.*sprite|sprite.*social)|(?:facebook|twitter|linkedin)[-_]?button|powered\s+by\s+edlio|\bedlio\b|\baeries\b|google[-_ ]?translate|(?:search|menu|close)[-_ ]?icon/i.test(value);
}

function assetSignalText(url: string, metadata: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname} ${parsed.search} ${metadata}`.toLowerCase();
  } catch {
    return metadata.toLowerCase();
  }
}

function hasDirectLogoSignal(url: string, metadata: string): boolean {
  return /(?:^|[\s_\-./])(?:logo|wordmark|brand(?:ing)?|identity|emblem|crest|seal)(?:$|[\s_\-./])/i.test(assetSignalText(url, metadata));
}

function likelyNonLogoAsset(value: string): boolean {
  return /(?:^|[\s_\-./])(staff|portrait|headshot|team|faculty|people|gallery|slideshow|timeline|infographic|report|brochure|flyer|calendar|newsletter|hero|cover|background)(?:$|[\s_\-./])/i.test(value);
}

function inlineSvgHasDirectLogoContext(context: string): boolean {
  const nearby = context.slice(-500).toLowerCase();
  if (rejectedAsset(nearby)) return false;
  return /(?:school|site|header|brand|main)[_-]?logo|logo[-_ ]?(?:image|container|wrapper|link)|\bclass\s*=\s*["'][^"']*\blogo\b/i.test(nearby);
}

function institutionMatchScore(institution: Institution, value: string): { score: number; reasons: string[] } {
  const text = value.toLowerCase();
  const ignored = new Set(["a", "an", "and", "at", "career", "college", "center", "for", "high", "in", "of", "school", "technical", "the", "university"]);
  const nameTokens = institution.name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !ignored.has(token));
  const matched = nameTokens.filter((token) => text.includes(token));
  const reasons = matched.map((token) => `institution:${token}`);
  let score = Math.min(30, matched.length * 12);
  const acronym = nameTokens.map((token) => token[0]).join("");
  if (acronym.length >= 3 && text.includes(acronym)) {
    score += 35;
    reasons.push(`institution-acronym:${acronym.toUpperCase()}`);
  }
  return { score, reasons };
}

function structuralScore(value: string): { score: number; reasons: string[] } {
  const text = value.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (/<header\b|\bheader\b|headerlogo|header-logo|logoimage|logo-image/.test(text)) {
    score += 28;
    reasons.push("structure:header");
  }
  if (/\bid\s*=\s*["'][^"']*logo|\bclass\s*=\s*["'][^"']*logo|\balt\s*=\s*["'][^"']*logo|(?:school|site|brand)[-_ ]?logo|logo[-_ ]?(?:image|container|wrapper|link)/.test(text)) {
    score += 26;
    reasons.push("structure:logo-container");
  }
  return { score, reasons };
}

function semanticAncestry($: cheerio.CheerioAPI, element: Element): { ancestry: string; pageRegion: string } {
  const parts: string[] = [];
  let pageRegion = "document";
  let current: Element | null = element;
  while (current) {
    const tagName = current.tagName?.toLowerCase();
    if (tagName) {
      const attributes: Record<string, string> = current.attribs ?? {};
      const details: string[] = [];
      for (const name of ["id", "class", "role", "aria-label", "aria-labelledby", "title"]) {
        const value = attributes[name];
        if (value) details.push(`${name}=${value.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      for (const [name, value] of Object.entries(attributes)) {
        if (!name.startsWith("data-") || !value || !/(logo|brand|identity|image|school|header)/i.test(`${name} ${value}`)) continue;
        details.push(`${name}=${value.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      const meaningful = tagName === "header" || tagName === "nav" || tagName === "main" || tagName === "footer" || tagName === "a" || details.length > 0;
      if (meaningful) parts.push(`${tagName}${details.length ? `(${[...new Set(details)].join("; ")})` : ""}`);
      if (tagName === "header") pageRegion = "header";
      else if (pageRegion === "document" && ["nav", "main", "footer"].includes(tagName)) pageRegion = tagName;
    }
    current = current.parent as Element | null;
  }
  return { ancestry: parts.join(" > "), pageRegion };
}

function elementMetadata(element: Element): string {
  const attributes: Record<string, string> = element.attribs ?? {};
  const details = [`tag=${element.tagName ?? "unknown"}`];
  for (const [name, value] of Object.entries(attributes)) {
    if (!value) continue;
    if (["alt", "class", "id", "title", "role", "aria-label", "type"].includes(name) || name.startsWith("data-")) {
      details.push(`${name}=${value.replace(/\s+/g, " ").slice(0, 240)}`);
    }
  }
  return details.join("; ");
}

function elementAssetUrls(element: Element): string[] {
  const attributes: Record<string, string> = element.attribs ?? {};
  const urls: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (!value) continue;
    const lowerName = name.toLowerCase();
    if (lowerName === "srcset" || lowerName.endsWith("-srcset")) {
      urls.push(...parseSrcset(value));
    } else if (lowerName === "src" || lowerName === "href" || /^(?:data-(?:src|image|lazy|original|url)(?:-|$))/.test(lowerName)) {
      const extracted = jsonAssetUrls(value);
      urls.push(...(extracted.length > 0 ? extracted : [value.trim()]));
    }
  }
  return [...new Set(urls)];
}

function isFaviconCandidate(candidate: Candidate): boolean {
  return candidate.source === "document-icon" || candidate.source === "web-manifest" || candidate.source === "favicon-fallback";
}

function isAcceptableAiAssessment(candidate: CandidateResult, assessment: { kind: LogoCandidateKind; eligible: boolean } | null | undefined, faviconFallback: boolean): boolean {
  if (!assessment?.eligible) return false;
  return ACCEPTABLE_AI_KINDS.has(assessment.kind) || (faviconFallback && isFaviconCandidate(candidate.candidate) && assessment.kind === "icon");
}

function addCandidate(candidates: Map<string, Candidate>, candidate: Candidate): void {
  const existing = candidates.get(candidate.key);
  if (!existing || candidate.initialScore > existing.initialScore) candidates.set(candidate.key, candidate);
}

function addImageCandidate(
  candidates: Map<string, Candidate>,
  institution: Institution,
  pageUrl: string,
  rawUrl: string | undefined,
  source: string,
  baseScore: number,
  signalText: string,
  structuralContext = "",
  ancestry = "",
  pageRegion = "",
): void {
  if (!rawUrl) return;
  const url = normalizeUrl(rawUrl, pageUrl);
  if (!url) return;
  if (isVideoAsset(url, signalText)) return;
  const assetText = assetSignalText(url, `${signalText} ${ancestry}`);
  if (rejectedAsset(assetText)) return;
  const urlSignals = tokenScore(url);
  const contextSignals = tokenScore(`${signalText} ${ancestry}`);
  const institutionSignals = institutionMatchScore(institution, assetText);
  const structureSignals = structuralScore(structuralContext);
  const genericImageSource = source === "image-element" || source === "picture-source" || source === "css-background";
  const explicitSignal = hasDirectLogoSignal(url, `${signalText} ${ancestry}`);
  const fallbackSource = source === "document-icon" || source === "web-manifest" || source === "favicon-fallback";
  if (source === "css-background" && !explicitSignal) return;
  if (!genericImageSource && !fallbackSource && !explicitSignal) return;
  const contextScore = genericImageSource ? Math.trunc(contextSignals.score * 0.35) : contextSignals.score;
  addCandidate(candidates, {
    institution,
    sourcePageUrl: pageUrl,
    key: assetIdentity(url),
    url,
    inlineSvg: null,
    source,
    metadata: signalText.replace(/\s+/g, " ").trim().slice(0, 500),
    ancestry,
    pageRegion,
    qualification: explicitSignal ? "strong" : "fallback",
    initialScore: baseScore + urlSignals.score + contextScore + institutionSignals.score + structureSignals.score,
    reasons: [
      `source:${source}`,
      ...urlSignals.reasons.map((reason) => `url-${reason}`),
      ...contextSignals.reasons.map((reason) => `context-${reason}`),
      ...institutionSignals.reasons,
      ...structureSignals.reasons,
    ],
  });
}

function addInlineSvgCandidate(candidates: Map<string, Candidate>, institution: Institution, pageUrl: string, svg: string, context: string, ancestry: string, pageRegion: string): void {
  const svgTitle = svg.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g, " ") ?? "";
  if (!inlineSvgHasDirectLogoContext(`${context} ${ancestry}`)) return;
  const signals = `${svgTitle} ${context.slice(-500)} ${ancestry}`;
  if (rejectedAsset(signals)) return;
  const tokenSignals = tokenScore(signals);
  const institutionSignals = institutionMatchScore(institution, signals);
  const structureSignals = structuralScore(`${context} ${ancestry}`);
  if (!hasPositiveLogoSignal(signals) && institutionSignals.score === 0) return;
  const key = `inline-svg:${createHash("sha256").update(pageUrl).update(svg).digest("hex")}`;
  addCandidate(candidates, {
    institution,
    sourcePageUrl: pageUrl,
    key,
    url: null,
    inlineSvg: svg,
    source: "inline-svg",
    metadata: signals.replace(/\s+/g, " ").trim().slice(0, 500),
    ancestry,
    pageRegion,
    qualification: "strong",
    initialScore: 65 + tokenSignals.score + institutionSignals.score + structureSignals.score,
    reasons: ["source:inline-svg", ...tokenSignals.reasons, ...institutionSignals.reasons, ...structureSignals.reasons],
  });
}

function relevantLinks(html: string, pageUrl: string, rootUrl: string): string[] {
  const links: Array<{ url: string; score: number }> = [];
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = parseAttributes(match[1]);
    const url = normalizeUrl(attributes.get("href") ?? "", pageUrl);
    if (!url || !sameSite(url, rootUrl)) continue;
    const text = `${url} ${attributes.get("title") ?? ""} ${match[2].replace(/<[^>]*>/g, " ")}`.toLowerCase();
    const matches = RELEVANT_PAGE_TOKENS.filter((token) => text.includes(token)).length;
    if (matches > 0) links.push({ url, score: matches * 10 + tokenScore(text).score });
  }
  return [...new Map(links.sort((left, right) => right.score - left.score).map((link) => [link.url, link.url])).values()];
}

function discoverHtmlCandidates(institution: Institution, html: string, pageUrl: string): { candidates: Candidate[]; manifestUrls: string[] } {
  const candidates = new Map<string, Candidate>();
  const manifestUrls: string[] = [];
  const $ = cheerio.load(html);
  $("link").each((_, element) => {
    const attributes = element.attribs ?? {};
    const rel = attributes.rel?.toLowerCase() ?? "";
    const href = attributes.href;
    if (rel.includes("manifest")) {
      const manifestUrl = href ? normalizeUrl(href, pageUrl) : null;
      if (manifestUrl) manifestUrls.push(manifestUrl);
    }
    if (rel.includes("icon") || rel.includes("image_src")) {
      addImageCandidate(candidates, institution, pageUrl, href, rel.includes("icon") ? "document-icon" : "metadata-image", 0, elementMetadata(element), "head", "head", "head");
    }
  });
  $("meta").each((_, element) => {
    const attributes = element.attribs ?? {};
    const marker = `${attributes.property ?? ""} ${attributes.name ?? ""}`.toLowerCase();
    if (marker.includes("og:image") || marker.includes("twitter:image") || marker === "image") {
      addImageCandidate(candidates, institution, pageUrl, attributes.content, "metadata-image", 0, elementMetadata(element), "head", "head", "head");
    }
  });
  $("img, source").each((_, element) => {
    if (element.parent?.type === "tag" && element.parent.tagName?.toLowerCase() === "video") return;
    const source = element.tagName?.toLowerCase() === "source" ? "picture-source" : "image-element";
    const metadata = elementMetadata(element);
    const context = semanticAncestry($, element);
    for (const assetUrl of elementAssetUrls(element)) {
      addImageCandidate(candidates, institution, pageUrl, assetUrl, source, 0, metadata, context.ancestry, context.ancestry, context.pageRegion);
    }
  });
  $("[style]").each((_, element) => {
    const style = element.attribs?.style ?? "";
    const context = semanticAncestry($, element);
    for (const match of style.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      addImageCandidate(candidates, institution, pageUrl, match[1], "css-background", 0, elementMetadata(element), context.ancestry, context.ancestry, context.pageRegion);
    }
  });
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    addImageCandidate(candidates, institution, pageUrl, match[1], "css-background", 0, match[1], "stylesheet", "stylesheet", "stylesheet");
  }
  $("svg").each((_, element) => {
    const context = semanticAncestry($, element);
    addInlineSvgCandidate(candidates, institution, pageUrl, $.html(element), elementMetadata(element), context.ancestry, context.pageRegion);
  });
  addImageCandidate(candidates, institution, pageUrl, "/favicon.ico", "favicon-fallback", 10, "favicon");
  return { candidates: [...candidates.values()], manifestUrls: [...new Set(manifestUrls)] };
}

function manifestCandidates(institution: Institution, manifestUrl: string, value: unknown): Candidate[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { icons?: unknown[] }).icons)) return [];
  const candidates = new Map<string, Candidate>();
  for (const icon of (value as { icons: unknown[] }).icons.slice(0, 8)) {
    if (!icon || typeof icon !== "object") continue;
    const record = icon as { src?: unknown; sizes?: unknown; purpose?: unknown };
    if (typeof record.src !== "string") continue;
    addImageCandidate(candidates, institution, manifestUrl, record.src, "web-manifest", 28, `${String(record.sizes ?? "")} ${String(record.purpose ?? "")}`);
  }
  return [...candidates.values()];
}

class HostLimiter {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly nextStart = new Map<string, number>();

  constructor(private readonly delayMs: number) {}

  async run<T>(url: string, action: () => Promise<T>): Promise<T> {
    const host = hostWithoutWww(url);
    const previous = this.queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.queues.set(host, previous.then(() => current));
    await previous;
    const waitMs = Math.max(0, (this.nextStart.get(host) ?? 0) - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    this.nextStart.set(host, Date.now() + this.delayMs);
    try {
      return await action();
    } finally {
      release();
    }
  }
}

class WorkQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /^HTTP 5\d\d$/.test(error.message);
}

async function fetchWithRetry(url: string, options: Options, limiter: HostLimiter): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await limiter.run(url, () => fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": "Nukleio Catalog logo evaluator/1.0",
          Accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.5",
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      }));
      if (response.status >= 500 && response.status <= 599 && attempt === 0) {
        lastError = new Error(`HTTP ${response.status}`);
        await response.body?.cancel();
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === 1) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds ${maximumBytes} bytes.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchPage(url: string, options: Options, limiter: HostLimiter): Promise<{ finalUrl: string; html: string }> {
  const response = await fetchWithRetry(url, options, limiter);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("html") && !contentType.includes("xhtml")) {
    await response.body?.cancel();
    throw new Error(`Not HTML: ${contentType}`);
  }
  const bytes = await readResponse(response, MAX_HTML_BYTES);
  return { finalUrl: response.url, html: bytes.toString("utf8") };
}

async function fetchJson(url: string, options: Options, limiter: HostLimiter): Promise<unknown> {
  const response = await fetchWithRetry(url, options, limiter);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readResponse(response, MAX_MANIFEST_BYTES);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function fetchImage(url: string, options: Options, limiter: HostLimiter): Promise<{ bytes: Buffer; contentType: string; finalUrl: string }> {
  const response = await fetchWithRetry(url, options, limiter);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "application/octet-stream";
  if (contentType.startsWith("video/") || contentType.startsWith("audio/")) throw new Error(`Unsupported media type: ${contentType}`);
  const bytes = await readResponse(response, MAX_IMAGE_BYTES);
  return { bytes, contentType, finalUrl: response.url };
}

async function makeWebp(bytes: Buffer): Promise<{ bytes: Buffer; width: number; height: number }> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { animated: false, limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new Error("Invalid image.");
  }
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable.");
  const attempts = [
    { width: 512, quality: 82 }, { width: 384, quality: 76 }, { width: 256, quality: 70 },
    { width: 192, quality: 62 }, { width: 128, quality: 54 },
  ];
  for (const attempt of attempts) {
    const webp = await sharp(bytes, { animated: false, limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: attempt.width, height: attempt.width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: attempt.quality, effort: 4, smartSubsample: true })
      .toBuffer();
    if (webp.length <= MAX_WEBP_BYTES) return { bytes: webp, width: metadata.width, height: metadata.height };
  }
  throw new Error(`Could not compress below ${MAX_WEBP_BYTES} bytes.`);
}

async function makeVisionPreview(bytes: Buffer): Promise<Buffer> {
  // Preserve alpha in the stored/review WebP, but give the VLM an opaque dark
  // canvas so white-on-transparent institutional marks remain legible.
  return sharp(bytes, { animated: false, limitInputPixels: 40_000_000 })
    .flatten({ background: "#263548" })
    .webp({ quality: 82, effort: 4, smartSubsample: true })
    .toBuffer();
}

function scoreCandidate(candidate: Candidate, width: number, height: number): { score: number; reasons: string[] } {
  let score = 30 + candidate.initialScore;
  const reasons = [...candidate.reasons];
  const ratio = width / height;
  if (ratio >= 0.65 && ratio <= 1.7) {
    score += 4;
    reasons.push("shape:tie-breaker");
  } else if (ratio > 4 || ratio < 0.25) {
    score -= 12;
    reasons.push("shape:banner-like");
  }
  if (width >= 32 && height >= 32) {
    score += 2;
    reasons.push("size:tie-breaker");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function reviewScore(score: number, assessment: { kind: LogoCandidateKind; eligible: boolean } | undefined): number {
  if (!assessment) return score;
  if (["photo", "document", "screenshot"].includes(assessment.kind)) return Math.min(score, 5);
  if (!assessment.eligible && assessment.kind === "icon") return Math.min(score, 12);
  if (!assessment.eligible && assessment.kind === "unknown") return Math.min(score, 20);
  return score;
}

function previewFileName(institutionId: string, rank: number): string {
  return `${institutionId.replace(/[^a-z0-9_-]/gi, "_")}-candidate-${rank}.webp`;
}

function visionPreviewFileName(institutionId: string, rank: number): string {
  return `${institutionId.replace(/[^a-z0-9_-]/gi, "_")}-candidate-${rank}-vision.webp`;
}

function reviewRow(institution: Institution, overrides: Partial<ReviewRow>): ReviewRow {
  return {
    institution_id: institution.id,
    run_seed: "",
    institution_name: institution.name,
    normalized_name: institution.normalized_name,
    category: institution.category,
    city: institution.city ?? "",
    state: institution.state ?? "",
    website: institution.website,
    source_page_url: "",
    candidate_url: "",
    preview_path: "",
    candidate_rank: "",
    score: "",
    auto_selected: "false",
    status: "",
    content_type: "",
    source_bytes: "",
    preview_bytes: "",
    width: "",
    height: "",
    reasons: "",
    candidate_metadata: "",
    candidate_ancestry: "",
    candidate_region: "",
    ai_choice: "",
    ai_confidence: "",
    ai_reason: "",
    ai_model: "",
    ai_status: "not_run",
    ai_duration_ms: "",
    ai_kind: "",
    ai_eligible: "",
    error: "",
    ...overrides,
  };
}

function retrievalRow(institution: Institution, seed: string, candidate: Candidate, inventoryIndex: number, overrides: Partial<RetrievalReviewRow> = {}): RetrievalReviewRow {
  return {
    institution_id: institution.id,
    run_seed: seed,
    institution_name: institution.name,
    category: institution.category,
    website: institution.website,
    inventory_index: String(inventoryIndex),
    batch_number: "",
    source: candidate.source,
    candidate_url: candidate.url ?? "",
    source_page_url: candidate.sourcePageUrl,
    page_region: candidate.pageRegion,
    metadata: candidate.metadata,
    ancestry: candidate.ancestry,
    batch_rank: "",
    final_rank: "",
    status: "not_ranked",
    error: "",
    ...overrides,
  };
}

async function rankCandidateInventory(
  institution: Institution,
  seed: string,
  candidates: Candidate[],
  selector: LogoSelector,
  aiQueue: WorkQueue,
): Promise<{ candidates: Candidate[]; retrievalRows: RetrievalReviewRow[] }> {
  const indexed = candidates.map((candidate, index) => ({ candidate, index: index + 1 }));
  const rankable = indexed.filter(({ candidate }) => !isFaviconCandidate(candidate));
  const shortlisted: Array<{ candidate: Candidate; index: number }> = [];
  const retrievalRows = new Map<number, RetrievalReviewRow>(indexed.map(({ candidate, index }) => [index, retrievalRow(institution, seed, candidate, index, {
    batch_number: String(Math.floor((index - 1) / TEXT_RANK_BATCH_SIZE) + 1),
    status: isFaviconCandidate(candidate) ? "deferred_favicon" : "not_selected_by_text",
  })]));
  for (let offset = 0; offset < rankable.length; offset += TEXT_RANK_BATCH_SIZE) {
    const batch = rankable.slice(offset, offset + TEXT_RANK_BATCH_SIZE);
    const batchNumber = Math.floor(offset / TEXT_RANK_BATCH_SIZE) + 1;
    const ranking = await aiQueue.run(() => selector.rankCandidates({
      institution,
      // Each model call uses its own 1..N indexes. Small local models often
      // answer relative to the visible batch even when given global indexes.
      candidates: batch.map(({ candidate }, localIndex) => ({
        index: localIndex + 1,
        source: candidate.source,
        sourcePageUrl: candidate.sourcePageUrl,
        candidateUrl: candidate.url ?? "",
        metadata: candidate.metadata,
        ancestry: candidate.ancestry,
        pageRegion: candidate.pageRegion,
      })),
    }));
    for (const [rank, localIndex] of ranking.candidateIndexes.entries()) {
      const entry = batch[localIndex - 1];
      if (entry && !shortlisted.some((item) => item.index === entry.index)) {
        shortlisted.push(entry);
        const row = retrievalRows.get(entry.index);
        if (row) retrievalRows.set(entry.index, { ...row, batch_number: String(batchNumber), batch_rank: String(rank + 1), status: "shortlisted_by_text" });
      }
    }
  }
  if (shortlisted.length === 0) return { candidates: [], retrievalRows: [...retrievalRows.values()] };
  if (shortlisted.length <= TEXT_RANK_RESULT_SIZE) {
    for (const [rank, entry] of shortlisted.entries()) {
      const row = retrievalRows.get(entry.index);
      if (row) retrievalRows.set(entry.index, { ...row, final_rank: String(rank + 1), status: "selected_for_visual" });
    }
    return { candidates: shortlisted.map((entry) => entry.candidate), retrievalRows: [...retrievalRows.values()] };
  }
  const finalRanking = await aiQueue.run(() => selector.rankCandidates({
    institution,
    candidates: shortlisted.map(({ candidate }, localIndex) => ({
      index: localIndex + 1,
      source: candidate.source,
      sourcePageUrl: candidate.sourcePageUrl,
      candidateUrl: candidate.url ?? "",
      metadata: candidate.metadata,
      ancestry: candidate.ancestry,
      pageRegion: candidate.pageRegion,
    })),
  }));
  const rankedCandidates = finalRanking.candidateIndexes.map((localIndex) => shortlisted[localIndex - 1]?.candidate).filter((candidate): candidate is Candidate => candidate !== undefined);
  for (const [rank, localIndex] of finalRanking.candidateIndexes.entries()) {
    const entry = shortlisted[localIndex - 1];
    const row = entry ? retrievalRows.get(entry.index) : undefined;
    if (entry && row) retrievalRows.set(entry.index, { ...row, final_rank: String(rank + 1), status: "selected_for_visual" });
  }
  return { candidates: rankedCandidates, retrievalRows: [...retrievalRows.values()] };
}

async function evaluateInstitution(
  institution: Institution,
  options: Options,
  limiter: HostLimiter,
  selector: LogoSelector | null,
  aiQueue: WorkQueue | null,
): Promise<EvaluationResult> {
  const website = normalizeUrl(institution.website);
  if (!website) return { reviewRows: [reviewRow(institution, { run_seed: options.seed, status: "error", error: "Invalid website URL." })], retrievalRows: [] };

  const candidates = new Map<string, Candidate>();
  const pageQueue = [website];
  const visited = new Set<string>();
  let firstError: string | null = null;
  let rootUrl = website;

  while (pageQueue.length > 0 && visited.size < options.maxPages) {
    const currentUrl = pageQueue.shift() as string;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);
    try {
      const page = await fetchPage(currentUrl, options, limiter);
      if (visited.size === 1) rootUrl = page.finalUrl;
      const discovered = discoverHtmlCandidates(institution, page.html, page.finalUrl);
      for (const candidate of discovered.candidates) addCandidate(candidates, candidate);
      for (const link of relevantLinks(page.html, page.finalUrl, rootUrl)) {
        if (!visited.has(link) && !pageQueue.includes(link) && pageQueue.length + visited.size < options.maxPages) pageQueue.push(link);
      }
      for (const manifestUrl of discovered.manifestUrls.slice(0, 2)) {
        try {
          for (const candidate of manifestCandidates(institution, manifestUrl, await fetchJson(manifestUrl, options, limiter))) addCandidate(candidates, candidate);
        } catch {
          // A bad manifest does not prevent logo discovery from the document itself.
        }
      }
    } catch (error) {
      firstError ??= cleanError(error);
    }
  }

  const inventory = [...candidates.values()].slice(0, MAX_DISCOVERY_CANDIDATES);
  const primaryInventory = inventory.filter((candidate) => !isFaviconCandidate(candidate));
  const faviconInventory = inventory.filter(isFaviconCandidate);
  let discoveryList = primaryInventory;
  let usingFaviconFallback = false;
  let retrievalRows = inventory.map((candidate, index) => retrievalRow(institution, options.seed, candidate, index + 1, {
    batch_number: String(Math.floor(index / TEXT_RANK_BATCH_SIZE) + 1),
    status: isFaviconCandidate(candidate) ? "deferred_favicon" : selector ? "not_selected_by_text" : "ai_disabled",
  }));
  const useFaviconFallback = (): void => {
    usingFaviconFallback = true;
    discoveryList = [...faviconInventory]
      .sort((left, right) => right.initialScore - left.initialScore || left.key.localeCompare(right.key))
      .slice(0, options.maxCandidates);
    const rankByKey = new Map(discoveryList.map((candidate, index) => [candidate.key, index + 1]));
    retrievalRows = retrievalRows.map((row) => {
      const rank = rankByKey.get(inventory[Number(row.inventory_index) - 1]?.key);
      return rank ? { ...row, final_rank: String(rank), status: "selected_as_favicon_fallback" } : row;
    });
  };
  if (selector && aiQueue) {
    try {
      const ranked = await rankCandidateInventory(institution, options.seed, inventory, selector, aiQueue);
      discoveryList = ranked.candidates;
      retrievalRows = ranked.retrievalRows;
      if (discoveryList.length === 0 && faviconInventory.length > 0) useFaviconFallback();
    } catch (error) {
      const message = `Text candidate ranking failed: ${cleanError(error)}`;
      return {
        reviewRows: [reviewRow(institution, { run_seed: options.seed, status: "error", error: message })],
        retrievalRows: retrievalRows.map((row) => ({ ...row, status: "text_ranking_error", error: message })),
      };
    }
  } else {
    discoveryList = [...primaryInventory].sort((left, right) => right.initialScore - left.initialScore || left.key.localeCompare(right.key)).slice(0, TEXT_RANK_RESULT_SIZE);
    if (discoveryList.length === 0 && faviconInventory.length > 0) useFaviconFallback();
    else {
      const rankByKey = new Map(discoveryList.map((candidate, index) => [candidate.key, index + 1]));
      retrievalRows = retrievalRows.map((row) => ({ ...row, final_rank: rankByKey.get(inventory[Number(row.inventory_index) - 1]?.key) ? String(rankByKey.get(inventory[Number(row.inventory_index) - 1]?.key)) : "" }));
    }
  }
  if (discoveryList.length === 0) {
    return { reviewRows: [reviewRow(institution, { run_seed: options.seed, status: firstError ? "error" : "no_candidates", error: firstError ?? "No image candidates found." })], retrievalRows };
  }

  const convertCandidates = async (items: Candidate[]): Promise<CandidateResult[]> => {
    const converted: CandidateResult[] = [];
    for (const candidate of items) {
      try {
        const image = candidate.inlineSvg
          ? { bytes: Buffer.from(candidate.inlineSvg, "utf8"), contentType: "image/svg+xml", finalUrl: candidate.sourcePageUrl }
          : await fetchImage(candidate.url as string, options, limiter);
        const preview = await makeWebp(image.bytes);
        const scored = scoreCandidate(candidate, preview.width, preview.height);
        converted.push({
          candidate,
          contentType: image.contentType,
          sourceBytes: image.bytes.length,
          preview: preview.bytes,
          previewBytes: preview.bytes.length,
          width: preview.width,
          height: preview.height,
          score: scored.score,
          reasons: scored.reasons,
          finalUrl: image.finalUrl,
        });
      } catch {
        // An inaccessible, oversized, or invalid image is not useful for review.
      }
    }
    return converted;
  };
  let converted = await convertCandidates(discoveryList);
  if (converted.length === 0 && !usingFaviconFallback && faviconInventory.length > 0) {
    useFaviconFallback();
    converted = await convertCandidates(discoveryList);
  }
  if (converted.length === 0) {
    return { reviewRows: [reviewRow(institution, { run_seed: options.seed, status: "no_candidates", error: "Discovered URLs did not yield downloadable images." })], retrievalRows };
  }

  if (selector) {
    const retrievalOrder = new Map(discoveryList.map((candidate, index) => [candidate.key, index]));
    converted.sort((left, right) => (retrievalOrder.get(left.candidate.key) ?? Number.MAX_SAFE_INTEGER) - (retrievalOrder.get(right.candidate.key) ?? Number.MAX_SAFE_INTEGER));
  } else {
    converted.sort((left, right) => right.score - left.score || left.finalUrl.localeCompare(right.finalUrl));
  }
  const uniqueConverted = new Map<string, CandidateResult>();
  for (const candidate of converted) {
    const fingerprint = createHash("sha256").update(candidate.preview).digest("hex");
    if (!uniqueConverted.has(fingerprint)) uniqueConverted.set(fingerprint, candidate);
  }
  const selected = [...uniqueConverted.values()].slice(0, options.maxCandidates);
  for (const [index, candidate] of selected.entries()) {
    await Promise.all([
      writeFile(path.join(PREVIEW_DIR, previewFileName(institution.id, index + 1)), candidate.preview),
      makeVisionPreview(candidate.preview).then((preview) => writeFile(path.join(PREVIEW_DIR, visionPreviewFileName(institution.id, index + 1)), preview)),
    ]);
  }

  let selection: LogoSelection | null = null;
  let aiStatus = selector ? "error" : "disabled";
  let aiError = "";
  if (selector && aiQueue) {
    try {
      selection = await aiQueue.run(() => selector.select({
        institution,
        allowFaviconFallback: usingFaviconFallback,
        candidates: selected.map((candidate, index) => ({
          index: index + 1,
          previewPath: path.join(PREVIEW_DIR, visionPreviewFileName(institution.id, index + 1)),
          source: candidate.candidate.source,
          sourcePageUrl: candidate.candidate.sourcePageUrl,
          candidateUrl: candidate.finalUrl,
          metadata: candidate.candidate.metadata,
        })),
      }));
      const selectionResult = selection;
      const chosenAssessment = selectionResult.candidateIndex === null
        ? null
        : selectionResult.assessments.find((assessment) => assessment.index === selectionResult.candidateIndex) ?? null;
      aiStatus = selectionResult.candidateIndex === null
        ? "no_match"
        : !isAcceptableAiAssessment(selected[selectionResult.candidateIndex - 1], chosenAssessment, usingFaviconFallback)
          ? "rejected_kind"
          : selectionResult.confidence >= options.aiThreshold ? "accepted" : "below_threshold";
    } catch (error) {
      aiError = cleanError(error);
    }
  }
  const aiAcceptedRank = selection && selection.candidateIndex !== null && selection.confidence >= options.aiThreshold
    && (() => {
      const assessment = selection.assessments.find((item) => item.index === selection.candidateIndex);
      return isAcceptableAiAssessment(selected[selection.candidateIndex - 1], assessment, usingFaviconFallback);
    })()
    ? selection.candidateIndex
    : null;
  const rows: ReviewRow[] = [];
  for (const [index, candidate] of selected.entries()) {
    const rank = index + 1;
    const filePath = path.join(PREVIEW_DIR, previewFileName(institution.id, rank));
    const assessment = selection?.assessments.find((item) => item.index === rank);
    rows.push(reviewRow(institution, {
      run_seed: options.seed,
      source_page_url: candidate.candidate.sourcePageUrl,
      candidate_url: candidate.finalUrl,
      preview_path: path.relative(REPOSITORY_ROOT, filePath).replaceAll(path.sep, "/"),
      candidate_rank: String(rank),
      score: String(reviewScore(candidate.score, assessment)),
      auto_selected: String(selector ? rank === aiAcceptedRank : rank === 1 && candidate.score >= options.minScore),
      status: "candidate",
      content_type: candidate.contentType,
      source_bytes: String(candidate.sourceBytes),
      preview_bytes: String(candidate.previewBytes),
      width: String(candidate.width),
      height: String(candidate.height),
      reasons: candidate.reasons.join(";"),
      candidate_metadata: candidate.candidate.metadata,
      candidate_ancestry: candidate.candidate.ancestry,
      candidate_region: candidate.candidate.pageRegion,
      ai_choice: selection?.candidateIndex === null ? "none" : String(selection?.candidateIndex ?? ""),
      ai_confidence: selection ? selection.confidence.toFixed(2) : "",
      ai_reason: selection?.reason ?? aiError,
      ai_model: selection?.model ?? (selector ? options.aiModel : ""),
      ai_status: aiStatus,
      ai_duration_ms: selection ? String(selection.durationMs) : "",
      ai_kind: assessment?.kind ?? "",
      ai_eligible: assessment ? String(assessment.eligible) : "",
    }));
  }
  return { reviewRows: rows, retrievalRows };
}

function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

async function readManifestRows(): Promise<ReviewRow[]> {
  try {
    const rows = parse(await readFile(MANIFEST_CSV, "utf8"), { columns: true, bom: true, skip_empty_lines: true }) as Array<Record<string, string>>;
    return rows.map((row) => reviewRow({
      id: row.institution_id,
      name: row.institution_name ?? "",
      normalized_name: row.normalized_name ?? "",
      category: row.category === "college" ? "college" : "high_school",
      city: row.city || null,
      state: row.state || null,
      website: row.website ?? "",
    }, row));
  } catch {
    return [];
  }
}

async function readRetrievalRows(): Promise<RetrievalReviewRow[]> {
  try {
    return parse(await readFile(RETRIEVAL_CSV, "utf8"), { columns: true, bom: true, skip_empty_lines: true }) as RetrievalReviewRow[];
  } catch {
    return [];
  }
}

function processedIds(rows: ReviewRow[], refreshFailed: boolean): Set<string> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) grouped.set(row.institution_id, [...(grouped.get(row.institution_id) ?? []), row.status]);
  const result = new Set<string>();
  for (const [id, statuses] of grouped) {
    const onlyFailures = statuses.every((status) => status === "error" || status === "no_candidates");
    if (!refreshFailed || !onlyFailures) result.add(id);
  }
  return result;
}

async function selectInstitutions(options: Options, existing: Set<string>): Promise<Institution[]> {
  const institutions = await queryLocal<Institution>(`SELECT
  id, name, normalized_name, category, city, state, website
FROM educational_institutions
WHERE (logo_key IS NULL OR TRIM(logo_key) = '')
  AND website IS NOT NULL
  AND TRIM(website) <> '';`);
  const eligible = institutions.filter((institution) => !existing.has(institution.id));
  const random = seededRandom(options.seed);
  const collegePool = shuffle(eligible.filter((institution) => institution.category === "college"), random);
  const highSchoolPool = shuffle(eligible.filter((institution) => institution.category === "high_school"), random);
  const half = Math.floor(options.limit / 2);
  const selected = [...collegePool.slice(0, half), ...highSchoolPool.slice(0, half)];
  const selectedIds = new Set(selected.map((institution) => institution.id));
  const remainderPool = shuffle(eligible.filter((institution) => !selectedIds.has(institution.id)), random);
  return shuffle([...selected, ...remainderPool.slice(0, options.limit - selected.length)], random);
}

async function ensureOutput(): Promise<void> {
  await mkdir(PREVIEW_DIR, { recursive: true });
  try {
    const manifest = await readFile(MANIFEST_CSV, "utf8");
    const header = manifest.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, "").split(",") ?? [];
    if (!MANIFEST_HEADER.every((column) => header.includes(column))) await writeManifestRows(await readManifestRows());
  } catch {
    const legacyRows = await readLegacyReviewRows();
    if (legacyRows.length > 0) {
      await writeManifestRows(legacyRows);
    } else {
      await writeFile(MANIFEST_CSV, `\uFEFF${MANIFEST_HEADER.join(",")}\r\n`, "utf8");
    }
  }
  try {
    const retrieval = await readFile(RETRIEVAL_CSV, "utf8");
    const header = retrieval.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, "").split(",") ?? [];
    if (!RETRIEVAL_HEADER.every((column) => header.includes(column))) await writeRetrievalRows(await readRetrievalRows());
  } catch {
    await writeRetrievalRows([]);
  }
}

async function readLegacyReviewRows(): Promise<ReviewRow[]> {
  try {
    const rows = parse(await readFile(REVIEW_CSV, "utf8"), { columns: true, bom: true, skip_empty_lines: true }) as Array<Record<string, string>>;
    if (!rows.every((row) => typeof row.institution_id === "string" && row.institution_id.length > 0)) return [];
    return rows.map((row) => reviewRow({
      id: row.institution_id,
      name: row.institution_name ?? "",
      normalized_name: row.normalized_name ?? "",
      category: row.category === "college" ? "college" : "high_school",
      city: row.city || null,
      state: row.state || null,
      website: row.website ?? "",
    }, row));
  } catch {
    return [];
  }
}

async function writeManifestRows(rows: ReviewRow[]): Promise<void> {
  const csv = rows.map((row) => MANIFEST_HEADER.map((header) => csvValue(row[header])).join(",")).join("\r\n");
  await writeFile(MANIFEST_CSV, `\uFEFF${MANIFEST_HEADER.join(",")}\r\n${csv}${csv ? "\r\n" : ""}`, "utf8");
}

async function appendManifestRows(rows: ReviewRow[]): Promise<void> {
  if (rows.length === 0) return;
  const csv = rows.map((row) => MANIFEST_HEADER.map((header) => csvValue(row[header])).join(",")).join("\r\n");
  await writeFile(MANIFEST_CSV, `${csv}\r\n`, { encoding: "utf8", flag: "a" });
}

async function writeRetrievalRows(rows: RetrievalReviewRow[]): Promise<void> {
  const csv = rows.map((row) => RETRIEVAL_HEADER.map((header) => csvValue(row[header])).join(",")).join("\r\n");
  await writeFile(RETRIEVAL_CSV, `\uFEFF${RETRIEVAL_HEADER.join(",")}\r\n${csv}${csv ? "\r\n" : ""}`, "utf8");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function reviewPreviewUrl(row: ReviewRow): string | null {
  if (!row.preview_path) return null;
  const absolutePreviewPath = path.resolve(REPOSITORY_ROOT, row.preview_path);
  const relative = path.relative(OUTPUT_DIR, absolutePreviewPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replaceAll(path.sep, "/");
}

function isAutoSelected(row: ReviewRow): boolean {
  return row.auto_selected.trim().toLowerCase() === "true";
}

async function writeReviewArtifacts(rows: ReviewRow[]): Promise<void> {
  const compactRows = rows.map((row) => [
    row.institution_name,
    row.category,
    row.website,
    row.candidate_rank,
    row.score,
    row.auto_selected,
    row.ai_kind,
    row.ai_eligible,
    row.ai_choice,
    row.ai_confidence,
    row.ai_status,
    row.status,
    row.candidate_url,
    row.error,
  ].map(csvValue).join(","));

  const byInstitution = new Map<string, ReviewRow[]>();
  for (const row of rows) byInstitution.set(row.institution_id, [...(byInstitution.get(row.institution_id) ?? []), row]);
  const cards = [...byInstitution.values()].map((group) => {
    const first = group[0];
    const schoolDecision = first.ai_status && first.ai_status !== "disabled" && first.ai_status !== "not_run"
      ? `<p class="school-decision">AI choice: <strong>${escapeHtml(first.ai_choice || "none")}</strong> · confidence ${escapeHtml(first.ai_confidence || "—")} · ${escapeHtml(first.ai_status)}${first.ai_reason ? ` — ${escapeHtml(first.ai_reason)}` : ""}</p>`
      : "";
    const candidates = group.map((row) => {
      const previewUrl = reviewPreviewUrl(row);
      const image = previewUrl
        ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(first.institution_name)} candidate ${escapeHtml(row.candidate_rank || "")}">`
        : `<div class="missing-image">No preview</div>`;
      const candidateLink = row.candidate_url
        ? `<a href="${escapeHtml(row.candidate_url)}" target="_blank" rel="noreferrer">Open candidate source</a>`
        : "";
      const selected = isAutoSelected(row) ? `<span class="selected">AI selected</span>` : "";
      const score = row.score ? `<span>Score ${escapeHtml(row.score)}</span>` : "";
      const aiAssessment = row.ai_kind
        ? `<span class="ai-decision">AI: ${escapeHtml(row.ai_kind)} · ${row.ai_eligible === "true" ? "eligible" : "rejected"}</span>`
        : "";
      const error = row.error ? `<p class="error">${escapeHtml(row.error)}</p>` : "";
      return `<article class="candidate">
  ${image}
  <div class="candidate-meta"><strong>Candidate ${escapeHtml(row.candidate_rank || "—")}</strong>${selected}${score}${aiAssessment}${candidateLink}</div>
  ${error}
</article>`;
    }).join("\n");
    return `<section class="school">
  <header><h2>${escapeHtml(first.institution_name)}</h2><span>${escapeHtml(first.category)}</span><span>seed ${escapeHtml(first.run_seed || "legacy")}</span><a href="${escapeHtml(first.website)}" target="_blank" rel="noreferrer">Open school website</a></header>
  ${schoolDecision}
  <div class="candidates">${candidates}</div>
</section>`;
  }).join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Logo review</title><style>
body{margin:0;background:#f4f6f8;color:#1d2733;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}.page{max-width:1440px;margin:auto;padding:28px}h1{margin:0 0 6px}p{color:#526170}.school{background:#fff;border:1px solid #dce3ea;border-radius:12px;padding:18px;margin:16px 0;box-shadow:0 1px 2px #1018280d}.school header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.school h2{font-size:18px;margin:0}.school header span{color:#596779}.school a{color:#0a63bd}.school-decision{margin:10px 0 0;color:#374151}.candidates{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:14px}.candidate{border:1px solid #e1e7ed;border-radius:8px;padding:12px;min-width:0}.candidate img,.missing-image{display:block;width:100%;height:180px;object-fit:contain;background-color:#263548;background-image:linear-gradient(45deg,#314257 25%,transparent 25%),linear-gradient(-45deg,#314257 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#314257 75%),linear-gradient(-45deg,transparent 75%,#314257 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;border-radius:5px}.missing-image{display:grid;place-items:center;color:#d5dee8}.candidate-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}.candidate-meta a{margin-left:auto}.selected{background:#d9f5e5;color:#0d6b35;border-radius:999px;padding:2px 8px;font-size:12px}.ai-decision{background:#e8efff;color:#244a9d;border-radius:999px;padding:2px 8px;font-size:12px}.error{color:#a22626;margin:9px 0 0}.footer{margin-top:20px;color:#637281;font-size:12px}</style></head>
<body><main class="page"><h1>Logo review</h1><p>${rows.length} evaluation row${rows.length === 1 ? "" : "s"}. Images are loaded locally from the <code>previews</code> folder.</p>${cards}<p class="footer">Generated by scripts/logos/scrape-website-logos.ts</p></main></body></html>`;
  await writeFile(REVIEW_HTML, html, "utf8");
  try {
    await writeFile(REVIEW_CSV, `\uFEFF${REVIEW_HEADER.join(",")}\r\n${compactRows.join("\r\n")}${compactRows.length > 0 ? "\r\n" : ""}`, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EBUSY" || code === "EPERM") {
      throw new Error(`The HTML review was written, but ${REVIEW_CSV} is open or locked. Close it, then run --render-review.`);
    }
    throw error;
  }
}

async function writeRetrievalArtifacts(rows: RetrievalReviewRow[]): Promise<void> {
  await writeRetrievalRows(rows);
  const byInstitution = new Map<string, RetrievalReviewRow[]>();
  for (const row of rows) byInstitution.set(row.institution_id, [...(byInstitution.get(row.institution_id) ?? []), row]);
  const schools = [...byInstitution.values()].map((group) => {
    const first = group[0];
    const tableRows = group.map((row) => {
      const asset = row.candidate_url
        ? `<a href="${escapeHtml(row.candidate_url)}" target="_blank" rel="noreferrer">Open asset</a>`
        : "Inline SVG";
      const source = row.source_page_url
        ? `<a href="${escapeHtml(row.source_page_url)}" target="_blank" rel="noreferrer">Open page</a>`
        : "";
      return `<tr><td>${escapeHtml(row.inventory_index)}</td><td>${escapeHtml(row.batch_number || "—")}</td><td>${escapeHtml(row.batch_rank || "—")}</td><td>${escapeHtml(row.final_rank || "—")}</td><td><span class="status ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.page_region || "—")}</td><td>${escapeHtml(row.source)}</td><td>${asset}</td><td>${source}</td><td><code>${escapeHtml(row.metadata || "—")}</code></td><td><code>${escapeHtml(row.ancestry || "—")}</code></td><td>${escapeHtml(row.error || "")}</td></tr>`;
    }).join("\n");
    return `<section class="school"><header><h2>${escapeHtml(first.institution_name)}</h2><span>${escapeHtml(first.category)}</span><span>seed ${escapeHtml(first.run_seed || "legacy")}</span><a href="${escapeHtml(first.website)}" target="_blank" rel="noreferrer">Open school website</a></header><p>${group.length} raw DOM asset${group.length === 1 ? "" : "s"}. <strong>selected_for_visual</strong> rows were handed off by text ranking; <strong>selected_as_favicon_fallback</strong> is used only when no ordinary asset can be evaluated.</p><div class="scroll"><table><thead><tr><th>Inventory</th><th>Batch</th><th>Batch rank</th><th>Final rank</th><th>Text status</th><th>Region</th><th>Discovery source</th><th>Asset</th><th>Page</th><th>Element metadata</th><th>Semantic ancestry</th><th>Error</th></tr></thead><tbody>${tableRows}</tbody></table></div></section>`;
  }).join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Logo text retrieval audit</title><style>
body{margin:0;background:#f4f6f8;color:#1d2733;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}.page{max-width:1800px;margin:auto;padding:28px}h1{margin:0 0 6px}p{color:#526170}.school{background:#fff;border:1px solid #dce3ea;border-radius:12px;padding:18px;margin:16px 0;box-shadow:0 1px 2px #1018280d}.school header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.school h2{font-size:18px;margin:0}.school header span{color:#596779}.school a{color:#0a63bd}.scroll{overflow:auto;border:1px solid #e1e7ed;border-radius:8px}table{width:100%;border-collapse:collapse;min-width:1500px}th,td{padding:9px 10px;border-bottom:1px solid #e7ecf1;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f8fafc;font-size:12px;white-space:nowrap}tr:last-child td{border-bottom:0}code{display:block;max-width:420px;white-space:normal;overflow-wrap:anywhere;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#344054}.status{display:inline-block;border-radius:999px;padding:2px 7px;background:#eef2f6;color:#455468;font-size:12px;white-space:nowrap}.status.shortlisted_by_text{background:#e8efff;color:#244a9d}.status.selected_for_visual{background:#d9f5e5;color:#0d6b35}.status.selected_as_favicon_fallback{background:#fff0c2;color:#8a5600}.status.text_ranking_error{background:#fee4e2;color:#b42318}.footer{margin-top:20px;color:#637281;font-size:12px}</style></head>
<body><main class="page"><h1>Logo text retrieval audit</h1><p>${rows.length} raw DOM candidate${rows.length === 1 ? "" : "s"}. This is the first-stage text-only ranking audit; no image judgment is represented here.</p>${schools}<p class="footer">Generated by scripts/logos/scrape-website-logos.ts</p></main></body></html>`;
  await writeFile(RETRIEVAL_HTML, html, "utf8");
}

async function mapLimit<T, R>(items: T[], concurrency: number, callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resetReview(options: Options): Promise<void> {
  if (!options.yes) throw new Error("--reset-review requires --yes because it deletes data/logos evaluation files.");
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  console.log(`Removed ${OUTPUT_DIR}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.resetReview) {
    await resetReview(options);
    return;
  }

  await ensureOutput();
  const existingRows = await readManifestRows();
  const existingRetrievalRows = await readRetrievalRows();
  if (options.renderReview) {
    await writeReviewArtifacts(existingRows);
    await writeRetrievalArtifacts(existingRetrievalRows);
    console.log(`Review CSV: ${REVIEW_CSV}`);
    console.log(`Visual review: ${REVIEW_HTML}`);
    console.log(`Text retrieval CSV: ${RETRIEVAL_CSV}`);
    console.log(`Text retrieval audit: ${RETRIEVAL_HTML}`);
    return;
  }
  const selector = options.aiEnabled
    ? new OllamaLogoSelector({ baseUrl: options.ollamaUrl, model: options.aiModel, keepAlive: options.aiKeepAlive })
    : null;
  if (selector) {
    await selector.assertAvailable();
    console.log(`AI selector: ${options.aiModel} at ${options.ollamaUrl} (threshold ${options.aiThreshold}, concurrency ${options.aiConcurrency})`);
  } else {
    console.log("AI selector: disabled; deterministic rank-1 selection remains enabled.");
  }
  const institutions = await selectInstitutions(options, processedIds(existingRows, options.refreshFailed));
  if (institutions.length === 0) {
    console.log("No eligible schools remain for evaluation.");
    return;
  }

  console.log("Website logo evaluation");
  console.log(`Seed: ${options.seed}`);
  console.log(`Schools selected: ${institutions.length}`);
  console.log(`Manifest: ${MANIFEST_CSV}`);
  console.log(`Review CSV: ${REVIEW_CSV}`);
  console.log(`Visual review: ${REVIEW_HTML}`);
  console.log(`Text retrieval CSV: ${RETRIEVAL_CSV}`);
  console.log(`Text retrieval audit: ${RETRIEVAL_HTML}`);
  console.log(`Preview directory: ${PREVIEW_DIR}`);
  if (options.apply) console.log("Apply mode: accepted AI selections will be uploaded to remote R2 and recorded in remote D1.");
  const limiter = new HostLimiter(options.perHostDelayMs);
  const aiQueue = selector ? new WorkQueue(options.aiConcurrency) : null;
  let completed = 0;
  const batches = await mapLimit(institutions, options.concurrency, async (institution) => {
    const result = await evaluateInstitution(institution, options, limiter, selector, aiQueue);
    completed += 1;
    console.log(`Evaluated ${completed}/${institutions.length}: ${institution.name}`);
    return result;
  });
  const rows = batches.flatMap((result) => result.reviewRows);
  const retrievalRows = batches.flatMap((result) => result.retrievalRows);
  await appendManifestRows(rows);
  await writeRetrievalArtifacts([...existingRetrievalRows, ...retrievalRows]);
  if (!options.apply) await writeReviewArtifacts([...existingRows, ...rows]);

  const statusCounts = new Map<string, number>();
  for (const row of rows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  console.log("Summary");
  for (const [status, count] of [...statusCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) console.log(`  ${status}: ${count}`);
  if (options.apply) {
    const result = await applyAcceptedSelections(rows);
    console.log(`Remote changes: ${result.uploaded} logo${result.uploaded === 1 ? "" : "s"} uploaded and recorded; ${result.skipped} evaluation row${result.skipped === 1 ? "" : "s"} not applied.`);
  } else {
    console.log("No D1 or R2 changes were made.");
  }
}

main().catch((error: unknown) => {
  console.error(cleanError(error));
  process.exitCode = 1;
});

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import sharp, { type Metadata } from "sharp";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DATABASE_NAME = "nukleio-catalog";
const OUTPUT_DIR = path.join(REPOSITORY_ROOT, "data", "logos");
const REVIEW_CSV = path.join(OUTPUT_DIR, "logo-review.csv");
const MANIFEST_CSV = path.join(OUTPUT_DIR, "logo-manifest.csv");
const REVIEW_HTML = path.join(OUTPUT_DIR, "logo-review.html");
const PREVIEW_DIR = path.join(OUTPUT_DIR, "previews");

const DEFAULT_LIMIT = 20;
const DEFAULT_CONCURRENCY = 24;
const DEFAULT_PER_HOST_DELAY_MS = 750;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MIN_SCORE = 75;
const MAX_DISCOVERY_CANDIDATES = 24;
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
  concurrency: number;
  perHostDelayMs: number;
  timeoutMs: number;
  maxPages: number;
  maxCandidates: number;
  minScore: number;
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
  initialScore: number;
  reasons: string[];
};

type ReviewRow = {
  institution_id: string;
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

const MANIFEST_HEADER = [
  "institution_id", "institution_name", "normalized_name", "category", "city", "state", "website",
  "source_page_url", "candidate_url", "preview_path", "candidate_rank", "score", "auto_selected",
  "status", "content_type", "source_bytes", "preview_bytes", "width", "height", "reasons", "error",
] as const;

const REVIEW_HEADER = [
  "institution_name", "category", "website", "candidate_rank", "score", "auto_selected", "status", "candidate_url", "error",
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
  --concurrency <count>        Concurrent school evaluations (default: ${DEFAULT_CONCURRENCY})
  --per-host-delay-ms <ms>     Minimum delay between requests to one host (default: ${DEFAULT_PER_HOST_DELAY_MS})
  --timeout-ms <ms>            Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-pages <count>          Homepage plus relevant same-site pages; 1-4 (default: ${DEFAULT_MAX_PAGES})
  --max-candidates <count>     Downloaded WebP previews per school; 1-5 (default: ${DEFAULT_MAX_CANDIDATES})
  --min-score <score>          Score needed to mark rank 1 as auto-selected; 0-100 (default: ${DEFAULT_MIN_SCORE})
  --refresh-failed             Retry schools previously recorded only as errors or no-candidate results
  --render-review              Rebuild the compact CSV and visual HTML review from the local manifest
  --reset-review               Delete local manifests, review files, and previews under data/logos
  --yes                        Required with --reset-review
`);
  process.exit(0);
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) usage();

  let limit = DEFAULT_LIMIT;
  let concurrency = DEFAULT_CONCURRENCY;
  let perHostDelayMs = DEFAULT_PER_HOST_DELAY_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxPages = DEFAULT_MAX_PAGES;
  let maxCandidates = DEFAULT_MAX_CANDIDATES;
  let minScore = DEFAULT_MIN_SCORE;
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
    if (["--limit", "--concurrency", "--per-host-delay-ms", "--timeout-ms", "--max-pages", "--max-candidates", "--min-score"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      const number = Number(value);
      if (!Number.isInteger(number)) throw new Error(`${argument} must be an integer.`);
      if (argument === "--limit") limit = number;
      if (argument === "--concurrency") concurrency = number;
      if (argument === "--per-host-delay-ms") perHostDelayMs = number;
      if (argument === "--timeout-ms") timeoutMs = number;
      if (argument === "--max-pages") maxPages = number;
      if (argument === "--max-candidates") maxCandidates = number;
      if (argument === "--min-score") minScore = number;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (limit < 1 || concurrency < 1 || perHostDelayMs < 0 || timeoutMs < 1) throw new Error("--limit, --concurrency, --per-host-delay-ms, and --timeout-ms must be positive.");
  if (maxPages < 1 || maxPages > 4) throw new Error("--max-pages must be between 1 and 4.");
  if (maxCandidates < 1 || maxCandidates > 5) throw new Error("--max-candidates must be between 1 and 5.");
  if (minScore < 0 || minScore > 100) throw new Error("--min-score must be between 0 and 100.");
  return { limit, concurrency, perHostDelayMs, timeoutMs, maxPages, maxCandidates, minScore, refreshFailed, renderReview, resetReview, yes };
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

function hasPositiveLogoSignal(value: string): boolean {
  const text = value.toLowerCase();
  return POSITIVE_TOKENS.some(([token]) => text.includes(token));
}

function rejectedAsset(value: string): boolean {
  return /recaptcha|gstatic\.com|wp-includes\/images\/w-logo|(?:social.*sprite|sprite.*social)|(?:facebook|twitter|linkedin)[-_]?button/i.test(value);
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
  if (/<header\b|headerlogo|header-logo|logoimage|logo-image/.test(text)) {
    score += 28;
    reasons.push("structure:header");
  }
  if (/\bid\s*=\s*["'][^"']*logo|\bclass\s*=\s*["'][^"']*logo|\balt\s*=\s*["'][^"']*logo/.test(text)) {
    score += 26;
    reasons.push("structure:logo-container");
  }
  return { score, reasons };
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
): void {
  if (!rawUrl) return;
  const url = normalizeUrl(rawUrl, pageUrl);
  if (!url) return;
  if (rejectedAsset(`${url} ${signalText}`)) return;
  const urlSignals = tokenScore(url);
  const contextSignals = tokenScore(signalText);
  const institutionSignals = institutionMatchScore(institution, `${url} ${signalText}`);
  const structureSignals = structuralScore(structuralContext);
  const genericImageSource = source === "image-element" || source === "picture-source" || source === "css-background";
  const explicitSignal = hasPositiveLogoSignal(`${url} ${signalText}`) || institutionSignals.score > 0 || structureSignals.score > 0;
  if (source === "css-background" && !explicitSignal) return;
  if ((source === "image-element" || source === "picture-source") && !explicitSignal) return;
  const contextScore = genericImageSource ? Math.trunc(contextSignals.score * 0.35) : contextSignals.score;
  addCandidate(candidates, {
    institution,
    sourcePageUrl: pageUrl,
    key: url,
    url,
    inlineSvg: null,
    source,
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

function addInlineSvgCandidate(candidates: Map<string, Candidate>, institution: Institution, pageUrl: string, svg: string, context: string): void {
  const svgTitle = svg.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g, " ") ?? "";
  const signals = `${svgTitle} ${context}`;
  const tokenSignals = tokenScore(signals);
  const institutionSignals = institutionMatchScore(institution, signals);
  const structureSignals = structuralScore(context);
  if (!hasPositiveLogoSignal(signals) && institutionSignals.score === 0 && structureSignals.score === 0) return;
  const key = `inline-svg:${createHash("sha256").update(pageUrl).update(svg).digest("hex")}`;
  addCandidate(candidates, {
    institution,
    sourcePageUrl: pageUrl,
    key,
    url: null,
    inlineSvg: svg,
    source: "inline-svg",
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
  const tagPattern = /<(link|img|source|meta)\b[^>]*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tagName = match[1].toLowerCase();
    const attributes = parseAttributes(match[0]);
    if (tagName === "link") {
      const rel = attributes.get("rel")?.toLowerCase() ?? "";
      const href = attributes.get("href");
      if (rel.includes("manifest")) {
        const manifestUrl = href ? normalizeUrl(href, pageUrl) : null;
        if (manifestUrl) manifestUrls.push(manifestUrl);
      }
      if (rel.includes("icon") || rel.includes("image_src")) {
        addImageCandidate(candidates, institution, pageUrl, href, "document-icon", rel.includes("icon") ? 32 : 22, `${rel} ${attributes.get("sizes") ?? ""}`);
      }
      continue;
    }
    if (tagName === "meta") {
      const marker = `${attributes.get("property") ?? ""} ${attributes.get("name") ?? ""}`.toLowerCase();
      if (marker.includes("og:image") || marker.includes("twitter:image") || marker === "image") {
        addImageCandidate(candidates, institution, pageUrl, attributes.get("content"), "metadata-image", 5, marker);
      }
      continue;
    }
    const source = tagName === "source" ? "picture-source" : "image-element";
    const signals = `${attributes.get("alt") ?? ""} ${attributes.get("class") ?? ""} ${attributes.get("id") ?? ""} ${attributes.get("title") ?? ""}`;
    const index = match.index ?? 0;
    const structuralContext = html.slice(Math.max(0, index - 1_500), Math.min(html.length, index + match[0].length + 300));
    const baseScore = 5;
    addImageCandidate(candidates, institution, pageUrl, attributes.get("src"), source, baseScore, signals, structuralContext);
    addImageCandidate(candidates, institution, pageUrl, attributes.get("data-src"), source, baseScore, signals, structuralContext);
    for (const url of parseSrcset(attributes.get("srcset") ?? "")) addImageCandidate(candidates, institution, pageUrl, url, source, baseScore, signals, structuralContext);
    for (const url of parseSrcset(attributes.get("data-srcset") ?? "")) addImageCandidate(candidates, institution, pageUrl, url, source, baseScore, signals, structuralContext);
  }
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    addImageCandidate(candidates, institution, pageUrl, match[1], "css-background", 0, match[1]);
  }
  const svgPattern = /<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi;
  for (const match of html.matchAll(svgPattern)) {
    const index = match.index ?? 0;
    const context = html.slice(Math.max(0, index - 1_500), Math.min(html.length, index + match[0].length + 300));
    addInlineSvgCandidate(candidates, institution, pageUrl, match[0], context);
  }
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

function previewFileName(institutionId: string, rank: number): string {
  return `${institutionId.replace(/[^a-z0-9_-]/gi, "_")}-candidate-${rank}.webp`;
}

function reviewRow(institution: Institution, overrides: Partial<ReviewRow>): ReviewRow {
  return {
    institution_id: institution.id,
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
    error: "",
    ...overrides,
  };
}

async function evaluateInstitution(institution: Institution, options: Options, limiter: HostLimiter): Promise<ReviewRow[]> {
  const website = normalizeUrl(institution.website);
  if (!website) return [reviewRow(institution, { status: "error", error: "Invalid website URL." })];

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

  const discoveryList = [...candidates.values()]
    .sort((left, right) => right.initialScore - left.initialScore || left.key.localeCompare(right.key))
    .slice(0, MAX_DISCOVERY_CANDIDATES);
  if (discoveryList.length === 0) {
    return [reviewRow(institution, { status: firstError ? "error" : "no_candidates", error: firstError ?? "No image candidates found." })];
  }

  const converted: CandidateResult[] = [];
  for (const candidate of discoveryList) {
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
  if (converted.length === 0) {
    return [reviewRow(institution, { status: "no_candidates", error: "Discovered URLs did not yield downloadable images." })];
  }

  converted.sort((left, right) => right.score - left.score || left.finalUrl.localeCompare(right.finalUrl));
  const selected = converted.slice(0, options.maxCandidates);
  const rows: ReviewRow[] = [];
  for (const [index, candidate] of selected.entries()) {
    const rank = index + 1;
    const filePath = path.join(PREVIEW_DIR, previewFileName(institution.id, rank));
    await writeFile(filePath, candidate.preview);
    rows.push(reviewRow(institution, {
      source_page_url: candidate.candidate.sourcePageUrl,
      candidate_url: candidate.finalUrl,
      preview_path: path.relative(REPOSITORY_ROOT, filePath).replaceAll(path.sep, "/"),
      candidate_rank: String(rank),
      score: String(candidate.score),
      auto_selected: String(rank === 1 && candidate.score >= options.minScore),
      status: "candidate",
      content_type: candidate.contentType,
      source_bytes: String(candidate.sourceBytes),
      preview_bytes: String(candidate.previewBytes),
      width: String(candidate.width),
      height: String(candidate.height),
      reasons: candidate.reasons.join(";"),
    }));
  }
  return rows;
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

async function readManifestRows(): Promise<ReviewRow[]> {
  try {
    return parse(await readFile(MANIFEST_CSV, "utf8"), { columns: true, bom: true, skip_empty_lines: true }) as ReviewRow[];
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
  const collegePool = shuffle(eligible.filter((institution) => institution.category === "college"));
  const highSchoolPool = shuffle(eligible.filter((institution) => institution.category === "high_school"));
  const half = Math.floor(options.limit / 2);
  const selected = [...collegePool.slice(0, half), ...highSchoolPool.slice(0, half)];
  const selectedIds = new Set(selected.map((institution) => institution.id));
  const remainderPool = shuffle(eligible.filter((institution) => !selectedIds.has(institution.id)));
  return shuffle([...selected, ...remainderPool.slice(0, options.limit - selected.length)]);
}

async function ensureOutput(): Promise<void> {
  await mkdir(PREVIEW_DIR, { recursive: true });
  try {
    await readFile(MANIFEST_CSV, "utf8");
  } catch {
    const legacyRows = await readLegacyReviewRows();
    if (legacyRows.length > 0) {
      await writeManifestRows(legacyRows);
    } else {
      await writeFile(MANIFEST_CSV, `\uFEFF${MANIFEST_HEADER.join(",")}\r\n`, "utf8");
    }
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
    row.status,
    row.candidate_url,
    row.error,
  ].map(csvValue).join(","));

  const byInstitution = new Map<string, ReviewRow[]>();
  for (const row of rows) byInstitution.set(row.institution_id, [...(byInstitution.get(row.institution_id) ?? []), row]);
  const cards = [...byInstitution.values()].map((group) => {
    const first = group[0];
    const candidates = group.map((row) => {
      const previewUrl = reviewPreviewUrl(row);
      const image = previewUrl
        ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(first.institution_name)} candidate ${escapeHtml(row.candidate_rank || "")}">`
        : `<div class="missing-image">No preview</div>`;
      const candidateLink = row.candidate_url
        ? `<a href="${escapeHtml(row.candidate_url)}" target="_blank" rel="noreferrer">Open candidate source</a>`
        : "";
      const selected = isAutoSelected(row) ? `<span class="selected">Auto-selected</span>` : "";
      const score = row.score ? `<span>Score ${escapeHtml(row.score)}</span>` : "";
      const error = row.error ? `<p class="error">${escapeHtml(row.error)}</p>` : "";
      return `<article class="candidate">
  ${image}
  <div class="candidate-meta"><strong>Candidate ${escapeHtml(row.candidate_rank || "—")}</strong>${selected}${score}${candidateLink}</div>
  ${error}
</article>`;
    }).join("\n");
    return `<section class="school">
  <header><h2>${escapeHtml(first.institution_name)}</h2><span>${escapeHtml(first.category)}</span><a href="${escapeHtml(first.website)}" target="_blank" rel="noreferrer">Open school website</a></header>
  <div class="candidates">${candidates}</div>
</section>`;
  }).join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Logo review</title><style>
body{margin:0;background:#f4f6f8;color:#1d2733;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}.page{max-width:1440px;margin:auto;padding:28px}h1{margin:0 0 6px}p{color:#526170}.school{background:#fff;border:1px solid #dce3ea;border-radius:12px;padding:18px;margin:16px 0;box-shadow:0 1px 2px #1018280d}.school header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.school h2{font-size:18px;margin:0}.school header span{color:#596779}.school a{color:#0a63bd}.candidates{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:14px}.candidate{border:1px solid #e1e7ed;border-radius:8px;padding:12px;min-width:0}.candidate img,.missing-image{display:block;width:100%;height:180px;object-fit:contain;background:#f8fafc;border-radius:5px}.missing-image{display:grid;place-items:center;color:#7a8794}.candidate-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px}.candidate-meta a{margin-left:auto}.selected{background:#d9f5e5;color:#0d6b35;border-radius:999px;padding:2px 8px;font-size:12px}.error{color:#a22626;margin:9px 0 0}.footer{margin-top:20px;color:#637281;font-size:12px}</style></head>
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
  if (options.renderReview) {
    await writeReviewArtifacts(existingRows);
    console.log(`Review CSV: ${REVIEW_CSV}`);
    console.log(`Visual review: ${REVIEW_HTML}`);
    return;
  }
  const institutions = await selectInstitutions(options, processedIds(existingRows, options.refreshFailed));
  if (institutions.length === 0) {
    console.log("No eligible schools remain for evaluation.");
    return;
  }

  console.log("Website logo evaluation");
  console.log(`Schools selected: ${institutions.length}`);
  console.log(`Manifest: ${MANIFEST_CSV}`);
  console.log(`Review CSV: ${REVIEW_CSV}`);
  console.log(`Visual review: ${REVIEW_HTML}`);
  console.log(`Preview directory: ${PREVIEW_DIR}`);
  const limiter = new HostLimiter(options.perHostDelayMs);
  let completed = 0;
  const batches = await mapLimit(institutions, options.concurrency, async (institution) => {
    const rows = await evaluateInstitution(institution, options, limiter);
    completed += 1;
    console.log(`Evaluated ${completed}/${institutions.length}: ${institution.name}`);
    return rows;
  });
  const rows = batches.flat();
  await appendManifestRows(rows);
  await writeReviewArtifacts([...existingRows, ...rows]);

  const statusCounts = new Map<string, number>();
  for (const row of rows) statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
  console.log("Summary");
  for (const [status, count] of [...statusCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) console.log(`  ${status}: ${count}`);
  console.log("No D1 or R2 changes were made.");
}

main().catch((error: unknown) => {
  console.error(cleanError(error));
  process.exitCode = 1;
});

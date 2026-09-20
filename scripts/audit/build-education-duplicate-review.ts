import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CANDIDATES = path.join(REPOSITORY_ROOT, "data", "audits", "education-duplicate-candidates.json");
const DEFAULT_OUTPUT = path.join(REPOSITORY_ROOT, "data", "audits", "education-duplicate-review.csv");

type CandidateRow = {
  id: string;
  source: string;
  source_id: string;
  name: string;
  normalized_name: string;
  category: string;
  city: string | null;
  state: string | null;
  source_year: number | null;
  is_active: number;
};

type CandidateGroup = {
  key: string;
  candidateType: string;
  rows: CandidateRow[];
};

type AuditCandidates = {
  exactLocationCandidates: CandidateGroup[];
};

type RawRow = Record<string, string>;

type ReviewRow = {
  groupId: string;
  candidateType: string;
  groupSize: number;
  dbId: string;
  source: string;
  sourceId: string;
  sourceYear: number | null;
  category: string;
  name: string;
  normalizedName: string;
  dbCity: string | null;
  dbState: string | null;
  dbIsActive: number;
  rawName: string | null;
  website: string | null;
  sourceAddress: string | null;
  sourceCity: string | null;
  sourceState: string | null;
  sourceZip: string | null;
  mailingAddress: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  districtOrLea: string | null;
  status: string | null;
  schoolType: string | null;
  sourceClassification: string | null;
  gradeRange: string | null;
  sourceFrame: string | null;
  sourceMatch: string;
  reviewDecision: string;
  canonicalSourceId: string;
  reviewNotes: string;
};

function usage(): never {
  console.log(`Usage:
  .\\node_modules\\.bin\\tsx.cmd scripts\\audit\\build-education-duplicate-review.ts

Options:
  --candidates <path>  Candidate JSON (default: data/audits/education-duplicate-candidates.json)
  --output <path>      Review CSV (default: data/audits/education-duplicate-review.csv)
`);
  process.exit(0);
}

function parseOptions(argv: string[]): { candidatesPath: string; outputPath: string } {
  if (argv.includes("--help") || argv.includes("-h")) usage();
  let candidatesPath = DEFAULT_CANDIDATES;
  let outputPath = DEFAULT_OUTPUT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--candidates" || argument === "--output") {
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--candidates") candidatesPath = path.resolve(REPOSITORY_ROOT, value);
      if (argument === "--output") outputPath = path.resolve(REPOSITORY_ROOT, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { candidatesPath, outputPath };
}

function clean(value: unknown): string {
  const text = String(value ?? "").replace(/^\uFEFF/, "").trim();
  return ["-1", "-2", "-3"].includes(text) ? "" : text;
}

async function readCsv(filePath: string): Promise<RawRow[]> {
  const parser = createReadStream(filePath).pipe(parse({
    bom: true,
    columns: (header: string[]) => header.map((column) => column.trim()),
    skip_empty_lines: true,
    relax_column_count: false,
    trim: false,
  }));
  const rows: RawRow[] = [];
  for await (const rawRow of parser) rows.push(rawRow as RawRow);
  return rows;
}

function rawKey(source: string, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}

function joinParts(parts: Array<unknown>): string | null {
  const values = parts.map(clean).filter(Boolean);
  return values.length > 0 ? values.join(", ") : null;
}

function getRawContext(source: string, raw: RawRow | undefined): Omit<ReviewRow, "groupId" | "candidateType" | "groupSize" | "dbId" | "source" | "sourceId" | "sourceYear" | "category" | "name" | "normalizedName" | "dbCity" | "dbState" | "dbIsActive"> {
  if (!raw) {
    return {
      rawName: null,
      website: null,
      sourceAddress: null,
      sourceCity: null,
      sourceState: null,
      sourceZip: null,
      mailingAddress: null,
      mailingCity: null,
      mailingState: null,
      mailingZip: null,
      districtOrLea: null,
      status: null,
      schoolType: null,
      sourceClassification: null,
      gradeRange: null,
      sourceFrame: null,
      sourceMatch: "missing_raw_row",
      reviewDecision: "",
      canonicalSourceId: "",
      reviewNotes: "Raw source row was not found.",
    };
  }

  if (source === "IPEDS") {
    return {
      rawName: clean(raw.INSTNM) || null,
      website: clean(raw.WEBADDR) || null,
      sourceAddress: clean(raw.ADDR) || null,
      sourceCity: clean(raw.CITY) || null,
      sourceState: clean(raw.STABBR).toUpperCase() || null,
      sourceZip: clean(raw.ZIP) || null,
      mailingAddress: null,
      mailingCity: null,
      mailingState: null,
      mailingZip: null,
      districtOrLea: clean(raw.F1SYSNAM) || null,
      status: clean(raw.CYACTIVE) === "1" ? "Active" : "Inactive/unknown",
      schoolType: clean(raw.INSTCAT) || null,
      sourceClassification: joinParts([raw.CONTROL, raw.SECTOR]) ,
      gradeRange: null,
      sourceFrame: null,
      sourceMatch: "matched_raw_row",
      reviewDecision: "",
      canonicalSourceId: "",
      reviewNotes: "",
    };
  }

  if (source === "CCD") {
    return {
      rawName: clean(raw.SCH_NAME) || null,
      website: clean(raw.WEBSITE) || null,
      sourceAddress: joinParts([raw.LSTREET1, raw.LSTREET2, raw.LSTREET3]),
      sourceCity: clean(raw.LCITY) || null,
      sourceState: clean(raw.LSTATE).toUpperCase() || null,
      sourceZip: joinParts([raw.LZIP, raw.LZIP4]),
      mailingAddress: joinParts([raw.MSTREET1, raw.MSTREET2, raw.MSTREET3]),
      mailingCity: clean(raw.MCITY) || null,
      mailingState: clean(raw.MSTATE).toUpperCase() || null,
      mailingZip: joinParts([raw.MZIP, raw.MZIP4]),
      districtOrLea: joinParts([raw.LEA_NAME, raw.LEAID]),
      status: clean(raw.SY_STATUS_TEXT) || null,
      schoolType: clean(raw.SCH_TYPE_TEXT) || null,
      sourceClassification: joinParts([raw.CHARTER_TEXT, raw.OUT_OF_STATE_FLAG]),
      gradeRange: joinParts([raw.GSLO, raw.GSHI]),
      sourceFrame: null,
      sourceMatch: "matched_raw_row",
      reviewDecision: "",
      canonicalSourceId: "",
      reviewNotes: "",
    };
  }

  const physicalAddress = clean(raw.PL_ADD);
  const physicalCity = clean(raw.PL_CIT);
  const physicalState = clean(raw.PL_STABB).toUpperCase();
  return {
    rawName: clean(raw.PINST) || null,
    website: null,
    sourceAddress: physicalAddress || null,
    sourceCity: physicalCity || clean(raw.PCITY) || null,
    sourceState: physicalState || clean(raw.PSTABB).toUpperCase() || null,
    sourceZip: clean(raw.PL_ZIP) || clean(raw.PZIP) || null,
    mailingAddress: clean(raw.PADDRS) || null,
    mailingCity: clean(raw.PCITY) || null,
    mailingState: clean(raw.PSTABB).toUpperCase() || null,
    mailingZip: clean(raw.PZIP) || null,
    districtOrLea: clean(raw.PCNTNM) || null,
    status: "PSS respondent record",
    schoolType: clean(raw.TYPOLOGY) || null,
    sourceClassification: joinParts([raw.RELIG, raw.ORIENT]),
    gradeRange: joinParts([raw.LOGR2024, raw.HIGR2024]),
    sourceFrame: clean(raw.FRAME) || null,
    sourceMatch: "matched_raw_row",
    reviewDecision: "",
    canonicalSourceId: "",
    reviewNotes: physicalCity ? "" : "Physical city unavailable; mailing city shown as fallback.",
  };
}

function csvValue(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(rows: ReviewRow[]): string {
  const columns: Array<keyof ReviewRow> = [
    "groupId", "candidateType", "groupSize", "dbId", "source", "sourceId", "sourceYear",
    "category", "name", "normalizedName", "dbCity", "dbState", "dbIsActive", "rawName",
    "website", "sourceAddress", "sourceCity", "sourceState", "sourceZip", "mailingAddress",
    "mailingCity", "mailingState", "mailingZip", "districtOrLea", "status", "schoolType",
    "sourceClassification", "gradeRange", "sourceFrame", "sourceMatch", "reviewDecision",
    "canonicalSourceId", "reviewNotes",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvValue(row[column])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const candidates = JSON.parse(await readFile(options.candidatesPath, "utf8")) as AuditCandidates;
  const [collegeRows, publicRows, privateRows] = await Promise.all([
    readCsv(path.join(REPOSITORY_ROOT, "data", "colleges.csv")),
    readCsv(path.join(REPOSITORY_ROOT, "data", "public_highschools.csv")),
    readCsv(path.join(REPOSITORY_ROOT, "data", "private_highschools.csv")),
  ]);
  const rawRows = new Map<string, RawRow>();
  for (const row of collegeRows) rawRows.set(rawKey("IPEDS", clean(row.UNITID)), row);
  for (const row of publicRows) rawRows.set(rawKey("CCD", clean(row.NCESSCH)), row);
  for (const row of privateRows) rawRows.set(rawKey("PSS", clean(row.PPIN)), row);

  const reviewRows: ReviewRow[] = [];
  candidates.exactLocationCandidates.forEach((group, groupIndex) => {
    const groupId = `DUP-${String(groupIndex + 1).padStart(4, "0")}`;
    for (const candidate of group.rows) {
      const context = getRawContext(candidate.source, rawRows.get(rawKey(candidate.source, candidate.source_id)));
      reviewRows.push({
        groupId,
        candidateType: group.candidateType,
        groupSize: group.rows.length,
        dbId: candidate.id,
        source: candidate.source,
        sourceId: candidate.source_id,
        sourceYear: candidate.source_year,
        category: candidate.category,
        name: candidate.name,
        normalizedName: candidate.normalized_name,
        dbCity: candidate.city,
        dbState: candidate.state,
        dbIsActive: candidate.is_active,
        ...context,
      });
    }
  });

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, buildCsv(reviewRows), "utf8");
  console.log("Education duplicate review CSV created");
  console.log(`Candidate groups: ${candidates.exactLocationCandidates.length}`);
  console.log(`Candidate rows: ${reviewRows.length}`);
  console.log(`Output: ${options.outputPath}`);
  console.log("No database rows were changed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

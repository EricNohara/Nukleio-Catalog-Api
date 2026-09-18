# Nukleio Catalog API --- Architecture & Implementation Specification

## 1. Purpose

Build a small, public, read-only catalog API for Nukleio that provides:

1.  **U.S. educational institutions**
    -   Colleges
    -   High schools
    -   Basic metadata
    -   Logos when available
2.  **Technologies**
    -   Programming languages
    -   Frameworks
    -   General technologies
    -   Basic metadata
    -   Logos/icons when available

Nukleio is the primary client, but the API should also be publicly
usable.

The design should prioritize:

-   Simplicity
-   \$0/month operation
-   Fast autocomplete/search
-   Stable entity IDs
-   Minimal infrastructure
-   Manual, reproducible data imports
-   Easy manual backfilling of missing metadata/logos
-   Avoiding unnecessary abstraction or infrastructure

Do **not** generalize the system for entity types beyond education and
technologies unless a concrete future requirement appears.

------------------------------------------------------------------------

## 2. Hard Constraints

### Cost

**The API must not incur paid Cloudflare usage. \$0/month is a hard
constraint, not merely an optimization.**

If traffic or abuse would otherwise cause billable usage, availability
should be sacrificed instead. It is acceptable for:

-   Public traffic to be rejected or unavailable.
-   In an extreme case, Nukleio traffic to become unavailable.

It is **not** acceptable to intentionally allow billable usage just to
preserve availability.

Use Cloudflare hard usage/spend controls wherever Cloudflare supports
them. Do not enable paid features without an explicit future decision.

### Environment strategy

Use only **one remote environment**.

Remote infrastructure:

-   One Cloudflare Worker: `nukleio-catalog-api`
-   One D1 database: `nukleio-catalog`
-   One R2 bucket: `nukleio-catalog-assets`

Do **not** create permanent `dev`/`staging` D1 databases, Workers, or R2
buckets.

Use Wrangler local development/storage for development, migrations,
parser testing, and import validation before modifying remote resources.

### Geographic scope

Educational institution data is **U.S.-only** for now.

Do not complicate the initial schema to support international
institutions.

### API behavior

The API is:

-   Read-only
-   Publicly consumable
-   GET-only for public resources
-   Search-oriented
-   Not a CRUD API
-   Not an administration API

No public write endpoints should exist.

------------------------------------------------------------------------

## 3. High-Level Architecture

``` text
                        Clients
                           |
             +-------------+-------------+
             |                           |
          Nukleio                    Public clients
       server-side                       |
             |                    anonymous requests
      Bearer API key              30 requests/min/IP
             |                           |
             +-------------+-------------+
                           |
                           v
                Cloudflare Worker
                nukleio-catalog-api
                    |             |
                    |             |
                    v             v
                   D1             R2
             nukleio-catalog   nukleio-catalog-assets
                    |             |
        +-----------+----+        +----------------------+
        |                |        |                      |
 educational_       technologies  education/...       technologies/...
 institutions
```

Nukleio must call the Catalog API from its **server-side backend** so
the privileged API key is never exposed to browsers.

------------------------------------------------------------------------

## 4. Cloudflare Configuration

The repository should contain a single `wrangler.jsonc`.

Conceptually:

``` jsonc
{
  "name": "nukleio-catalog-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-17",

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "nukleio-catalog",
      "database_id": "<REAL_DATABASE_ID>"
    }
  ],

  "r2_buckets": [
    {
      "binding": "ASSETS",
      "bucket_name": "nukleio-catalog-assets"
    }
  ]
}
```

Use:

-   `env.DB` for D1
-   `env.ASSETS` for R2

Secrets such as the Nukleio privileged API key must not be committed to
Git.

------------------------------------------------------------------------

## 5. D1 Data Model

Prefer **one table per public entity family**, not separate tables for
every category.

### 5.1 Educational institutions

Use one table:

``` text
educational_institutions
```

Both colleges and high schools belong in this table.

Required conceptual fields:

``` text
id
source
source_id
name
normalized_name
category
city
state
country
website
logo_key
source_year
is_active
created_at / imported_at
updated_at (if useful)
```

`category` must be exactly:

``` text
college
high_school
```

The public API uses the internal `id`.

Do not expose IPEDS/NCES identifiers as the primary public IDs.

Retain `source` and `source_id` internally for provenance,
deduplication, and future manual re-imports.

A uniqueness constraint should prevent duplicate records from the same
source:

``` text
UNIQUE(source, source_id)
```

Useful indexes should include at least:

-   `normalized_name`
-   `category`
-   potentially `(category, normalized_name)` if query plans justify it

Avoid adding fields that are not needed by the public API or ingestion
workflow.

### 5.2 Technologies

Use one table:

``` text
technologies
```

Do not create separate physical tables for languages, frameworks, and
technologies.

Required conceptual fields:

``` text
id
name
normalized_name
category
website
logo_key
created_at
updated_at (if useful)
```

`category` must be exactly:

``` text
language
framework
technology
```

Everything that is not specifically a programming language or framework
belongs in `technology`.

Each entity has exactly **one** category.

Examples:

``` text
Python       -> language
JavaScript   -> language
React        -> framework
Next.js      -> framework
AWS          -> technology
Docker       -> technology
PostgreSQL   -> technology
Git          -> technology
```

### 5.3 Aliases

Search should support common abbreviations/aliases when data is
available, for example:

``` text
MIT -> Massachusetts Institute of Technology
AWS -> Amazon Web Services
JS  -> JavaScript
```

Do not make comprehensive alias creation a blocker for the initial
import.

Aliases may come from:

-   Source datasets
-   Simple deterministic rules where appropriate
-   Later manual backfills
-   Later AI-assisted backfills

Choose a simple implementation, such as a shared alias table or
equivalent lightweight structure.

Do not introduce a separate search service solely for aliases.

### 5.4 Import metadata

Keep provenance lightweight.

An `import_batches` table is acceptable and recommended for dataset
imports, containing only useful information such as:

``` text
id
source
source_year
source_url
file_name
row_count
imported_at
status
```

A checksum may be retained if it is easy to generate, but provenance
must not become an elaborate subsystem.

Provenance is internal and should not appear in normal API responses.

------------------------------------------------------------------------

## 6. Public API

Version the initial API under:

``` text
/v1
```

### 6.1 Education search

``` http
GET /v1/education/search?q=boston
```

Optional category:

``` http
GET /v1/education/search?q=boston&category=college
GET /v1/education/search?q=parkway&category=high_school
```

Valid education categories:

``` text
college
high_school
```

### 6.2 Education entity lookup

``` http
GET /v1/education/{id}
```

Example response:

``` json
{
  "id": "12345",
  "name": "Boston University",
  "category": "college",
  "city": "Boston",
  "state": "MA",
  "country": "US",
  "website": "https://www.bu.edu",
  "logo_url": "https://..."
}
```

If no logo exists:

``` json
"logo_url": null
```

### 6.3 Technology search

``` http
GET /v1/technologies/search?q=react
```

Optional category:

``` http
GET /v1/technologies/search?q=python&category=language
GET /v1/technologies/search?q=react&category=framework
GET /v1/technologies/search?q=aws&category=technology
```

Valid categories:

``` text
language
framework
technology
```

### 6.4 Technology entity lookup

``` http
GET /v1/technologies/{id}
```

Example:

``` json
{
  "id": "123",
  "name": "React",
  "category": "framework",
  "website": "https://react.dev",
  "logo_url": "https://..."
}
```

### 6.5 Search parameters

Search rules:

-   `q` is required.
-   Minimum query length: **2 characters**.
-   Default result limit: **10**.
-   Optional `limit` parameter.
-   Maximum allowed limit: **25**.
-   No pagination.
-   No list-all endpoint is required.

Invalid category, limit, or query parameters should produce a clear
`400` response.

------------------------------------------------------------------------

## 7. Search Behavior

The primary use case is autocomplete/dropdown search inside Nukleio.

Examples include:

-   Project forms
-   School selection
-   Skill/technology selection
-   Other Nukleio responses that include standardized entities and their
    logos for downstream clients

Search should initially prioritize **text relevance only**.

Do not implement popularity ranking.

### Normalization

Store a normalized searchable form of names.

Normalization should remain deterministic and simple. At minimum
consider:

-   Lowercasing
-   Trimming
-   Collapsing repeated whitespace
-   Reasonable punctuation normalization

Do not destroy the original display name.

### Fuzzy search

Support lightweight typo tolerance if it can be implemented simply and
efficiently within D1/Worker constraints.

Example desired behavior:

``` text
bostn universty
```

should ideally still find:

``` text
Boston University
```

However:

-   Do not add Elasticsearch, Algolia, Typesense, Meilisearch, or
    another paid/external search system.
-   Do not build a complex ranking engine.
-   Do not jeopardize free-tier operation.
-   Exact/prefix/normalized matches should be preferred over weaker
    fuzzy matches.

Aliases should handle abbreviation cases separately from typo tolerance.

------------------------------------------------------------------------

## 8. Authentication and Rate Limiting

There are two traffic classes.

### 8.1 Public traffic

Public GET requests require no account or API key.

Initial rate limit:

``` text
30 requests / minute / IP
```

When exceeded, return:

``` http
429 Too Many Requests
```

The implementation should remain inexpensive and simple.

Do not build:

-   Public user accounts
-   Public API-key issuance
-   Billing
-   Subscription tiers
-   Developer dashboards

unless the API is intentionally monetized in the future.

### 8.2 Nukleio traffic

Nukleio calls the API server-side using:

``` http
Authorization: Bearer <NUKLEIO_CATALOG_API_KEY>
```

A valid privileged key bypasses the normal public 30/min/IP
application-level rate limit.

There is no ordinary application-level Nukleio rate limit.

The secret must:

-   Be stored securely.
-   Never be committed.
-   Never be included in client-side JavaScript.
-   Be compared safely by the Worker.

### 8.3 Hard cost protection

Nukleio's privileged status does **not** override the hard \$0
requirement.

Configure available Cloudflare controls so that unexpected traffic
cannot intentionally produce paid usage.

If the only alternative to billing is rejecting traffic, reject traffic.

Priority order:

1.  Preserve Nukleio traffic when possible.
2.  Throttle/reject public traffic aggressively when necessary.
3.  If required to guarantee no billing, allow all traffic---including
    Nukleio---to become unavailable.

Codex must verify the current Cloudflare mechanisms/limits before
implementing cost controls rather than assuming a particular paid/free
behavior.

------------------------------------------------------------------------

## 9. CORS

Public GET endpoints should support browser clients.

Use public GET-compatible CORS, conceptually:

``` http
Access-Control-Allow-Origin: *
```

Do not expose the Nukleio privileged credential through CORS or browser
code.

------------------------------------------------------------------------

## 10. R2 Logo Storage

Use one R2 bucket:

``` text
nukleio-catalog-assets
```

Keep education and technology assets logically separated.

Suggested key organization:

``` text
education/
  colleges/
    ...
  high-schools/
    ...

technologies/
  ...
```

The exact R2 object layout is an implementation detail.

Consumers should use the `logo_url` returned by the API and should not
need knowledge of R2 key conventions.

### Database representation

Store an internal object key:

``` text
logo_key
```

rather than permanently storing the complete public URL.

Example:

``` text
education/colleges/12345.svg
```

The Worker/API constructs `logo_url`.

This allows the asset hostname or delivery strategy to change later
without rewriting every D1 record.

### Missing logos

Missing logos are valid:

``` json
"logo_url": null
```

The API should not dynamically search the web for a logo when a request
occurs.

Missing logos can be manually/backfill-updated later.

### Formats

Prefer SVG when an appropriate SVG is available.

For raster logos:

-   Normalize formats where useful.
-   Compress them.
-   Avoid unnecessarily large dimensions/files.
-   Optimize for storage and delivery efficiency.

Do not perform expensive image processing at request time.

------------------------------------------------------------------------

## 11. Data Ingestion Philosophy

Imports are **manual and reproducible**, not scheduled production jobs.

Do not build:

-   Cron jobs
-   Scheduled Workers
-   Automatic annual IPEDS refreshes
-   Background crawlers
-   Continuous logo discovery
-   Runtime AI lookup

The expected process is:

``` text
download dataset
      |
      v
local parser
      |
      v
validation / dry run
      |
      v
local D1 import
      |
      v
manual verification
      |
      v
remote D1 import
```

This data is expected to be assembled initially and then
changed/backfilled manually when needed.

------------------------------------------------------------------------

## 12. Educational Data Sources

For colleges, prefer official NCES/IPEDS public-release data.

For high schools, use an appropriate official NCES public dataset when
that stage is implemented.

Use only publicly available datasets whose terms permit the intended
use/redistribution.

Do not ingest restricted-use NCES datasets.

Keep provenance simple:

-   Source name
-   Source URL
-   Release year
-   File name where useful

Do not expose this metadata through normal public entity responses.

### Raw files

Raw downloaded datasets may live under something like:

``` text
data/raw/
```

They should remain local and be ignored by Git.

Example:

``` text
data/raw/ipeds/2024/HD2024.csv
```

Do not commit large raw source datasets.

Simple source manifests are acceptable if useful, but do not build an
elaborate provenance or licensing system.

------------------------------------------------------------------------

## 13. Initial IPEDS Import

The first ingestion milestone is:

``` text
IPEDS CSV
   ->
validated parser
   ->
local D1
   ->
remote D1
```

Use official NCES/IPEDS data.

For the initial college dataset, retain only fields needed by this API
plus internal provenance.

Likely mapping:

``` text
UNITID  -> source_id
INSTNM  -> name
CITY    -> city
STABBR  -> state
WEBADDR -> website
```

Other IPEDS fields may be used only when needed to determine whether an
institution belongs in the college catalog.

Use:

``` text
source = "IPEDS"
country = "US"
category = "college"
```

Use `UNITID` as the source-specific identifier, but generate/use an
internal API ID separately.

### Parser requirements

The importer should:

-   Stream the CSV rather than unnecessarily loading the whole file.
-   Handle a UTF-8 BOM.
-   Trim strings.
-   Convert empty optional values to `NULL`.
-   Validate required values.
-   Generate normalized names.
-   Validate/normalize website values reasonably.
-   Detect duplicate source IDs.
-   Report invalid/skipped rows.
-   Support a dry-run mode.
-   Support local import first.
-   Be idempotent through upsert behavior based on
    `(source, source_id)`.

Do not silently discard malformed required records.

### Dry run

The dry run should report useful counts such as:

-   Total source rows
-   Selected rows
-   Excluded rows
-   Invalid/missing required fields
-   Duplicate source IDs
-   Invalid websites
-   Rows that would be inserted/updated

### Remote import

Only import remotely after local validation succeeds.

Use sensible batches rather than one enormous SQL statement/request.

The exact batch size should be chosen conservatively based on current D1
limits; roughly 100--250 rows per operation is a reasonable starting
range if supported.

------------------------------------------------------------------------

## 14. Technology Dataset

Do not block the education implementation on selecting a technology
dataset.

Technology ingestion will be designed separately later.

The database/API architecture must already support:

``` text
language
framework
technology
```

but Codex should **not invent a technology data source** during the
initial IPEDS milestone.

------------------------------------------------------------------------

## 15. Logo Acquisition

Logo acquisition is a separate ingestion/backfill concern from the core
API.

The intended strategy is broadly:

1.  Use deterministic/official-domain-based methods where practical.
2.  Store successful logo assets in R2.
3.  Leave unavailable logos as `NULL`.
4.  Backfill misses later, potentially using AI-assisted research/manual
    review.

This is a **one-time/manual data-building process**, not runtime API
behavior.

Do not implement a production crawler or autonomous logo agent as part
of the initial API.

Because logos may have copyright/trademark considerations separate from
factual government datasets, verify an acceptable
sourcing/redistribution approach before performing a bulk public logo
mirror. Do not turn this into a complex licensing subsystem.

------------------------------------------------------------------------

## 16. Repository Responsibilities

This repository owns the entire catalog system:

``` text
Nukleio-Catalog-Api/
|
+-- src/
|   +-- Worker/API implementation
|
+-- migrations/
|   +-- D1 migrations
|
+-- scripts/
|   +-- import/
|   |   +-- dataset import scripts
|   |
|   +-- logos/
|       +-- later logo processing/backfill utilities
|
+-- data/
|   +-- raw/                 # gitignored
|   +-- source-manifests/    # optional/lightweight
|
+-- wrangler.jsonc
+-- package.json
+-- tsconfig.json
```

Exact organization may vary slightly if a simpler conventional structure
is preferable.

Do not split ingestion into another repository.

------------------------------------------------------------------------

## 17. Error Responses

Use predictable JSON errors.

Examples:

### Invalid query

``` json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "Search query must contain at least 2 characters."
  }
}
```

### Not found

``` json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Entity not found."
  }
}
```

### Rate limited

``` json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests."
  }
}
```

Avoid leaking internal database or Cloudflare error details.

------------------------------------------------------------------------

## 18. Explicit Non-Goals

Do **not** build any of the following unless requirements change:

-   Separate remote dev/staging infrastructure
-   Separate college and high-school databases
-   Separate language/framework/technology databases
-   Separate R2 buckets for each entity category
-   User accounts for the Catalog API
-   Public API-key management
-   Billing
-   Monetization
-   Administrative dashboard
-   Public write endpoints
-   Scheduled imports
-   Scheduled crawling
-   Runtime web scraping
-   Runtime AI logo lookup
-   External hosted search service
-   Popularity-based ranking
-   Pagination
-   International school support
-   Generic catalog framework for arbitrary future entity types
-   Complex licensing/provenance subsystem
-   Microservices

Prefer the simplest implementation that satisfies the stated
requirements.

------------------------------------------------------------------------

## 19. Implementation Order

Codex should implement incrementally.

### Phase 1 --- Foundation

1.  Finalize `wrangler.jsonc`.
2.  Add minimal Worker/TypeScript scaffolding.
3.  Define environment bindings/types.
4.  Add D1 migration(s) for the initial schema.
5.  Apply/test migrations locally.

### Phase 2 --- College ingestion

1.  Obtain official IPEDS CSV.
2.  Add local raw-data path conventions/gitignore rules.
3.  Implement `import-ipeds.ts`.
4.  Add dry-run validation.
5.  Import into local D1.
6.  Validate counts/sample entities.
7.  Only then apply migration/import to remote D1.

### Phase 3 --- Education API

Implement:

``` text
GET /v1/education/search
GET /v1/education/{id}
```

Include:

-   Search normalization
-   Category filtering
-   Limits
-   Lightweight fuzzy matching if practical
-   Alias support structure
-   `logo_url`
-   Error handling

### Phase 4 --- Access protection

Implement:

-   Anonymous public access
-   30 requests/minute/IP
-   Server-side Nukleio Bearer credential
-   Public-limit bypass for authenticated Nukleio calls
-   CORS
-   Hard \$0-oriented Cloudflare safeguards

### Phase 5 --- R2/logo integration

Implement:

-   R2 binding
-   `logo_key`
-   Public logo delivery strategy
-   `logo_url` construction
-   Missing-logo behavior

Do not bulk acquire logos until sourcing/redistribution strategy is
settled.

### Phase 6 --- High schools

Select an official NCES dataset and implement a corresponding manual
importer into the same:

``` text
educational_institutions
```

table using:

``` text
category = "high_school"
```

### Phase 7 --- Technologies

Later determine the technology dataset/curation approach and populate
the existing:

``` text
technologies
```

table.

Then expose:

``` text
GET /v1/technologies/search
GET /v1/technologies/{id}
```

------------------------------------------------------------------------

## 20. Guiding Principle

This project should remain intentionally small.

The desired system is essentially:

``` text
Static-ish public datasets
        +
Manually curated logos
        |
        v
       D1 + R2
        |
        v
Small Cloudflare Worker
        |
        +--> privileged Nukleio usage
        |
        +--> rate-limited public usage
```

Do not solve hypothetical scale, monetization, internationalization,
automation, or generalized catalog problems before they exist.

Build the smallest reliable API that gives Nukleio and public consumers
fast access to standardized U.S. schools, technologies, metadata, and
logos while maintaining the hard \$0/month operating constraint.

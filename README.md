# Nukleio Catalog API

An independent, public catalog service for reusable reference data. The initial catalog focus is education data, with technology catalogs planned for a later phase.

## Project status

This repository currently contains project scaffolding only. The Worker API, D1 schema migrations, data-import tooling, and deployment configuration will be added in later steps.

## Planned architecture

- TypeScript on Cloudflare Workers
- Hono for HTTP routing
- Cloudflare D1 for catalog metadata
- Cloudflare R2 for logos and icons
- Wrangler for local development, migrations, and deployment
- Versioned routes such as `/v1/schools/...` and `/v1/technologies/...`

See [docs/architecture.md](docs/architecture.md) for the initial design notes.

## Repository layout

```text
src/
  api/                 Public Worker routes and request handling
  catalog/             Catalog domain types and normalization
  shared/              Shared utilities and types
scripts/
  enrichment/          Future asset-enrichment tooling
  import/              Future source-data import tooling
migrations/            Future Cloudflare D1 SQL migrations
data/
  corrections/         Reviewable manual corrections
  source-manifests/    Source metadata, checksums, and provenance
docs/                  Architecture and project documentation
```

Raw source downloads and binary assets are intentionally excluded from Git. Only the scripts, manifests, migrations, and reviewable corrections belong in this repository.

## Local prerequisites

The planned implementation will use Node.js 20 or newer and the Wrangler CLI. No dependencies are installed yet because application and import code have not been created.

## GitHub workflow

The default branch is `main`. Keep changes focused and use pull requests for changes once the GitHub repository is created. Before the first implementation, add the repository-specific Wrangler configuration and Cloudflare resource identifiers through local environment files or GitHub Actions secrets; do not commit credentials or production identifiers that should remain private.

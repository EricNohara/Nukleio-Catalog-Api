# Nukleio Catalog API — Initial Architecture

This document records the initial specifications supplied for the project. It is design guidance for future implementation, not a command to implement the API in this setup phase.

## Purpose and scope

Nukleio Catalog API is intended to be an independent public service for reusable reference data. Nukleio will be its first consumer, but the API should remain usable by other applications.

The first catalog area is education data:

- Colleges and universities from IPEDS
- Public high schools from the NCES Common Core of Data
- Private high schools from the NCES Private School Universe Survey
- Names, aliases, locations, official websites, source identifiers, coordinates, and asset references

Technology catalogs are planned for a later phase and may include programming languages, frameworks, libraries, developer tools, platforms, aliases, categories, homepages, and icons.

## Intended architecture

```text
Clients
  |
  v
Cloudflare Worker API
  |
  +-- Cloudflare D1: catalog metadata
  +-- Cloudflare R2: logos and icons
```

The public contract will use versioned routes such as `/v1/schools/...` and `/v1/technologies/...`. Catalog areas should remain logically separated even if they are initially served by one Worker and stored in one D1 database.

## Planned tooling

- TypeScript for the Worker and data tooling
- Hono for Worker routing
- Wrangler for development, bindings, migrations, and deployment
- SQL migrations for D1 schema changes
- Node.js TypeScript scripts for initial imports and later enrichment
- Zod where runtime validation is useful

## Data maintenance principles

Initial source datasets will be imported by local, versioned scripts. Source manifests, checksums, provenance, and manual corrections should remain reviewable and reproducible. Raw downloads and binary assets should not be committed. Logo and icon collection is separate from metadata import, with enriched assets stored in R2 and references stored in D1.

The initial system is deliberately small: one public Worker API, D1 metadata, R2 assets, and a one-time local import process. Caching, rate limiting, automation, and specialized search infrastructure can be added when actual usage justifies them. Unit testing is not required for the MVP according to the initial specification.

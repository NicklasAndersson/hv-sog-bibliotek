# AGENTS.md — r2-dir-list

## Project Overview

R2 Directory Listing is a Cloudflare Worker that serves HTML directory listings for Cloudflare R2 buckets. It sits in front of an R2 bucket via a custom domain and only intercepts 404 responses for paths ending in `/`, generating a file/folder listing page. Normal object access is unaffected.

- **Runtime**: Cloudflare Workers (V8 isolates, no Node.js APIs)
- **Language**: TypeScript (ES2021 target)
- **Build/Deploy**: Wrangler (`wrangler deploy`)
- **Upstream**: Forked from [cmj2002/r2-dir-list](https://github.com/cmj2002/r2-dir-list)

## Architecture

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry point (`fetch` handler). Handles Basic Auth, origin fetch, redirect logic, R2 listing, full-bucket search (`?q=`), and response generation. |
| `src/config.ts` | Site configuration (domain → `SiteConfig` mapping). **Gitignored** — each deployment has its own. |
| `src/types.ts` | TypeScript types: `Env` (R2 bucket bindings), `SiteConfig` (per-site options including redirect, sorting, descriptions). |
| `src/render.ts` | HTML template rendering: directory listing page with breadcrumbs, folder/file rows, search bar, search results page, footer. |
| `src/static.ts` | Static assets: SVG icons and CSS inlined into the HTML response. |
| `wrangler.toml` | Wrangler config (routes, R2 bindings, observability). **Gitignored**. |

## Key Conventions

- **No external dependencies** — only `@cloudflare/workers-types` (dev) and `wrangler`. All HTML/CSS is inlined.
- **Config is gitignored** — `src/config.ts` and `wrangler.toml` contain deployment-specific secrets/domains and must not be committed. Example files (`*.example`) are provided upstream.
- **Basic Auth** is implemented directly in the worker entry point in `src/index.ts`. Credentials are read from Wrangler secrets (`AUTH_USERNAME`, `AUTH_PASSWORD`) via the `Env` type — never hardcode them.
- **R2 API** — uses the Workers R2 bindings (`R2Bucket`, `R2Object`, `R2ListOptions`). Pagination is handled by `listBucket()`.
- **HTML generation** — template literals, no framework. Output is a single self-contained HTML page.
- **Search** — server-side full-bucket search via `?q=` query parameter. Lists all R2 objects (no prefix/delimiter), filters by case-insensitive `includes()` on object keys and `desp` descriptions. Search bar appears in the header of every directory listing page.

## Security — Public Repo

This repo is **public**. Never commit secrets, credentials, or deployment-specific values.

- `src/config.ts` and `wrangler.toml` are in `.gitignore` — keep them there.
- Auth credentials (`AUTH_USERNAME`, `AUTH_PASSWORD`) must be set via `wrangler secret put`, never hardcoded in source.
- Do not log or expose request headers, auth tokens, or bucket contents in committed code.
- The `/sitemap.xml` endpoint is intentionally unauthenticated (public file listing).

## Current Deployment

- **Domain**: `bibliotek.hv-sog.se`
- **Bucket**: `bibliotek`
- **Route**: `bibliotek.hv-sog.se/*` on zone `hv-sog.se`
- **Last deploy**: 2026-03-21

## Development

```bash
npm install
npm run dev     # local dev with wrangler
npm run deploy  # deploy to Cloudflare
```

## Editing Guidelines

- Keep changes minimal and focused. This is a small, single-purpose worker.
- Do not add Node.js-specific APIs — the runtime is Cloudflare Workers (V8).
- When modifying HTML output in `render.ts`, preserve the existing CSS class structure from `static.ts`.
- Never commit `src/config.ts` or `wrangler.toml` — they contain deployment-specific configuration.

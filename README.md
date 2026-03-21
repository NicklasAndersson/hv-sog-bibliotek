# R2 Directory Listing

A Cloudflare Worker that generates HTML directory listings for [Cloudflare R2](https://developers.cloudflare.com/r2/) buckets. Forked from [cmj2002/r2-dir-list](https://github.com/cmj2002/r2-dir-list).

Currently deployed at **bibliotek.hv-sog.se** serving the `bibliotek` R2 bucket (HV-SOG document library).

## Setup

```bash
npm install
```

Create your deployment-specific config files (these are gitignored):

- `src/config.ts` — site configuration (domain, bucket binding, descriptions, favicon, etc.)
- `wrangler.toml` — Wrangler configuration (routes, R2 bindings, zone)

See `src/config.ts.example` and `wrangler.toml.example` in the upstream repo for templates.

### Configuration

In `src/config.ts`, configure a `SiteConfig` per domain:

- `name` — site title shown in the header
- `bucket` — R2 bucket binding from `Env`
- `desp` — path-specific descriptions shown in the listing and footer
- `decodeURI` — decode URI-encoded object keys (recommended)
- `favicon` — URL to a PNG favicon
- `showPoweredBy` — show/hide footer attribution
- `legalInfo` — optional legal text in footer (raw HTML)
- `redirect` — optional async function for key redirects
- `sortFn` — optional custom sort functions for files and folders
- `dangerousOverwriteZeroByteObject` — allow listing even when a 0-byte object exists at the path

In `wrangler.toml`, configure:

- `routes` — domain pattern and zone name
- `r2_buckets` — bucket binding name and bucket name

## Development

```bash
npm run dev      # local dev server (wrangler dev)
npm run deploy   # deploy to Cloudflare Workers
```

## How It Works

The worker sits in front of an R2 bucket via a custom domain. It intercepts responses and generates a directory listing page when **all** of the following are true:

- The response from R2 is a 404
- The requested path ends with `/`
- There are objects or prefixes under that path in the bucket

Otherwise, the original R2 response is returned unchanged — normal object access is unaffected.

The worker also implements Basic Auth to restrict access.

### Search

Every directory listing page includes a search bar in the header. Submitting a query performs a **full-bucket server-side search** — the worker lists all objects in the R2 bucket and filters by case-insensitive substring match against file/folder names and `desp` descriptions. Results are displayed as a flat list with full paths.

## Project Structure

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry point — auth, origin fetch, redirect, R2 listing |
| `src/config.ts` | Per-domain site configuration (**gitignored**) |
| `src/types.ts` | TypeScript types (`Env`, `SiteConfig`) |
| `src/render.ts` | HTML template rendering (directory listing, search results) |
| `src/static.ts` | Inlined SVG icons and CSS |

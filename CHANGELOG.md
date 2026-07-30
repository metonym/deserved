# Changelog

## 0.4.0 — 2026-07-30

**Features**

- Programmatic API: `serve()` via package exports for embedding without the CLI. (`#15`)
- Fail fast when the root path is missing or not a directory. (`#16`)
- Hot-swap stylesheets on CSS-only changes in `--watch` mode (mixed batches still full-reload). (`#18`)
- Hop to the next free port when the default is taken; honor `$PORT` when `--port` is omitted. (`#20`)
- Show file sizes and modification times in directory listings.

**Performance**

- Cache path resolution with watcher / TTL invalidation (re-stat winners so content edits stay fresh). (`#17`)

**Fixes**

- Keep live-reload SSE alive with heartbeats; close clients on shutdown and log `server stopped` cleanly. (`#21`)
- Bound the compressed-response cache with a 64MB LRU byte budget, evict on watch invalidation, and scope it per handler instance.

## 0.3.0 — 2026-07-27

**Features**

- Serve root `404.html` (with live-reload injection under `--watch`) for HTML-accepting 404s; other clients keep the plain-text body. (`#13`)
- Honor `If-Range` per RFC 9110: a stale or weak validator falls back to a full `200` instead of a `206`. (`#13`)

**Performance**

- Compress asynchronously and single-flight concurrent cache misses for the same file/encoding. (`#8`)
- Preserve BunFile sendfile path under `--cors`; skip body read/compress/inject work for `HEAD`. (`#9`)

**Fixes**

- Stream Range responses instead of buffering the slice into memory. (`#7`)
- Harden request handling: malformed `%`-encoding → `400`, unexpected errors → logged `500`, send `Vary: Accept-Encoding` on identity compressible responses, keep validators on `416`, bracket `::1` in the banner URL. (`#10`)
- Redirect slashless directory URLs with `301`, and URI-encode directory-listing hrefs. (`#11`)
- `--watch` ignores nested `.git` / dot-directory churn (every path segment, not just the first). (`#13`)

## 0.2.0 — 2026-07-26

**Breaking changes:**

- Cache headers are off by default (`no-cache`). Use `--cache` for long-lived, immutable asset caching. (`#4`)

**Features**

- Prefer zstd compression when the client advertises it via `Accept-Encoding`, falling back to gzip. (`#6`)

**Fixes**

- Graceful shutdown on `SIGINT`/`SIGTERM`, including when `--watch` is not set; await `server.stop()` before exit. (`#5`)

## 0.1.0 — 2026-07-14

- initial release

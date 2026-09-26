# Changelog

## 0.6.0 — 2026-09-25

**Breaking changes:**

- Public API is `serve` and `createHandler`. `startServer` and `portExplicit` are internal, and `createHandler` takes `Partial<Options>` like `serve()`.

**Features**

- Live reload survives a server restart: the client waits for the event stream to reconnect instead of reloading into an error page after one second.
- Drop ANSI colors when stdout isn't a TTY or `NO_COLOR` is set.

**Fixes**

- `serve({ quiet: true })` is fully silent, including the startup banner. CLI `-q` still prints the banner and only silences request logs.
- Reject a second path argument (`deserved dist docs` no longer silently serves `docs`).
- Empty `--port=` and `--host=` error instead of binding port `0` or host `""`.
- Don't subscribe an SSE client on `HEAD /__events`.
- Respect `q=0` when negotiating compression (`gzip;q=0` refuses gzip).
- Send a weak ETag with compressed responses so `If-None-Match` 304s still work and `If-Range` falls back to a full response.
- Don't block startup when the browser-open command waits for the browser to exit.
- `HEAD` reports the same `Content-Encoding` and `Content-Length` as `GET`.
- Answer CORS preflight from `createHandler` (embedding with `cors: true` no longer returns `405` on `OPTIONS`).
- Collapse leading slashes on directory trailing-slash redirects so `//evil.com` isn't an open redirect.
- Stop serving dotfiles outside `/.well-known/` (they 404, including via `404.html`).

**Performance**

- Publish one shared chunk for the CLI and library (8.6 kB gzipped, down from 14.7 kB).

## 0.5.1 — 2026-09-15

**Features**

- Publish the npm package with provenance attestations. (`#36`)

## 0.5.0 — 2026-09-08

**Features**

- Publish TypeScript declaration files with the package. (`#24`)

**Performance**

- Gzip via Bun 1.4's native `CompressionStream` (drops the `node:zlib` fallback). (`#27`)
- Cut redundant allocations on the request hot path (`safeJoin`, `notModified`, `isCompressible`, SPA checks).
- Keep compressed-cache entries as `Blob` so `Response` skips copying the body buffer.
- Batch request-log writes and skip sanitization when the path is clean.
- Cache the `404.html` body by `(size, mtime)` instead of re-reading on every HTML 404.
- Cache directory resolution alongside file resolution (browser 404s / listings).
- Evict resolution-cache entries LRU instead of clearing the whole map past capacity.
- Build response headers as plain objects; memoize `Last-Modified` for an unchanged mtime.
- With `--watch`, trust the cached stat until the watcher invalidates it; non-watch mode still re-stats so edits are visible immediately.

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
